/**
 * 工具参数与输出 schema（供 `defineTool` 推导 `args` 与规范值）。
 *
 * 对齐 `@deepseek-ai/dsh-tools@0.2.0-rc.2`：`parameters` 为 `ParameterSchemaSpec`，
 * `output.schema` 为 `ValueSchemaSpec`，`render` 返回 `ContentBlock[]`（此处为 `TextBlock`）。
 */

/** `agentheart_task_submit` 参数。 */
export const taskSubmitParams = {
  queue: { type: 'string', required: true, description: '任务队列名' },
  name: { type: 'string', description: '业务名（可选）' },
} as const

/** `agentheart_task_list` 参数。 */
export const taskListParams = {
  state: { type: 'string', description: '状态过滤：pending/running/succeeded/failed/dead 等' },
  queue: { type: 'string', description: '队列过滤' },
  limit: { type: 'number', description: '每页条数（默认 50，上限 500）' },
  cursor: { type: 'string', description: '游标（上次响应的 nextCursor）' },
} as const

/** `agentheart_task_control` 参数。 */
export const taskControlParams = {
  taskId: { type: 'string', required: true, description: '任务 ID' },
  action: { type: 'string', required: true, description: 'pause | resume | retry | cancel' },
  resetAttempts: { type: 'boolean', description: 'retry 时是否清零已尝试次数' },
  force: { type: 'boolean', description: 'cancel 时是否强制' },
} as const

/** `agentheart_job` 参数。 */
export const jobParams = {
  action: {
    type: 'string',
    required: true,
    description: 'create | list | get | enable | disable | trigger | delete',
  },
  jobId: {
    type: 'string',
    description: '定时任务 ID（get/enable/disable/trigger/delete 必填）',
  },
  queue: { type: 'string', description: '目标队列（create 必填）' },
  name: { type: 'string', description: '业务名（create 可选，缺省取 jobId）' },
  cron: { type: 'string', description: 'Cron 表达式（create，与 intervalMs 二选一）' },
  intervalMs: {
    type: 'number',
    description: '固定间隔毫秒（create，与 cron 二选一，1..=86400000）',
  },
  misfirePolicy: {
    type: 'string',
    description: '错过补偿：skip | fire_once | catch_up（create 可选，默认 fire_once）',
  },
  maxAttempts: { type: 'number', description: '每次触发生成任务的最大尝试次数（create 可选，默认 3）' },
  maxConsecutiveFailures: {
    type: 'number',
    description: '连续失败告警阈值（create 可选，默认 3）',
  },
  enabled: { type: 'boolean', description: '是否启用（create 可选，默认 true）' },
  idempotencyKey: { type: 'string', description: '幂等键（create 可选，相同键返回既有 jobId）' },
  limit: { type: 'number', description: '每页条数（list 用，默认 50）' },
  cursor: { type: 'string', description: '游标（list 用）' },
} as const

/** `agentheart_queue` 参数。 */
export const queueParams = {
  action: {
    type: 'string',
    required: true,
    description: 'declare | publish | stats | list | lease | ack | nack',
  },
  queue: { type: 'string', description: '队列名（declare/publish/stats/lease 必填）' },
  body: { type: 'string', description: '消息体（publish 必填）' },
  capacity: { type: 'number', description: '队列容量（declare 可选，1..=1000000）' },
  msgId: { type: 'string', description: '消息 ID（ack/nack 必填）' },
  mode: { type: 'string', description: 'publish 模式：try（默认）| block' },
  waitMs: { type: 'number', description: 'lease 等待毫秒（默认 0，上限 30000）' },
} as const

/** `agentheart_loop` 参数。 */
export const loopParams = {
  action: {
    type: 'string',
    required: true,
    description: 'create | list | get | pause | resume | stop | trigger',
  },
  loopId: { type: 'string', description: '循环 ID（除 create/list 外必填）' },
  name: { type: 'string', description: '循环名（create 可选）' },
  maxIterations: { type: 'number', description: '迭代上限（create 必填，1..=1000000）' },
  intervalMs: { type: 'number', description: '迭代间隔毫秒（create 可选，0..=86400000）' },
  onError: { type: 'string', description: '失败策略：continue | stop | dead' },
  deadlineMs: { type: 'number', description: '墙钟截止毫秒（create 可选）' },
} as const

/** `agentheart_rule` 参数。 */
export const ruleParams = {
  action: {
    type: 'string',
    required: true,
    description: 'create | list | get | enable | disable | delete',
  },
  ruleId: { type: 'string', description: '规则 ID（除 create/list 外必填）' },
  on: { type: 'string', description: '事件类型：task | delivery | error | heartbeat | loop | *' },
  ruleAction: {
    type: 'string',
    description: '动作 JSON，如 {"type":"publish","queue":"q","body":"hi"}',
  },
  filter: { type: 'string', description: '过滤条件 JSON（字段等值匹配）' },
  maxFires: { type: 'number', description: '最大触发次数（达到后自动停用）' },
} as const

/** `agentheart_observe` 参数。 */
export const observeParams = {
  kind: { type: 'string', required: true, description: 'health | heartbeat | metrics | trace' },
  taskId: { type: 'string', description: 'trace 时必填' },
  names: { type: 'string', description: 'metrics 指标名，逗号分隔（可选）' },
} as const

/** 文本输出契约：`schema` 为 string，`render` 返回 `ContentBlock[]`（`TextBlock`）。 */
export const textOutput = {
  schema: { type: 'string' } as const,
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** 把任意值序列化为可读 JSON 文本。 */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
