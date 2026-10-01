#!/usr/bin/env node
/**
 * 清单自检：package.json 的 dsh 字段、exports 目标、必需文件与语法。
 *
 * 用法：node scripts/check.mjs
 * 退出码：0 全通过，1 有失败项。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

/**
 * 记录一项失败。
 *
 * @param message - 说明。
 */
function fail(message) {
  problems.push(message)
}

/**
 * 记录一项提示。
 *
 * @param message - 说明。
 */
function note(message) {
  notes.push(message)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// ── package.json 关键字段 ──────────────────────────────────────────────
if (pkg.name !== 'dsh-web-search-ocgo') fail(`包名应为 dsh-web-search-ocgo，实际 ${pkg.name}`)
if (pkg.type !== 'module') fail('package.json 必须声明 "type": "module"')
if (pkg.license !== 'MIT') fail('license 应为 MIT')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('缺少 dsh.bundle.patch 指向 cordis.patch.yml')
if (pkg.dsh?.client?.platform !== 'web') fail('缺少 dsh.client.platform = "web"（否则浏览器半不会被扫描）')
for (const required of ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager']) {
  if (!(pkg.dsh?.client?.inject ?? []).includes(required)) {
    fail(`dsh.client.inject 应包含 ${required}`)
  }
}

// ── exports 目标存在 ───────────────────────────────────────────────────
for (const [key, target] of Object.entries(pkg.exports ?? {})) {
  if (typeof target !== 'string') continue
  if (!existsSync(join(ROOT, target))) fail(`exports["${key}"] 指向的文件不存在：${target}`)
}

// ── files 清单里的文件存在 ─────────────────────────────────────────────
for (const entry of pkg.files ?? []) {
  if (entry.includes('*')) continue
  if (!existsSync(join(ROOT, entry))) fail(`files 里列了不存在的路径：${entry}`)
}

// ── 必需文件 ───────────────────────────────────────────────────────────
for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'LICENSE', 'NOTICE', 'README.md']) {
  if (!existsSync(join(ROOT, required))) fail(`缺少必需文件：${required}`)
}

// ── 语法检查 ───────────────────────────────────────────────────────────
/**
 * 收集要检查的 JS 文件。
 *
 * @returns 相对路径数组。
 */
function jsFiles() {
  const out = ['index.js', 'client.js']
  for (const dir of ['lib', 'test', 'scripts', 'bench']) {
    const abs = join(ROOT, dir)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(`${dir}/${name}`)
    }
  }
  return out
}

for (const file of jsFiles()) {
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' })
  } catch (error) {
    fail(`语法错误 ${file}: ${String(error.stderr ?? error).split('\n').slice(0, 3).join(' ')}`)
  }
}

// ── 依赖解析 ───────────────────────────────────────────────────────────
try {
  await import('@deepseek-ai/schemastery')
} catch (error) {
  fail(`无法解析 @deepseek-ai/schemastery：${String(error.message).split('\n')[0]}`)
  note('修法：ln -sfn ~/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery')
}

// ── 依赖面告警：只应 import schemastery 这一个 dsh 包 ──────────────────
const sources = ['index.js', 'lib/constants.js', 'lib/errors.js', 'lib/cache.js', 'lib/provider.js']
for (const file of sources) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const bare = [...text.matchAll(/from\s+'(@deepseek-ai\/[^']+)'/gu)].map((match) => match[1])
  for (const spec of bare) {
    if (spec !== '@deepseek-ai/schemastery') {
      fail(`${file} 里出现了不该有的 dsh 运行时依赖：${spec}（见 NOTICE 与 README「为什么不 import dsh 包」）`)
    }
  }
}

// ── 报告 ───────────────────────────────────────────────────────────────
if (notes.length > 0) {
  console.log('提示：')
  for (const line of notes) console.log(`  · ${line}`)
}
if (problems.length > 0) {
  console.error(`\n✖ 自检失败，${problems.length} 项：`)
  for (const line of problems) console.error(`  · ${line}`)
  process.exit(1)
}
console.log(`✔ 自检通过：${jsFiles().length} 个文件语法正确，清单字段与依赖面均符合约定。`)
