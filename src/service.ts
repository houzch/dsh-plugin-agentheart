/**
 * Cordis 服务：在 `ctx` 上暴露 `ctx.agentheart`，供其它插件 `inject: ['agentheart']` 消费。
 *
 * 注：服务的注册方式与生命周期由 Cordis 管理；本骨架在插件入口创建实例并
 * `attach(runtime)`，具体注册细节需按目标 DSH 版本核对（实施方案 §2.5 Q3）。
 * 对外只暴露稳定的方法面，避免泄露传输细节。
 */
import { Service, type Context } from '@deepseek-ai/cordis'

import type { AgentHeartClient } from './client.js'
import type { AgentHeartRuntime } from './runtime.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentheart: AgentHeartService
  }
}

/** AgentHeart 服务（`ctx.agentheart`）。 */
export class AgentHeartService extends Service {
  private runtime: AgentHeartRuntime | null = null

  constructor(ctx: Context) {
    super(ctx, 'agentheart')
  }

  /** 绑定运行时（由插件入口在连接就绪后调用）。 */
  attach(runtime: AgentHeartRuntime): void {
    this.runtime = runtime
  }

  /** 底层协议客户端（高级用法）。 */
  get client(): AgentHeartClient {
    if (!this.runtime) throw new Error('agentheart: 服务尚未就绪')
    return this.runtime.api
  }

  /** 任务 API。 */
  get tasks() {
    return {
      submit: (queue: string, name?: string) => this.client.submitTask(queue, name),
      list: (page?: Record<string, unknown>) => this.client.listTasks(page),
      get: (taskId: string) => this.client.getTask(taskId),
      control: (
        action: 'pause' | 'resume' | 'retry' | 'cancel',
        taskId: string,
        options?: { force?: boolean; resetAttempts?: boolean },
      ) => this.client.controlTask(action, taskId, options),
    }
  }

  /** 定时任务 API。 */
  get jobs() {
    return {
      create: (spec: Record<string, unknown>) => this.client.createJob(spec),
      list: (page?: Record<string, unknown>) => this.client.listJobs(page),
      enable: (jobId: string) => this.client.controlJob('enable', jobId),
      disable: (jobId: string) => this.client.controlJob('disable', jobId),
      trigger: (jobId: string, now = false) => this.client.triggerJob(jobId, now),
      remove: (jobId: string) => this.client.deleteJob(jobId),
    }
  }

  /** 消息队列 API。 */
  get queue() {
    return {
      list: () => this.client.listQueues(),
      stats: (queue?: string) => this.client.queueStats(queue),
      declare: (queue: string, capacity?: number) => this.client.declareQueue(queue, capacity),
      publish: (queue: string, body: string, mode?: 'try' | 'block') =>
        this.client.publish(queue, body, mode),
      lease: (queue: string, waitMs?: number) => this.client.lease(queue, waitMs),
      ack: (msgId: string) => this.client.ack(msgId),
      nack: (msgId: string, requeue = true) => this.client.nack(msgId, requeue),
    }
  }

  /** 循环任务 API。 */
  get loops() {
    return {
      list: (page?: Record<string, unknown>) => this.client.listLoops(page),
      get: (loopId: string) => this.client.getLoop(loopId),
      create: (spec: Record<string, unknown>) => this.client.createLoop(spec),
      pause: (loopId: string) => this.client.controlLoop('pause', loopId),
      resume: (loopId: string) => this.client.controlLoop('resume', loopId),
      stop: (loopId: string) => this.client.controlLoop('stop', loopId),
      trigger: (loopId: string) => this.client.controlLoop('trigger', loopId),
    }
  }

  /** 自动化规则 API。 */
  get rules() {
    return {
      list: (page?: Record<string, unknown>) => this.client.listRules(page),
      get: (ruleId: string) => this.client.getRule(ruleId),
      create: (spec: Record<string, unknown>) => this.client.createRule(spec),
      enable: (ruleId: string) => this.client.controlRule('enable', ruleId),
      disable: (ruleId: string) => this.client.controlRule('disable', ruleId),
      remove: (ruleId: string) => this.client.deleteRule(ruleId),
    }
  }

  /** 可观测 API。 */
  get observe() {
    return {
      health: () => this.client.health(),
      heartbeat: () => this.client.heartbeat(),
      metrics: (names?: string[]) => this.client.metrics(names),
      trace: (taskId: string) => this.client.trace(taskId),
    }
  }
}
