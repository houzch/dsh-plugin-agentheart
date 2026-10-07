/**
 * 事件桥接：把内核事件流（`event.*`）回流到 DSH 的 Cordis 事件总线。
 *
 * 真实 API（`@deepseek-ai/cordis@4.0.4`）：`ctx.emit(name, ...args)` 为**同步**派发，
 * 事件名须在 Cordis 的 `Events` 接口中声明——本模块已声明 `agentheart/*` 通道。
 *
 * **Trajectory**：DSH 的 Trajectory 即 **append-only 会话日志**
 * （`@deepseek-ai/dsh-session` 的 `ctx.sessions: SessionStore` + `Session.append(type, data)`，
 * 事件类型由可合并扩展的 `SessionEventMap` 界定）。
 * 本桥接默认**不写入**会话日志：后台桥接没有「当前会话」句柄，且新增事件类型需扩展
 * `SessionEventMap`（与会话格式版本耦合）。需要落 Trajectory 的宿主可在 `onEvent`
 * 回调里通过 `ctx.sessions` 自行追加，或订阅 `session/event` 做只读观测。
 *
 * 语义：内核事件流为**至少一次**且带单调 `seq`，本桥接按 `seq` 幂等去重。
 */
import type { Context } from '@deepseek-ai/cordis'

import type { AhEvent } from './client.js'
import type { AgentHeartRuntime } from './runtime.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 兜底通道：主题不在下列具名通道时使用。 */
    'agentheart/event'(event: AhEvent): void
    /** 任务状态变更（`event.task`）。 */
    'agentheart/task'(event: AhEvent): void
    /** 消息投递结果（`event.delivery`）。 */
    'agentheart/delivery'(event: AhEvent): void
    /** 错误告警（`event.error`）。 */
    'agentheart/error'(event: AhEvent): void
    /** 循环任务事件（`event.loop`）。 */
    'agentheart/loop'(event: AhEvent): void
    /** 自动化规则事件（`event.rule`）。 */
    'agentheart/rule'(event: AhEvent): void
    /** 心跳事件（`event.heartbeat`）。 */
    'agentheart/heartbeat'(event: AhEvent): void
  }
}

/** 事件桥接选项。 */
export interface EventBridgeOptions {
  /** 轮询间隔（毫秒，默认 1000）。 */
  intervalMs?: number
  /** 事件回调（供测试、日志或自定义转发到会话日志）。 */
  onEvent?: (event: AhEvent) => void
}

/** 事件桥接器：把内核事件流按主题广播为 Cordis 事件。 */
export class EventBridge {
  private timer: ReturnType<typeof setInterval> | null = null
  private cursor = 0

  constructor(
    private readonly runtime: AgentHeartRuntime,
    private readonly ctx: Context,
    private readonly options: EventBridgeOptions = {},
  ) {}

  /** 启动轮询。 */
  start(): void {
    if (this.timer) return
    const intervalMs = this.options.intervalMs ?? 1000
    this.timer = setInterval(() => this.pump(), intervalMs)
    this.timer.unref?.()
  }

  /** 停止轮询。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private pump(): void {
    let events: AhEvent[]
    try {
      events = this.runtime.drainEvents()
    } catch {
      return
    }
    for (const event of events) {
      if (typeof event.seq === 'number') {
        if (event.seq <= this.cursor) continue // 幂等：忽略重复/乱序旧事件
        this.cursor = event.seq
      }
      this.forward(event)
    }
  }

  /** 按主题派发到 Cordis 事件（`ctx.emit` 为同步派发）。 */
  private forward(event: AhEvent): void {
    this.options.onEvent?.(event)
    const ctx = this.ctx
    switch (topicOf(event.m)) {
      case 'task':
        ctx.emit('agentheart/task', event)
        break
      case 'delivery':
        ctx.emit('agentheart/delivery', event)
        break
      case 'error':
        ctx.emit('agentheart/error', event)
        break
      case 'loop':
        ctx.emit('agentheart/loop', event)
        break
      case 'rule':
        ctx.emit('agentheart/rule', event)
        break
      case 'heartbeat':
        ctx.emit('agentheart/heartbeat', event)
        break
      default:
        ctx.emit('agentheart/event', event)
    }
  }
}

/** `event.task` -> `task`。 */
function topicOf(message: string): string {
  const prefix = 'event.'
  return message.startsWith(prefix) ? message.slice(prefix.length) : message
}
