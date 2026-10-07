/**
 * 测试辅助（**仅供测试**；`tsconfig.json` 已将其排除出发布构建）。
 */
import assert from 'node:assert/strict'
import net from 'node:net'

import { HEADER_LEN, MAGIC, PROTOCOL_VERSION } from './client.js'

const FLAG_EVENT = 0x4

/** 最小假内核：解析请求帧、按 `m` 应答，并可推送事件帧。 */
export interface FakeKernel {
  address: string
  /** 已收到的请求消息体（解析后，按到达顺序）。 */
  readonly received: Record<string, unknown>[]
  /** 向已连接的客户端推送一个事件帧。 */
  pushEvent(event: Record<string, unknown>): void
  /** 等待出现满足条件的请求。 */
  waitForRequest(
    predicate: (request: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>
  /** 等待任一客户端连接断开。 */
  waitForDisconnect(timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

/** 复刻一帧（与实现解耦，用于交叉校验线格式）。 */
export function frame(requestId: number, payload: unknown, flags: number): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(HEADER_LEN)
  header.writeUInt32LE(MAGIC, 0)
  header.writeUInt8(PROTOCOL_VERSION, 4)
  header.writeUInt8(0, 5)
  header.writeUInt16LE(flags, 6)
  header.writeUInt32LE(requestId >>> 0, 8)
  header.writeUInt32LE(body.length, 12)
  return Buffer.concat([header, body])
}

/** 轮询等待（消除时序抖动，避免固定 sleep）。 */
export async function waitFor<T>(
  probe: () => T,
  ok: (value: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error('waitFor: 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 启动最小假内核；`handler` 返回 `undefined` 表示不回应该请求。 */
export async function startFakeKernel(
  handler: (request: Record<string, unknown>) => unknown | undefined,
): Promise<FakeKernel> {
  const received: Record<string, unknown>[] = []
  const sockets = new Set<net.Socket>()
  let disconnected = false

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      disconnected = true
    })
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= HEADER_LEN) {
        const requestId = buffer.readUInt32LE(8)
        const length = buffer.readUInt32LE(12)
        if (buffer.length < HEADER_LEN + length) return
        const body = buffer.subarray(HEADER_LEN, HEADER_LEN + length).toString('utf8')
        buffer = buffer.subarray(HEADER_LEN + length)
        const request = JSON.parse(body) as Record<string, unknown>
        received.push(request)
        const reply = handler(request)
        if (reply !== undefined) socket.write(frame(requestId, reply, 0))
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', '应当拿到监听端口')

  return {
    address: `127.0.0.1:${address.port}`,
    received,
    pushEvent(event) {
      for (const socket of sockets) socket.write(frame(0, event, FLAG_EVENT))
    },
    waitForRequest(predicate, timeoutMs = 2000) {
      return waitFor(
        () => received.find(predicate),
        (found) => found !== undefined,
        timeoutMs,
      ).then((found) => found as Record<string, unknown>)
    },
    async waitForDisconnect(timeoutMs = 2000) {
      await waitFor(() => disconnected, (value) => value, timeoutMs)
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
