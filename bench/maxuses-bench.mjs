// maxUses 成本/质量曲线基准脚本（阶段 0 spike #3）
// 用法: node maxuses-bench.mjs [--dry]
// 输出: bench/maxuses-raw.json
//
// 协议: POST https://opencode.ai/zen/go/v1/messages
//       tools: [{ type: "web_search_20250305", name: "web_search", max_uses: N }]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '/Users/mac/.dsh/profiles/web/node_modules/js-yaml/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_OUT = path.join(__dirname, 'maxuses-raw.json');
const CREDS = '/Users/mac/.dsh/.credentials.yaml';
const ENDPOINT = 'https://opencode.ai/zen/go/v1/messages';

// —— 凭据：只在内存中使用，绝不写盘/打印 ——
const creds = yaml.load(fs.readFileSync(CREDS, 'utf8'));
const KEY = creds.refs?.OPENCODE_API_KEY;
if (!KEY) throw new Error('OPENCODE_API_KEY 未找到');
if (KEY.length !== 67) console.warn(`[warn] key 长度 ${KEY.length}（预期 67）`);

// —— 固定会话 UUID：模拟「会话头稳定化」，同时观察 Go 侧 prompt cache ——
const SESSION_UUID = 'd5b0a1c2-7f31-4e88-9a04-6b2c1f0d3e57';

const QUERIES = [
  'DeepSeek Harness 0.1.7 更新内容',
  'leeyoung1 dsh-web-search-opencode-go',
  'dsh 插件市场 网页搜索 provider',
  'OpenCode Go 订阅 额度 限制',
];
const MAX_USES = [1, 2, 3, 5];
const RUNS = 2;
const MAX_TOKENS = 4096;
const MODEL = 'deepseek-v4.1-flash';
const SLEEP_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function analyze(j) {
  const content = Array.isArray(j?.content) ? j.content : [];
  const textBlocks = content.filter((b) => b?.type === 'text');
  const serverToolUse = content.filter((b) => b?.type === 'server_tool_use');
  const searchResultBlocks = content.filter((b) => b?.type === 'web_search_tool_result');
  const thinkingBlocks = content.filter((b) => b?.type === 'thinking');

  // 结果条数（去重后 url 数）
  const items = searchResultBlocks.flatMap((b) => (Array.isArray(b.content) ? b.content : []));
  const urls = new Set();
  let malformedResultBlocks = 0;
  for (const b of searchResultBlocks) {
    if (!Array.isArray(b.content)) malformedResultBlocks += 1; // 例如 {type:"web_search_tool_result_error"}
  }
  for (const it of items) if (it?.url) urls.add(it.url);

  // web_search_result.content 非空条数
  let contentNonEmpty = 0;
  let contentChars = 0;
  for (const it of items) {
    const c = typeof it?.content === 'string' ? it.content.trim() : '';
    if (c) {
      contentNonEmpty += 1;
      contentChars += c.length;
    }
  }

  // citations[].cited_text 条数
  let citedTextCount = 0;
  let citationsTotal = 0;
  for (const b of textBlocks) {
    const cites = Array.isArray(b?.citations) ? b.citations : [];
    citationsTotal += cites.length;
    for (const c of cites) {
      const t = typeof c?.cited_text === 'string' ? c.cited_text.trim() : '';
      if (t) citedTextCount += 1;
    }
  }

  // 错误块
  const errorBlocks = searchResultBlocks
    .filter((b) => !Array.isArray(b.content))
    .map((b) => b.content?.error_code ?? b.content?.type ?? 'unknown');

  const u = j?.usage ?? {};
  return {
    stopReason: j?.stop_reason ?? null,
    resultCount: urls.size,
    rawItemCount: items.length,
    contentNonEmptyCount: contentNonEmpty,
    contentChars,
    citedTextCount,
    citationsTotal,
    textBlockCount: textBlocks.length,
    thinkingBlockCount: thinkingBlocks.length,
    serverToolUseCount: serverToolUse.length,
    searchResultBlockCount: searchResultBlocks.length,
    malformedResultBlocks,
    errorBlocks,
    usage: {
      input_tokens: num(u.input_tokens),
      output_tokens: num(u.output_tokens),
      cache_read_input_tokens: num(u.cache_read_input_tokens),
      cache_creation_input_tokens: num(u.cache_creation_input_tokens),
      server_tool_use: u.server_tool_use ?? null,
      raw_keys: Object.keys(u),
    },
    urls: [...urls],
  };
}

async function once({ query, maxUses, run }) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] },
    ],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
  };
  const headers = {
    'x-api-key': KEY,
    authorization: `Bearer ${KEY}`,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'dsh-research/1.0',
    'x-opencode-session': SESSION_UUID,
    'x-opencode-client': 'dsh',
  };

  const t0 = Date.now();
  const rec = { maxUses, query, run, sessionUUID: SESSION_UUID, httpStatus: null, latencyMs: null, ok: false };
  let attempts = 0;
  while (attempts < 2) {
    attempts += 1;
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body) });
      const elapsed = Date.now() - t0;
      const txt = await res.text();
      let j = null;
      try {
        j = JSON.parse(txt);
      } catch {
        /* 非 JSON */
      }
      rec.httpStatus = res.status;
      rec.latencyMs = elapsed;
      rec.attempts = attempts;
      if (res.ok && j) {
        rec.ok = true;
        Object.assign(rec, analyze(j));
        rec.usageBody = j.usage ?? null;
      } else {
        rec.ok = false;
        rec.errorText = String(txt).slice(0, 600);
        // 429/5xx：最多重试 1 次（总计不超过 2 次尝试）
        if ((res.status === 429 || res.status >= 500) && attempts < 2) {
          console.warn(`  [retry] HTTP ${res.status} → 1 次重试`);
          await sleep(2500);
          continue;
        }
      }
      break;
    } catch (e) {
      rec.latencyMs = Date.now() - t0;
      rec.attempts = attempts;
      rec.ok = false;
      rec.errorText = `network: ${e?.message ?? String(e)}`;
      if (attempts < 2) {
        await sleep(2500);
        continue;
      }
      break;
    }
  }
  return rec;
}

// —— 主流程：串行 ——
const dry = process.argv.includes('--dry');
const total = QUERIES.length * MAX_USES.length * RUNS;
if (dry) {
  console.log(`[dry] sessionUUID=${SESSION_UUID} 总请求数=${total}`);
  console.log(`[dry] queries=${QUERIES.length} maxUses=${MAX_USES.join(',')} runs=${RUNS}`);
  process.exit(0);
}

const records = [];
let i = 0;
for (const query of QUERIES) {
  for (const maxUses of MAX_USES) {
    for (let run = 1; run <= RUNS; run += 1) {
      i += 1;
      process.stdout.write(`[${String(i).padStart(2)}/${total}] max_uses=${maxUses} run=${run} q="${query}" … `);
      const rec = await once({ query, maxUses, run });
      records.push(rec);
      if (rec.ok) {
        const u = rec.usage;
        console.log(
          `HTTP ${rec.httpStatus} ${rec.latencyMs}ms | ${rec.resultCount}条 content非空${rec.contentNonEmptyCount} cited${rec.citedTextCount} | in ${u.input_tokens} out ${u.output_tokens} cacheR ${u.cache_read_input_tokens} cacheW ${u.cache_creation_input_tokens}`,
        );
      } else {
        console.log(`HTTP ${rec.httpStatus} FAIL: ${String(rec.errorText).slice(0, 160)}`);
      }
      if (i < total) await sleep(SLEEP_MS);
    }
  }
}

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    model: MODEL,
    maxTokens: MAX_TOKENS,
    sessionUUID: SESSION_UUID,
    queries: QUERIES,
    maxUses: MAX_USES,
    runs: RUNS,
    totalRequests: total,
    sleepMs: SLEEP_MS,
    note: '同一 session UUID 串行执行；cache 字段来自响应 usage。key 不落盘。',
  },
  records,
};
fs.writeFileSync(RAW_OUT, JSON.stringify(payload, null, 2));
console.log(`\n写入 ${RAW_OUT} （${records.length} 条记录）`);
const fails = records.filter((r) => !r.ok);
console.log(`失败 ${fails.length} 条${fails.length ? '：' + JSON.stringify(fails.map((f) => ({ s: f.httpStatus, m: f.maxUses, q: f.query, e: String(f.errorText).slice(0, 120) }))) : ''}`);
