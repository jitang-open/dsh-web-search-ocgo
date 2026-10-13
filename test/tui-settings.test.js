/**
 * TUI 设置区块的契约测试。
 *
 * 这些断言对应 dsh-tui 的 `TuiSettingsSection` 契约：`ns` 必须等于 settings
 * 命名空间、`kind` 只能是四种之一、字段引用的 group 必须存在。
 * 一旦 TUI 侧契约变动或我们写错字段，这里会先红。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTuiSettingsSection } from '../lib/tui-settings.js'

/** TUI 设置屏认得的控件类型（`TuiSettingsFieldKind`）。 */
const ALLOWED_KINDS = new Set(['text', 'number', 'boolean', 'select'])

/** 本插件的 settings 命名空间 = profile 里的 loader entry id。 */
const EXPECTED_NS = 'web-search-ocgo'

test('TUI 设置区块：ns 必须是 settings 命名空间（= entry id）', () => {
  const section = createTuiSettingsSection()
  assert.equal(section.ns, EXPECTED_NS, 'ns 与 entry id 不一致时，TUI 会把区块标为不可用')
  assert.equal(typeof section.title, 'string')
  assert.ok(section.title.length > 0, 'title 不能为空')
  assert.equal(section.descriptions?.zh, '网页搜索（自研）')
})

test('TUI 设置区块：字段结构合法', () => {
  const section = createTuiSettingsSection()
  const groupIds = new Set((section.groups ?? []).map((group) => group.id))

  assert.ok(section.fields.length > 0, '至少要有一个字段')

  for (const field of section.fields) {
    const where = `字段 ${field.path?.join('.') ?? '(无 path)'}`

    assert.ok(Array.isArray(field.path) && field.path.length > 0, `${where} 必须有非空 path`)
    assert.ok(field.path.every((seg) => typeof seg === 'string' && seg.length > 0), `${where} 的 path 每段都得是非空字符串`)
    assert.equal(typeof field.label, 'string', `${where} 必须有 label`)
    assert.ok(field.label.length > 0, `${where} 的 label 不能为空`)
    assert.ok(ALLOWED_KINDS.has(field.kind), `${where} 的 kind=${field.kind} 不在允许集合内`)

    if (field.group !== undefined) {
      assert.ok(groupIds.has(field.group), `${where} 引用了不存在的 group: ${field.group}`)
    }
    if (field.options !== undefined) {
      assert.ok(Array.isArray(field.options) && field.options.length > 0, `${where} 的 options 不能是空数组`)
      for (const option of field.options) {
        assert.equal(typeof option.value, 'string', `${where} 的 option.value 必须是字符串`)
        assert.equal(typeof option.label, 'string', `${where} 的 option.label 必须是字符串`)
      }
    }
  }
})

test('TUI 设置区块：path 不重复', () => {
  const section = createTuiSettingsSection()
  const seen = new Set()
  for (const field of section.fields) {
    const key = field.path.join('.')
    assert.ok(!seen.has(key), `字段 path 重复: ${key}`)
    seen.add(key)
  }
})

test('TUI 设置区块：分组结构合法', () => {
  const section = createTuiSettingsSection()
  const seen = new Set()
  for (const group of section.groups ?? []) {
    assert.ok(typeof group.id === 'string' && group.id.length > 0, 'group.id 不能为空')
    assert.ok(!seen.has(group.id), `group.id 重复: ${group.id}`)
    seen.add(group.id)
    assert.ok(typeof group.title === 'string' && group.title.length > 0, `group ${group.id} 缺 title`)
    if (group.mode !== undefined) {
      assert.ok(['inline', 'page'].includes(group.mode), `group ${group.id} 的 mode 非法`)
    }
  }
})

test('TUI 设置区块：覆盖了 Config 的全部可编辑字段', () => {
  const section = createTuiSettingsSection()
  const paths = new Set(section.fields.map((field) => field.path.join('.')))

  // 这些是 index.js 的 Config 里除 fallbackApiKey 之外的全部字段。
  // fallbackApiKey 故意不进 TUI：它是「字面密钥」配置项，与 credentials seam
  // 的 secret 控件语义不同（后者按 ref 存取），留在 cordis.patch.yml 里更清楚。
  const expected = [
    'apiKey',
    'apiKeyEnv',
    'baseURL',
    'model',
    'apiVersion',
    'maxTokens',
    'maxUses',
    'sessionId',
    'clientHeader',
    'fallbackEnabled',
    'fallbackBaseURL',
    'fallbackModel',
    'fallbackApiKeyEnv',
    'cacheEnabled',
    'cacheTtlMs',
    'cacheMaxEntries',
    'snippetMaxChars',
    'answerMaxChars',
    'retryCount',
  ]

  for (const key of expected) {
    assert.ok(paths.has(key), `TUI 设置页缺少字段: ${key}`)
  }
  assert.equal(paths.size, expected.length, '不应有多余字段')
})

test('TUI 设置区块：密钥字段走 credentials seam', () => {
  const section = createTuiSettingsSection()
  const secret = section.fields.find((field) => field.path.join('.') === 'apiKey')

  assert.ok(secret !== undefined, '应有 apiKey 字段')
  assert.equal(secret.secret?.ref, 'OPENCODE_API_KEY', '密钥控件必须声明 ref，明文才不会被写进配置文档')
  assert.equal(secret.kind, 'text')
})

test('TUI 设置区块：两个模型字段带可循环选项', () => {
  const section = createTuiSettingsSection()
  const model = section.fields.find((field) => field.path.join('.') === 'model')
  const fallbackModel = section.fields.find((field) => field.path.join('.') === 'fallbackModel')

  // kind 保持 text：这样 ←/→ 能循环预设，回车仍可手输自定义值。
  assert.equal(model.kind, 'text')
  assert.deepEqual(
    model.options.map((option) => option.value),
    ['deepseek-v4.1-flash', 'deepseek-v4-flash'],
  )

  assert.equal(fallbackModel.kind, 'text')
  assert.deepEqual(
    fallbackModel.options.map((option) => option.value),
    ['deepseek-flash', 'deepseek-v4-pro'],
  )
})

test('TUI 设置区块：可序列化（注册时会被结构化克隆/透传）', () => {
  const section = createTuiSettingsSection()
  // 区块里不应出现函数或循环引用 —— 只允许纯数据 + 可选的 parse 函数。
  const clone = JSON.parse(JSON.stringify(section))
  assert.equal(clone.ns, section.ns)
  assert.equal(clone.fields.length, section.fields.length)
  for (const field of section.fields) {
    assert.equal(typeof field.parse, 'undefined', '本插件不使用 parse 自定义解析，保持纯数据')
  }
})
