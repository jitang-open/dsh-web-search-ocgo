/**
 * dsh-web-search-ocgo — 浏览器半（设置页）。
 *
 * 手写 `__ModuleLoader__` bundle，无构建步骤（与 dsh-ssh-manager 同一范式）。
 *
 * 为什么必须自己写这一半：DSH 0.1.7-rc.2 的 host 侧会给我们的 entry 标
 * `autoGenerate: true`，但 **web client 里没有任何消费方** —— 把整个 pnpm store
 * 翻遍，`autoGenerate` 只出现在 `dsh-api-remotes` 的 wire schema 里。
 * 要出设置页，只能自己注册 `plugins.bundle.config`。
 *
 * 注册链路（已实测确认）：
 *   1. 我们注册 `plugins.bundle.config`，key = **包名** `dsh-web-search-ocgo`；
 *   2. plugin-manager 的 config-ledger 从该 slot 的 keys 推出 `ledger.bundles`，
 *      于是 `configured = ledger.bundles.has(pkg.name)` 为 true；
 *   3. bundle 详情页因此渲染 `renderSlot('plugins.bundle.config', { view: 'page' }, …)`；
 *   4. 组件用 `ctx.configForms.get(<profile entry id>)` 读写配置。
 *
 * 注意两个 id 不一样：slot key 用**包名**，configForms 的 entryId 用 **entry id**。
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-search-ocgo',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** `plugins.bundle.config` 的 key：本插件的**包名**。 */
    const BUNDLE_KEY = 'dsh-web-search-ocgo'

    /** `configForms.get()` 的 entryId：profile 里的 **loader entry id**。 */
    const ENTRY_ID = 'web-search-ocgo'

    /**
     * 字段清单。
     *
     * 硬编码而非从 schema 动态生成：`ConfigForm` 只暴露 value/revision，
     * 不暴露 schema（schema 在 host 侧 `describe()` 里，client 半拿不到）。
     * 分组顺序即渲染顺序。
     */
    const GROUPS = [
      {
        title: '端点与模型',
        fields: [
          {
            key: 'baseURL',
            label: '端点',
            type: 'text',
            hint: 'OpenCode Go 端点，不含 /messages。',
          },
          {
            key: 'model',
            label: '模型',
            type: 'text',
            hint: 'Go 端点只认 deepseek-v4-flash / deepseek-v4.1-flash。',
          },
          { key: 'apiVersion', label: 'anthropic-version', type: 'text' },
          { key: 'maxTokens', label: '生成 token 上限', type: 'number' },
          {
            key: 'maxUses',
            label: 'max_uses',
            type: 'number',
            hint: '实测对成本与结果条数都没有影响（每次只发起 1 次搜索），建议保持 5。',
          },
        ],
      },
      {
        title: '凭据',
        fields: [
          {
            key: 'apiKeyEnv',
            label: '密钥引用名',
            type: 'text',
            hint: '凭据中心（~/.dsh/.credentials.yaml）里的名字。',
          },
          {
            key: 'apiKey',
            label: '字面密钥',
            type: 'secret',
            hint: '设了就优先于上面的引用名。留空表示不改动。',
          },
        ],
      },
      {
        title: 'OpenCode Go 会话头',
        fields: [
          {
            key: 'sessionId',
            label: '固定会话 id',
            type: 'text',
            hint: '留空则每次启动随机。实测缓存命中不依赖它的稳定性。',
          },
          { key: 'clientHeader', label: 'x-opencode-client', type: 'text' },
        ],
      },
      {
        title: '失败回退官方端点',
        fields: [
          {
            key: 'fallbackEnabled',
            label: '启用回退',
            type: 'boolean',
            hint: 'Go 端点重试耗尽后改打官方端点。会消耗 DeepSeek 余额。',
          },
          { key: 'fallbackBaseURL', label: '官方端点', type: 'text' },
          {
            key: 'fallbackModel',
            label: '官方模型',
            type: 'text',
            hint: '官方端点只认 deepseek-flash / deepseek-v4-pro。',
          },
          { key: 'fallbackApiKeyEnv', label: '官方密钥引用名', type: 'text' },
        ],
      },
      {
        title: '查询缓存',
        fields: [
          {
            key: 'cacheEnabled',
            label: '启用缓存',
            type: 'boolean',
            hint: '同查询 + 同配置在 TTL 内直接复用，命中即 0 token。',
          },
          { key: 'cacheTtlMs', label: 'TTL（毫秒）', type: 'number' },
          { key: 'cacheMaxEntries', label: '条目上限（LRU）', type: 'number' },
        ],
      },
      {
        title: '结果质量',
        fields: [
          {
            key: 'answerMaxChars',
            label: 'result.content 截断字符数',
            type: 'number',
            hint: '取自响应的 text 块（模型总结）。0 = 不返回。这是相对官方 provider 最大的质量差异点。',
          },
          { key: 'snippetMaxChars', label: '单条摘要截断字符数', type: 'number' },
        ],
      },
      {
        title: '可靠性',
        fields: [
          {
            key: 'retryCount',
            label: '重试次数',
            type: 'number',
            hint: '针对 429 / 5xx / 网络错误的退避重试，不含首次请求。',
          },
        ],
      },
    ]

    /** 注入的样式，只用主题 token，跟随明暗主题。 */
    const CSS = [
      '.dsh-ocgo-root{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.dsh-ocgo-status{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}',
      '.dsh-ocgo-group{display:flex;flex-direction:column;gap:10px}',
      '.dsh-ocgo-group-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-ocgo-field{display:flex;flex-direction:column;gap:4px;max-width:520px}',
      '.dsh-ocgo-label{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ocgo-overridden{font-size:10.5px;padding:0 5px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);color:var(--dsw-alias-state-business-primary)}',
      '.dsh-ocgo-input,.dsh-ocgo-number{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none}',
      '.dsh-ocgo-input:focus,.dsh-ocgo-number:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.dsh-ocgo-input[data-dirty=true],.dsh-ocgo-number[data-dirty=true]{border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary))}',
      '.dsh-ocgo-hint{margin:0;font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-ocgo-check{display:flex;align-items:center;gap:8px}',
      '.dsh-ocgo-check input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary)}',
      '.dsh-ocgo-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsh-ocgo-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:12.5px;cursor:pointer}',
      '.dsh-ocgo-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-ocgo-btn:disabled{opacity:.5;cursor:default}',
      '.dsh-ocgo-btn.is-primary{background:var(--dsw-alias-label-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base));font-weight:500}',
      '.dsh-ocgo-notice{font-size:12px;margin:0}',
      '.dsh-ocgo-notice[data-kind=ok]{color:var(--dsw-alias-state-success-secondary)}',
      '.dsh-ocgo-notice[data-kind=err]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-ocgo-facts{display:flex;flex-direction:column;gap:2px;margin:0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ocgo-facts code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    ].join('')

    /**
     * 把样式挂到文档上，返回卸载函数。
     *
     * @returns 移除 `<style>` 的函数。
     */
    function installStyles() {
      const style = document.createElement('style')
      style.dataset.dshOcgo = 'settings'
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    /**
     * 订阅一个 ConfigForm 的快照。
     *
     * @param form - `ctx.configForms.get(entryId)` 返回的表单。
     * @returns 当前快照。
     */
    function useFormSnapshot(form) {
      return React.useSyncExternalStore(
        React.useCallback((listener) => form.subscribe(listener), [form]),
        React.useCallback(() => form.getSnapshot(), [form]),
      )
    }

    /**
     * 判断某字段是否被用户显式覆盖过。
     *
     * `user` 层的**存在性**才是覆盖标记 —— 值恰好等于默认值也算覆盖。
     *
     * @param user - 快照里的用户层。
     * @param key - 字段名。
     * @returns 被覆盖时为 true。
     */
    function isOverridden(user, key) {
      return typeof user === 'object' && user !== null && Object.prototype.hasOwnProperty.call(user, key)
    }

    /**
     * 渲染一个字段的编辑器。
     *
     * @param props - 字段元数据、当前值、覆盖标记与提交回调。
     * @returns React 元素。
     */
    function Field(props) {
      const { field, value, overridden, onCommit } = props
      const [draft, setDraft] = React.useState(null)
      const shown = draft === null ? value : draft
      const dirty = draft !== null && String(draft) !== String(value)

      /** 提交当前草稿。 */
      const commit = () => {
        if (draft === null) return
        if (String(draft) === String(value)) {
          setDraft(null)
          return
        }
        onCommit(field.key, field.type === 'number' ? Number(draft) : draft)
        setDraft(null)
      }

      const label = h(
        'label',
        { className: 'dsh-ocgo-label' },
        field.label,
        overridden === true ? h('span', { className: 'dsh-ocgo-overridden' }, '已改') : null,
      )

      if (field.type === 'boolean') {
        return h(
          'div',
          { className: 'dsh-ocgo-field' },
          h(
            'label',
            { className: 'dsh-ocgo-label' },
            h('span', { className: 'dsh-ocgo-check' }, h('input', {
              type: 'checkbox',
              checked: value === true,
              onChange: (event) => onCommit(field.key, event.target.checked),
            }), field.label),
            overridden === true ? h('span', { className: 'dsh-ocgo-overridden' }, '已改') : null,
          ),
          field.hint === undefined ? null : h('p', { className: 'dsh-ocgo-hint' }, field.hint),
        )
      }

      return h(
        'div',
        { className: 'dsh-ocgo-field' },
        label,
        h('input', {
          className: field.type === 'number' ? 'dsh-ocgo-number' : 'dsh-ocgo-input',
          type: field.type === 'number' ? 'number' : field.type === 'secret' ? 'password' : 'text',
          value: field.type === 'secret' ? (draft ?? '') : String(shown ?? ''),
          placeholder: field.type === 'secret' ? (overridden === true ? '已设置（留空不改动）' : '未设置') : '',
          'data-dirty': dirty ? 'true' : 'false',
          autoComplete: 'off',
          spellCheck: false,
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setDraft(null)
          },
        }),
        field.hint === undefined ? null : h('p', { className: 'dsh-ocgo-hint' }, field.hint),
      )
    }

    /**
     * 造出设置页组件。
     *
     * 组件必须闭包捕获 `form`：slot 只向注册者注入 `view`/`form` 两个 ownerProp，
     * 而 bundle 详情页调 `renderSlot('plugins.bundle.config', { view: 'page' }, …)`
     * 时**没有**传 `form`，所以不能指望从 props 拿。这里改成在 `whileServed`
     * 回调里取到 `ConfigForm` 后由闭包递进去 —— 也顺带保证 form 只在
     * namespace 真被 Host 服务时才创建。
     *
     * @param form - `ctx.configForms.get(ENTRY_ID)` 返回的表单。
     * @returns React 组件。
     */
    function makeSettingsPanel(form) {
      return function SettingsPanel() {
        const snapshot = useFormSnapshot(form)
        const [notice, setNotice] = React.useState(null)
        const [busy, setBusy] = React.useState(false)

        if (snapshot.status === 'unavailable') {
          return h(
            'p',
            { className: 'dsh-ocgo-status' },
            'Host 当前不提供 web-search-ocgo 这个配置命名空间（插件可能未启用或加载失败）。',
          )
        }
        if (snapshot.status === 'loading' || snapshot.value === undefined) {
          return h('p', { className: 'dsh-ocgo-status' }, '正在读取配置…')
        }

        const value = snapshot.value

        /**
         * 写一个字段。
         *
         * @param key - 字段名。
         * @param next - 新值。
         */
        const commit = async (key, next) => {
          setBusy(true)
          setNotice(null)
          try {
            const accepted = await form.set(key, next)
            setNotice(
              accepted
                ? { kind: 'ok', text: `已保存 ${key}` }
                : { kind: 'err', text: `${key} 写入被 Host 拒绝（配置可能已被并发修改）` },
            )
          } catch (error) {
            setNotice({ kind: 'err', text: `${key} 写入失败：${String(error?.message ?? error)}` })
          } finally {
            setBusy(false)
          }
        }

        const overriddenKeys = GROUPS.flatMap((group) => group.fields)
          .map((field) => field.key)
          .filter((key) => isOverridden(snapshot.user, key))

        return h(
          'div',
          { className: 'dsh-ocgo-root' },
          h(
            'p',
            { className: 'dsh-ocgo-facts' },
            h('span', null, 'provider id ', h('code', null, 'opencode-go'), '　·　entry ', h('code', null, ENTRY_ID)),
            h('span', null, '写入位置：profile 的 ', h('code', null, 'cordis.patch.yml')),
            h(
              'span',
              null,
              'Host ',
              snapshot.writable ? '可写' : '只读',
              '　·　',
              snapshot.mode === 'host' ? '已连 Host' : '仅本进程内存',
              snapshot.revision === undefined ? '' : `　·　revision ${snapshot.revision}`,
            ),
          ),
          notice === null ? null : h('p', { className: 'dsh-ocgo-notice', 'data-kind': notice.kind }, notice.text),
          ...GROUPS.map((group) =>
            h(
              'section',
              { className: 'dsh-ocgo-group', key: group.title },
              h('h4', { className: 'dsh-ocgo-group-title' }, group.title),
              ...group.fields.map((field) =>
                h(Field, {
                  key: field.key,
                  field,
                  value: value[field.key],
                  overridden: isOverridden(snapshot.user, field.key),
                  onCommit: commit,
                }),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsh-ocgo-actions' },
            h(
              'button',
              {
                className: 'dsh-ocgo-btn',
                type: 'button',
                disabled: busy || !snapshot.writable || overriddenKeys.length === 0,
                onClick: async () => {
                  setBusy(true)
                  setNotice(null)
                  try {
                    const ops = overriddenKeys.map((key) => ({ op: 'unset', path: [key] }))
                    const accepted = await form.mutate(ops)
                    setNotice(
                      accepted
                        ? { kind: 'ok', text: `已恢复全部 ${ops.length} 项默认值` }
                        : { kind: 'err', text: '批量恢复被 Host 拒绝' },
                    )
                  } catch (error) {
                    setNotice({ kind: 'err', text: `批量恢复失败：${String(error?.message ?? error)}` })
                  } finally {
                    setBusy(false)
                  }
                },
              },
              overriddenKeys.length === 0 ? '没有改动过的项' : `全部恢复默认（${overriddenKeys.length} 项）`,
            ),
            h('span', { className: 'dsh-ocgo-hint' }, busy ? '正在写入…' : '改动会在失焦或回车时立即保存'),
          ),
        )
      }
    }

    return {
      inject: ['slots', 'configForms'],
      /**
       * 挂载设置页。
       *
       * @param ctx - 浏览器插件上下文。
       */
      apply(ctx) {
        ctx.effect(installStyles, 'web-search-ocgo: settings styles')
        ctx.effect(
          () =>
            ctx.configForms.whileServed([ENTRY_ID], () => {
              const panel = makeSettingsPanel(ctx.configForms.get(ENTRY_ID))
              return ctx.slots.inject('plugins.bundle.config', () =>
                ctx.slots.register(
                  {
                    name: 'plugins.bundle.config',
                    key: BUNDLE_KEY,
                  },
                  panel,
                ),
              )
            }),
          'web-search-ocgo: settings page',
        )
      },
    }
  },
})
