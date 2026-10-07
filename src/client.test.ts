/**
 * 协议客户端契约测试。
 *
 * 用一个独立的 TCP 假内核交叉校验**线格式**与请求-响应 / 事件语义：
 * 帧头字段位置在测试中独立复刻（不复用 `encodeFrame`），避免「自己验自己」。
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'

import {
  AgentHeartClient,
  AhRequestError,
  encodeFrame,
  HEADER_LEN,
  MAGIC,
  PROTOCOL_VERSION,
  parseAddress,
} from './client.js'

const FLAG_REQUEST = 0x1
const FLAG_EVENT = 0x4

/** 复刻一帧（与实现解耦，用于交叉校验线格式）。 */
function frame(requestId: number, payload: unknown, flags: number): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(HEADER_LEN)
  header.writeUInt32LE(MAGIC, 0)
  header.writeUInt8(PROTOCOL_VERSION, 4)
  header.writeUInt8(0, 5)
  header.writeUInt16LE(flags, 6)
  header.writeUInt32LE(requestId >>> 0, 8)
  header.writeUInt32LE(body.length, 12)
  return Buffer.concat([header, body])
}

interface FakeKernel {
  address: string
  /** 已收到的请求消息体（解析后，按到达顺序）。 */
  readonly received: Record<string, unknown>[]
  /** 向已连接的客户端推送一个事件帧。 */
  pushEvent(event: Record<string, unknown>): void
  close(): Promise<void>
}

/** 启动最小假内核：解析请求帧并按 `m` 回应（返回 `undefined` 表示不回）。 */
async function startKernel(
  handler: (request: Record<string, unknown>) => unknown | undefined,
): Promise<FakeKernel> {
  const received: Record<string, unknown>[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= HEADER_LEN) {
        const requestId = buffer.readUInt32LE(8)
        const length = buffer.readUInt32LE(12)
        if (buffer.length < HEADER_LEN + length) return
        const body = buffer.subarray(HEADER_LEN, HEADER_LEN + length).toString('utf8')
        buffer = buffer.subarray(HEADER_LEN + length)
        const request = JSON.parse(body) as Record<string, unknown>
        received.push(request)
        const reply = handler(request)
        if (reply !== undefined) socket.write(frame(requestId, reply, 0))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', '应当拿到端口')
  return {
    address: `127.0.0.1:${address.port}`,
    received,
    pushEvent(event) {
      for (const socket of sockets) socket.write(frame(0, event, FLAG_EVENT))
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/** 轮询等待（消除时序抖动，避免依赖固定 sleep）。 */
async function waitFor<T>(probe: () => T, ok: (value: T) => boolean, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error('waitFor: 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('parseAddress 解析 host:port 并拒绝非法输入', () => {
  assert.deepEqual(parseAddress('127.0.0.1:17890'), { host: '127.0.0.1', port: 17890 })
  assert.throws(() => parseAddress('nope'), /地址非法/)
  assert.throws(() => parseAddress('127.0.0.1:0'), /端口非法/)
})

test('encodeFrame 按方案 §8.3 写入 16 字节帧头', () => {
  const buffer = encodeFrame(7, { m: 'system.health' })
  assert.equal(buffer.readUInt32LE(0), MAGIC)
  assert.equal(buffer.readUInt8(4), PROTOCOL_VERSION)
  assert.equal(buffer.readUInt8(5), 0)
  assert.equal(buffer.readUInt16LE(6), FLAG_REQUEST)
  assert.equal(buffer.readUInt32LE(8), 7)
  assert.equal(buffer.readUInt32LE(12), buffer.length - HEADER_LEN)
  assert.deepEqual(JSON.parse(buffer.subarray(HEADER_LEN).toString('utf8')), {
    m: 'system.health',
  })
})

test('握手 + job.create / job.delete 往返', async () => {
  const kernel = await startKernel((request) => {
    switch (request.m) {
      case 'system.hello':
        return { ok: true, m: 'system.hello', result: { ver: PROTOCOL_VERSION } }
      case 'job.create':
        return { ok: true, m: 'job.create', result: { jobId: 'job-1', state: 'enabled' } }
      case 'job.delete':
        return { ok: true, m: 'job.delete', result: { jobId: 'job-1', deleted: true } }
      default:
        return { ok: false, error: { code: 7, codeName: 'UNKNOWN_METHOD', message: request.m } }
    }
  })
  try {
    const client = await AgentHeartClient.connect(kernel.address, 'tok')
    assert.deepEqual(await client.createJob({ queue: 'q', cron: '0 * * * * *' }), {
      jobId: 'job-1',
      state: 'enabled',
    })
    assert.deepEqual(await client.deleteJob('job-1'), { jobId: 'job-1', deleted: true })
    assert.deepEqual(kernel.received[0], { m: 'system.hello', ver: PROTOCOL_VERSION, token: 'tok' })
    assert.deepEqual(kernel.received[1], { m: 'job.create', queue: 'q', cron: '0 * * * * *' })
    assert.deepEqual(kernel.received[2], { m: 'job.delete', jobId: 'job-1' })
    client.close()
  } finally {
    await kernel.close()
  }
})

test('ok:false 时 must 抛 AhRequestError 并携带内核错误码', async () => {
  const kernel = await startKernel((request) =>
    request.m === 'system.hello'
      ? { ok: true, result: {} }
      : {
          ok: false,
          error: { code: 6, codeName: 'BAD_REQUEST', message: 'cron 与 intervalMs 必须二选一' },
        },
  )
  try {
    const client = await AgentHeartClient.connect(kernel.address)
    await assert.rejects(
      () => client.createJob({ queue: 'q' }),
      (error: unknown) => {
        assert.ok(error instanceof AhRequestError)
        assert.equal(error.response.error?.code, 6)
        return true
      },
    )
    client.close()
  } finally {
    await kernel.close()
  }
})

test('握手被拒绝时 connect 抛错', async () => {
  const kernel = await startKernel(() => ({
    ok: false,
    error: { code: 1, codeName: 'DENIED', message: 'bad token' },
  }))
  try {
    await assert.rejects(() => AgentHeartClient.connect(kernel.address, 'bad'), /握手被拒绝/)
  } finally {
    await kernel.close()
  }
})

test('事件帧与响应帧在同一连接分流：事件入队、响应按 requestId 匹配', async () => {
  const kernel = await startKernel((request) =>
    request.m === 'system.hello' ? { ok: true, result: {} } : { ok: true, result: { up: true } },
  )
  try {
    const client = await AgentHeartClient.connect(kernel.address)
    kernel.pushEvent({ m: 'event.task', seq: 1, taskId: 't-1' })
    // 触发一次往返；事件帧可能先于/后于响应到达，故轮询等待
    assert.deepEqual(await client.health(), { up: true })
    const events = await waitFor(() => client.drainEvents(), (list) => list.length > 0)
    assert.equal(events[0]?.m, 'event.task')
    assert.equal(events[0]?.seq, 1)
    assert.deepEqual(client.drainEvents(), []) // drain 后清空
    client.close()
  } finally {
    await kernel.close()
  }
})
