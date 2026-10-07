/**
 * 事件桥接测试：主题路由、`seq` 幂等去重、回调、启停幂等。
 *
 * 直接驱动私有 `pump()`（不经定时器），保证确定性、无时序抖动。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import type { AhEvent } from './client.js'
import { EventBridge } from './events.js'
import type { AgentHeartRuntime } from './runtime.js'

interface Emitted {
  name: string
  payload: AhEvent
}

/** 构造被测桥接：假运行时（可注入事件）+ 假 ctx（记录 emit）。 */
function setup() {
  let queue: AhEvent[] = []
  const emitted: Emitted[] = []
  const seen: AhEvent[] = []
  const runtime = {
    drainEvents: () => {
      const out = queue
      queue = []
      return out
    },
  } as unknown as AgentHeartRuntime
  const ctx = {
    emit: (name: string, payload: AhEvent) => {
      emitted.push({ name, payload })
    },
  } as unknown as Context
  const bridge = new EventBridge(runtime, ctx, {
    intervalMs: 3_600_000, // 测试不依赖定时器
    onEvent: (event) => seen.push(event),
  })
  const pump = () => (bridge as unknown as { pump(): void }).pump()
  return {
    bridge,
    emitted,
    seen,
    push: (...events: AhEvent[]) => queue.push(...events),
    pump,
  }
}

test('按主题路由到具名 Cordis 事件', () => {
  const { push, pump, emitted } = setup()
  push({ m: 'event.task', seq: 1 }, { m: 'event.delivery', seq: 2 }, { m: 'event.error', seq: 3 })
  pump()
  assert.deepEqual(
    emitted.map((entry) => entry.name),
    ['agentheart/task', 'agentheart/delivery', 'agentheart/error'],
  )
})

test('未知主题走兜底通道 agentheart/event', () => {
  const { push, pump, emitted } = setup()
  push({ m: 'event.something-new', seq: 1 })
  pump()
  assert.deepEqual(
    emitted.map((entry) => entry.name),
    ['agentheart/event'],
  )
})

test('按 seq 幂等去重：重复与乱序旧事件被忽略', () => {
  const { push, pump, emitted } = setup()
  push({ m: 'event.task', seq: 1 }, { m: 'event.task', seq: 3 })
  pump()
  push({ m: 'event.task', seq: 3 }, { m: 'event.task', seq: 2 }, { m: 'event.task', seq: 4 })
  pump()
  assert.deepEqual(
    emitted.map((entry) => entry.payload.seq),
    [1, 3, 4],
  )
})

test('onEvent 回调收到每个被转发事件（含兜底通道）', () => {
  const { push, pump, seen } = setup()
  push({ m: 'event.loop', seq: 1 }, { m: 'event.rule', seq: 2 }, { m: 'event.unknown', seq: 3 })
  pump()
  assert.equal(seen.length, 3)
})

test('start 幂等、stop 可重入', () => {
  const { bridge } = setup()
  bridge.start()
  bridge.start() // 幂等：不应重复起定时器
  bridge.stop()
  bridge.stop() // 可重入：不应抛错
})

test('运行时取事件抛错时，轮询静默跳过（不冒泡）', () => {
  const emitted: Emitted[] = []
  const runtime = {
    drainEvents: () => {
      throw new Error('agentheart: 未连接')
    },
  } as unknown as AgentHeartRuntime
  const ctx = {
    emit: (name: string, payload: AhEvent) => {
      emitted.push({ name, payload })
    },
  } as unknown as Context
  const bridge = new EventBridge(runtime, ctx, { intervalMs: 3_600_000 })
  assert.doesNotThrow(() => (bridge as unknown as { pump(): void }).pump())
  assert.equal(emitted.length, 0)
})
