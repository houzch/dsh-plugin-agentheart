/**
 * DSH 工具注册：把 AgentHeart 能力暴露为模型可调用的工具。
 *
 * 形态对齐官方：`inject: ['tools']` + `ctx.tools.register(defineTool({...}))`。
 * 工具**失败隔离**：异常以可读文本返回，不抛栈、不影响宿主会话。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

import type { AgentHeartRuntime } from './runtime.js'
import {
  jobParams,
  jsonText,
  loopParams,
  observeParams,
  queueParams,
  ruleParams,
  taskControlParams,
  taskListParams,
  taskSubmitParams,
  textOutput,
} from './schema.js'

type ToolArgs = Record<string, unknown>
type ToolExecute = (args: ToolArgs) => Promise<string>

/** 注册全部 AgentHeart 工具。 */
export function registerTools(ctx: Context, runtime: AgentHeartRuntime): void {
  for (const tool of buildTools(runtime)) ctx.tools.register(tool)
}

/** 把一次执行包裹为「失败返回可读文本」的形式。 */
function guard(fn: ToolExecute): ToolExecute {
  return async (args) => {
    try {
      return await fn(args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return jsonText({ ok: false, error: message })
    }
  }
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseJson(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return undefined
  }
}

function buildTools(runtime: AgentHeartRuntime): ReturnType<typeof defineTool>[] {
  return [
    defineTool({
      name: 'agentheart_task_submit',
      description: '向 AgentHeart 提交一个任务到指定队列，返回 taskId。',
      parameters: taskSubmitParams,
      output: textOutput,
      execute: guard(async (args) => {
        const queue = str(args.queue)
        if (!queue) return jsonText({ ok: false, error: '缺少 queue' })
        return jsonText(await runtime.api.submitTask(queue, str(args.name)))
      }),
    }),

    defineTool({
      name: 'agentheart_task_list',
      description: '按状态/队列分页查询 AgentHeart 任务。',
      parameters: taskListParams,
      output: textOutput,
      execute: guard(async (args) => {
        const page: Record<string, unknown> = { limit: num(args.limit) ?? 50 }
        const cursor = str(args.cursor)
        if (cursor) page.cursor = cursor
        const filter: Record<string, unknown> = {}
        const state = str(args.state)
        if (state) filter.state = [state]
        const queue = str(args.queue)
        if (queue) filter.queue = queue
        const request: Record<string, unknown> = { m: 'task.list', page }
        if (Object.keys(filter).length > 0) request.filter = filter
        return jsonText(await runtime.api.must(request))
      }),
    }),

    defineTool({
      name: 'agentheart_task_control',
      description: '控制任务：暂停 / 恢复 / 重试 / 取消（幂等）。',
      parameters: taskControlParams,
      output: textOutput,
      execute: guard(async (args) => {
        const taskId = str(args.taskId)
        const action = str(args.action)
        if (!taskId || !action) return jsonText({ ok: false, error: '缺少 taskId/action' })
        if (!['pause', 'resume', 'retry', 'cancel'].includes(action)) {
          return jsonText({ ok: false, error: `不支持的 action: ${action}` })
        }
        const result = await runtime.api.controlTask(
          action as 'pause' | 'resume' | 'retry' | 'cancel',
          taskId,
          { resetAttempts: bool(args.resetAttempts), force: bool(args.force) },
        )
        return jsonText(result)
      }),
    }),

    defineTool({
      name: 'agentheart_job',
      description:
        '创建与管理 AgentHeart 定时任务（创建 / 列表 / 详情 / 启用 / 停用 / 触发 / 删除）。',
      parameters: jobParams,
      output: textOutput,
      execute: guard(async (args) => {
        const action = str(args.action)
        const jobId = str(args.jobId)
        switch (action) {
          case 'create': {
            const queue = str(args.queue)
            if (!queue) return jsonText({ ok: false, error: '缺少 queue' })
            const cron = str(args.cron)
            const intervalMs = num(args.intervalMs)
            if ((cron === undefined) === (intervalMs === undefined)) {
              return jsonText({ ok: false, error: 'cron 与 intervalMs 必须二选一' })
            }
            const spec: Record<string, unknown> = { queue }
            if (cron !== undefined) spec.cron = cron
            if (intervalMs !== undefined) spec.intervalMs = intervalMs
            const name = str(args.name)
            if (name) spec.name = name
            const misfirePolicy = str(args.misfirePolicy)
            if (misfirePolicy) spec.misfirePolicy = misfirePolicy
            const maxAttempts = num(args.maxAttempts)
            if (maxAttempts !== undefined) spec.maxAttempts = maxAttempts
            const maxConsecutiveFailures = num(args.maxConsecutiveFailures)
            if (maxConsecutiveFailures !== undefined) {
              spec.maxConsecutiveFailures = maxConsecutiveFailures
            }
            if (typeof args.enabled === 'boolean') spec.enabled = args.enabled
            const idempotencyKey = str(args.idempotencyKey)
            if (idempotencyKey) spec.idempotencyKey = idempotencyKey
            return jsonText(await runtime.api.createJob(spec))
          }
          case 'list':
            return jsonText(
              await runtime.api.listJobs({ limit: num(args.limit) ?? 50, cursor: str(args.cursor) }),
            )
          case 'get':
            if (!jobId) return jsonText({ ok: false, error: '缺少 jobId' })
            return jsonText(await runtime.api.must({ m: 'job.get', jobId }))
          case 'enable':
          case 'disable':
            if (!jobId) return jsonText({ ok: false, error: '缺少 jobId' })
            return jsonText(await runtime.api.controlJob(action, jobId))
          case 'trigger':
            if (!jobId) return jsonText({ ok: false, error: '缺少 jobId' })
            return jsonText(await runtime.api.triggerJob(jobId, false))
          case 'delete':
            if (!jobId) return jsonText({ ok: false, error: '缺少 jobId' })
            return jsonText(await runtime.api.deleteJob(jobId))
          default:
            return jsonText({ ok: false, error: `不支持的 action: ${action ?? '空'}` })
        }
      }),
    }),

    defineTool({
      name: 'agentheart_queue',
      description: '声明 / 发布 / 观测 / 消费 AgentHeart 消息队列。',
      parameters: queueParams,
      output: textOutput,
      execute: guard(async (args) => {
        const action = str(args.action)
        const queue = str(args.queue)
        switch (action) {
          case 'list':
            return jsonText(await runtime.api.listQueues())
          case 'stats':
            return jsonText(await runtime.api.queueStats(queue))
          case 'declare':
            if (!queue) return jsonText({ ok: false, error: '缺少 queue' })
            return jsonText(await runtime.api.declareQueue(queue, num(args.capacity)))
          case 'publish': {
            const body = str(args.body)
            if (!queue || body === undefined) return jsonText({ ok: false, error: '缺少 queue/body' })
            const mode = str(args.mode)
            return jsonText(
              await runtime.api.publish(queue, body, mode === 'block' ? 'block' : mode === 'try' ? 'try' : undefined),
            )
          }
          case 'lease':
            if (!queue) return jsonText({ ok: false, error: '缺少 queue' })
            return jsonText(await runtime.api.lease(queue, num(args.waitMs) ?? 0))
          case 'ack': {
            const msgId = str(args.msgId)
            if (!msgId) return jsonText({ ok: false, error: '缺少 msgId' })
            return jsonText(await runtime.api.ack(msgId))
          }
          case 'nack': {
            const msgId = str(args.msgId)
            if (!msgId) return jsonText({ ok: false, error: '缺少 msgId' })
            return jsonText(await runtime.api.nack(msgId, true))
          }
          default:
            return jsonText({ ok: false, error: `不支持的 action: ${action ?? '空'}` })
        }
      }),
    }),

    defineTool({
      name: 'agentheart_loop',
      description: '创建与管理 AgentHeart 循环任务（Loop）。',
      parameters: loopParams,
      output: textOutput,
      execute: guard(async (args) => {
        const action = str(args.action)
        const loopId = str(args.loopId)
        switch (action) {
          case 'list':
            return jsonText(await runtime.api.listLoops())
          case 'create': {
            const maxIterations = num(args.maxIterations)
            if (!maxIterations) return jsonText({ ok: false, error: '缺少 maxIterations' })
            const spec: Record<string, unknown> = { maxIterations }
            const name = str(args.name)
            if (name) spec.name = name
            const intervalMs = num(args.intervalMs)
            if (intervalMs !== undefined) spec.intervalMs = intervalMs
            const onError = str(args.onError)
            if (onError) spec.onError = onError
            const deadlineMs = num(args.deadlineMs)
            if (deadlineMs !== undefined) spec.deadlineMs = deadlineMs
            return jsonText(await runtime.api.createLoop(spec))
          }
          case 'get':
            if (!loopId) return jsonText({ ok: false, error: '缺少 loopId' })
            return jsonText(await runtime.api.getLoop(loopId))
          case 'pause':
          case 'resume':
          case 'stop':
          case 'trigger':
            if (!loopId) return jsonText({ ok: false, error: '缺少 loopId' })
            return jsonText(await runtime.api.controlLoop(action, loopId))
          default:
            return jsonText({ ok: false, error: `不支持的 action: ${action ?? '空'}` })
        }
      }),
    }),

    defineTool({
      name: 'agentheart_rule',
      description: '创建与管理 AgentHeart 自动化规则（事件 → 动作）。',
      parameters: ruleParams,
      output: textOutput,
      execute: guard(async (args) => {
        const action = str(args.action)
        const ruleId = str(args.ruleId)
        switch (action) {
          case 'list':
            return jsonText(await runtime.api.listRules())
          case 'create': {
            const on = str(args.on)
            const ruleAction = parseJson(args.ruleAction)
            if (!on || !ruleAction) return jsonText({ ok: false, error: '缺少 on/ruleAction' })
            const spec: Record<string, unknown> = { on, action: ruleAction }
            const filter = parseJson(args.filter)
            if (filter) spec.filter = filter
            const maxFires = num(args.maxFires)
            if (maxFires !== undefined) spec.maxFires = maxFires
            return jsonText(await runtime.api.createRule(spec))
          }
          case 'get':
            if (!ruleId) return jsonText({ ok: false, error: '缺少 ruleId' })
            return jsonText(await runtime.api.getRule(ruleId))
          case 'enable':
          case 'disable':
            if (!ruleId) return jsonText({ ok: false, error: '缺少 ruleId' })
            return jsonText(await runtime.api.controlRule(action, ruleId))
          case 'delete':
            if (!ruleId) return jsonText({ ok: false, error: '缺少 ruleId' })
            return jsonText(await runtime.api.deleteRule(ruleId))
          default:
            return jsonText({ ok: false, error: `不支持的 action: ${action ?? '空'}` })
        }
      }),
    }),

    defineTool({
      name: 'agentheart_observe',
      description: '观测 AgentHeart：健康 / 心跳 / 指标 / 任务链路。',
      parameters: observeParams,
      output: textOutput,
      execute: guard(async (args) => {
        const kind = str(args.kind)
        switch (kind) {
          case 'health':
            return jsonText(await runtime.api.health())
          case 'heartbeat':
            return jsonText(await runtime.api.heartbeat())
          case 'metrics': {
            const names = str(args.names)
            return jsonText(await runtime.api.metrics(names ? names.split(',').map((n) => n.trim()) : undefined))
          }
          case 'trace': {
            const taskId = str(args.taskId)
            if (!taskId) return jsonText({ ok: false, error: '缺少 taskId' })
            return jsonText(await runtime.api.trace(taskId))
          }
          default:
            return jsonText({ ok: false, error: `不支持的 kind: ${kind ?? '空'}` })
        }
      }),
    }),
  ]
}
