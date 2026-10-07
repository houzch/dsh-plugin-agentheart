/**
 * 插件装配测试：直接调用插件契约 `apply(ctx, config)`。
 *
 * 在**真实 Cordis Context** 上验证「注册工具/服务 → 连接 → 端到端调用 → 卸载回收」
 * 全链路，以及「启动失败不崩宿主、降级为可读错误」的保证。
 *
 * 说明：不做日志内容断言——`ctx.logger` 属宿主输出面，此处只验证**行为保证**。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { sidecarPackageName } from './binary.js'
import type { Config as AgentHeartConfig } from './config.js'
import { apply, inject, name } from './index.js'
import { startFakeKernel } from './test-helpers.js'

const require = createRequire(import.meta.url)
const VER = 1

/** 平台子包是否已安装（尚未发布时为 false）。 */
const subpackageInstalled = (() => {
  try {
    require.resolve(`${sidecarPackageName()}/package.json`)
    return true
  } catch {
    return false
  }
})()

/** 构造真实 Context，并注入可收集工具注册的假 `tools` 服务。 */
function makeContext() {
  const tools = new Map<string, ToolDefinition>()
  const ctx = new Context()
  ctx.reflect.provide('tools', {
    register: (tool: unknown) => {
      const definition = tool as ToolDefinition
      tools.set(definition.name, definition)
    },
  })
  return { ctx, tools }
}

/** 完整配置（对齐 `config.ts` 的默认值）。 */
function makeConfig(overrides: Partial<AgentHeartConfig> = {}): AgentHeartConfig {
  return {
    mode: 'external',
    binaryPath: '',
    healthIntervalMs: 0, // 关闭探活，避免额外请求干扰断言
    shutdownTimeoutMs: 300,
    eventTopics: ['task', 'delivery', 'error', 'loop', 'rule'],
    kernel: { workers: 0, heartbeatMs: 1000 },
    ...overrides,
  }
}

/** 调用一个已注册工具的处理器，返回文本结果。 */
async function runTool(
  tools: Map<string, ToolDefinition>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = tools.get(toolName)
  assert.ok(tool, `应注册 ${toolName}`)
  const execute = tool.execute as (args: unknown) => Promise<unknown>
  return (await execute(args)) as string
}

test('插件契约：name=agentheart，inject 依赖 tools', () => {
  assert.equal(name, 'agentheart')
  assert.deepEqual(inject, ['tools'])
})

test('装配成功：注册 8 个工具与 ctx.agentheart，端到端连通假内核并在卸载时断连', async () => {
  const kernel = await startFakeKernel((request) => {
    switch (request.m) {
      case 'system.hello':
        return { ok: true, result: { ver: VER } }
      case 'stream.subscribe':
        return { ok: true, result: { subscribed: true } }
      case 'system.health':
        return { ok: true, result: { up: true, queues: 2 } }
      default:
        return { ok: true, result: {} }
    }
  })
  const { ctx, tools } = makeContext()
  try {
    apply(ctx, makeConfig({ address: kernel.address, token: 'tok' }))

    assert.ok(ctx.agentheart, '应注册 ctx.agentheart')
    assert.equal(tools.size, 8)

    // 握手 → 订阅（顺序与内容）
    await kernel.waitForRequest((request) => request.m === 'stream.subscribe')
    assert.deepEqual(kernel.received[0], { m: 'system.hello', ver: VER, token: 'tok' })
    assert.deepEqual(kernel.received[1], {
      m: 'stream.subscribe',
      topics: ['task', 'delivery', 'error', 'loop', 'rule'],
      fromSeq: 0,
    })

    // 端到端：ctx.agentheart → 服务 → 运行时 → 客户端 → socket → 假内核
    assert.deepEqual(await ctx.agentheart.observe.health(), { up: true, queues: 2 })

    // 工具层复用同一运行时
    assert.deepEqual(JSON.parse(await runTool(tools, 'agentheart_observe', { kind: 'health' })), {
      up: true,
      queues: 2,
    })

    // 卸载回收：ctx.effect 清理 → 断连；此后工具降级为可读错误
    await ctx.fiber.dispose()
    await kernel.waitForDisconnect()
    const afterDispose = JSON.parse(
      await runTool(tools, 'agentheart_observe', { kind: 'health' }),
    ) as { ok: boolean; error: string }
    assert.equal(afterDispose.ok, false)
    assert.match(afterDispose.error, /尚未连接/)
  } finally {
    await kernel.close()
  }
})

test('启动失败不崩宿主：external 缺 address 时降级为可读错误', async () => {
  const { ctx, tools } = makeContext()
  apply(ctx, makeConfig({ mode: 'external', address: undefined }))

  assert.ok(ctx.agentheart)
  assert.equal(tools.size, 8)

  const parsed = JSON.parse(await runTool(tools, 'agentheart_observe', { kind: 'health' })) as {
    ok: boolean
    error: string
  }
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /尚未连接/)

  await ctx.fiber.dispose()
})

test('默认 sidecar 配置失败时同样降级为可读错误', { skip: subpackageInstalled }, async () => {
  const { ctx, tools } = makeContext()
  apply(ctx, makeConfig({ mode: 'sidecar', binaryPath: '' }))

  assert.equal(tools.size, 8)
  const parsed = JSON.parse(await runTool(tools, 'agentheart_job', { action: 'list' })) as {
    ok: boolean
    error: string
  }
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /尚未连接/)

  await ctx.fiber.dispose()
})
