/**
 * 原始响应结构 dump：直接打 OpenCode Go，把 `content[]` 每个块的字段清单打出来。
 *
 * 用途：确认 `web_search_result` 到底带不带 `content` / `page_age`，
 * `text` 块带不带 `citations` —— 这决定 P2「摘要覆盖率」该怎么优化。
 *
 * 用法：node bench/dump-response.mjs "查询词"
 * 凭据：~/.dsh/.credentials.yaml 的 OPENCODE_API_KEY
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CREDENTIALS = join(homedir(), '.dsh', '.credentials.yaml')
const ENDPOINT = 'https://opencode.ai/zen/go/v1/messages'
const MODEL = 'deepseek-v4.1-flash'

/**
 * 从凭据文件里取一个 ref 的值（够用的行解析，不引 yaml 依赖）。
 *
 * @param ref - 凭据名。
 * @returns 密钥字符串。
 */
function readCredential(ref) {
  const text = readFileSync(CREDENTIALS, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (!new RegExp(`^\\s*${ref}\\s*:`).test(lines[i])) continue
    const inline = lines[i].split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/gu, '')
    if (inline.length > 0) return inline
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].trim()
      if (next.length === 0) continue
      if (!/^\s/.test(lines[j])) break
      return next.replace(/^['"]|['"]$/gu, '')
    }
  }
  throw new Error(`凭据 ${ref} 未找到`)
}

/**
 * 描述一个值的形状，不打印内容（避免把网页正文全打出来）。
 *
 * @param value - 任意值。
 * @returns 形状描述。
 */
function shapeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'string') return `string(len=${value.length})`
  return typeof value
}

const query = process.argv[2] ?? 'DeepSeek Harness 0.1.7 更新内容'
const apiKey = readCredential('OPENCODE_API_KEY')

const body = {
  model: MODEL,
  max_tokens: 4096,
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }],
    },
  ],
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
}

const started = Date.now()
const response = await fetch(ENDPOINT, {
  method: 'POST',
  redirect: 'error',
  headers: {
    'x-api-key': apiKey,
    authorization: `Bearer ${apiKey}`,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    accept: 'application/json',
    'x-opencode-session': crypto.randomUUID(),
    'x-opencode-client': 'dsh',
  },
  body: JSON.stringify(body),
})

console.log(`HTTP ${response.status}  ${Date.now() - started} ms`)
const payload = await response.json()
if (!response.ok) {
  console.log(JSON.stringify(payload, null, 2).slice(0, 2000))
  process.exit(1)
}

console.log(`\n顶层字段: ${Object.keys(payload).join(', ')}`)
console.log(`usage: ${JSON.stringify(payload.usage)}`)
console.log(`stop_reason: ${payload.stop_reason}`)

const blocks = payload.content ?? []
console.log(`\ncontent 块数 = ${blocks.length}`)
for (const [index, block] of blocks.entries()) {
  const keys = Object.keys(block)
  console.log(`\n[${index}] type=${block.type}  字段=[${keys.join(', ')}]`)
  if (block.type === 'text') {
    const citations = block.citations ?? []
    console.log(`    text 长度=${(block.text ?? '').length}  citations=${citations.length}`)
    if (citations.length > 0) {
      console.log(`    citation 字段=[${Object.keys(citations[0]).join(', ')}]`)
      console.log(`    首条 cited_text 长度=${(citations[0].cited_text ?? '').length}`)
    }
  }
  if (block.type === 'server_tool_use') {
    console.log(`    name=${block.name} input=${JSON.stringify(block.input)}`)
  }
  if (block.type === 'web_search_tool_result') {
    const items = block.content ?? []
    console.log(`    结果条数=${items.length}`)
    if (items.length > 0) {
      console.log(`    每条字段=[${Object.keys(items[0]).join(', ')}]`)
      for (const [i, item] of items.slice(0, 3).entries()) {
        console.log(
          `    #${i} url=${String(item.url).slice(0, 70)}  title=${String(item.title ?? '').slice(0, 50)}`,
        )
        console.log(
          `        content=${shapeOf(item.content)}  page_age=${JSON.stringify(item.page_age)}  其它=${Object.keys(item).filter((k) => !['type', 'url', 'title', 'content', 'page_age'].includes(k)).join(',') || '(无)'}`,
        )
      }
    }
  }
}
