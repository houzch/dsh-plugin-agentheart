/**
 * `@agentheart/dsh-plugin-agentheart` —— AgentHeart 的 DeepSeek Harness 嵌入式插件入口。
 *
 * 形态：**函数插件**（`export function apply(ctx, config)`），符合 Cordis 插件规范。
 * - 通过 `ctx` 注册的能力（工具、事件监听）在插件卸载时**自动清理**；
 * - 侧车进程与 TCP 连接等外部资源通过 `ctx.effect(() => cleanup)` 回收。
 *
 * 该模块只做「装配」，具体能力见 `service.ts` / `tools.ts` / `events.ts`。
 */
import type { Context } from '@deepseek-ai/cordis'

import { Config } from './config.js'
import type { Config as AgentHeartConfig } from './config.js'
import { EventBridge } from './events.js'
import { AgentHeartRuntime } from './runtime.js'
import { AgentHeartService } from './service.js'
import { registerTools } from './tools.js'

/** 插件名。 */
export const name = 'agentheart'

/** 依赖服务：工具注册表就绪后才加载本插件。 */
export const inject = ['tools']

/** 对外导出配置 schema（供 Cordis 校验与默认值填充）。 */
export { Config }
export { AgentHeartService, AgentHeartRuntime, EventBridge }
export type { AhEvent, AhResponse, TaskItem } from './client.js'
export type { Config as AgentHeartPluginConfig, KernelOptions, SidecarMode } from './config.js'

/**
 * 插件入口。
 *
 * 启动为**异步**：`runtime.start()` 完成后才连接事件桥；启动失败不使宿主崩溃，
 * 仅记录错误（工具/服务在未连接时会返回可读错误）。
 */
export function apply(ctx: Context, config: AgentHeartConfig): void {
  const log = ctx.logger('agentheart')
  const runtime = new AgentHeartRuntime(config)
  const service = new AgentHeartService(ctx)
  service.attach(runtime)
  const events = new EventBridge(runtime, ctx)

  registerTools(ctx, runtime)

  ctx.effect(() => {
    void runtime.start().then(
      () => {
        events.start()
        log.info('[agentheart] 侧车已连接，事件桥已启动')
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        log.error(`[agentheart] 启动失败：${message}`)
      },
    )

    // 卸载时回收：停桥 → 断连 → 停侧车
    return () => {
      events.stop()
      void runtime.stop()
    }
  })
}
