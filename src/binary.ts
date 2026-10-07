/**
 * 平台子包二进制解析。
 *
 * 侧车通过**平台子包**分发：`@agentheart/agentheartd-<platform>-<arch>`
 * （如 `@agentheart/agentheartd-win32-x64`）。本模块依当前平台定位可执行文件；
 * 缺失时给出「安装子包 / 设 binaryPath / 改 mode: external」的明确指引。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** 支持的平台-架构矩阵（与主包 optionalDependencies 对齐）。 */
export const SUPPORTED_TARGETS = [
  'win32-x64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
] as const

/** 当前目标标识，如 `win32-x64`。 */
export function currentTarget(): string {
  return `${process.platform}-${process.arch}`
}

/** 平台子包名，如 `@agentheart/agentheartd-win32-x64`。 */
export function sidecarPackageName(target: string = currentTarget()): string {
  return `@agentheart/agentheartd-${target}`
}

/** 可执行文件名（Windows 带 .exe）。 */
export function executableName(): string {
  return process.platform === 'win32' ? 'agentheartd.exe' : 'agentheartd'
}

/**
 * 解析侧车可执行文件路径。
 *
 * 优先级：`configuredPath` → 环境变量 `AGENTHEART_BINARY` → 平台子包内 `bin/`。
 * 全部失败时抛出带修复指引的错误。
 */
export function resolveSidecarBinary(configuredPath = ''): string {
  const explicit = configuredPath || process.env.AGENTHEART_BINARY || ''
  if (explicit) {
    if (existsSync(explicit)) return explicit
    throw new Error(`agentheart: 指定的侧车二进制不存在：${explicit}`)
  }

  const target = currentTarget()
  const packageName = sidecarPackageName(target)
  try {
    const packageJson = require.resolve(`${packageName}/package.json`)
    const binary = join(dirname(packageJson), 'bin', executableName())
    if (existsSync(binary)) return binary
    throw new Error(`agentheart: 平台子包 ${packageName} 缺少 bin/${executableName()}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('agentheart:')) throw error
    throw new Error(
      [
        `agentheart: 未找到当前平台（${target}）的侧车二进制（${packageName}）。`,
        `支持的目标：${SUPPORTED_TARGETS.join(', ')}`,
        '修复方式（任选其一）：',
        `  1) 安装对应平台子包：npm i ${packageName}`,
        '  2) 在 cordis.yml 中设置 config.binaryPath 指向自定义二进制；',
        '  3) 设置 config.mode=external 连接既有侧车。',
      ].join('\n'),
    )
  }
}
