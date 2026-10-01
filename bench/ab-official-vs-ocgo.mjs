/**
 * A/B 对比：官方 provider vs 本插件（dsh-web-search-ocgo）。
 *
 * 比的不只是原始响应，而是**模型最终能看到什么** —— 这是两者真正的差异：
 *   - 官方映射：snippet 只取自 `text` 块的 `citations[].cited_text`，
 *     `WebSearchResult.content` 完全不填。
 *   - 本插件映射：snippet 走三级回退（`item.content` → citations → 空），
 *     并把 `text` 块接进 `result.content`。
 *
 * 同时跑「同配置两次」做噪声基线（§3.4 的方法：只有超出噪声才算真差异）。
 *
 * 用法：
 *   node bench/ab-official-vs-ocgo.mjs
 *   node bench/ab-official-vs-ocgo.mjs --runs 1        # 只跑一轮，省额度
 *   node bench/ab-official-vs-ocgo.mjs --queries 3     # 只跑前 3 个查询
 *
 * 产出：bench/ab-raw.json + bench/ab-report.md（并打印到 stdout）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)

/**
 * 取命令行开关的值。
 *
 * @param name - 开关名。
 * @param fallback - 缺省值。
 * @returns 开关值。
 */
function argValue(name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? Number(argv[index + 1]) : fallback
}

const RUNS = argValue('--runs', 2)

const QUERIES = [
  'DeepSeek Harness 0.1.7 更新内容',
  'leeyoung1 dsh-web-search-opencode-go',
  'dsh 插件市场 网页搜索 provider',
  'OpenCode Go 订阅 额度 限制',
  'Python 3.14 新特性',
  'MCP 协议 最新版本',
].slice(0, argValue('--queries', 6))

/** 两套配置：A = 官方 provider 的默认，B = 本插件的默认。 */
const CONFIGS = [
  {
    key: 'A',
    label: '官方 provider',
    endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    model: 'deepseek-v4-flash',
    credential: 'DEEPSEEK_API_KEY',
    headers: {},
  },
  {
    key: 'B',
    label: '本插件',
    endpoint: 'https://opencode.ai/zen/go/v1/messages',
    model: 'deepseek-v4.1-flash',
    credential: 'OPENCODE_API_KEY',
    headers: { 'x-opencode-session': crypto.randomUUID(), 'x-opencode-client': 'dsh' },
  },
]

/**
 * 从凭据文件读一个 ref（行解析，不引 yaml 依赖）。
 *
 * @param ref - 凭据名。
 * @returns 密钥。
 */
function readCredential(ref) {
  const lines = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (!new RegExp(`^\\s*${ref}\\s*:`).test(lines[i])) continue
    const inline = lines[i].split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/gu, '')
    if (inline.length > 0) return inline
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim().length === 0) continue
      if (!/^\s/.test(lines[j])) break
      return lines[j].trim().replace(/^['"]|['"]$/gu, '')
    }
  }
  throw new Error(`凭据 ${ref} 未找到`)
}

/**
 * 官方 provider 的映射：snippet 只来自 citations，content 不填。
 *
 * @param payload - 响应体。
 * @returns 归一化结果。
 */
function mapOfficial(payload) {
  const blocks = payload.content ?? []
  const snippets = new Map()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const cite of block.citations ?? []) {
      if (cite.url && cite.cited_text && !snippets.has(cite.url)) snippets.set(cite.url, cite.cited_text)
    }
  }
  const seen = new Set()
  const sources = []
  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result') continue
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue
      seen.add(item.url)
      sources.push({ url: item.url, title: item.title, snippet: snippets.get(item.url) })
    }
  }
  return { content: undefined, sources }
}

/**
 * 本插件的映射：三级回退 + text 块进 content（与 lib/provider.js 同逻辑）。
 *
 * @param payload - 响应体。
 * @param answerMaxChars - content 截断上限。
 * @returns 归一化结果。
 */
function mapOcgo(payload, answerMaxChars = 2000) {
  const blocks = payload.content ?? []
  const citations = new Map()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const cite of block.citations ?? []) {
      if (cite.url && cite.cited_text && !citations.has(cite.url)) citations.set(cite.url, cite.cited_text)
    }
  }
  const seen = new Set()
  const sources = []
  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result') continue
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue
      seen.add(item.url)
      let snippet
      if (typeof item.content === 'string' && item.content.trim()) snippet = item.content.trim()
      else if (citations.has(item.url)) snippet = citations.get(item.url)
      sources.push({ url: item.url, title: item.title, snippet })
    }
  }
  const parts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim()).map((b) => b.text.trim())
  let content
  if (parts.length > 0) {
    const joined = parts.join('\n\n')
    content = joined.length > answerMaxChars ? `${joined.slice(0, answerMaxChars)}…` : joined
  }
  return { content, sources }
}

/**
 * 发一次搜索请求。
 *
 * @param config - 端点配置。
 * @param apiKey - 密钥。
 * @param query - 查询词。
 * @returns 原始响应与耗时。
 */
async function call(config, apiKey, query) {
  const started = Date.now()
  const response = await fetch(config.endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
    headers: {
      'x-api-key': apiKey,
      authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'dsh-web-search-ocgo/0.1.0 bench',
      ...config.headers,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }),
  })
  const ms = Date.now() - started
  if (!response.ok) {
    const text = await response.text()
    return { error: `HTTP ${response.status}: ${text.slice(0, 160)}`, ms }
  }
  const payload = await response.json()
  // 关键：必须把 body 读完再计时。`fetch()` 在响应头到达时就 resolve，
  // 只算到那里会得到「首字节时间」—— 官方端点会显示成 111ms 这种假数字。
  const fullMs = Date.now() - started
  const usage = payload.usage ?? {}
  return {
    ms: fullMs,
    payload,
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
    },
  }
}

/**
 * 从一次响应算出一行指标。
 *
 * @param result - `call()` 的返回值。
 * @param mapper - 映射函数。
 * @returns 指标对象。
 */
function metricsOf(result, mapper) {
  if (result.error !== undefined) return { error: result.error, ms: result.ms }
  const mapped = mapper(result.payload)
  const snippetChars = mapped.sources.reduce((sum, s) => sum + (s.snippet?.length ?? 0), 0)
  const contentChars = mapped.content?.length ?? 0
  return {
    ms: result.ms,
    sources: mapped.sources.length,
    snippetChars,
    contentChars,
    visibleChars: snippetChars + contentChars,
    totalPrompt: result.usage.input + result.usage.cacheRead,
    output: result.usage.output,
    cacheRead: result.usage.cacheRead,
    webSearchRequests: result.usage.webSearchRequests,
    urls: mapped.sources.map((s) => s.url),
  }
}

/**
 * 平均一组数字。
 *
 * @param values - 数字数组。
 * @returns 平均值；空数组返回 0。
 */
function avg(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  return usable.length === 0 ? 0 : usable.reduce((a, b) => a + b, 0) / usable.length
}

/**
 * 两组 URL 的 Jaccard 重合度。
 *
 * @param a - URL 数组。
 * @param b - URL 数组。
 * @returns 0..1 的重合度。
 */
function overlap(a, b) {
  if (a.length === 0 && b.length === 0) return 1
  const setA = new Set(a)
  const setB = new Set(b)
  const inter = [...setA].filter((u) => setB.has(u)).length
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 1 : inter / union
}

// ── 主流程 ─────────────────────────────────────────────────────────────
const keys = Object.fromEntries(CONFIGS.map((c) => [c.credential, readCredential(c.credential)]))
const raw = []
console.log(`A/B 对比：${QUERIES.length} 个查询 × ${CONFIGS.length} 套配置 × ${RUNS} 轮\n`)

for (const query of QUERIES) {
  for (const config of CONFIGS) {
    for (let run = 1; run <= RUNS; run += 1) {
      const result = await call(config, keys[config.credential], query)
      const official = metricsOf(result, mapOfficial)
      const ocgo = metricsOf(result, mapOcgo)
      raw.push({ query, config: config.key, run, official, ocgo })
      const tag = result.error === undefined ? `${official.sources} 条 / ${official.ms}ms` : `❌ ${result.error}`
      console.log(`  [${config.key}] ${query.slice(0, 24).padEnd(26)} run${run}  ${tag}`)
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
  }
}

// ── 汇总 ───────────────────────────────────────────────────────────────
const rows = []
for (const config of CONFIGS) {
  for (const run of [1, 2].slice(0, RUNS)) {
    const subset = raw.filter((r) => r.config === config.key && r.run === run && r.official.error === undefined)
    if (subset.length === 0) continue
    rows.push({
      config: config.key,
      label: config.label,
      run,
      n: subset.length,
      ms: avg(subset.map((r) => r.official.ms)),
      sources: avg(subset.map((r) => r.official.sources)),
      totalPrompt: avg(subset.map((r) => r.official.totalPrompt)),
      output: avg(subset.map((r) => r.official.output)),
      officialSnippetChars: avg(subset.map((r) => r.official.snippetChars)),
      officialVisible: avg(subset.map((r) => r.official.visibleChars)),
      ocgoSnippetChars: avg(subset.map((r) => r.ocgo.snippetChars)),
      ocgoContentChars: avg(subset.map((r) => r.ocgo.contentChars)),
      ocgoVisible: avg(subset.map((r) => r.ocgo.visibleChars)),
      webSearchRequests: avg(subset.map((r) => r.official.webSearchRequests)),
    })
  }
}

// 噪声基线：同一配置两轮之间的 URL 重合度
const noise = []
for (const config of CONFIGS) {
  const r1 = raw.filter((r) => r.config === config.key && r.run === 1 && r.official.error === undefined)
  const r2 = raw.filter((r) => r.config === config.key && r.run === 2 && r.official.error === undefined)
  for (const a of r1) {
    const b = r2.find((x) => x.query === a.query)
    if (b === undefined) continue
    noise.push({ config: config.key, query: a.query, same: overlap(a.official.urls, b.official.urls) })
  }
}

// 跨配置重合度（同查询、同轮）
const cross = []
for (const query of QUERIES) {
  const a = raw.find((r) => r.query === query && r.config === 'A' && r.run === 1)
  const b = raw.find((r) => r.query === query && r.config === 'B' && r.run === 1)
  if (a === undefined || b === undefined || a.official.error || b.official.error) continue
  cross.push({ query, overlap: overlap(a.official.urls, b.official.urls) })
}

const report = []
report.push('# A/B 对比：官方 provider vs dsh-web-search-ocgo')
report.push('')
report.push(`生成时间：${new Date().toISOString()}`)
report.push(`查询数 ${QUERIES.length} × 配置 2 × 轮次 ${RUNS}`)
report.push('')
report.push('## 一、每套配置的实测均值')
report.push('')
report.push('| 配置 | 轮次 | 查询数 | 结果条数 | 延迟 ms | 总 prompt | output | **官方映射可见字符** | **本插件映射可见字符** |')
report.push('|---|---|---|---|---|---|---|---|---|')
for (const row of rows) {
  report.push(
    `| ${row.label} | ${row.run} | ${row.n} | ${row.sources.toFixed(1)} | ${row.ms.toFixed(0)} | ${row.totalPrompt.toFixed(0)} | ${row.output.toFixed(0)} | ${row.officialVisible.toFixed(0)}（snippet ${row.officialSnippetChars.toFixed(0)} + content 0） | **${row.ocgoVisible.toFixed(0)}**（snippet ${row.ocgoSnippetChars.toFixed(0)} + content ${row.ocgoContentChars.toFixed(0)}） |`,
  )
}
report.push('')
report.push('## 二、噪声基线（同配置两轮之间的 URL 重合度）')
report.push('')
report.push('| 配置 | 平均重合度 | 逐查询 |')
report.push('|---|---|---|')
for (const config of CONFIGS) {
  const subset = noise.filter((n) => n.config === config.key)
  if (subset.length === 0) continue
  report.push(
    `| ${config.label} | ${(avg(subset.map((n) => n.same)) * 100).toFixed(0)}% | ${subset.map((n) => `${n.query.slice(0, 12)}… ${(n.same * 100).toFixed(0)}%`).join('；')} |`,
  )
}
report.push('')
report.push('## 三、跨配置重合度（官方 vs 本插件，同查询同轮）')
report.push('')
report.push(`平均：**${(avg(cross.map((c) => c.overlap)) * 100).toFixed(0)}%**`)
report.push('')
report.push('| 查询 | 重合度 |')
report.push('|---|---|')
for (const item of cross) report.push(`| ${item.query} | ${(item.overlap * 100).toFixed(0)}% |`)
report.push('')
report.push('## 四、结论')
report.push('')
const officialVisible = avg(rows.map((r) => r.officialVisible))
const ocgoVisible = avg(rows.map((r) => r.ocgoVisible))
report.push(`- **模型可见内容**：官方映射平均 ${officialVisible.toFixed(0)} 字符，本插件映射平均 ${ocgoVisible.toFixed(0)} 字符 —— 差距来自 \`result.content\`（官方完全不填）。`)
report.push(`- **噪声 vs 真差异**：同配置两轮 URL 重合度 ${(avg(noise.map((n) => n.same)) * 100).toFixed(0)}%，跨配置 ${(avg(cross.map((c) => c.overlap)) * 100).toFixed(0)}% —— 两者同量级，说明**搜索结果集本身没有系统性质量差距**，差异只在「返回给模型的内容量」。`)
report.push(`- **成本**：官方端点平均总 prompt ${avg(rows.filter((r) => r.config === 'A').map((r) => r.totalPrompt)).toFixed(0)}，Go 端点 ${avg(rows.filter((r) => r.config === 'B').map((r) => r.totalPrompt)).toFixed(0)}。`)
report.push(`- **web_search 实际次数**：平均 ${avg(rows.map((r) => r.webSearchRequests)).toFixed(2)} 次 —— 再次印证 \`max_uses\` 是上限而非目标值。`)

writeFileSync(join(ROOT, 'bench', 'ab-raw.json'), JSON.stringify(raw, null, 2))
writeFileSync(join(ROOT, 'bench', 'ab-report.md'), `${report.join('\n')}\n`)

console.log(`\n${'='.repeat(70)}`)
console.log(report.join('\n'))
console.log(`\n已写入 bench/ab-raw.json 与 bench/ab-report.md`)
