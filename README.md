# @agentheart/dsh-plugin-agentheart

把 **AgentHeart**（AI Agent 的「心脏包」：任务调度 / 定时任务 / 消息队列 / 循环任务 / 并发治理）
以 **Cordis 插件**形态嵌入 **DeepSeek Harness（DSH）**。

- **零侵入宿主**：不修改 DSH 核心源码，仅以插件 + 配置接入；
- **零内核依赖**：AgentHeart 内核仍为 Rust 零第三方依赖；
- **可插拔可回退**：卸载插件即回收侧车进程，宿主回到原生形态。

> 设计依据与完整实施步骤见 `agentheart-test/docs/AgentHeart_集成DeepSeekHarness实施方案.md`。

## 架构

```
DSH (Node/TS + Cordis)  ──插件──▶  回环 TCP 帧协议  ──▶  agentheartd 侧车（Rust 内核）
   ctx.agentheart 服务 / agentheart_* 工具 / 事件回流
```

## 安装

```sh
# 通道 A（推荐）：npm
dsh plugin --profile <profile> add @agentheart/dsh-plugin-agentheart

# 通道 B：GitHub 仓库（pnpm≥10 首次需把包 key 写入 profile 的 pnpm-workspace.yaml 的 allowBuilds）
dsh plugin --profile <profile> add github:houzch/dsh-plugin-agentheart

# 通道 C：本地目录 / tarball（内部分发、零账号；tarball 亦见 GitHub Release 资产）
dsh plugin --profile <profile> add ./dsh-plugin-agentheart
dsh plugin --profile <profile> add ./agentheart-dsh-plugin-agentheart-1.0.0.tgz

# 开发期：直接指向 TS 源码（免打包、免构建）
pnpm dsh web --patch /abs/path/to/dsh-plugin-agentheart/cordis.patch.yml
```

侧车二进制通过**平台子包**分发（`@agentheart/agentheartd-<platform>-<arch>`），
npm 依据 `os`/`cpu` **只安装匹配平台**，无需 postinstall、可离线。

## 配置

在用户 profile 的 `cordis.yml` 中覆盖默认值：

```yaml
- id: agentheart
  name: '@agentheart/dsh-plugin-agentheart'
  config:
    mode: sidecar                 # sidecar（默认）| external（连接既有侧车）
    address: '127.0.0.1:17890'    # mode=external 时必填
    token: '<本地令牌>'            # mode=external 时必填
    binaryPath: ''                # 留空 = 自动解析平台子包
    healthIntervalMs: 5000
    shutdownTimeoutMs: 3000
    eventTopics: ['task', 'delivery', 'error', 'loop', 'rule']
    kernel:
      workers: 0                  # 0 = 内核默认
      heartbeatMs: 1000
```

## 能力

**服务**（供其它插件 `inject: ['agentheart']`）：`ctx.agentheart.{tasks,jobs,queue,loops,rules,observe}`。

**工具**（供模型调用）：`agentheart_task_submit` / `agentheart_task_list` / `agentheart_task_control` /
`agentheart_job` / `agentheart_queue` / `agentheart_loop` / `agentheart_rule` / `agentheart_observe`。

**事件**：内核 `event.task/delivery/error/loop/rule/heartbeat` 回流为 Cordis **类型化事件**
（`ctx.emit('agentheart/task' | …)`，同步派发；可在其它插件中 `ctx.on('agentheart/task', …)` 订阅）。

> **Trajectory**：DSH 的 Trajectory 即 append-only 会话日志（`@deepseek-ai/dsh-session` 的 `ctx.sessions`）。
> 本插件默认**只读观测、不写入**（后台桥接无「当前会话」句柄）；如需把 AgentHeart 事件落库到某个会话，
> 可在事件回调中通过 `ctx.sessions` 的 `Session.append(...)` 自行追加。

## 与内置「定时任务」插件的边界

DSH 内置 `@deepseek-ai/dsh-schedule` 是**会话绑定的提醒**（`schedule_create/list/delete/update`，把消息投递回原会话；Host 须运行，最小粒度 1 分钟）。
本插件是面向工程的**可靠调度**（队列任务 / 重试 / 死信 / 循环 / 并发治理；侧车独立运行）。

二者**互补、可共存**：调度时间源相互独立、工具名不冲突，**不存在双重调度**。
建议——简单提醒用内置 `schedule_*`；需要可靠执行与失败自愈用 AgentHeart。可选单向桥接默认关闭（详见集成方案 §3.6）。

## 开发

```sh
npm install
npm run build       # tsc -> lib/（不含测试）
npm run typecheck
npm test            # 编译到 test-build/ 后由 node:test 运行
```

测试骨架基于 Node 内置 `node:test`（**零新增依赖**，共 49 例；Windows 跳过 1 例信号语义）：

| 文件 | 覆盖 |
| --- | --- |
| `src/client.test.ts` | 协议线格式（16 字节帧头）、握手、请求-响应、事件与响应分流、内核错误码透传——用**独立 TCP 假内核**交叉校验线格式 |
| `src/events.test.ts` | 主题路由、`seq` 幂等去重、`onEvent` 回调、启停幂等、取事件异常静默 |
| `src/tools.test.ts` | 8 个工具注册、`agentheart_job` 的 create/delete、前置校验、**失败隔离**（异常转可读文本） |
| `src/binary.test.ts` | 平台矩阵与 `package.json` 的 `optionalDependencies` 对齐、解析优先级、子包缺失的**修复指引** |
| `src/supervisor.test.ts` | 真实 spawn 下解析启动横幅（含跨分块与 `mqtt` 行）、就绪超时、提前退出、`stop` 优雅与强杀、stderr 截断 |
| `src/service.test.ts` | 用**真实 `Context`** 验证 `ctx.agentheart` 注册，并逐组断言 `tasks/jobs/queue/loops/rules/observe` 的转发方法名与实参 |
| `src/index.test.ts` | 装配契约 `apply(ctx, config)`：8 工具 + 服务注册、握手与订阅次序、**端到端调用**、`ctx.effect` 卸载断连、启动失败降级为可读错误 |

（`src/test-helpers.ts` 为测试共用辅助：假内核与轮询等待。）

> 监督器测试以 `process.execPath` 充当侧车二进制、用 `NODE_OPTIONS=--require` 预载横幅脚本，
> 在**真实 spawn** 下验证进程生命周期，既无需真实 `agentheartd` 也不依赖模块 mock。

测试与辅助文件**不进入发布产物**：`tsconfig.json` 排除 `src/**/*.test.ts` 与 `src/test-helpers.ts`，`files` 仅含 `lib/`。

## 发布前置与步骤

**已本地验证**

| 项 | 状态 |
| --- | --- |
| registry | `https://registry.npmjs.org/`（公开） |
| 包名占用 | `@agentheart/dsh-plugin-agentheart`、`@agentheart/agentheartd-win32-x64` 均 **404（未被占用）** |
| `publishConfig.access` | `public`（scoped 包发布必需，已在 `package.json` 配置） |
| `npm publish --dry-run` | ✅ 通过：44 文件 / 36.5 kB，输出 `with tag latest and public access` |
| 质量门禁 | ✅ `typecheck` / `test`（49 例：48 通过 / 1 跳过）/ `build` / `pack --dry-run` 全绿 |
| 仓库布局 | 独立**公开**仓库 [`houzch/dsh-plugin-agentheart`](https://github.com/houzch/dsh-plugin-agentheart)（内核镜像 `houzch/agentheart` 同级）；`repository` / `homepage` / `bugs` 已补齐 |

**待人工执行（当前阻塞项）**

1. 在 npm 创建组织 **`agentheart`**（或改用个人 scope，并同步修改 `package.json` 中的包名）；
2. `npm login`（账号启用 2FA 时走交互式登录）；
3. 配置 CI 发布凭据——**二选一**：

   **A（推荐）Trusted Publishing（OIDC 免令牌）**：npm 包设置页 → *Trusted Publisher* → GitHub Actions，
   填 **Organization or user = `houzch`**、**Repository = `dsh-plugin-agentheart`**、
   **Workflow filename = `publish-plugin.yml`**，并勾选允许 `npm publish`。免长期令牌；需 npm CLI ≥ 11.5.1（Node ≥ 22.14），
   CI 已显式升级 npm。注意：**通常需包已存在才能配置**，故**首次发布**可能仍需先走 B。

   **B Granular Access Token（GAT）**：Access Tokens → *Generate New Token* →
   **Packages and scopes** 选 scope `@agentheart` + **Read and write (publish and stage)**，
   并勾选 **Bypass two-factor authentication**；存为仓库 secret **`NPM_TOKEN`**。
   注意：`Organizations` 段的授权**不能**发布该组织的包，发布权限只在 Packages/scopes 段。

> ⚠️ **classic / Automation Token 已于 2025-11 移除**，请勿按旧文档生成。
> ⚠️ npm 已宣布：**bypass-2FA 令牌的直接发布**将于 **2027-01** 停用——届时改用 `Read and write (stage only)`
> + `npm stage publish`（维护者批准），或改用 OIDC。

**产出与发布**（平台子包**先于**主包，顺序不可颠倒）

```sh
# 1) 生成平台子包（默认当前平台并自动定位二进制；跨平台用 --target / --binary 指定）
npm run pack:platforms
#    → platforms/@agentheart/agentheartd-<target>/{package.json, bin/<exe>}

# 2) 发布子包（每平台各一次）
cd platforms/@agentheart/agentheartd-<target> && npm publish

# 3) 最后发布主包（publishConfig.access=public 已生效，无需 --access 参数）
npm publish
```

脚本以**主包 `package.json` 为唯一事实源**（版本 + `optionalDependencies` 平台矩阵）：
`--target` 非法、或声明版本与主包不一致时**直接报错退出**；二进制缺省按
`<公开仓库>/target/release/agentheartd[.exe]` 定位（可用 `--binary` / `AH_SIDECAR_BINARY` / `AH_PUBLIC_ROOT` 覆盖）。

**CI**：[`.github/workflows/ci.yml`](.github/workflows/ci.yml)（typecheck / test / build / 打包冒烟）；
**CI 发布**：[`.github/workflows/publish-plugin.yml`](.github/workflows/publish-plugin.yml) 以 5 平台**原生矩阵**构建侧车 → 发布子包 → 再发布主包（`needs` 强制顺序）→ tag 触发时汇总 **6 个 tarball** 建 **GitHub Release**（供离线/内网安装）。
本仓库**公开** + GitHub Actions OIDC ⇒ 已启用 `NPM_CONFIG_PROVENANCE=true` 生成签名证明。

> 分发通道：**npmjs（主）+ GitHub Release 资产（离线 / 内网）**；**不接 GitHub Packages**
> （其要求包 scope 与仓库 owner 一致，且公开包安装也需 access token/PAT）。

**未决 / 已知限制**

- **平台子包不在本仓库提交**：`platforms/` 已 gitignore，须在发布前用 `npm run pack:platforms` 产出；
  本地（未指定 `--target`）只会产出**当前平台**，其余平台需在各自环境/CI 产出，**发齐 5 个同版本子包后**才能发主包。
  若在子包发布前发主包，应**临时移除 `optionalDependencies`**（使用者改用 `config.binaryPath` 或 `mode: external`），
  否则安装侧会尝试拉取不存在的可选依赖（npm 降级为警告，pnpm 会报错）。
- 平台子包与主包共用 `repository`（生成脚本从主包 `package.json` 读取），npm 页面统一回链到本仓库。

## 版本对齐

本插件锁定 DSH **`0.2.0-rc.2` 版本列车**（已在真实 DSH 类型下通过 `npm run build`）：

| 包 | 版本 |
| --- | --- |
| `@deepseek-ai/dsh-tools` | `0.2.0-rc.2` |
| `@deepseek-ai/cordis` | `~4.0.4` |
| `@deepseek-ai/schemastery` | `~3.18.4` |

DSH 处于预览期、API 演进较快，插件**不承诺**跨破坏性版本兼容；升级走「巡检 → 适配 → 契约测试」。

## 许可

MIT
