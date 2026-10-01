#!/usr/bin/env node
/**
 * dsh-search-ocgo-doctor —— 一键定位「搜索为什么不通」。
 *
 * 默认只做只读检查，不发任何网络请求。加 `--probe` 才真发一次搜索（会花钱）。
 *
 * 用法：
 *   node bin/doctor.mjs
 *   node bin/doctor.mjs --probe
 *   node bin/doctor.mjs --profile web --json
 *
 * 退出码：0 无阻断项，1 有阻断项。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/**
 * 读一个命令行开关的值。
 *
 * @param name - 开关名（含 `--`）。
 * @param fallback - 缺省值。
 * @returns 开关值。
 */
function argValue(name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const PROFILE = argValue('--profile', 'web')
const PROBE = argv.includes('--probe')
const AS_JSON = argv.includes('--json')

const DSH_HOME = join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const CREDENTIALS = join(DSH_HOME, '.credentials.yaml')
const PROFILE_PATCH = join(PROFILE_DIR, 'cordis.patch.yml')
const PROFILE_PKG = join(PROFILE_DIR, 'package.json')
const PLUGIN_LINK = join(PROFILE_DIR, 'node_modules', 'dsh-web-search-ocgo')

/** 检查结果。 */
const checks = []

/**
 * 记录一条检查结果。
 *
 * @param level - `ok` / `warn` / `fail`。
 * @param title - 检查项标题。
 * @param detail - 细节说明。
 */
function record(level, title, detail) {
  checks.push({ level, title, detail })
}

/**
 * 从凭据文件里取一个 ref 的值（够用的行解析，不引 yaml 依赖）。
 *
 * @param ref - 凭据名。
 * @returns 密钥字符串；找不到时为 undefined。
 */
function readCredential(ref) {
  if (!existsSync(CREDENTIALS)) return undefined
  const lines = readFileSync(CREDENTIALS, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (!new RegExp(`^\\s*${ref}\\s*:`).test(lines[i])) continue
    const inline = lines[i]
      .split(':')
      .slice(1)
      .join(':')
      .trim()
      .replace(/^['"]|['"]$/gu, '')
    if (inline.length > 0) return inline
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim().length === 0) continue
      if (!/^\s/.test(lines[j])) break
      return lines[j].trim().replace(/^['"]|['"]$/gu, '')
    }
  }
  return undefined
}

/**
 * 在一份 YAML 里找真正的 loader entry id。
 *
 * 必须跳过注释行 —— 配置里常有用来说明历史的注释（例如「旧插件
 * dsh-web-search-opencode-go 已移除」），直接 grep 全文会误报。
 *
 * @param yaml - YAML 文本。
 * @param id - 要找的 entry id。
 * @returns 存在真正的 `- id: <id>` 行时为 true。
 */
function hasEntryId(yaml, id) {
  return yaml.split('\n').some((line) => {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('#')) return false
    return new RegExp(`^-\\s*id:\\s*${id}\\b`, 'u').test(trimmed)
  })
}

/**
 * 描述密钥而不泄漏它。
 *
 * @param value - 密钥。
 * @returns 形如 `已设置（67 字符，前缀 sk-…）` 的说明。
 */
function describeSecret(value) {
  if (value === undefined) return '未设置'
  return `已设置（${value.length} 字符，前缀 ${value.slice(0, 4)}…）`
}

// ── 1. 依赖解析 ────────────────────────────────────────────────────────
try {
  await import('@deepseek-ai/schemastery')
  record('ok', '依赖 @deepseek-ai/schemastery', '可解析')
} catch {
  record(
    'fail',
    '依赖 @deepseek-ai/schemastery',
    `解析失败。修法：ln -sfn ~/.dsh/profiles/${PROFILE}/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery`,
  )
}

// ── 2. 语法 ────────────────────────────────────────────────────────────
const syntaxTargets = ['index.js', 'client.js', 'lib/constants.js', 'lib/errors.js', 'lib/cache.js', 'lib/provider.js']
const broken = []
for (const file of syntaxTargets) {
  if (!existsSync(join(ROOT, file))) {
    broken.push(`${file}（缺失）`)
    continue
  }
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' })
  } catch {
    broken.push(file)
  }
}
if (broken.length === 0) record('ok', '语法检查', `${syntaxTargets.length} 个文件通过`)
else record('fail', '语法检查', `有问题：${broken.join('、')}`)

// ── 3. 凭据 ────────────────────────────────────────────────────────────
const goKey = readCredential('OPENCODE_API_KEY')
const deepseekKey = readCredential('DEEPSEEK_API_KEY')
if (existsSync(CREDENTIALS)) {
  record('ok', '凭据文件', CREDENTIALS)
} else {
  record('fail', '凭据文件', `不存在：${CREDENTIALS}`)
}
if (goKey !== undefined) record('ok', 'OPENCODE_API_KEY（Go 端点）', describeSecret(goKey))
else record('fail', 'OPENCODE_API_KEY（Go 端点）', '未设置 —— 搜索会报 WEB_PROVIDER_CREDENTIAL_MISSING')
if (deepseekKey !== undefined) record('ok', 'DEEPSEEK_API_KEY（回退用）', describeSecret(deepseekKey))
else record('warn', 'DEEPSEEK_API_KEY（回退用）', '未设置 —— Go 端点失败时无法回退官方端点')

// ── 4. profile 配置 ────────────────────────────────────────────────────
if (!existsSync(PROFILE_PATCH)) {
  record('fail', `profile 补丁（${PROFILE}）`, `不存在：${PROFILE_PATCH}`)
} else {
  const patch = readFileSync(PROFILE_PATCH, 'utf8')
  record('ok', `profile 补丁（${PROFILE}）`, PROFILE_PATCH)

  if (hasEntryId(patch, 'web-search-ocgo')) {
    record('ok', '本插件 entry', 'cordis.patch.yml 里有 web-search-ocgo')
  } else {
    record('info', '本插件 entry', 'cordis.patch.yml 里没写 —— 由本插件的 bundle 补丁自动插入，属正常')
  }

  // searchProvider 的钉法可能写在用户 patch 里，也可能写在插件的 bundle patch 里。
  const bundlePatchPath = join(ROOT, 'cordis.patch.yml')
  const bundlePatch = existsSync(bundlePatchPath) ? readFileSync(bundlePatchPath, 'utf8') : ''
  const pinnedInUser = /^-?\s*id:\s*web\b[\s\S]{0,300}?searchProvider:\s*(\S+)/mu.exec(patch)
  const pinnedInBundle = /^-\s*id:\s*web\b[\s\S]{0,300}?searchProvider:\s*(\S+)/mu.exec(bundlePatch)
  const pinned = pinnedInUser?.[1] ?? pinnedInBundle?.[1]
  if (pinned === 'opencode-go') {
    record('ok', 'web.searchProvider', `opencode-go（来自${pinnedInUser ? '用户 patch' : '插件 bundle 补丁'}）`)
  } else if (pinned === undefined) {
    record('warn', 'web.searchProvider', '两处都没找到 —— 搜索可能仍由官方 provider 接管')
  } else {
    record('warn', 'web.searchProvider', `当前钉在 ${pinned} —— 不是本插件（官方链路会接管搜索）`)
  }

  if (hasEntryId(patch, 'web-search-opencode-go')) {
    record('warn', '旧链路残留', 'cordis.patch.yml 里仍有 web-search-opencode-go 这个 entry，建议清理')
  } else {
    record('ok', '旧链路残留', '用户 patch 里没有旧插件的 entry')
  }
}

// ── 5. bundle 登记与链接 ───────────────────────────────────────────────
if (existsSync(PROFILE_PKG)) {
  try {
    const pkg = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'))
    const bundles = pkg.dsh?.profile?.bundles ?? []
    if (bundles.includes('dsh-web-search-ocgo')) record('ok', 'bundle 登记', 'dsh.profile.bundles 里有 dsh-web-search-ocgo')
    else record('warn', 'bundle 登记', 'dsh.profile.bundles 里没有 dsh-web-search-ocgo')
    if (bundles.includes('dsh-web-search-opencode-go')) {
      record('warn', '旧 bundle 登记', 'dsh.profile.bundles 里仍有 dsh-web-search-opencode-go')
    }
  } catch (error) {
    record('warn', 'bundle 登记', `package.json 解析失败：${String(error.message).split('\n')[0]}`)
  }
} else {
  record('warn', 'bundle 登记', `profile 的 package.json 不存在：${PROFILE_PKG}`)
}

if (existsSync(PLUGIN_LINK)) record('ok', '插件链接', PLUGIN_LINK)
else record('fail', '插件链接', `不存在：${PLUGIN_LINK}。修法：ln -sfn "${ROOT}" "${PLUGIN_LINK}"`)

// ── 6. 会话日志：旧版自定义事件的遗留污染 ──────────────────────────────
// 本插件曾写自定义事件 web/ocgo-search-response，而 harness 的读路径会拒绝
// 任何不在 KNOWN_SESSION_EVENT_TYPES 里、又没标 ignorable 的事件类型 ——
// 一条就足以让整份会话日志报「历史加载失败」。新版已停写，历史日志可能仍有
// 遗留，这里主动扫出来（只读；解压用外部 zstd，找不到就跳过）。
const sessionsRoot = join(DSH_HOME, 'sessions')
const LEGACY_EVENT = 'web/ocgo-search-response'

/**
 * 列出所有会话日志（v3 / v4）。
 *
 * @param root - sessions 根目录。
 * @returns 日志文件的绝对路径数组。
 */
function listSessionLogs(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^session\.v\d+\.jsonl\.zstd$/u.test(entry.name)) found.push(full)
    }
  }
  walk(root)
  return found
}

if (!existsSync(sessionsRoot)) {
  record('warn', '会话日志', `不存在：${sessionsRoot}`)
} else {
  const logs = listSessionLogs(sessionsRoot)
  const poisoned = []
  let scanned = 0
  let zstdMissing = false
  for (const file of logs) {
    let text
    try {
      text = execFileSync('zstd', ['-d', '-c', file], {
        stdio: 'pipe',
        maxBuffer: 512 * 1024 * 1024,
      }).toString('utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        zstdMissing = true
        break
      }
      continue
    }
    scanned += 1
    for (const line of text.split('\n')) {
      if (!line.includes(LEGACY_EVENT)) continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed?.type === LEGACY_EVENT && parsed.ignorable !== true) {
        poisoned.push(`${file}（seq ${parsed.seq}）`)
      }
    }
  }
  if (zstdMissing) {
    record('info', '会话日志', '跳过遗留污染扫描：没找到 zstd 命令')
  } else if (poisoned.length === 0) {
    record('ok', '会话日志', `已扫描 ${scanned} 份，没有会让日志打不开的遗留事件`)
  } else {
    record(
      'fail',
      '会话日志遗留污染',
      `${poisoned.length} 条未标 ignorable 的 ${LEGACY_EVENT} 会让整份日志拒绝加载：${poisoned.slice(0, 3).join('、')}${poisoned.length > 3 ? ' …' : ''}。修法：给该事件补 "ignorable":true，并保持 zstd frame 布局（第一个 frame 恰好是 header 一行）`,
    )
  }
}

// ── 7. 可选：真发一次搜索 ──────────────────────────────────────────────
if (PROBE) {
  if (goKey === undefined) {
    record('fail', '真实搜索探测', '跳过：没有 OPENCODE_API_KEY')
  } else {
    const endpoint = 'https://opencode.ai/zen/go/v1/messages'
    const started = Date.now()
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-api-key': goKey,
          authorization: `Bearer ${goKey}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          accept: 'application/json',
          'x-opencode-session': crypto.randomUUID(),
          'x-opencode-client': 'dsh-doctor',
        },
        body: JSON.stringify({
          model: 'deepseek-v4.1-flash',
          max_tokens: 4096,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: DeepSeek Harness' }] },
          ],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        }),
      })
      const durationMs = Date.now() - started
      if (!response.ok) {
        const text = await response.text()
        record('fail', '真实搜索探测', `HTTP ${response.status}：${text.slice(0, 200)}`)
      } else {
        const payload = await response.json()
        const blocks = payload.content ?? []
        const resultBlocks = blocks.filter((block) => block.type === 'web_search_tool_result')
        const sources = resultBlocks.flatMap((block) => block.content ?? [])
        const answerChars = blocks
          .filter((block) => block.type === 'text')
          .reduce((sum, block) => sum + (block.text ?? '').length, 0)
        const usage = payload.usage ?? {}
        record(
          'ok',
          '真实搜索探测',
          [
            `${durationMs} ms`,
            `${sources.length} 条结果`,
            `text 块合计 ${answerChars} 字符`,
            `input ${usage.input_tokens ?? 0} + cache_read ${usage.cache_read_input_tokens ?? 0} = 总 prompt ${(usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)}`,
            `web_search 次数 ${usage.server_tool_use?.web_search_requests ?? 0}`,
          ].join(' / '),
        )
        if (resultBlocks.length === 0) {
          record('fail', '真实搜索探测', '响应里没有 web_search_tool_result 块 —— 未触发原生搜索')
        }
      }
    } catch (error) {
      record('fail', '真实搜索探测', `${String(error?.message ?? error)}（${Date.now() - started} ms）`)
    }
  }
}

// ── 输出 ───────────────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify({ profile: PROFILE, probe: PROBE, checks }, null, 2))
} else {
  const icon = { ok: '✔', warn: '⚠', fail: '✖', info: 'ℹ' }
  console.log(`dsh-web-search-ocgo doctor  profile=${PROFILE}${PROBE ? '  (含真实探测)' : ''}\n`)
  for (const check of checks) {
    console.log(`${icon[check.level]} ${check.title}`)
    console.log(`    ${check.detail}`)
  }
  const fails = checks.filter((check) => check.level === 'fail').length
  const warns = checks.filter((check) => check.level === 'warn').length
  console.log(`\n合计 ${checks.length} 项：${fails} 阻断、${warns} 提醒。`)
}

process.exit(checks.some((check) => check.level === 'fail') ? 1 : 0)
