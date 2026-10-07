/**
 * 平台子包二进制解析测试。
 *
 * 覆盖：平台矩阵与 `package.json` 的 `optionalDependencies` 对齐、
 * 解析优先级（configuredPath → `AGENTHEART_BINARY` → 平台子包）、
 * 以及子包缺失时的「可操作修复指引」。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  currentTarget,
  executableName,
  resolveSidecarBinary,
  sidecarPackageName,
  SUPPORTED_TARGETS,
} from './binary.js'

const require = createRequire(import.meta.url)

/** 本测试文件自身——用作「真实存在的文件路径」。 */
const EXISTING_FILE = fileURLToPath(import.meta.url)

/** 平台子包是否已安装（尚未发布时为 false）。 */
const subpackageInstalled = (() => {
  try {
    require.resolve(`${sidecarPackageName()}/package.json`)
    return true
  } catch {
    return false
  }
})()

test('currentTarget 反映当前平台与架构', () => {
  assert.equal(currentTarget(), `${process.platform}-${process.arch}`)
})

test('sidecarPackageName 生成 scoped 平台子包名', () => {
  assert.equal(sidecarPackageName('linux-arm64'), '@agentheart/agentheartd-linux-arm64')
  assert.equal(sidecarPackageName(), `@agentheart/agentheartd-${currentTarget()}`)
})

test('executableName 在 Windows 带 .exe', () => {
  assert.equal(executableName(), process.platform === 'win32' ? 'agentheartd.exe' : 'agentheartd')
})

test('平台矩阵与 package.json 的 optionalDependencies 对齐且同版本', () => {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version: string
    optionalDependencies: Record<string, string>
  }
  const declared = Object.keys(manifest.optionalDependencies).sort()
  assert.deepEqual(
    declared,
    SUPPORTED_TARGETS.map((target) => sidecarPackageName(target)).sort(),
  )
  for (const [name, version] of Object.entries(manifest.optionalDependencies)) {
    assert.equal(version, manifest.version, `${name} 应与主包同版本发布`)
  }
})

test('resolveSidecarBinary：显式路径存在时直接返回', () => {
  assert.ok(existsSync(EXISTING_FILE))
  assert.equal(resolveSidecarBinary(EXISTING_FILE), EXISTING_FILE)
})

test('resolveSidecarBinary：显式路径不存在时抛错', () => {
  const missing = join(dirname(EXISTING_FILE), '__definitely-missing__')
  assert.throws(() => resolveSidecarBinary(missing), /指定的侧车二进制不存在/)
})

test('resolveSidecarBinary：AGENTHEART_BINARY 作为次优先来源', () => {
  const previous = process.env.AGENTHEART_BINARY
  process.env.AGENTHEART_BINARY = EXISTING_FILE
  try {
    assert.equal(resolveSidecarBinary(''), EXISTING_FILE)
  } finally {
    if (previous === undefined) delete process.env.AGENTHEART_BINARY
    else process.env.AGENTHEART_BINARY = previous
  }
})

test('resolveSidecarBinary：configuredPath 优先于 AGENTHEART_BINARY', () => {
  const previous = process.env.AGENTHEART_BINARY
  process.env.AGENTHEART_BINARY = join(dirname(EXISTING_FILE), '__env-missing__')
  try {
    assert.equal(resolveSidecarBinary(EXISTING_FILE), EXISTING_FILE)
  } finally {
    if (previous === undefined) delete process.env.AGENTHEART_BINARY
    else process.env.AGENTHEART_BINARY = previous
  }
})

test('resolveSidecarBinary：平台子包缺失时给出可操作的修复指引', { skip: subpackageInstalled }, () => {
  const previous = process.env.AGENTHEART_BINARY
  delete process.env.AGENTHEART_BINARY
  try {
    assert.throws(
      () => resolveSidecarBinary(''),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes(`未找到当前平台（${currentTarget()}）`))
        assert.ok(error.message.includes('支持的目标：'))
        assert.ok(error.message.includes(`npm i ${sidecarPackageName()}`))
        assert.ok(error.message.includes('config.binaryPath'))
        assert.ok(error.message.includes('config.mode=external'))
        return true
      },
    )
  } finally {
    if (previous !== undefined) process.env.AGENTHEART_BINARY = previous
  }
})
