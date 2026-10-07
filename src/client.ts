/**
 * AgentHeart 内核接口协议客户端（TypeScript 版，仅 Node 标准库）。
 *
 * 协议：16 字节小端帧头 + UTF-8 JSON 载荷（内核方案 §8.3）。
 * 特性：
 * - **单连接事件流**：事件帧入队（`drainEvents`），响应帧按 requestId 分发；
 * - **强类型便捷方法**：任务 / 定时 / 队列 / 循环 / 规则 / 可观测；
 * - **断线重连**：`reconnect()` 重建连接并重新握手（连接级状态整体替换）。
 *
 * 与 `agentheart-sdk/node/agentheart.js` 保持同一协议线格式。
 */
import net from 'node:net'

export const MAGIC = 0x41480001
export const PROTOCOL_VERSION = 1
export const HEADER_LEN = 16
const FLAG_REQUEST = 0x1
const FLAG_EVENT = 0x4
const MAX_EVENTS = 1024
const DEFAULT_TIMEOUT_MS = 5000

/** 内核统一错误对象（方案 §8.6.2）。 */
export interface AhError {
  code: number
  codeName: string
  message: string
  detail?: unknown
}

/** 统一响应信封：成功 `{ ok:true, result }`；失败 `{ ok:false, error }`。 */
export interface AhResponse<T = unknown> {
  ok: boolean
  m?: string
  result?: T
  error?: AhError
}

/** 内核单向推送事件（`event.*`）。 */
export type AhEvent = { m: string; seq?: number; ts?: number } & Record<string, unknown>

/** 任务对象（部分字段，其余按扩展字段透传）。 */
export interface TaskItem {
  id: string
  queue: string
  state: string
  [key: string]: unknown
}

/** 分页结果。 */
export interface PageResult<T> {
  items: T[]
  nextCursor: string | null
}

/** 请求失败（`ok:false`）时抛出的错误。 */
export class AhRequestError extends Error {
  readonly response: AhResponse

  constructor(response: AhResponse) {
    super(response.error?.message ?? 'agentheart: 请求失败')
    this.name = 'AhRequestError'
    this.response = response
  }
}

/** 编码一帧请求。 */
export function encodeFrame(requestId: number, payload: string | object): Buffer {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(HEADER_LEN)
  header.writeUInt32LE(MAGIC, 0)
  header.writeUInt8(PROTOCOL_VERSION, 4)
  header.writeUInt8(0, 5)
  header.writeUInt16LE(FLAG_REQUEST, 6)
  header.writeUInt32LE(requestId >>> 0, 8)
  header.writeUInt32LE(body.length, 12)
  return Buffer.concat([header, body])
}

/** 解析 `host:port`（取最后一个冒号，兼容 IPv6 之外的常见形式）。 */
export function parseAddress(addr: string): { host: string; port: number } {
  const index = addr.lastIndexOf(':')
  if (index <= 0) throw new Error(`地址非法: ${addr}`)
  const host = addr.slice(0, index)
  const port = Number(addr.slice(index + 1))
  if (!Number.isInteger(port) || port <= 0) throw new Error(`端口非法: ${addr}`)
  return { host, port }
}

interface Waiter {
  resolve: (value: AhResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 单连接的解析状态（重连时整体替换，互不干扰）。 */
class Connection {
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<number, Waiter>()
  private events: AhEvent[] = []
  private closed = false

  constructor(
    private readonly socket: net.Socket,
    private readonly onClose: (() => void) | null,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', () => this.fail())
    socket.on('close', () => this.fail())
  }

  get isClosed(): boolean {
    return this.closed
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= HEADER_LEN) {
      if (this.buffer.readUInt32LE(0) !== MAGIC) {
        this.fail()
        return
      }
      const flags = this.buffer.readUInt16LE(6)
      const requestId = this.buffer.readUInt32LE(8)
      const length = this.buffer.readUInt32LE(12)
      if (this.buffer.length < HEADER_LEN + length) return
      const body = this.buffer.subarray(HEADER_LEN, HEADER_LEN + length).toString('utf8')
      this.buffer = this.buffer.subarray(HEADER_LEN + length)

      let value: AhResponse | AhEvent
      try {
        value = JSON.parse(body) as AhResponse | AhEvent
      } catch {
        continue
      }

      if (flags & FLAG_EVENT) {
        this.events.push(value as AhEvent)
        while (this.events.length > MAX_EVENTS) this.events.shift()
      } else {
        const waiter = this.pending.get(requestId)
        if (waiter) {
          clearTimeout(waiter.timer)
          this.pending.delete(requestId)
          waiter.resolve(value as AhResponse)
        }
      }
    }
  }

  private fail(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('agentheart: 内核连接已关闭'))
    }
    this.pending.clear()
    this.onClose?.()
  }

  request(requestId: number, request: string, timeoutMs: number): Promise<AhResponse> {
    return new Promise<AhResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          reject(new Error(`agentheart: 请求超时（${requestId}）`))
        }
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      this.socket.write(encodeFrame(requestId, request), (error) =>
        error ? this.rejectOne(requestId, error) : undefined,
      )
    })
  }

  private rejectOne(requestId: number, error: Error): void {
    const waiter = this.pending.get(requestId)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.pending.delete(requestId)
    waiter.reject(error)
  }

  drain(): AhEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  destroy(): void {
    this.fail()
    this.socket.destroy()
  }
}

/**
 * AgentHeart 内核接口客户端。
 *
 * 使用 `AgentHeartClient.connect(addr, token)` 建立会话；同一连接同时支持
 * 请求-响应与事件订阅。
 */
export class AgentHeartClient {
  private connection: Connection | null = null
  private nextId = 1

  private constructor(
    private readonly address: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  /** 连接并完成握手。 */
  static async connect(
    address: string,
    token = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<AgentHeartClient> {
    const client = new AgentHeartClient(address, token, timeoutMs)
    await client.reconnect()
    return client
  }

  /** 建立底层连接并握手（亦用于断线重连）。 */
  async reconnect(): Promise<void> {
    const { host, port } = parseAddress(this.address)
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const connecting = net.connect({ host, port }, () => resolve(connecting))
      connecting.once('error', reject)
    })
    socket.setNoDelay(true)
    this.nextId = 1
    this.connection = new Connection(socket, null)

    const response = await this.call({ m: 'system.hello', ver: PROTOCOL_VERSION, token: this.token })
    if (!response.ok) throw new Error('agentheart: 握手被拒绝')
  }

  /** 发送一次请求，返回响应信封。 */
  async call<T = unknown>(request: object | string): Promise<AhResponse<T>> {
    const connection = this.connection
    if (!connection || connection.isClosed) throw new Error('agentheart: 未连接或连接已关闭')
    const requestId = this.nextId++
    const body = typeof request === 'string' ? request : JSON.stringify(request)
    return (await connection.request(requestId, body, this.timeoutMs)) as AhResponse<T>
  }

  /** 发送一次请求；`ok:false` 时抛出 `AhRequestError`。 */
  async must<T = unknown>(request: object | string): Promise<T> {
    const response = await this.call<T>(request)
    if (!response.ok) throw new AhRequestError(response as AhResponse)
    return response.result as T
  }

  /** 订阅事件流（`topics` 为空或含 `*` 表示全部）。 */
  subscribe(topics: string[], fromSeq = 0): Promise<AhResponse> {
    return this.call({ m: 'stream.subscribe', topics, fromSeq })
  }

  /** 取走自上次调用以来收到的事件（非阻塞）。 */
  drainEvents(): AhEvent[] {
    return this.connection ? this.connection.drain() : []
  }

  /** 关闭连接。 */
  close(): void {
    this.connection?.destroy()
    this.connection = null
  }

  // ---- 强类型便捷方法 ----

  health(): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: 'system.health' })
  }

  heartbeat(): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: 'heartbeat.get' })
  }

  metrics(names?: string[]): Promise<Record<string, unknown>> {
    const request: Record<string, unknown> = { m: 'metrics.get' }
    if (names && names.length > 0) request.names = names
    return this.must<Record<string, unknown>>(request)
  }

  trace(taskId: string): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: 'trace.get', taskId })
  }

  listTasks(page?: Record<string, unknown>): Promise<PageResult<TaskItem>> {
    return this.must<PageResult<TaskItem>>({ m: 'task.list', page: page ?? {} })
  }

  getTask(taskId: string): Promise<{ task: TaskItem }> {
    return this.must<{ task: TaskItem }>({ m: 'task.get', taskId })
  }

  submitTask(queue: string, name?: string): Promise<{ taskId: string }> {
    const request: Record<string, unknown> = { m: 'task.trigger', queue }
    if (name) request.name = name
    return this.must<{ taskId: string }>(request)
  }

  controlTask(
    action: 'pause' | 'resume' | 'retry' | 'cancel',
    taskId: string,
    options?: { force?: boolean; resetAttempts?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: `task.${action}`, taskId, ...options })
  }

  createJob(spec: Record<string, unknown>): Promise<{ jobId: string; state: string }> {
    return this.must<{ jobId: string; state: string }>({ m: 'job.create', ...spec })
  }

  listJobs(page?: Record<string, unknown>): Promise<PageResult<Record<string, unknown>>> {
    return this.must<PageResult<Record<string, unknown>>>({ m: 'job.list', page: page ?? {} })
  }

  controlJob(action: 'enable' | 'disable', jobId: string): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: `job.${action}`, jobId })
  }

  triggerJob(jobId: string, now = false): Promise<{ taskId: string }> {
    return this.must<{ taskId: string }>({ m: 'job.trigger', jobId, now })
  }

  deleteJob(jobId: string): Promise<{ jobId: string; deleted: boolean }> {
    return this.must<{ jobId: string; deleted: boolean }>({ m: 'job.delete', jobId })
  }

  listQueues(): Promise<{ queues: string[] }> {
    return this.must<{ queues: string[] }>({ m: 'queue.list' })
  }

  queueStats(queue?: string): Promise<Record<string, unknown>> {
    const request: Record<string, unknown> = { m: 'queue.stats' }
    if (queue) request.queue = queue
    return this.must<Record<string, unknown>>(request)
  }

  declareQueue(queue: string, capacity?: number): Promise<Record<string, unknown>> {
    const request: Record<string, unknown> = { m: 'queue.declare', queue }
    if (capacity !== undefined) request.capacity = capacity
    return this.must<Record<string, unknown>>(request)
  }

  publish(queue: string, body: string, mode?: 'try' | 'block'): Promise<{ msgId: string }> {
    const request: Record<string, unknown> = { m: 'queue.publish', queue, body }
    if (mode) request.mode = mode
    return this.must<{ msgId: string }>(request)
  }

  lease(queue: string, waitMs = 0): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: 'queue.lease', queue, waitMs })
  }

  ack(msgId: string): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: 'queue.ack', msgId })
  }

  nack(msgId: string, requeue = true): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: 'queue.nack', msgId, requeue })
  }

  listLoops(page?: Record<string, unknown>): Promise<PageResult<Record<string, unknown>>> {
    return this.must<PageResult<Record<string, unknown>>>({ m: 'loop.list', page: page ?? {} })
  }

  getLoop(loopId: string): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: 'loop.get', loopId })
  }

  createLoop(spec: Record<string, unknown>): Promise<{ loopId: string; state: string }> {
    return this.must<{ loopId: string; state: string }>({ m: 'loop.create', ...spec })
  }

  controlLoop(
    action: 'pause' | 'resume' | 'stop' | 'trigger',
    loopId: string,
  ): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: `loop.${action}`, loopId })
  }

  createRule(spec: Record<string, unknown>): Promise<{ ruleId: string; enabled: boolean }> {
    return this.must<{ ruleId: string; enabled: boolean }>({ m: 'automation.rule.create', ...spec })
  }

  listRules(page?: Record<string, unknown>): Promise<PageResult<Record<string, unknown>>> {
    return this.must<PageResult<Record<string, unknown>>>({
      m: 'automation.rule.list',
      page: page ?? {},
    })
  }

  getRule(ruleId: string): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: 'automation.rule.get', ruleId })
  }

  controlRule(
    action: 'enable' | 'disable',
    ruleId: string,
  ): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: `automation.rule.${action}`, ruleId })
  }

  deleteRule(ruleId: string): Promise<Record<string, unknown>> {
    return this.must<Record<string, unknown>>({ m: 'automation.rule.delete', ruleId })
  }
}
