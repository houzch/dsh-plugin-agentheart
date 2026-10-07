/**
 * 侧车监督：启动 / 探活 / 停止 AgentHeart 侧车进程。
 *
 * `agentheartd` 启动横幅（见 `agentheart-core/src/bin/agentheartd.rs`）：
 *   agentheartd ready addr=<addr> token=<token>
 *   agentheartd mqtt=<addr> （topic 即队列名）
 *   agentheartd 协议：16 字节帧头 + JSON 载荷
 *
 * 本模块仅负责进程生命周期与端点解析；连接握手由 `client.ts` 完成。
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import { resolveSidecarBinary } from './binary.js'

/** 侧车端点（就绪横幅解析结果）。 */
export interface SidecarEndpoint {
  address: string
  token: string
  mqtt?: string
  pid?: number
}

const READY_RE = /agentheartd ready addr=(\S+)\s+token=(\S+)/
const MQTT_RE = /agentheartd mqtt=(\S+)/

/** 监督器选项。 */
export interface SidecarSupervisorOptions {
  /** 侧车二进制路径；留空则自动解析平台子包。 */
  binaryPath?: string
  /** 启动就绪超时（毫秒，默认 10000）。 */
  startupTimeoutMs?: number
  /** 追加环境变量。 */
  env?: Record<string, string>
  /** 进程退出回调（非主动停止时）。 */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

/** AgentHeart 侧车进程监督器。 */
export class SidecarSupervisor {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private endpoint: SidecarEndpoint | null = null
  private stopping = false
  private stderrTail = ''

  constructor(private readonly options: SidecarSupervisorOptions = {}) {}

  /** 当前端点。 */
  get current(): SidecarEndpoint | null {
    return this.endpoint
  }

  /** 侧车是否在运行。 */
  get running(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  /** 侧车最近的标准错误输出（用于诊断）。 */
  get lastStderr(): string {
    return this.stderrTail
  }

  /** 启动侧车并等待其打印 `ready` 横幅。 */
  start(): Promise<SidecarEndpoint> {
    if (this.running && this.endpoint) return Promise.resolve(this.endpoint)

    const binary = resolveSidecarBinary(this.options.binaryPath ?? '')
    const child = spawn(binary, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...this.options.env },
      windowsHide: true,
    })
    this.child = child
    this.stopping = false
    this.stderrTail = ''

    const startupTimeoutMs = this.options.startupTimeoutMs ?? 10_000

    return new Promise<SidecarEndpoint>((resolve, reject) => {
      let buffer = ''
      let mqtt: string | undefined

      const cleanup = (): void => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.stderr.off('data', onStderr)
        child.off('error', onError)
        child.off('exit', onExit)
      }

      const timer = setTimeout(() => {
        cleanup()
        void this.stop()
        reject(new Error(`agentheart: 侧车在 ${startupTimeoutMs}ms 内未就绪`))
      }, startupTimeoutMs)

      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8')
        const mqttMatch = MQTT_RE.exec(buffer)
        if (mqttMatch) mqtt = mqttMatch[1]
        const ready = READY_RE.exec(buffer)
        if (!ready) return
        const endpoint: SidecarEndpoint = {
          address: ready[1],
          token: ready[2],
          mqtt,
          pid: child.pid,
        }
        this.endpoint = endpoint
        cleanup()
        resolve(endpoint)
      }

      const onStderr = (chunk: Buffer): void => {
        this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2048)
      }

      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }

      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup()
        this.child = null
        this.endpoint = null
        if (!this.stopping) {
          reject(
            new Error(
              `agentheart: 侧车提前退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`,
            ),
          )
        }
        this.options.onExit?.(code, signal)
      }

      child.stdout.on('data', onData)
      child.stderr.on('data', onStderr)
      child.once('error', onError)
      child.once('exit', onExit)
    })
  }

  /** 优雅停止侧车（先 `SIGTERM`，超时后强杀）。 */
  async stop(timeoutMs = 3000): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill()
    })
    this.child = null
    this.endpoint = null
  }
}
