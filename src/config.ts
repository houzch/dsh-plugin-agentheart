/**
 * 插件配置：对齐 DSH「无可硬编码可调参数」约定——凡可调量均走 Config。
 *
 * 注：Schemastery 的确切 API（union / array / optional 语义）以目标 DSH 版本为准，
 * 见实施方案 §2.5 Q1/Q2；此处按官方示例（`Schema.object` / `Schema.string` /
 * `Schema.number` / `Schema.union([...])`）编写。
 */
import Schema from '@deepseek-ai/schemastery'

/** 承载模式：自拉侧车 / 连接既有侧车。 */
export type SidecarMode = 'sidecar' | 'external'

/** 内核参数（透传给 agentheartd 的默认配置；0 / 缺省表示内核默认）。 */
export interface KernelOptions {
  /** 执行线程数；0 表示内核默认。 */
  workers: number
  /** 心跳间隔（毫秒）。 */
  heartbeatMs: number
}

/** 插件配置。 */
export interface Config {
  /** 承载模式（默认 sidecar）。 */
  mode: SidecarMode
  /** mode=external 时的侧车地址，如 `127.0.0.1:17890`。 */
  address?: string
  /** mode=external 时的本地令牌。 */
  token?: string
  /** 侧车二进制路径；留空表示自动解析平台子包。 */
  binaryPath: string
  /** 健康探活间隔（毫秒）。 */
  healthIntervalMs: number
  /** 停止侧车时的优雅超时（毫秒）。 */
  shutdownTimeoutMs: number
  /** 订阅的事件主题（内核 `stream.subscribe` 的 topics）。 */
  eventTopics: string[]
  /** 内核参数。 */
  kernel: KernelOptions
}

/** 默认订阅的主题。 */
export const DEFAULT_EVENT_TOPICS = ['task', 'delivery', 'error', 'loop', 'rule']

/** 默认内核参数。 */
export const DEFAULT_KERNEL: KernelOptions = { workers: 0, heartbeatMs: 1000 }

/** Schemastery 配置 schema（Cordis 加载时校验并填充默认值）。 */
export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['sidecar', 'external']).default('sidecar'),
  address: Schema.string(),
  token: Schema.string(),
  binaryPath: Schema.string().default(''),
  healthIntervalMs: Schema.number().default(5000),
  shutdownTimeoutMs: Schema.number().default(3000),
  eventTopics: Schema.array(Schema.string()).default(DEFAULT_EVENT_TOPICS),
  kernel: Schema.object({
    workers: Schema.number().default(DEFAULT_KERNEL.workers),
    heartbeatMs: Schema.number().default(DEFAULT_KERNEL.heartbeatMs),
  }).default(DEFAULT_KERNEL),
})
