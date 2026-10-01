/**
 * 查询缓存的单元测试：命中、TTL 过期、LRU 淘汰、开关与统计。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createQueryCache } from '../lib/cache.js'

/** 一份最小可用的 provider 选项，缓存键会用到其中几个字段。 */
const OPTIONS = {
  baseURL: 'https://opencode.ai/zen/go/v1',
  model: 'deepseek-v4.1-flash',
  maxUses: 5,
  maxTokens: 4096,
  snippetMaxChars: 300,
}

/**
 * 造一个可手动推进时间的缓存。
 *
 * @param overrides - 覆盖默认开关。
 * @returns `{ cache, tick, now }`。
 */
function makeCache(overrides = {}) {
  let current = 1_000_000
  const cache = createQueryCache({
    resolveEnabled: () => overrides.enabled ?? true,
    resolveTtlMs: () => overrides.ttlMs ?? 300_000,
    resolveMaxEntries: () => overrides.maxEntries ?? 50,
    now: () => current,
  })
  return { cache, tick: (ms) => (current += ms), now: () => current }
}

/** 一个可辨识的假结果。 */
const RESULT = { sources: [{ url: 'https://a.test/1' }], truncated: false }

test('缓存：写入后能命中，未写过则未命中', () => {
  const { cache } = makeCache()
  const request = { query: '第一个查询' }

  assert.equal(cache.get(request, OPTIONS), undefined)
  cache.set(request, OPTIONS, RESULT)
  assert.deepEqual(cache.get(request, OPTIONS), RESULT)
  assert.deepEqual(cache.stats(), { size: 1, hits: 1, misses: 1 })
})

test('缓存：不同查询词互不干扰', () => {
  const { cache } = makeCache()
  cache.set({ query: 'A' }, OPTIONS, RESULT)

  assert.equal(cache.get({ query: 'B' }, OPTIONS), undefined)
  assert.deepEqual(cache.get({ query: 'A' }, OPTIONS), RESULT)
})

test('缓存：端点或模型变了就不复用（键包含配置）', () => {
  const { cache } = makeCache()
  const request = { query: '同一个查询' }
  cache.set(request, OPTIONS, RESULT)

  assert.deepEqual(cache.get(request, OPTIONS), RESULT)
  assert.equal(cache.get(request, { ...OPTIONS, model: 'deepseek-v4-flash' }), undefined)
  assert.equal(cache.get(request, { ...OPTIONS, baseURL: 'https://api.deepseek.com/anthropic/v1' }), undefined)
  assert.equal(cache.get(request, { ...OPTIONS, maxUses: 2 }), undefined)
})

test('缓存：maxResults 不同视为不同条目', () => {
  const { cache } = makeCache()
  cache.set({ query: 'q', maxResults: 10 }, OPTIONS, RESULT)

  assert.equal(cache.get({ query: 'q', maxResults: 5 }, OPTIONS), undefined)
  assert.deepEqual(cache.get({ query: 'q', maxResults: 10 }, OPTIONS), RESULT)
})

test('缓存：TTL 到期后失效并计入未命中', () => {
  const { cache, tick } = makeCache({ ttlMs: 1000 })
  const request = { query: 'q' }
  cache.set(request, OPTIONS, RESULT)

  tick(999)
  assert.deepEqual(cache.get(request, OPTIONS), RESULT, '未到期应命中')

  tick(2)
  assert.equal(cache.get(request, OPTIONS), undefined, '到期后应失效')
  assert.equal(cache.stats().size, 0, '过期条目应被清掉')
})

test('缓存：超过上限时淘汰最久未使用的一条', () => {
  const { cache } = makeCache({ maxEntries: 2 })

  cache.set({ query: 'a' }, OPTIONS, { sources: [{ url: 'a' }], truncated: false })
  cache.set({ query: 'b' }, OPTIONS, { sources: [{ url: 'b' }], truncated: false })
  // 读一次 a，把 a 变成最近使用，于是 b 成为最久未使用。
  cache.get({ query: 'a' }, OPTIONS)
  cache.set({ query: 'c' }, OPTIONS, { sources: [{ url: 'c' }], truncated: false })

  assert.equal(cache.stats().size, 2)
  assert.equal(cache.get({ query: 'b' }, OPTIONS), undefined, 'b 应被淘汰')
  assert.notEqual(cache.get({ query: 'a' }, OPTIONS), undefined, 'a 应保留')
  assert.notEqual(cache.get({ query: 'c' }, OPTIONS), undefined, 'c 应保留')
})

test('缓存：关闭开关后既不写也不读', () => {
  const { cache } = makeCache({ enabled: false })
  const request = { query: 'q' }
  cache.set(request, OPTIONS, RESULT)

  assert.equal(cache.get(request, OPTIONS), undefined)
  assert.equal(cache.stats().size, 0)
})

test('缓存：TTL 为 0 或上限为 0 等同于关闭', () => {
  const zeroTtl = makeCache({ ttlMs: 0 }).cache
  zeroTtl.set({ query: 'q' }, OPTIONS, RESULT)
  assert.equal(zeroTtl.get({ query: 'q' }, OPTIONS), undefined)

  const zeroMax = makeCache({ maxEntries: 0 }).cache
  zeroMax.set({ query: 'q' }, OPTIONS, RESULT)
  assert.equal(zeroMax.get({ query: 'q' }, OPTIONS), undefined)
})

test('缓存：clear 清空内容但保留统计计数', () => {
  const { cache } = makeCache()
  const request = { query: 'q' }
  cache.set(request, OPTIONS, RESULT)
  cache.get(request, OPTIONS)

  cache.clear()
  assert.equal(cache.stats().size, 0)
  assert.equal(cache.stats().hits, 1)
})
