#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 houzc

/**
 * 生成「平台侧车子包」：`platforms/@agentheart/agentheartd-<target>/`
 *
 * 主包通过 `optionalDependencies` 以**同版本**引用这些子包，npm 依 `os`/`cpu` 只安装匹配平台，
 * 无需 postinstall、可离线。本脚本以**主包 package.json 为唯一事实源**（版本 + 平台矩阵），
 * 产出子包目录（`package.json` + `bin/<exe>`），随后即可 `npm publish`。
 *
 * 用法：
 *   node scripts/build-platform-packages.mjs                                  # 当前平台，自动定位二进制
 *   node scripts/build-platform-packages.mjs --target linux-x64 --binary /path/agentheartd
 *   node scripts/build-platform-packages.mjs --target a --binary A --target b --binary B
 *
 * 二进制定位优先级：`--binary` → 环境变量 `AH_SIDECAR_BINARY` → `<公开仓库>/target/release/agentheartd[.exe]`。
 * 公开仓库根目录：环境变量 `AH_PUBLIC_ROOT`，缺省按同级布局推断（`<work>/agentheart`）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const OUT_ROOT = join(PLUGIN_ROOT, 'platforms')

const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
const VERSION = manifest.version
const OPTIONAL = manifest.optionalDependencies ?? {}
/** 平台矩阵：以主包 `optionalDependencies` 为唯一事实源（`src/binary.ts` 与其测试保证一致）。 */
const SUPPORTED = Object.keys(OPTIONAL).map((name) => name.replace('@agentheart/agentheartd-', ''))

function fail(message) {
  console.error(`build-platform-packages: ${message}`)
  process.exit(1)
}

/** 可执行文件名（Windows 带 `.exe`）。 */
function executableName(target) {
  return target.startsWith('win32-') ? 'agentheartd.exe' : 'agentheartd'
}

/**
 * 公开仓库根目录：`AH_PUBLIC_ROOT` → 同级布局 `<work>/agentheart` → 内嵌布局 `<work>/agentheart-test/plugins/…`。
 * 判别依据：该目录下存在 `agentheart-core/src/lib.rs`。
 */
function publicRoot() {
  if (process.env.AH_PUBLIC_ROOT) return resolve(process.env.AH_PUBLIC_ROOT)
  const candidates = [
    resolve(PLUGIN_ROOT, '..', 'agentheart'),
    resolve(PLUGIN_ROOT, '..', '..', '..', 'agentheart'),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'agentheart-core', 'src', 'lib.rs'))) return candidate
  }
  return candidates[0]
}

function resolveBinary(target, explicit) {
  if (explicit) return resolve(explicit)
  if (process.env.AH_SIDECAR_BINARY) return resolve(process.env.AH_SIDECAR_BINARY)
  const candidate = join(publicRoot(), 'target', 'release', executableName(target))
  if (existsSync(candidate)) return candidate
  return fail(
    `未找到 ${target} 的侧车二进制（${candidate}）。请用 --binary 指定，或先构建公开仓库：cargo build --release --bin agentheartd`,
  )
}

function parseArgs(argv) {
  const jobs = []
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--target') {
      const target = argv[index + 1]
      if (!target) fail('--target 缺少取值')
      jobs.push({ target, binary: null })
      index += 1
    } else if (flag === '--binary') {
      const path = argv[index + 1]
      if (!path) fail('--binary 缺少取值')
      const job = jobs.at(-1)
      if (!job) fail('--binary 必须跟在 --target 之后')
      job.binary = path
      index += 1
    } else {
      fail(`未知参数：${flag}`)
    }
  }
  if (jobs.length === 0) jobs.push({ target: `${process.platform}-${process.arch}`, binary: null })
  for (const job of jobs) {
    if (!SUPPORTED.includes(job.target)) {
      fail(`不支持的平台：${job.target}（支持：${SUPPORTED.join(', ')}）`)
    }
  }
  return jobs
}

function build(job) {
  const packageName = `@agentheart/agentheartd-${job.target}`
  if (OPTIONAL[packageName] !== VERSION) {
    fail(
      `${packageName} 在 optionalDependencies 中声明为 ${OPTIONAL[packageName] ?? '缺失'}，与主包版本 ${VERSION} 不一致`,
    )
  }
  const binary = resolveBinary(job.target, job.binary)
  const [platform, arch] = job.target.split('-')
  const dir = join(OUT_ROOT, '@agentheart', `agentheartd-${job.target}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const subManifest = {
    name: packageName,
    version: VERSION,
    description: `AgentHeart 侧车二进制（${job.target}）——供 @agentheart/dsh-plugin-agentheart 使用`,
    license: 'MIT',
    os: [platform],
    cpu: [arch],
    files: ['bin'],
    publishConfig: { access: 'public' },
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(subManifest, null, 2)}\n`)
  const destination = join(dir, 'bin', executableName(job.target))
  cpSync(binary, destination)
  const megabytes = statSync(destination).size / 1024 / 1024
  console.log(`生成 ${packageName}@${VERSION}`)
  console.log(`  源：${binary}`)
  console.log(`  目标：${destination}（${megabytes.toFixed(2)} MB）`)
  return dir
}

const built = parseArgs(process.argv.slice(2)).map(build)
console.log(`\n共生成 ${built.length} 个平台子包。发布顺序：**平台子包先于主包**：`)
for (const dir of built) console.log(`  cd ${dir} && npm publish`)
if (built.length < SUPPORTED.length) {
  console.log(`\n注意：平台矩阵共 ${SUPPORTED.length} 个，尚未全部产出（${SUPPORTED.join(', ')}）；主包发布前须先发齐同版本子包。`)
}
