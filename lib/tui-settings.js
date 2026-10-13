/**
 * TUI 设置区块：把本插件的 Config 暴露成 dsh-tui 的「设置」页。
 *
 * 设计要点（与 Web 半的区别）：
 *   - Web 半自己画 UI（注册 `plugins.bundle.config`，用 `ctx.configForms` 读写）；
 *   - TUI 半**只声明「什么可编辑」** —— TUI 自己拥有设置屏的渲染、暂存编辑
 *     与带 revision 栅栏的写入。存储、校验、分层仍归 dsh 的 settings 服务。
 *     见 dsh-tui 的 `settings-sections.d.ts` 顶部注释。
 *
 * 所以这里是一个纯数据描述，不 import 任何 dsh 包。
 */

/** 分组 id 常量，供字段引用。 */
const GROUP = {
  endpoint: 'endpoint',
  credential: 'credential',
  session: 'session',
  fallback: 'fallback',
  cache: 'cache',
  quality: 'quality',
  reliability: 'reliability',
}

/** Go 端点认得的模型（用于可循环选择，仍允许手输其它值）。 */
const GO_MODELS = [
  { value: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash', descriptions: { zh: '默认，质量更好' } },
  { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash', descriptions: { zh: '更便宜' } },
]

/** 官方端点认得的模型（回退用）。 */
const OFFICIAL_MODELS = [
  { value: 'deepseek-flash', label: 'deepseek-flash', descriptions: { zh: '默认' } },
  { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro', descriptions: { zh: '更强' } },
]

/**
 * 构造 TUI 设置区块描述。
 *
 * `ns` 必须等于插件在 dsh settings 服务上的命名空间 —— 也就是 profile 里的
 * loader entry id（`web-search-ocgo`）。不匹配时设置屏会把该区块标为不可用。
 *
 * @returns 可直接交给 `ctx.tuiSettingsSections.register()` 的区块对象。
 */
export function createTuiSettingsSection() {
  return {
    ns: 'web-search-ocgo',
    title: 'Web search (OpenCode Go)',
    descriptions: { zh: '网页搜索（自研）' },
    groups: [
      { id: GROUP.endpoint, title: 'Endpoint & model', descriptions: { zh: '端点与模型' } },
      { id: GROUP.credential, title: 'Credential', descriptions: { zh: '凭据' } },
      { id: GROUP.session, title: 'OpenCode Go headers', descriptions: { zh: 'OpenCode Go 会话头' } },
      { id: GROUP.fallback, title: 'Fallback endpoint', descriptions: { zh: '失败回退官方端点' } },
      { id: GROUP.cache, title: 'Query cache', descriptions: { zh: '查询缓存' } },
      { id: GROUP.quality, title: 'Result quality', descriptions: { zh: '结果质量' } },
      { id: GROUP.reliability, title: 'Reliability', descriptions: { zh: '可靠性' } },
    ],
    fields: [
      // ── 端点与模型 ────────────────────────────────────────────────
      {
        path: ['baseURL'],
        label: 'Endpoint',
        descriptions: { zh: '端点' },
        hint: 'OpenCode Go base URL, without /messages.',
        hintDescriptions: { zh: 'OpenCode Go 端点，不含 /messages。' },
        group: GROUP.endpoint,
        kind: 'text',
        placeholder: 'https://opencode.ai/zen/go/v1',
      },
      {
        path: ['model'],
        label: 'Model',
        descriptions: { zh: '模型' },
        hint: 'Only deepseek-v4-flash / deepseek-v4.1-flash are accepted by the Go endpoint.',
        hintDescriptions: { zh: 'Go 端点只认 deepseek-v4-flash / deepseek-v4.1-flash。←/→ 循环，回车手输。' },
        group: GROUP.endpoint,
        kind: 'text',
        options: GO_MODELS,
      },
      {
        path: ['apiVersion'],
        label: 'anthropic-version',
        descriptions: { zh: 'anthropic-version' },
        group: GROUP.endpoint,
        kind: 'text',
      },
      {
        path: ['maxTokens'],
        label: 'Max output tokens',
        descriptions: { zh: '生成 token 上限' },
        group: GROUP.endpoint,
        kind: 'number',
      },
      {
        path: ['maxUses'],
        label: 'max_uses',
        descriptions: { zh: 'max_uses' },
        hint: 'Measured: no effect on cost or result count (only 1 search is ever issued). Keep 5.',
        hintDescriptions: { zh: '实测对成本与结果条数都没有影响（每次只发起 1 次搜索），建议保持 5。' },
        group: GROUP.endpoint,
        kind: 'number',
      },

      // ── 凭据 ──────────────────────────────────────────────────────
      {
        path: ['apiKeyEnv'],
        label: 'Credential ref',
        descriptions: { zh: '密钥引用名' },
        hint: 'Name in the credentials store (~/.dsh/.credentials.yaml).',
        hintDescriptions: { zh: '凭据中心里的名字，默认 OPENCODE_API_KEY。' },
        group: GROUP.credential,
        kind: 'text',
      },
      {
        path: ['apiKey'],
        label: 'OpenCode Go API key',
        descriptions: { zh: 'OpenCode Go 密钥' },
        hint: 'Stored through the credentials seam; the literal never rides the settings document.',
        hintDescriptions: { zh: '经凭据 seam 保存，明文不会写进配置文件。留空表示不改动。' },
        group: GROUP.credential,
        kind: 'text',
        secret: { ref: 'OPENCODE_API_KEY' },
      },

      // ── 会话头 ────────────────────────────────────────────────────
      {
        path: ['sessionId'],
        label: 'Fixed session id',
        descriptions: { zh: '固定会话 id' },
        hint: 'Empty = a fresh random id each launch. Cache hits do not depend on it.',
        hintDescriptions: { zh: '留空则每次启动随机。实测缓存命中不依赖它的稳定性。' },
        group: GROUP.session,
        kind: 'text',
      },
      {
        path: ['clientHeader'],
        label: 'x-opencode-client',
        descriptions: { zh: 'x-opencode-client' },
        group: GROUP.session,
        kind: 'text',
      },

      // ── 失败回退 ──────────────────────────────────────────────────
      {
        path: ['fallbackEnabled'],
        label: 'Enable fallback',
        descriptions: { zh: '启用回退' },
        hint: 'After the Go endpoint exhausts retries, try the official DeepSeek endpoint (spends DeepSeek balance).',
        hintDescriptions: { zh: 'Go 端点重试耗尽后改打官方端点，会消耗 DeepSeek 余额。' },
        group: GROUP.fallback,
        kind: 'boolean',
      },
      {
        path: ['fallbackBaseURL'],
        label: 'Official endpoint',
        descriptions: { zh: '官方端点' },
        group: GROUP.fallback,
        kind: 'text',
        placeholder: 'https://api.deepseek.com/anthropic/v1',
      },
      {
        path: ['fallbackModel'],
        label: 'Official model',
        descriptions: { zh: '官方模型' },
        hint: 'The official endpoint only accepts deepseek-flash / deepseek-v4-pro.',
        hintDescriptions: { zh: '官方端点只认 deepseek-flash / deepseek-v4-pro。' },
        group: GROUP.fallback,
        kind: 'text',
        options: OFFICIAL_MODELS,
      },
      {
        path: ['fallbackApiKeyEnv'],
        label: 'Official credential ref',
        descriptions: { zh: '官方密钥引用名' },
        group: GROUP.fallback,
        kind: 'text',
      },

      // ── 查询缓存 ──────────────────────────────────────────────────
      {
        path: ['cacheEnabled'],
        label: 'Enable cache',
        descriptions: { zh: '启用缓存' },
        hint: 'Same query + same config reuses the result within the TTL: 0 tokens on a hit.',
        hintDescriptions: { zh: '同查询 + 同配置在 TTL 内复用，命中即 0 token。' },
        group: GROUP.cache,
        kind: 'boolean',
      },
      {
        path: ['cacheTtlMs'],
        label: 'TTL (ms)',
        descriptions: { zh: 'TTL（毫秒）' },
        group: GROUP.cache,
        kind: 'number',
      },
      {
        path: ['cacheMaxEntries'],
        label: 'Max entries (LRU)',
        descriptions: { zh: '条目上限（LRU）' },
        group: GROUP.cache,
        kind: 'number',
      },

      // ── 结果质量 ──────────────────────────────────────────────────
      {
        path: ['answerMaxChars'],
        label: 'result.content limit',
        descriptions: { zh: 'result.content 截断字符数' },
        hint: 'Summary taken from the response text block. 0 = do not return it. Biggest quality edge over the official provider.',
        hintDescriptions: { zh: '取自响应 text 块（模型总结）。0 = 不返回。这是相对官方 provider 最大的质量差异点。' },
        group: GROUP.quality,
        kind: 'number',
      },
      {
        path: ['snippetMaxChars'],
        label: 'Per-source snippet limit',
        descriptions: { zh: '单条摘要截断字符数' },
        group: GROUP.quality,
        kind: 'number',
      },

      // ── 可靠性 ────────────────────────────────────────────────────
      {
        path: ['retryCount'],
        label: 'Retries',
        descriptions: { zh: '重试次数' },
        hint: 'Backoff retries for 429 / 5xx / network errors, excluding the first attempt.',
        hintDescriptions: { zh: '针对 429 / 5xx / 网络错误的退避重试，不含首次请求。' },
        group: GROUP.reliability,
        kind: 'number',
      },
    ],
  }
}
