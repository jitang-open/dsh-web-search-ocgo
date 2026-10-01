/**
 * `mapResponse` 与 `normalizePublishedAt` 的单元测试。
 *
 * 这里用的响应形状是 `bench/dump-response.mjs` 从真实 Go 端点 dump 出来的：
 * `web_search_result` 的字段是 `[type, title, url, encrypted_content, page_age]`，
 * **没有 `content`**，`page_age` 是 `null`，`text` 块也没有 `citations`。
 * 测试同时覆盖「字段存在」与「字段缺失」两条路径。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WEB_PROVIDER_ERROR } from '../lib/errors.js'
import { mapResponse, normalizePublishedAt } from '../lib/provider.js'

/**
 * 构造一个贴近真实形状的响应。
 *
 * @param overrides - 覆盖 `content` 数组。
 * @returns 假的 Messages 响应体。
 */
function responseWith(content) {
  return {
    stop_reason: 'end_turn',
    usage: { input_tokens: 8517, output_tokens: 1030, server_tool_use: { web_search_requests: 1 } },
    content,
  }
}

test('mapResponse：去重、丢弃无 url 的项、保留 title', () => {
  const mapped = mapResponse(
    responseWith([
      { type: 'thinking', thinking: '推理' },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.test/1', title: 'A', page_age: null },
          { type: 'web_search_result', url: 'https://b.test/2', title: 'B' },
          { type: 'web_search_result', url: 'https://a.test/1', title: 'A 的重复项' },
          { type: 'web_search_result', url: '', title: '空 url' },
        ],
      },
    ]),
  )

  assert.equal(mapped.sources.length, 2, '重复 url 与空 url 都应被丢弃')
  assert.deepEqual(
    mapped.sources.map((source) => source.url),
    ['https://a.test/1', 'https://b.test/2'],
  )
  assert.equal(mapped.sources[0].title, 'A')
  assert.equal(mapped.truncated, false, 'truncated 恒为 false，截断由 web seam 负责')
})

test('mapResponse：没有 web_search_tool_result 块时必须报错', () => {
  assert.throws(
    () => mapResponse(responseWith([{ type: 'text', text: '我搜了一下' }])),
    (error) => {
      assert.equal(error.code, WEB_PROVIDER_ERROR)
      assert.equal(error.name, 'WebError')
      assert.match(error.message, /no web_search_tool_result/u)
      return true
    },
  )
})

test('mapResponse：摘要三级回退 —— item.content 优先，citations 次之，都没有则省略字段', () => {
  const mapped = mapResponse(
    responseWith([
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.test/1', content: '来自 item.content 的摘要' },
          { type: 'web_search_result', url: 'https://b.test/2' },
        ],
      },
      {
        type: 'text',
        text: '模型总结',
        citations: [{ url: 'https://b.test/2', cited_text: '来自 citation 的摘要' }],
      },
    ]),
  )

  assert.equal(mapped.sources[0].snippet, '来自 item.content 的摘要')
  assert.equal(mapped.sources[1].snippet, '来自 citation 的摘要')
})

test('mapResponse：snippetMaxChars 截断并加省略号', () => {
  const mapped = mapResponse(
    responseWith([
      {
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://a.test/1', content: 'x'.repeat(500) }],
      },
    ]),
    100,
  )

  assert.equal(mapped.sources[0].snippet.length, 101, '100 个字符 + 1 个省略号')
  assert.ok(mapped.sources[0].snippet.endsWith('…'))
})

test('mapResponse：answerMaxChars 为 0 时不返回 content 字段', () => {
  const mapped = mapResponse(
    responseWith([
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test/1' }] },
      { type: 'text', text: '这段总结不应出现' },
    ]),
    300,
    0,
  )

  assert.equal('content' in mapped, false, '关闭时不应留下空 content 键')
})

test('mapResponse：把多个 text 块拼成 result.content，thinking 块不参与', () => {
  const mapped = mapResponse(
    responseWith([
      { type: 'thinking', thinking: '这是推理过程，不该出现在 content 里' },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test/1' }] },
      { type: 'text', text: '第一段总结' },
      { type: 'text', text: '第二段总结' },
    ]),
    300,
    500,
  )

  assert.equal(mapped.content, '第一段总结\n\n第二段总结')
  assert.ok(!mapped.content.includes('推理过程'))
})

test('mapResponse：answerMaxChars 对 result.content 生效', () => {
  const mapped = mapResponse(
    responseWith([
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test/1' }] },
      { type: 'text', text: 'y'.repeat(4000) },
    ]),
    300,
    200,
  )

  assert.equal(mapped.content.length, 201)
  assert.ok(mapped.content.endsWith('…'))
})

test('mapResponse：text 块全为空时不返回 content', () => {
  const mapped = mapResponse(
    responseWith([
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test/1' }] },
      { type: 'text', text: '   ' },
    ]),
    300,
    500,
  )

  assert.equal('content' in mapped, false)
})

test('normalizePublishedAt：ISO 原样、相对时间换算、null 与垃圾丢弃', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z')

  assert.equal(normalizePublishedAt('2026-09-23T21:30:00Z', now), '2026-09-23T21:30:00.000Z')
  assert.equal(normalizePublishedAt('3 days ago', now), '2026-09-28T12:00:00.000Z')
  assert.equal(normalizePublishedAt('2 hours ago', now), '2026-10-01T10:00:00.000Z')
  assert.equal(normalizePublishedAt('yesterday', now), '2026-09-30T12:00:00.000Z')

  assert.equal(normalizePublishedAt(null, now), undefined)
  assert.equal(normalizePublishedAt('', now), undefined)
  assert.equal(normalizePublishedAt(undefined, now), undefined)
  assert.equal(normalizePublishedAt('很久以前', now), undefined)
  assert.equal(normalizePublishedAt('2026', now), undefined, '纯数字会被 Date.parse 当年份，必须排除')
})

test('mapResponse：page_age 为 null 时不产生 publishedAt 字段', () => {
  const mapped = mapResponse(
    responseWith([
      {
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://a.test/1', title: 'A', page_age: null }],
      },
    ]),
  )

  assert.equal('publishedAt' in mapped.sources[0], false)
})
