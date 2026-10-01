/**
 * dsh-web-search-ocgo — 自研的 DSH 网页搜索 provider。
 *
 * 走 OpenCode Go（`https://opencode.ai/zen/go/v1/messages`），自动注入
 * `x-opencode-session` / `x-opencode-client`，并在此基础上加了四件官方 provider
 * 没有的东西：
 *   1. 失败回退：Go 端点重试耗尽后自动改打官方 DeepSeek 端点（可关）。
 *   2. 查询缓存：同 query + 同配置在 TTL 内 0 token 复用。
 *   3. 摘要三级回退：`item.content` → `citations[].cited_text` → 空
 *      （官方只用 citations，实测摘要覆盖率 0%）。
 *   4. 日期规范化：`page_age` → ISO-8601，解析不出来就丢弃。
 *
 * 依赖面刻意压到最小：**只 import `@deepseek-ai/schemastery`**。
 * 实测从插件目录无法解析 `@deepseek-ai/dsh-*`（1/8 可解析），上游 fork 能 import
 * 是靠 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 指向 dsh 0.1.5-rc.3 的
 * 旧版本残留 —— 那是一个随时会坏的版本错配。本插件不碰它：错误对象按
 * `HarnessError` 的形状手工构造（`lib/errors.js`），其余契约全部经 `ctx` 取。
 */

import z from '@deepseek-ai/schemastery'
import { createQueryCache } from './lib/cache.js'
import {
  DEFAULT_ANSWER_MAX_CHARS,
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_FALLBACK_BASE_URL,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_USES,
  DEFAULT_MODEL,
  DEFAULT_RETRY_COUNT,
  DEFAULT_SNIPPET_MAX_CHARS,
  OPENCODE_CLIENT_VALUE,
  REQUEST_EVENT,
  SEARCH_PROVIDER_ID,
} from './lib/constants.js'
import { createSearchProvider } from './lib/provider.js'

/** Cordis 插件名，loader 诊断用。 */
export const name = 'web-search-ocgo'

/** 本 provider 注册进 `ctx.web` 这个 seam。 */
export const inject = ['web']

/**
 * 配置 schema。
 *
 * **每个字段都必须 `.volatile()`**：设置页只能 live 编辑声明为 volatile 的字段
 * （`dsh-settings` 的 `volatileForm` / `isVolatilePath` 决定）。漏掉一个，
 * 该字段在设置页里就改不动。
 */
export const Config = z.object({
  // ── 主端点与模型 ────────────────────────────────────────────────
  /** 字面密钥；设了就优先于凭据引用。 */
  apiKey: z.string().role('secret').volatile(),
  /** 凭据中心里的密钥名。 */
  apiKeyEnv: z.string().role('credential-ref').default('OPENCODE_API_KEY').volatile(),
  /** Go 端点（不含 `/messages`）。 */
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  /** 模型名；Go 端点只认 deepseek-v4-flash / deepseek-v4.1-flash。 */
  model: z.string().default(DEFAULT_MODEL).volatile(),
  /** `anthropic-version` 头。 */
  apiVersion: z.string().default(DEFAULT_API_VERSION).volatile(),
  /** 生成 token 上限。 */
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).volatile(),
  /**
   * `web_search` 工具的 `max_uses` 上限。
   *
   * 实测对成本与结果条数**都没有影响**（每次请求实际只发起 1 次搜索），
   * 保持 5；下调只有硬截断风险。见 bench/maxuses-report.md。
   */
  maxUses: z.number().step(1).min(1).default(DEFAULT_MAX_USES).volatile(),

  // ── OpenCode Go 会话头 ─────────────────────────────────────────
  /** 固定会话 id；留空则每次启动随机。 */
  sessionId: z.string().default('').volatile(),
  /** `x-opencode-client` 取值；留空则不发送该头。 */
  clientHeader: z.string().default(OPENCODE_CLIENT_VALUE).volatile(),

  // ── 失败回退官方端点 ────────────────────────────────────────────
  /** Go 端点失败后是否改打官方端点。会消耗 DeepSeek 余额。 */
  fallbackEnabled: z.boolean().default(true).volatile(),
  /** 官方端点（不含 `/messages`）。 */
  fallbackBaseURL: z.string().default(DEFAULT_FALLBACK_BASE_URL).volatile(),
  /** 官方端点模型；只认 deepseek-flash / deepseek-v4-pro。 */
  fallbackModel: z.string().default(DEFAULT_FALLBACK_MODEL).volatile(),
  /** 官方端点的凭据引用名。 */
  fallbackApiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile(),
  /** 官方端点的字面密钥；设了就优先。 */
  fallbackApiKey: z.string().role('secret').volatile(),

  // ── 查询缓存 ───────────────────────────────────────────────────
  /** 是否启用查询缓存。 */
  cacheEnabled: z.boolean().default(true).volatile(),
  /** 缓存存活毫秒数。 */
  cacheTtlMs: z.number().step(1).min(0).default(DEFAULT_CACHE_TTL_MS).volatile(),
  /** 缓存条目上限（LRU 淘汰）。 */
  cacheMaxEntries: z.number().step(1).min(0).default(DEFAULT_CACHE_MAX_ENTRIES).volatile(),

  // ── 结果质量 ───────────────────────────────────────────────────
  /** 单条摘要截断字符数；0 表示不截断。 */
  snippetMaxChars: z.number().step(1).min(0).default(DEFAULT_SNIPPET_MAX_CHARS).volatile(),
  /**
   * `result.content`（模型对搜索结果的总结）的截断字符数；**0 表示不返回该字段**。
   *
   * 这是本插件相对官方 provider 最大的质量差异点：官方完全不填
   * `WebSearchResult.content`，模型最终只拿到标题 + URL（实测摘要覆盖率 0%）。
   * 实测该字段的真实来源是响应里的 `text` 块（模型基于搜索结果写出的总结，
   * 约 1700 字符，含具体版本号与日期）。见 bench/dump-response.mjs。
   */
  answerMaxChars: z.number().step(1).min(0).default(DEFAULT_ANSWER_MAX_CHARS).volatile(),

  // ── 可靠性 ─────────────────────────────────────────────────────
  /** 可重试失败的重试次数（不含首次请求）。 */
  retryCount: z.number().step(1).min(0).max(5).default(DEFAULT_RETRY_COUNT).volatile(),
})

/**
 * 组装一次操作的配置快照。
 *
 * 每次 `search()` 入口调用一次，这样一次搜索不会混用两份配置，
 * 设置页的 live 改动也能立刻生效。
 *
 * @param ctx - 插件上下文。
 * @param config - schemastery 包装的 Config。
 * @param sessionFallback - 未配置 sessionId 时使用的进程级随机 id。
 * @returns provider 选项。
 */
function resolveOptions(ctx, config, sessionFallback) {
  const configuredSession = config.sessionId.get()
  return {
    apiKey: config.apiKey.get() ?? '',
    apiKeyEnv: config.apiKeyEnv.get(),
    baseURL: config.baseURL.get(),
    model: config.model.get(),
    apiVersion: config.apiVersion.get(),
    maxTokens: config.maxTokens.get(),
    maxUses: config.maxUses.get(),
    sessionId: configuredSession.length > 0 ? configuredSession : sessionFallback,
    clientHeader: config.clientHeader.get(),
    fallbackEnabled: config.fallbackEnabled.get(),
    fallbackBaseURL: config.fallbackBaseURL.get(),
    fallbackModel: config.fallbackModel.get(),
    fallbackApiKeyEnv: config.fallbackApiKeyEnv.get(),
    fallbackApiKey: config.fallbackApiKey.get() ?? '',
    snippetMaxChars: config.snippetMaxChars.get(),
    answerMaxChars: config.answerMaxChars.get(),
    retryCount: config.retryCount.get(),
    /**
     * 记录请求。抛错会阻止派发 —— 与官方 provider 一致：
     * 模型可见的辅助输入不允许在未留痕的情况下发出去。
     *
     * @param payload - 脱敏后的请求描述。
     */
    recordRequest(payload) {
      ctx.get('agents')?.currentInitiator()?.session.append(REQUEST_EVENT, payload)
    },
    /**
     * 记录响应：延迟 / token / 结果数 / 缓存命中 / 是否走回退。
     *
     * **只走 logger / console，不写会话日志。**
     *
     * 曾经写过自定义事件 `web/ocgo-search-response`，但那会让会话彻底打不开：
     * harness 的 `Session.append()` 只接受 `surfaceOp` / `sourceEventSeqs`，
     * **没有写 `ignorable` 的入口**；而读路径（`dsh-session-persistence` 的
     * `validateStoredEvents`）会拒绝任何不在 `KNOWN_SESSION_EVENT_TYPES` 里、
     * 又没标 `ignorable: true` 的事件类型 —— 一条记录就足以让整份日志
     * 报 "unknown to this harness and not marked ignorable" 而拒绝加载。
     * 官方 provider 同样只写请求事件。详见 `lib/constants.js`。
     *
     * 本函数位于搜索成功路径上，**绝不能抛错**影响主流程。
     *
     * @param payload - 脱敏后的响应统计。
     */
    recordResponse(payload) {
      const line = `[web-search-ocgo] 响应统计 ${JSON.stringify(payload)}`
      const logger = ctx.get('logger')
      if (logger !== undefined && typeof logger.info === 'function') logger.info(line)
      else console.log(line)
    },
  }
}

/**
 * 装载自检：不兼容时**明确报错**，而不是让整个 provider 静默消失。
 *
 * 只写日志、不抛错 —— 抛错会导致 provider 根本不注册，`web.searchProvider`
 * 钉在我们 id 上时搜索会彻底不可用（这正是上游 fork 硬伤 1 的翻版）。
 *
 * @param ctx - 插件上下文。
 * @param options - 当前配置快照。
 */
function selfCheck(ctx, options) {
  const problems = []
  if (ctx.get('web') === undefined) problems.push('ctx.web seam 不可用')
  if (!URL.canParse(options.baseURL)) problems.push(`baseURL 不是合法 URL: ${JSON.stringify(options.baseURL)}`)
  if (options.fallbackEnabled && !URL.canParse(options.fallbackBaseURL)) {
    problems.push(`fallbackBaseURL 不是合法 URL: ${JSON.stringify(options.fallbackBaseURL)}`)
  }
  if (!(options.maxTokens > 0)) problems.push(`maxTokens 必须为正整数，当前 ${options.maxTokens}`)
  if (!(options.maxUses > 0)) problems.push(`maxUses 必须为正整数，当前 ${options.maxUses}`)
  if (problems.length === 0) {
    console.log(
      `[web-search-ocgo] 已装载 provider id=${SEARCH_PROVIDER_ID} endpoint=${options.baseURL} model=${options.model} fallback=${options.fallbackEnabled ? options.fallbackModel : 'off'}`,
    )
    return
  }
  const message = `[web-search-ocgo] 配置自检未通过：${problems.join('；')}。provider 仍会注册，但搜索可能失败；请在「设置 → 插件 → 网页搜索（自研）」里修正，或改 profile 的 cordis.patch.yml。`
  const logger = ctx.get('logger')
  if (logger !== undefined && typeof logger.error === 'function') logger.error(message)
  else console.error(message)
}

/**
 * 注册搜索 provider。
 *
 * @param ctx - 插件上下文。
 * @param config - 已解析的 Config。
 */
export function apply(ctx, config) {
  const sessionFallback = crypto.randomUUID()
  const resolve = () => resolveOptions(ctx, config, sessionFallback)

  selfCheck(ctx, resolve())

  const cache = createQueryCache({
    resolveEnabled: () => config.cacheEnabled.get(),
    resolveTtlMs: () => config.cacheTtlMs.get(),
    resolveMaxEntries: () => config.cacheMaxEntries.get(),
  })

  ctx.web.registerSearchProvider(createSearchProvider({ ctx, resolveOptions: resolve, cache }))
}

export { SEARCH_PROVIDER_ID }
