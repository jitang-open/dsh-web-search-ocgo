/**
 * index.js 的契约测试：插件注册，以及「响应统计绝不写会话日志」这条硬约束。
 *
 * 背景：旧版额外写自定义事件 `web/ocgo-search-response`（延迟 / token / 结果数），
 * 该类型不在 harness 的 `KNOWN_SESSION_EVENT_TYPES` 里，又没有 `ignorable: true`
 * 标记 —— 只要有一条，**整份会话日志就会被读路径拒绝加载**（用户看到的是
 * 「历史加载失败：… unknown to this harness and not marked ignorable」）。
 *
 * 根因还包括写侧缺口：`Session.append(type, data, ...opts)` 只接受
 * `surfaceOp` / `sourceEventSeqs`，根本没有 `ignorable` 入口，仓库外插件没有
 * 正规途径写"可忽略事件"。所以本插件改为只写请求事件（与官方 provider 一致），
 * 响应统计走 logger / console。
 *
 * 这个测试把该结论锁死，防止将来有人把事件加回去。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../index.js'
import { REQUEST_EVENT } from '../lib/constants.js'

/** 一份能通过装载自检的配置值。 */
const CONFIG_VALUES = {
  apiKey: 'test-key',
  apiKeyEnv: 'OPENCODE_API_KEY',
  baseURL: 'https://opencode.ai/zen/go/v1',
  model: 'deepseek-v4.1-flash',
  apiVersion: '2023-06-01',
  maxTokens: 4096,
  maxUses: 5,
  sessionId: '',
  clientHeader: 'dsh',
  fallbackEnabled: false,
  fallbackBaseURL: 'https://api.deepseek.com/anthropic/v1',
  fallbackModel: 'deepseek-flash',
  fallbackApiKeyEnv: 'DEEPSEEK_API_KEY',
  fallbackApiKey: '',
  cacheEnabled: false,
  cacheTtlMs: 0,
  cacheMaxEntries: 0,
  snippetMaxChars: 300,
  answerMaxChars: 500,
  retryCount: 0,
}

/**
 * 造一个成功的 Messages 响应体。
 *
 * @returns Messages 响应体。
 */
function okBody() {
  return {
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
    content: [
      {
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://a.test/1', title: 'A' }],
      },
      { type: 'text', text: '总结' },
    ],
  }
}

/**
 * 造一个足以驱动 `apply()` 的假 ctx，并记录所有会话事件写入。
 *
 * @returns `{ ctx, appended, providerOf }`。
 */
function makeCtx() {
  const appended = []
  const session = {
    append(type, data) {
      appended.push({ type, data })
    },
  }
  let provider
  const ctx = {
    get(name) {
      if (name === 'agents') return { currentInitiator: () => ({ session }) }
      return undefined
    },
    web: {
      registerSearchProvider(registered) {
        provider = registered
      },
    },
  }
  return { ctx, appended, providerOf: () => provider }
}

/**
 * 造一个 schemastery 风格的只读配置桩。
 *
 * @param values - 各配置字段的值。
 * @returns 带 `.get()` 的配置对象。
 */
function makeConfig(values = CONFIG_VALUES) {
  return new Proxy({}, { get: (_target, key) => ({ get: () => values[key] }) })
}

test('index：注册 provider，且只写请求事件、不写任何自定义会话事件', async () => {
  const { ctx, appended, providerOf } = makeCtx()
  apply(ctx, makeConfig())

  const provider = providerOf()
  assert.ok(provider !== undefined, 'provider 应已注册到 ctx.web')
  assert.equal(provider.id, 'opencode-go')

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => okBody() })
  await provider.search({ query: '测试查询' }, undefined)

  const types = appended.map((entry) => entry.type)
  assert.deepEqual(
    types,
    [REQUEST_EVENT],
    `只应写请求事件 ${REQUEST_EVENT}，实际写了：${types.length === 0 ? '（什么都没写）' : types.join('、')}`,
  )
  assert.ok(
    !types.some((type) => type.startsWith('web/ocgo')),
    '不得再写本插件自定义事件 —— 未标 ignorable 的自定义类型会让整份会话日志拒绝加载',
  )
})

test('index：缓存命中路径同样不写自定义事件', async () => {
  const values = { ...CONFIG_VALUES, cacheEnabled: true, cacheTtlMs: 60_000, cacheMaxEntries: 4 }
  const { ctx, appended, providerOf } = makeCtx()
  apply(ctx, makeConfig(values))
  const provider = providerOf()

  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => okBody() }
  }

  await provider.search({ query: '同一查询' }, undefined)
  await provider.search({ query: '同一查询' }, undefined)

  assert.equal(calls, 1, '第二次应命中缓存，不再发请求')
  // 缓存命中不派发请求，所以也不留请求痕迹（recordRequest 只在真正发 fetch 前调用）。
  const types = appended.map((entry) => entry.type)
  assert.deepEqual(types, [REQUEST_EVENT], `只应写一条请求事件，实际：${types.join('、')}`)
})
