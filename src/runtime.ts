/**
 * 运行时聚合：统一持有「侧车监督器 + 协议客户端」，向服务与工具提供统一入口。
 *
 * - `mode=sidecar`：拉起平台子包侧车 → 解析端点 → 握手 → 订阅事件；
 * - `mode=external`：直接连接配置指定的既有侧车。
 */
import { AgentHeartClient, type AhEvent } from './client.js'
import type { Config } from './config.js'
import { SidecarSupervisor, type SidecarEndpoint } from './supervisor.js'

/** AgentHeart 运行时。 */
export class AgentHeartRuntime {
  private supervisor: SidecarSupervisor | null = null
  private client: AgentHeartClient | null = null
  private endpoint: SidecarEndpoint | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly config: Config) {}

  /** 协议客户端（未连接时抛错）。 */
  get api(): AgentHeartClient {
    if (!this.client) throw new Error('agentheart: 运行时尚未连接')
    return this.client
  }

  /** 当前端点。 */
  get target(): SidecarEndpoint | null {
    return this.endpoint
  }

  /** 建立运行时。 */
  async start(): Promise<void> {
    const endpoint = await this.resolveEndpoint()
    this.endpoint = endpoint
    this.client = await AgentHeartClient.connect(endpoint.address, endpoint.token)
    if (this.config.eventTopics.length > 0) {
      await this.client.subscribe(this.config.eventTopics, 0)
    }
    this.startHealthProbe()
  }

  private async resolveEndpoint(): Promise<SidecarEndpoint> {
    if (this.config.mode === 'external') {
      if (!this.config.address) {
        throw new Error('agentheart: mode=external 需在 config.address 提供侧车地址')
      }
      return { address: this.config.address, token: this.config.token ?? '' }
    }
    this.supervisor = new SidecarSupervisor({ binaryPath: this.config.binaryPath })
    return this.supervisor.start()
  }

  private startHealthProbe(): void {
    if (this.config.healthIntervalMs <= 0) return
    this.healthTimer = setInterval(() => {
      void this.client?.health().catch(() => undefined)
    }, this.config.healthIntervalMs)
    this.healthTimer.unref?.()
  }

  /** 取走自上次调用以来收到的事件（非阻塞）。 */
  drainEvents(): AhEvent[] {
    return this.client ? this.client.drainEvents() : []
  }

  /** 停止运行时：断连并（sidecar 模式下）停止侧车。 */
  async stop(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
    this.client?.close()
    this.client = null
    await this.supervisor?.stop(this.config.shutdownTimeoutMs)
    this.supervisor = null
    this.endpoint = null
  }
}
