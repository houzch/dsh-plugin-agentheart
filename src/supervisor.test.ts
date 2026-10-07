/**
 * 侧车监督器测试。
 *
 * 用 `process.execPath` 充当「侧车二进制」，并以 `NODE_OPTIONS=--require <临时脚本>`
 * 让子进程打印受控的启动横幅——于是在**真实 spawn** 下覆盖进程生命周期与
 * 横幅解析，既不需要真实 `agentheartd`，也不依赖模块 mock。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { SidecarSupervisor, type SidecarSupervisorOptions } from './supervisor.js'

const FAKE_DIR = mkdtempSync(join(tmpdir(), 'agentheart-supervisor-'))

after(() => rmSync(FAKE_DIR, { recursive: true, force: true }))

/** 写一个假侧车脚本，返回可安全放进 `NODE_OPTIONS` 的路径（正斜杠）。 */
function fakeSidecar(name: string, body: string): string {
  const file = join(FAKE_DIR, `${name}.cjs`)
  writeFileSync(file, body, 'utf8')
  return file.replace(/\\/g, '/')
}

/** 让 `spawn(process.execPath, [])` 预载给定脚本，以模拟侧车二进制。 */
function supervisorFor(script: string, options: SidecarSupervisorOptions = {}): SidecarSupervisor {
  return new SidecarSupervisor({
    binaryPath: process.execPath,
    env: { NODE_OPTIONS: `--require "${script}"` },
    ...options,
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const KEEP_ALIVE = 'setInterval(() => {}, 60000)'

test('start() 解析 ready 横幅（含跨分块的 mqtt 行），暴露端点与 pid', async () => {
  const script = fakeSidecar(
    'ready-mqtt',
    [
      "process.stdout.write('agentheartd mqtt=127.0.0.1:1883\\n')",
      "setTimeout(() => process.stdout.write('agentheartd ready addr=127.0.0.1:1234 token=tok-secret\\n'), 30)",
      KEEP_ALIVE,
    ].join('\n'),
  )
  const supervisor = supervisorFor(script)
  try {
    const endpoint = await supervisor.start()
    assert.equal(endpoint.address, '127.0.0.1:1234')
    assert.equal(endpoint.token, 'tok-secret')
    assert.equal(endpoint.mqtt, '127.0.0.1:1883')
    assert.equal(typeof endpoint.pid, 'number')
    assert.equal(supervisor.running, true)
    assert.deepEqual(supervisor.current, endpoint)
  } finally {
    await supervisor.stop(500)
  }
})

test('start() 幂等：重复调用返回同一端点', async () => {
  const script = fakeSidecar(
    'ready-only',
    `process.stdout.write('agentheartd ready addr=127.0.0.1:5555 token=t\\n')\n${KEEP_ALIVE}`,
  )
  const supervisor = supervisorFor(script)
  try {
    const first = await supervisor.start()
    const second = await supervisor.start()
    assert.deepEqual(second, first)
    assert.equal(supervisor.current?.address, '127.0.0.1:5555')
    assert.equal(supervisor.current?.mqtt, undefined)
  } finally {
    await supervisor.stop(500)
  }
})

test('就绪超时：拒绝、停止侧车并保留 stderr 诊断', async () => {
  const script = fakeSidecar(
    'silent',
    `process.stderr.write('booting agentheartd...\\n')\n${KEEP_ALIVE}`,
  )
  // 超时必须显著大于子进程启动耗时：否则在负载高的 CI runner 上，定时器会先于
  // 子进程写出 stderr 触发，导致 stderr 断言偶发失败。
  const supervisor = supervisorFor(script, { startupTimeoutMs: 1000 })
  try {
    await assert.rejects(() => supervisor.start(), /未就绪/)
    await waitUntil(() => !supervisor.running)
    assert.equal(supervisor.current, null)
    assert.match(supervisor.lastStderr, /booting agentheartd/)
  } finally {
    await supervisor.stop(500)
  }
})

test('stderr 仅保留最近 2048 字符', async () => {
  const script = fakeSidecar(
    'noisy',
    `process.stderr.write('x'.repeat(3000) + 'TAIL')\n${KEEP_ALIVE}`,
  )
  const supervisor = supervisorFor(script, { startupTimeoutMs: 1000 })
  try {
    await assert.rejects(() => supervisor.start(), /未就绪/)
    assert.ok(supervisor.lastStderr.length <= 2048)
    assert.ok(supervisor.lastStderr.includes('TAIL'))
  } finally {
    await supervisor.stop(500)
  }
})

test('侧车提前退出：拒绝并回调 onExit', async () => {
  const script = fakeSidecar(
    'early-exit',
    ["process.stdout.write('starting\\n')", 'setTimeout(() => process.exit(3), 20)'].join('\n'),
  )
  const exits: Array<number | null> = []
  const supervisor = supervisorFor(script, { onExit: (code) => exits.push(code) })
  await assert.rejects(() => supervisor.start(), /提前退出（code=3/)
  await waitUntil(() => !supervisor.running)
  assert.deepEqual(exits, [3])
})

test('stop() 优雅停止：进程退出且状态清空', async () => {
  const script = fakeSidecar(
    'stopper',
    `process.stdout.write('agentheartd ready addr=127.0.0.1:6001 token=t\\n')\n${KEEP_ALIVE}`,
  )
  const supervisor = supervisorFor(script)
  await supervisor.start()
  assert.equal(supervisor.running, true)
  await supervisor.stop(2000)
  assert.equal(supervisor.running, false)
  assert.equal(supervisor.current, null)
})

test(
  'stop() 超时后强杀忽略 SIGTERM 的侧车',
  { skip: process.platform === 'win32' ? 'Windows 无信号语义' : false },
  async () => {
    const script = fakeSidecar(
      'stubborn',
      [
        "process.stdout.write('agentheartd ready addr=127.0.0.1:6002 token=t\\n')",
        "process.on('SIGTERM', () => {})",
        KEEP_ALIVE,
      ].join('\n'),
    )
    const supervisor = supervisorFor(script)
    await supervisor.start()
    const startedAt = Date.now()
    await supervisor.stop(150)
    assert.ok(Date.now() - startedAt >= 140, '应先等待优雅超时再强杀')
    assert.equal(supervisor.running, false)
  },
)

test('未运行时 stop() 直接返回（可重入）', async () => {
  const supervisor = new SidecarSupervisor()
  await supervisor.stop()
  await supervisor.stop()
  assert.equal(supervisor.running, false)
  assert.equal(supervisor.current, null)
})
