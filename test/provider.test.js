/**
 * provider 的单元测试：请求形状、会话头、重试、官方端点回退、缓存集成、凭据缺失。
 *
 * 用假的 `globalThis.fetch` 驱动，不产生任何真实网络请求。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createQueryCache } from '../lib/cache.js'
import { WEB_PROVIDER_CREDENTIAL_MISSING, WEB_PROVIDER_ERROR } from '../lib/errors.js'
import { createSearchProvider } from '../lib/provider.js'

/** 一份能通过 `available()` 的默认选项。 */
function makeOptions(overrides = {}) {
  return {
    apiKey: '',
    apiKeyEnv: 'OPENCODE_API_KEY',
    baseURL: 'https://opencode.ai/zen/go/v1',
    model: 'deepseek-v4.1-flash',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
    sessionId: '11111111-2222-4333-8444-555555555555',
    clientHeader: 'dsh',
    fallbackEnabled: true,
    fallbackBaseURL: 'https://api.deepseek.com/anthropic/v1',
    fallbackModel: 'deepseek-flash',
    fallbackApiKeyEnv: 'DEEPSEEK_API_KEY',
    fallbackApiKey: '',
    snippetMaxChars: 300,
    answerMaxChars: 500,
    retryCount: 0,
    recordRequest: () => {},
    recordResponse: () => {},
    ...overrides,
  }
}

/**
 * 造一个成功的响应体。
 *
 * @param text - `text` 块内容。
 * @returns Messages 响应体。
 */
function okBody(text = '模型总结') {
  return {
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
    content: [
      {
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://a.test/1', title: 'A' }],
      },
      { type: 'text', text },
    ],
  }
}

/**
 * 造一个 provider 与它依赖的假上下文。
 *
 * @param handler - 假的 fetch 实现。
 * @param config - 覆盖 provider 选项。
 * @returns `{ provider, requests, events }`。
 */
function makeProvider(handler, config = {}) {
  const requests = []
  const events = { request: [], response: [] }
  const credentials = { OPENCODE_API_KEY: 'go-key', DEEPSEEK_API_KEY: 'ds-key' }
  const ctx = {
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        async resolve(ref) {
          const value = credentials[ref]
          return value === undefined ? undefined : { value }
        },
      }
    },
  }
  const options = makeOptions({
    ...config,
    recordRequest: (payload) => events.request.push(payload),
    recordResponse: (payload) => events.response.push(payload),
  })
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body), headers: init.headers })
    return handler(url, init, requests.length)
  }
  const provider = createSearchProvider({
    ctx,
    resolveOptions: () => options,
    cache: createQueryCache({
      resolveEnabled: () => config.cacheEnabled ?? true,
      resolveTtlMs: () => 300_000,
      resolveMaxEntries: () => 50,
    }),
  })
  return { provider, requests, events, options }
}

/**
 * 造一个指定状态码的响应。
 *
 * @param status - HTTP 状态码。
 * @param body - 响应体文本。
 * @returns `Response`。
 */
function reply(status, body = '{}') {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

const originalFetch = globalThis.fetch
test.after(() => {
  globalThis.fetch = originalFetch
})

test('provider：成功路径 —— 请求形状、会话头、结果映射、响应事件', async () => {
  const { provider, requests, events } = makeProvider(() => reply(200, JSON.stringify(okBody('这是总结'))))

  const result = await provider.search({ query: '测试查询', maxResults: 10 })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://opencode.ai/zen/go/v1/messages')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.redirect, 'error')

  // 会话头是 Go 端点的硬要求（缺失即 400 MissingSessionID）。
  assert.equal(requests[0].headers['x-opencode-session'], '11111111-2222-4333-8444-555555555555')
  assert.equal(requests[0].headers['x-opencode-client'], 'dsh')
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01')
  assert.equal(requests[0].headers.authorization, 'Bearer go-key')

  // 请求体形状。
  assert.equal(requests[0].body.model, 'deepseek-v4.1-flash')
  assert.equal(requests[0].body.tools[0].type, 'web_search_20250305')
  assert.equal(requests[0].body.tools[0].max_uses, 5)
  assert.equal(requests[0].body.messages[0].content[0].text, 'Perform a web search for the query: 测试查询')

  // 结果。
  assert.equal(result.sources.length, 1)
  assert.equal(result.content, '这是总结')

  // 事件：请求一条、响应一条。
  assert.equal(events.request.length, 1)
  assert.equal(events.request[0].endpoint, 'https://opencode.ai/zen/go/v1/messages')
  assert.equal(events.response.length, 1)
  assert.equal(events.response[0].fallback, false)
  assert.equal(events.response[0].cached, false)
  assert.equal(events.response[0].sourceCount, 1)
  assert.equal(events.response[0].answerChars, 4)
  assert.equal(events.response[0].webSearchRequests, 1)
})

test('provider：可重试状态码会退避重试，第二次成功', async () => {
  const { provider, requests } = makeProvider(
    (url, init, count) =>
      count === 1 ? reply(429, '{"error":{"message":"rate limited"}}') : reply(200, JSON.stringify(okBody())),
    { retryCount: 1 },
  )

  const result = await provider.search({ query: 'q' })

  assert.equal(requests.length, 2, '应重试一次')
  assert.equal(result.sources.length, 1)
})

test('provider：不带重试时 429 直接抛出，且错误里带状态码与端点说明', async () => {
  // 关掉回退，这样断言的就是「Go 端点自身不重试」。
  const { provider, requests } = makeProvider(() => reply(429, '{"error":{"message":"rate limited"}}'), {
    fallbackEnabled: false,
  })

  await assert.rejects(() => provider.search({ query: 'q' }), (error) => {
    assert.equal(error.code, WEB_PROVIDER_ERROR)
    assert.match(error.message, /HTTP 429/u)
    assert.match(error.message, /rate limited/u)
    return true
  })
  assert.equal(requests.length, 1)
})

test('provider：不可重试的 4xx 在 Go 端点侧不重试（回退仍会尝试官方端点）', async () => {
  const { provider, requests } = makeProvider(() => reply(400, '{"error":{"message":"MissingSessionID"}}'), {
    retryCount: 3,
  })

  await assert.rejects(() => provider.search({ query: 'q' }), /HTTP 400/u)

  const goRequests = requests.filter((entry) => entry.url.includes('opencode.ai'))
  assert.equal(goRequests.length, 1, '400 不在可重试集合里，Go 端点只该被请求一次')
  assert.equal(requests.length, 2, '第一次是 Go，第二次是回退官方端点')
  assert.equal(requests[1].url, 'https://api.deepseek.com/anthropic/v1/messages')
})

test('provider：Go 端点失败后回退官方端点，并如实标注 fallback', async () => {
  const { provider, requests, events } = makeProvider((url) =>
    url.includes('opencode.ai')
      ? reply(503, '{"error":{"message":"upstream down"}}')
      : reply(200, JSON.stringify(okBody('回退拿到的总结'))),
  )

  const result = await provider.search({ query: 'q' })

  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://opencode.ai/zen/go/v1/messages')
  assert.equal(requests[1].url, 'https://api.deepseek.com/anthropic/v1/messages')
  // 官方端点不该带 OpenCode 专属头。
  assert.equal(requests[1].headers['x-opencode-session'], undefined)
  assert.equal(requests[1].headers.authorization, 'Bearer ds-key')
  // 回退用的模型必须是官方端点认得的那个。
  assert.equal(requests[1].body.model, 'deepseek-flash')

  assert.equal(result.content, '回退拿到的总结')
  assert.equal(events.response[0].fallback, true)
  assert.equal(events.response[0].model, 'deepseek-flash')
})

test('provider：关掉回退时失败直接抛出，不做第二次请求', async () => {
  const { provider, requests } = makeProvider(() => reply(500, '{}'), { fallbackEnabled: false })

  await assert.rejects(() => provider.search({ query: 'q' }), /HTTP 500/u)
  assert.equal(requests.length, 1)
})

test('provider：回退端点缺凭据时报错里说明回退被跳过', async () => {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push(url)
    return reply(500, '{}')
  }
  const provider = createSearchProvider({
    ctx: {
      get: (name) =>
        name === 'credentials'
          ? { resolve: async (ref) => (ref === 'OPENCODE_API_KEY' ? { value: 'go-key' } : undefined) }
          : undefined,
    },
    resolveOptions: () => makeOptions(),
    cache: createQueryCache({
      resolveEnabled: () => true,
      resolveTtlMs: () => 1000,
      resolveMaxEntries: () => 10,
    }),
  })

  await assert.rejects(() => provider.search({ query: 'q' }), (error) => {
    assert.match(error.message, /Fallback to the official endpoint was skipped/u)
    assert.match(error.message, /DEEPSEEK_API_KEY/u)
    return true
  })
  assert.equal(requests.length, 1)
})

test('provider：主端点缺凭据时报 WEB_PROVIDER_CREDENTIAL_MISSING', async () => {
  const provider = createSearchProvider({
    ctx: { get: () => undefined },
    resolveOptions: () => makeOptions({ apiKeyEnv: 'NO_SUCH_REF' }),
    cache: createQueryCache({
      resolveEnabled: () => true,
      resolveTtlMs: () => 1000,
      resolveMaxEntries: () => 10,
    }),
  })

  await assert.rejects(() => provider.search({ query: 'q' }), (error) => {
    assert.equal(error.code, WEB_PROVIDER_CREDENTIAL_MISSING)
    assert.match(error.message, /NO_SUCH_REF/u)
    return true
  })
})

test('provider：字面 apiKey 优先于凭据引用', async () => {
  const { provider, requests } = makeProvider(() => reply(200, JSON.stringify(okBody())), {
    apiKey: 'literal-key',
  })

  await provider.search({ query: 'q' })
  assert.equal(requests[0].headers['x-api-key'], 'literal-key')
})

test('provider：第二次相同查询命中缓存，不再发请求', async () => {
  const { provider, requests, events } = makeProvider(() => reply(200, JSON.stringify(okBody())))

  const first = await provider.search({ query: '同一个查询', maxResults: 10 })
  const second = await provider.search({ query: '同一个查询', maxResults: 10 })

  assert.equal(requests.length, 1, '第二次应命中缓存')
  assert.deepEqual(second.sources, first.sources)
  assert.equal(events.response.length, 2)
  assert.equal(events.response[0].cached, false)
  assert.equal(events.response[1].cached, true)
  assert.equal(events.response[1].inputTokens, 0, '缓存命中即 0 token')
})

test('provider：结果里没有 web_search_tool_result 块时报错', async () => {
  const { provider } = makeProvider(() =>
    reply(200, JSON.stringify({ content: [{ type: 'text', text: '我直接回答了' }] })),
  )

  await assert.rejects(() => provider.search({ query: 'q' }), (error) => {
    assert.equal(error.code, WEB_PROVIDER_ERROR)
    assert.match(error.message, /no web_search_tool_result/u)
    return true
  })
})

test('provider：available() 反映配置是否够用', () => {
  const good = makeProvider(() => reply(200, '{}')).provider
  assert.equal(good.available(), true)

  const badUrl = createSearchProvider({
    ctx: { get: () => undefined },
    resolveOptions: () => makeOptions({ baseURL: '不是 URL' }),
    cache: createQueryCache({
      resolveEnabled: () => true,
      resolveTtlMs: () => 1,
      resolveMaxEntries: () => 1,
    }),
  })
  assert.equal(badUrl.available(), false)

  const noCredential = createSearchProvider({
    ctx: { get: () => undefined },
    resolveOptions: () => makeOptions({ apiKeyEnv: '' }),
    cache: createQueryCache({
      resolveEnabled: () => true,
      resolveTtlMs: () => 1,
      resolveMaxEntries: () => 1,
    }),
  })
  assert.equal(noCredential.available(), false)
})

test('provider：provider id 是 opencode-go', () => {
  assert.equal(makeProvider(() => reply(200, '{}')).provider.id, 'opencode-go')
})
