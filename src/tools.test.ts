/**
 * 工具层测试：`agentheart_job` 的 create/delete 动作、参数前置校验、
 * 以及「失败隔离」（异常转可读文本、不抛栈）。
 *
 * 用假 `runtime.api`（Proxy 记录调用）与假 `ctx.tools.register`（收集工具），
 * 从而在不启动侧车的前提下覆盖工具处理器逻辑。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { AgentHeartRuntime } from './runtime.js'
import { registerTools } from './tools.js'

interface ApiCall {
  method: string
  argv: unknown[]
}

/** 注册全部工具，返回「名字 → 工具」映射；api 调用被记录并按 `respond` 应答。 */
function setup(respond: (call: ApiCall) => unknown) {
  const calls: ApiCall[] = []
  const tools = new Map<string, ToolDefinition>()
  const api = new Proxy(
    {},
    {
      get(_target, property: string) {
        if (property === 'then') return undefined
        return (...argv: unknown[]) => {
          const call: ApiCall = { method: property, argv }
          calls.push(call)
          return Promise.resolve().then(() => respond(call))
        }
      },
    },
  )
  const runtime = { api } as unknown as AgentHeartRuntime
  const ctx = {
    tools: {
      register: (tool: unknown) => {
        const definition = tool as ToolDefinition
        tools.set(definition.name, definition)
      },
    },
  } as unknown as Context
  registerTools(ctx, runtime)
  return { tools, calls }
}

/** 调用一个工具的处理器，返回其文本结果。 */
async function run(tool: ToolDefinition, args: Record<string, unknown>): Promise<string> {
  const execute = tool.execute as (args: unknown) => Promise<unknown>
  return (await execute(args)) as string
}

function jobTool(tools: Map<string, ToolDefinition>): ToolDefinition {
  const tool = tools.get('agentheart_job')
  assert.ok(tool, '应注册 agentheart_job')
  return tool
}

test('注册 8 个 agentheart_* 工具', () => {
  const { tools } = setup(() => ({}))
  assert.deepEqual([...tools.keys()].sort(), [
    'agentheart_job',
    'agentheart_loop',
    'agentheart_observe',
    'agentheart_queue',
    'agentheart_rule',
    'agentheart_task_control',
    'agentheart_task_list',
    'agentheart_task_submit',
  ])
})

test('job create：仅透传显式提供的字段，构造 job.create 规格', async () => {
  const { tools, calls } = setup(() => ({ jobId: 'job-1', state: 'enabled' }))
  const result = await run(jobTool(tools), {
    action: 'create',
    queue: 'default',
    intervalMs: 1000,
    name: 'probe',
    idempotencyKey: 'k-1',
  })
  assert.deepEqual(JSON.parse(result), { jobId: 'job-1', state: 'enabled' })
  assert.deepEqual(calls, [
    {
      method: 'createJob',
      argv: [
        {
          queue: 'default',
          intervalMs: 1000,
          name: 'probe',
          idempotencyKey: 'k-1',
        },
      ],
    },
  ])
})

test('job create：cron 与 intervalMs 二选一、queue 必填（校验失败不发请求）', async () => {
  const { tools, calls } = setup(() => ({ jobId: 'job-1', state: 'enabled' }))
  const tool = jobTool(tools)

  assert.deepEqual(JSON.parse(await run(tool, { action: 'create', cron: '* * * * * *' })), {
    ok: false,
    error: '缺少 queue',
  })
  assert.deepEqual(JSON.parse(await run(tool, { action: 'create', queue: 'q' })), {
    ok: false,
    error: 'cron 与 intervalMs 必须二选一',
  })
  assert.deepEqual(
    JSON.parse(await run(tool, { action: 'create', queue: 'q', cron: '* * * * * *', intervalMs: 1000 })),
    { ok: false, error: 'cron 与 intervalMs 必须二选一' },
  )
  assert.equal(calls.length, 0, '前置校验失败不应触达协议层')
})

test('job delete：需要 jobId 并调用 deleteJob', async () => {
  const { tools, calls } = setup(() => ({ jobId: 'job-9', deleted: true }))
  const tool = jobTool(tools)

  assert.deepEqual(JSON.parse(await run(tool, { action: 'delete', jobId: 'job-9' })), {
    jobId: 'job-9',
    deleted: true,
  })
  assert.deepEqual(calls, [{ method: 'deleteJob', argv: ['job-9'] }])

  assert.deepEqual(JSON.parse(await run(tool, { action: 'delete' })), {
    ok: false,
    error: '缺少 jobId',
  })
  assert.equal(calls.length, 1)
})

test('job list：默认 limit=50', async () => {
  const { tools, calls } = setup(() => ({ items: [], nextCursor: null }))
  await run(jobTool(tools), { action: 'list' })
  assert.deepEqual(calls, [{ method: 'listJobs', argv: [{ limit: 50, cursor: undefined }] }])
})

test('不支持的 action 返回可读错误', async () => {
  const { tools } = setup(() => ({}))
  assert.deepEqual(JSON.parse(await run(jobTool(tools), { action: 'nope' })), {
    ok: false,
    error: '不支持的 action: nope',
  })
})

test('失败隔离：协议层异常转为可读文本，不抛栈', async () => {
  const { tools } = setup(() => {
    throw new Error('agentheart: 内核连接已关闭')
  })
  const observe = tools.get('agentheart_observe')
  assert.ok(observe)
  const parsed = JSON.parse(await run(observe, { kind: 'health' })) as {
    ok: boolean
    error: string
  }
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /内核连接已关闭/)
})

test('observability：trace 缺少 taskId 时前置拦截', async () => {
  const { tools, calls } = setup(() => ({}))
  const observe = tools.get('agentheart_observe')
  assert.ok(observe)
  assert.deepEqual(JSON.parse(await run(observe, { kind: 'trace' })), {
    ok: false,
    error: '缺少 taskId',
  })
  assert.equal(calls.length, 0)
})
