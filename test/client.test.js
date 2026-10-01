/**
 * 浏览器半（client.js）的结构测试。
 *
 * 用假的 `window.__ModuleLoader__` + 假 React + 假 ctx 把 factory 跑起来，
 * 验证：注册的 slot key 正确、组件能渲染、字段读写走的是 `ConfigForm` 契约。
 *
 * 这不能替代真实 GUI 验收，但能在不重启在用实例的前提下抓住绝大部分接线错误。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * 造一个够用的假 React。
 *
 * `useState` 必须真的能存值，否则测不出「输入 → 提交」这条链：
 * `Field` 的 `commit` 闭包捕获的是**当次渲染**的 `draft`，所以测试要先
 * 触发 onChange、再完整重渲染一次、最后调 onBlur。
 * 每次完整渲染前调 `__beginRender()` 把 hook 游标归零，保证两次渲染的
 * 组件调用顺序一致、状态索引对得上。
 *
 * @returns React 替身。
 */
function fakeReact() {
  const cells = []
  let cursor = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => {
      const index = cursor
      cursor += 1
      if (!(index in cells)) cells[index] = initial
      return [
        cells[index],
        (next) => {
          cells[index] = typeof next === 'function' ? next(cells[index]) : next
        },
      ]
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    __beginRender: () => {
      cursor = 0
    },
  }
}

/**
 * 造一个假表单，记录写操作。
 *
 * @param snapshot - `getSnapshot()` 的返回值。
 * @returns `{ form, writes }`。
 */
function fakeForm(snapshot) {
  const writes = []
  return {
    writes,
    form: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      set: async (field, value) => {
        writes.push({ op: 'set', field, value })
        return true
      },
      unset: async (field) => {
        writes.push({ op: 'unset', field })
        return true
      },
      mutate: async (ops) => {
        writes.push({ op: 'mutate', ops })
        return true
      },
    },
  }
}

/**
 * 加载 client.js 并拿到它的 bundle 定义。
 *
 * @returns `{ definition, registered, form, writes }`。
 */
async function loadBundle(snapshotOverrides = {}) {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load: (value) => {
        definition = value
      },
    },
  }
  // client.js 会在 apply 时注入一个 <style>，这里给个最小的 document 替身。
  globalThis.document = {
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  }

  const snapshot = {
    status: 'ready',
    value: { baseURL: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash', maxUses: 5 },
    base: {},
    user: { model: 'deepseek-v4.1-flash' },
    revision: 7,
    writable: true,
    mode: 'host',
    ...snapshotOverrides,
  }
  const { form, writes } = fakeForm(snapshot)
  const react = fakeReact()

  // 加时间戳绕过 ESM 模块缓存，让每个测试都重新执行一遍 client.js。
  await import(`../client.js?t=${Date.now()}${Math.random()}`)

  const registered = []
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    configForms: {
      whileServed: (namespaces, callback) => callback(new Set(namespaces)),
      get: (entryId) => {
        assert.equal(entryId, 'web-search-ocgo', 'configForms.get 必须用 entry id')
        return form
      },
    },
  }

  return { definition, registered, ctx, form, writes, snapshot, react }
}

/**
 * 递归收集元素树里的所有文本。
 *
 * @param node - 元素、字符串或数组。
 * @param out - 收集数组。
 * @returns 收集数组。
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node.children !== undefined) collectText(node.children, out)
  return out
}

test('client：bundle id 与 factory 结构正确', async () => {
  const { definition } = await loadBundle()

  assert.equal(definition.id, 'dsh-web-search-ocgo')
  assert.equal(typeof definition.factory, 'function')

  const exported = definition.factory((name) => {
    assert.equal(name, 'react', '目前只应 require react')
    return fakeReact()
  })

  assert.deepEqual(exported.inject, ['slots', 'configForms'])
  assert.equal(typeof exported.apply, 'function')
})

test('client：注册到 plugins.bundle.config，key 是包名而不是 entry id', async () => {
  const { definition, registered, ctx, react } = await loadBundle()
  definition.factory(() => react).apply(ctx)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'plugins.bundle.config')
  assert.equal(
    registered[0].options.key,
    'dsh-web-search-ocgo',
    'slot key 必须是包名 —— plugin-manager 用 ledger.bundles.has(pkg.name) 判断是否渲染配置页',
  )
})

test('client：组件能渲染出全部字段分组与当前值', async () => {
  const { definition, registered, ctx, react } = await loadBundle()
  definition.factory(() => react).apply(ctx)

  const tree = registered[0].component()
  const text = collectText(tree).join(' | ')

  for (const expected of [
    '端点与模型',
    '凭据',
    'OpenCode Go 会话头',
    '失败回退官方端点',
    '查询缓存',
    '结果质量',
    '可靠性',
    'opencode-go',
    'web-search-ocgo',
    'cordis.patch.yml',
    'revision 7',
  ]) {
    assert.ok(text.includes(expected), `渲染结果里应包含「${expected}」，实际为：${text.slice(0, 400)}`)
  }
})

test('client：status=unavailable 时给出明确提示而不是空白', async () => {
  const { definition, registered, ctx, react } = await loadBundle({ status: 'unavailable', value: undefined })
  definition.factory(() => react).apply(ctx)

  const text = collectText(registered[0].component()).join(' | ')
  assert.ok(text.includes('不提供'), `应提示命名空间不可用，实际为：${text}`)
})

test('client：status=loading 时显示读取中', async () => {
  const { definition, registered, ctx, react } = await loadBundle({ status: 'loading', value: undefined })
  definition.factory(() => react).apply(ctx)

  const text = collectText(registered[0].component()).join(' | ')
  assert.ok(text.includes('正在读取配置'), `实际为：${text}`)
})

test('client：字段编辑器把写入交给 ConfigForm.set', async () => {
  const { definition, registered, ctx, react, writes } = await loadBundle()
  definition.factory(() => react).apply(ctx)

  /**
   * 完整渲染一次，返回树里所有的 `input` 元素。
   *
   * 假 React 不会自己展开函数组件，所以遇到函数 type 时手动渲染一次；
   * 渲染前把 hook 游标归零，让两次渲染的组件顺序与状态索引对得上。
   *
   * @returns 输入框元素数组。
   */
  const renderInputs = () => {
    react.__beginRender()
    const inputs = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (typeof node.type === 'function') {
        walk(node.type(node.props))
        return
      }
      if (node.type === 'input') inputs.push(node)
      walk(node.children)
    }
    walk(registered[0].component())
    return inputs
  }

  const textInput = renderInputs().find((input) => input.props.type === 'text')
  assert.ok(textInput !== undefined, '应有一个文本输入框')

  // 模拟用户输入：更新 draft。必须重渲染一次，commit 闭包才能看到新值。
  textInput.props.onChange({ target: { value: 'https://example.test/v1' } })

  const updated = renderInputs().find((input) => input.props.type === 'text')
  updated.props.onBlur()

  assert.equal(writes.length, 1, '应产生一次写入')
  assert.deepEqual(writes[0], { op: 'set', field: 'baseURL', value: 'https://example.test/v1' })
})

test('client：值没变时不产生写入', async () => {
  const { definition, registered, ctx, react, writes } = await loadBundle()
  definition.factory(() => react).apply(ctx)

  const renderInputs = () => {
    react.__beginRender()
    const inputs = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (typeof node.type === 'function') {
        walk(node.type(node.props))
        return
      }
      if (node.type === 'input') inputs.push(node)
      walk(node.children)
    }
    walk(registered[0].component())
    return inputs
  }

  const textInput = renderInputs().find((input) => input.props.type === 'text')
  // 原值就是 baseURL 的当前值，输入同样内容再失焦不应写盘。
  textInput.props.onChange({ target: { value: textInput.props.value } })
  renderInputs().find((input) => input.props.type === 'text').props.onBlur()

  assert.equal(writes.length, 0)
})

test('client：只读快照下禁用「全部恢复默认」', async () => {
  const { definition, registered, ctx, react } = await loadBundle({ writable: false })
  definition.factory(() => react).apply(ctx)

  const tree = registered[0].component()
  const buttons = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node.type === 'button') buttons.push(node)
    walk(node.children)
  }
  walk(tree)

  const resetButton = buttons.find((button) => collectText(button).join('').includes('恢复默认'))
  assert.ok(resetButton !== undefined, '应有恢复默认按钮')
  assert.equal(resetButton.props.disabled, true, '只读时该按钮应禁用')
})
