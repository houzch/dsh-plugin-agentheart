/**
 * Cordis 服务测试：`ctx.agentheart` 的注册与方法面转发。
 *
 * 用**真实 `Context`**（而非假对象）验证 `Service` 基类注册，再以
 * 「消费方视角」（`ctx.agentheart`）逐一断言各组方法转发到协议客户端的
 * 方法名与实参，防止转发层静默错配。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import type { AgentHeartRuntime } from './runtime.js'
import { AgentHeartService } from './service.js'

interface ApiCall {
  method: string
  argv: unknown[]
}

/** 构造服务并 attach 一个「记录型」假客户端。 */
function setup() {
  const calls: ApiCall[] = []
  const api = new Proxy(
    {},
    {
      get(_target, property: string) {
        if (property === 'then') return undefined
        return (...argv: unknown[]) => {
          calls.push({ method: property, argv })
          return Promise.resolve({ ok: true })
        }
      },
    },
  )
  const ctx = new Context()
  const service = new AgentHeartService(ctx)
  service.attach({ api } as unknown as AgentHeartRuntime)
  // 消费方视角：Cordis 返回的是派生实例（原型链指向本实例），方法面一致
  const exposed = ctx.agentheart
  return { ctx, service, exposed, calls }
}

test('经 Cordis 注册为 ctx.agentheart，且方法面可访问', () => {
  const { ctx, exposed } = setup()
  assert.ok(ctx.agentheart, 'ctx.agentheart 应已注册')
  assert.equal(typeof exposed.jobs.create, 'function')
  assert.equal(typeof exposed.tasks.submit, 'function')
  assert.equal(typeof exposed.observe.health, 'function')
})

test('未 attach 运行时：client 抛「服务尚未就绪」', () => {
  const ctx = new Context()
  const service = new AgentHeartService(ctx)
  assert.throws(() => service.client, /服务尚未就绪/)
})

test('tasks 方法面转发', async () => {
  const { exposed, calls } = setup()
  await exposed.tasks.submit('q1', 'n1')
  await exposed.tasks.list({ limit: 5 })
  await exposed.tasks.get('t-1')
  await exposed.tasks.control('retry', 't-2', { resetAttempts: true })
  assert.deepEqual(calls, [
    { method: 'submitTask', argv: ['q1', 'n1'] },
    { method: 'listTasks', argv: [{ limit: 5 }] },
    { method: 'getTask', argv: ['t-1'] },
    { method: 'controlTask', argv: ['retry', 't-2', { resetAttempts: true }] },
  ])
})

test('jobs 方法面转发（enable/disable 映射 controlJob，remove 映射 deleteJob）', async () => {
  const { exposed, calls } = setup()
  await exposed.jobs.create({ queue: 'q', intervalMs: 1000 })
  await exposed.jobs.list({ limit: 10 })
  await exposed.jobs.enable('j-1')
  await exposed.jobs.disable('j-2')
  await exposed.jobs.trigger('j-3', true)
  await exposed.jobs.remove('j-4')
  assert.deepEqual(calls, [
    { method: 'createJob', argv: [{ queue: 'q', intervalMs: 1000 }] },
    { method: 'listJobs', argv: [{ limit: 10 }] },
    { method: 'controlJob', argv: ['enable', 'j-1'] },
    { method: 'controlJob', argv: ['disable', 'j-2'] },
    { method: 'triggerJob', argv: ['j-3', true] },
    { method: 'deleteJob', argv: ['j-4'] },
  ])
})

test('queue 方法面转发（含 ack/nack）', async () => {
  const { exposed, calls } = setup()
  await exposed.queue.list()
  await exposed.queue.stats('q')
  await exposed.queue.declare('q', 100)
  await exposed.queue.publish('q', 'body', 'block')
  await exposed.queue.lease('q', 500)
  await exposed.queue.ack('m-1')
  await exposed.queue.nack('m-2', false)
  assert.deepEqual(calls, [
    { method: 'listQueues', argv: [] },
    { method: 'queueStats', argv: ['q'] },
    { method: 'declareQueue', argv: ['q', 100] },
    { method: 'publish', argv: ['q', 'body', 'block'] },
    { method: 'lease', argv: ['q', 500] },
    { method: 'ack', argv: ['m-1'] },
    { method: 'nack', argv: ['m-2', false] },
  ])
})

test('loops 方法面转发（pause/resume/stop/trigger 映射 controlLoop）', async () => {
  const { exposed, calls } = setup()
  await exposed.loops.list({ limit: 3 })
  await exposed.loops.get('l-1')
  await exposed.loops.create({ maxIterations: 5 })
  await exposed.loops.pause('l-2')
  await exposed.loops.resume('l-3')
  await exposed.loops.stop('l-4')
  await exposed.loops.trigger('l-5')
  assert.deepEqual(calls, [
    { method: 'listLoops', argv: [{ limit: 3 }] },
    { method: 'getLoop', argv: ['l-1'] },
    { method: 'createLoop', argv: [{ maxIterations: 5 }] },
    { method: 'controlLoop', argv: ['pause', 'l-2'] },
    { method: 'controlLoop', argv: ['resume', 'l-3'] },
    { method: 'controlLoop', argv: ['stop', 'l-4'] },
    { method: 'controlLoop', argv: ['trigger', 'l-5'] },
  ])
})

test('rules 方法面转发（enable/disable 映射 controlRule，remove 映射 deleteRule）', async () => {
  const { exposed, calls } = setup()
  await exposed.rules.list({ limit: 2 })
  await exposed.rules.get('r-1')
  await exposed.rules.create({ on: 'event.task', action: { kind: 'publish' } })
  await exposed.rules.enable('r-2')
  await exposed.rules.disable('r-3')
  await exposed.rules.remove('r-4')
  assert.deepEqual(calls, [
    { method: 'listRules', argv: [{ limit: 2 }] },
    { method: 'getRule', argv: ['r-1'] },
    { method: 'createRule', argv: [{ on: 'event.task', action: { kind: 'publish' } }] },
    { method: 'controlRule', argv: ['enable', 'r-2'] },
    { method: 'controlRule', argv: ['disable', 'r-3'] },
    { method: 'deleteRule', argv: ['r-4'] },
  ])
})

test('observe 方法面转发', async () => {
  const { exposed, calls } = setup()
  await exposed.observe.health()
  await exposed.observe.heartbeat()
  await exposed.observe.metrics(['a', 'b'])
  await exposed.observe.trace('t-9')
  assert.deepEqual(calls, [
    { method: 'health', argv: [] },
    { method: 'heartbeat', argv: [] },
    { method: 'metrics', argv: [['a', 'b']] },
    { method: 'trace', argv: ['t-9'] },
  ])
})
