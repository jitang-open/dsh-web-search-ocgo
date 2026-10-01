/**
 * 搜索 provider 本体：OpenCode Go 端点 + 会话头 + 结果映射 + 重试 + 官方端点回退。
 *
 * 协议事实（全部实测，见 dsh-web-search-ocgo-plan.md §3.1）：
 *   POST {baseURL}/messages
 *   headers: x-api-key / authorization: Bearer / anthropic-version /
 *            content-type / accept / x-opencode-session（必需）/ x-opencode-client
 *   body:    { model, max_tokens, messages:[{role:'user',content:[{type:'text',text}]}],
 *              tools:[{type:'web_search_20250305', name:'web_search', max_uses:N}] }
 *
 * 响应 `content[]` 块类型：thinking / server_tool_use / web_search_tool_result / text。
 * 结果在 `web_search_tool_result.content[]`，每项含 url / title / page_age / 可选 content。
 * 没有 `web_search_tool_result` 块时**必须报错**，不降级去抓正文（官方设计，沿用）。
 */

import {
  DEFAULT_ANSWER_MAX_CHARS,
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_FALLBACK_BASE_URL,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_USES,
  DEFAULT_MODEL,
  DEFAULT_RETRY_COUNT,
  DEFAULT_SNIPPET_MAX_CHARS,
  OPENCODE_CLIENT_HEADER,
  OPENCODE_CLIENT_VALUE,
  OPENCODE_SESSION_HEADER,
  REQUEST_EVENT,
  SEARCH_PROVIDER_ID,
  USER_AGENT,
} from './constants.js'
import {
  WEB_PROVIDER_CREDENTIAL_MISSING,
  WEB_PROVIDER_ERROR,
  abortedError,
  isAbortError,
  throwIfAborted,
  webError,
} from './errors.js'

/** 可重试的 HTTP 状态码。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

/** 首次重试前的等待毫秒数；后续按 attempt 线性放大。 */
const RETRY_BASE_DELAY_MS = 400

/** 退避等待的上限。 */
const RETRY_MAX_DELAY_MS = 4000

/**
 * 进程级随机会话 id。
 *
 * OpenCode Go 只要求该头**存在**，不要求跨请求稳定：实测（bench/maxuses-report.md）
 * 同 UUID 连跑两次固然 16/16 命中缓存，但**首次使用该 UUID 也 16/16 命中** ——
 * 说明 Go 侧 prompt cache 的作用域宽于单个会话 UUID，稳定化并不带来额外命中。
 * 所以默认每次启动随机即可；需要固定值时用设置页的 `sessionId`。
 */
const PROCESS_SESSION_ID = crypto.randomUUID()

/**
 * 构造请求体。
 *
 * @param query - 用户查询词。
 * @param options - 本次搜索解析出的参数。
 * @returns Messages 请求体。
 */
function buildBody(query, options) {
  return {
    model: options.model,
    max_tokens: options.maxTokens,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }],
      },
    ],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
  }
}

/**
 * 构造请求头。
 *
 * @param apiKey - 已解析的密钥。
 * @param options - 本次搜索解析出的参数。
 * @returns 请求头对象。
 */
function buildHeaders(apiKey, options) {
  const headers = {
    'x-api-key': apiKey,
    authorization: `Bearer ${apiKey}`,
    'anthropic-version': options.apiVersion,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
  }
  if (options.sessionId.length > 0) headers[OPENCODE_SESSION_HEADER] = options.sessionId
  if (options.clientHeader.length > 0) headers[OPENCODE_CLIENT_HEADER] = options.clientHeader
  return headers
}

/**
 * 从响应文本里尽量抽出可读的错误说明。
 *
 * @param text - 响应体原文。
 * @returns 说明片段，取不到时为空串。
 */
function describeHttpError(text) {
  if (text.length === 0) return ''
  try {
    const parsed = JSON.parse(text)
    const detail =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message)
    if (typeof detail === 'string' && detail.length > 0) return detail
  } catch {
    // 非 JSON，退回原文片段。
  }
  return text.slice(0, 300)
}

/**
 * 把多个 `text` 块的 `citations[]` 收成 `url → cited_text` 映射（首次出现优先）。
 *
 * 这是摘要的**第二级**来源。实测命中率为 0，但零成本，保留。
 *
 * @param blocks - 响应 content 块。
 * @returns url 到引用原文的映射。
 */
function citationSnippets(blocks) {
  const map = new Map()
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    for (const cite of block.citations ?? []) {
      if (
        typeof cite?.url === 'string' &&
        cite.url.length > 0 &&
        typeof cite.cited_text === 'string' &&
        cite.cited_text.length > 0 &&
        !map.has(cite.url)
      ) {
        map.set(cite.url, cite.cited_text)
      }
    }
  }
  return map
}

/**
 * 解析相对时间描述（如 `3 days ago`）为绝对毫秒时间戳。
 *
 * @param raw - 待解析的字符串。
 * @param nowMs - 当前时间毫秒数。
 * @returns 毫秒时间戳；无法解析时为 undefined。
 */
function parseRelativeAge(raw, nowMs) {
  const text = raw.trim().toLowerCase()
  if (text === 'just now' || text === 'now') return nowMs
  if (text === 'yesterday') return nowMs - 24 * 60 * 60 * 1000
  const match = /^(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week|month|year)s?\s+ago$/.exec(text)
  if (match === null) return undefined
  const amount = Number(match[1])
  const unitMs = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  }[match[2]]
  return unitMs === undefined ? undefined : nowMs - amount * unitMs
}

/**
 * 把 `page_age` 规范化成 ISO-8601 字符串。
 *
 * 官方 provider 原样透传 `page_age`（可能是 `2 days ago` 这种非 ISO 文本），
 * 这里统一成 ISO；解析不出来时**丢弃**该字段而不是塞一个假日期。
 *
 * @param raw - 原始 `page_age`。
 * @param nowMs - 当前时间毫秒数。
 * @returns ISO 字符串；无法规范化时为 undefined。
 */
export function normalizePublishedAt(raw, nowMs = Date.now()) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const text = raw.trim()
  // 纯数字会被 Date.parse 误当成「年」，直接排除。
  if (!/^\d+$/.test(text)) {
    const direct = Date.parse(text)
    if (!Number.isNaN(direct)) {
      try {
        return new Date(direct).toISOString()
      } catch {
        // 落到相对时间分支。
      }
    }
  }
  const relative = parseRelativeAge(text, nowMs)
  if (relative === undefined) return undefined
  try {
    return new Date(relative).toISOString()
  } catch {
    return undefined
  }
}

/**
 * 按上限截断摘要，并标记是否被截断。
 *
 * @param text - 原文。
 * @param maxChars - 上限字符数；<= 0 表示不截断。
 * @returns 截断后的文本。
 */
function truncate(text, maxChars) {
  if (!(maxChars > 0) || text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

/**
 * 为一条结果挑摘要：`item.content` → citations → 空（三级回退）。
 *
 * 官方 provider **只**用 citations，实测摘要覆盖率 0%（`item.content` 0/10、
 * `cited_text` 0 条），模型最终只拿到标题 + URL。这里把 `item.content` 接进来，
 * 是本插件最大的质量提升点。
 *
 * @param item - 一条 `web_search_result`。
 * @param citations - url → cited_text 映射。
 * @param maxChars - 摘要截断上限。
 * @returns 摘要文本；三级都没有时为 undefined。
 */
function pickSnippet(item, citations, maxChars) {
  if (typeof item.content === 'string' && item.content.trim().length > 0) {
    return truncate(item.content.trim(), maxChars)
  }
  const cited = citations.get(item.url)
  if (typeof cited === 'string' && cited.trim().length > 0) {
    return truncate(cited.trim(), maxChars)
  }
  return undefined
}

/**
 * 收集 `text` 块里的模型总结，作为 `WebSearchResult.content` 返回。
 *
 * 实测依据（bench/dump-response.mjs）：`web_search_result` 只有
 * `[type, title, url, encrypted_content, page_age]`，没有 `content`；
 * `page_age` 是 `null`；`text` 块也没有 `citations`。所以「摘要」在结构上就取不到，
 * 而 `text` 块里是模型基于搜索结果写出的总结（实测 1699 字符，含具体版本号与日期）。
 * `WebSearchResult.content` 的契约正是「provider-generated answer text / summary」。
 *
 * @param blocks - 响应 content 块。
 * @param maxChars - 截断上限；<= 0 表示不返回该字段。
 * @returns 拼接后的总结文本；不需要或没有内容时为 undefined。
 */
function collectAnswerText(blocks, maxChars) {
  if (!(maxChars > 0)) return undefined
  const parts = []
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    const text = block.text
    if (typeof text === 'string' && text.trim().length > 0) parts.push(text.trim())
  }
  if (parts.length === 0) return undefined
  return truncate(parts.join('\n\n'), maxChars)
}

/**
 * 把 Anthropic Messages 响应映射成归一化搜索结果。
 *
 * @param response - 已解析的响应体。
 * @param maxChars - 单条摘要截断上限。
 * @param answerMaxChars - `result.content` 截断上限；<= 0 表示不返回该字段。
 * @returns 归一化结果，`truncated` 恒为 false（截断由 web seam 负责）。
 * @throws 当响应里没有 `web_search_tool_result` 块时。
 */
export function mapResponse(response, maxChars = DEFAULT_SNIPPET_MAX_CHARS, answerMaxChars = 0) {
  const blocks = Array.isArray(response?.content) ? response.content : []
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw webError(
      'OpenCode Go returned no web_search_tool_result blocks; the request may not have triggered native web search',
      WEB_PROVIDER_ERROR,
    )
  }
  const citations = citationSnippets(blocks)
  const nowMs = Date.now()
  const seen = new Set()
  const sources = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item?.type !== 'web_search_result') continue
      if (typeof item.url !== 'string' || item.url.length === 0) continue
      if (seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = pickSnippet(item, citations, maxChars)
      const publishedAt = normalizePublishedAt(item.page_age, nowMs)
      sources.push({
        url: item.url,
        ...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
        ...(snippet !== undefined ? { snippet } : {}),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      })
    }
  }
  const answer = collectAnswerText(blocks, answerMaxChars)
  return {
    ...(answer !== undefined ? { content: answer } : {}),
    sources,
    truncated: false,
  }
}

/**
 * 从响应体里抽出用量与工具调用统计，供响应事件使用。
 *
 * 注意：`input_tokens` **不可单独作为成本指标** —— 它会被缓存命中率扰动出
 * ±100% 的假波动（实测），必须与 `cache_read_input_tokens` 相加看总 prompt。
 *
 * @param response - 已解析的响应体。
 * @returns 用量快照。
 */
function usageOf(response) {
  const usage = response?.usage ?? {}
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
    stopReason: typeof response?.stop_reason === 'string' ? response.stop_reason : undefined,
  }
}

/**
 * 等待一段时间，同时尊重调用方的取消信号。
 *
 * @param ms - 等待毫秒数。
 * @param signal - 调用方的取消信号。
 */
function sleep(ms, signal) {
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(abortedError(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(abortedError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 创建搜索 provider。
 *
 * @param deps - 依赖集合。
 * @param deps.ctx - 插件上下文，用于取 credentials / agents 服务。
 * @param deps.resolveOptions - 返回**本次操作**的配置快照（每次 search 入口调用一次，
 *   这样一次搜索不会混用两份配置，同时设置页的 live 改动能立刻生效）。
 * @param deps.cache - 查询缓存实例。
 * @returns 符合 `WebSearchProvider` 契约的 provider。
 */
export function createSearchProvider({ ctx, resolveOptions, cache }) {
  /**
   * 解析一次凭证：先问凭据中心，再退回进程环境变量。
   *
   * @param ref - 凭据引用名。
   * @param signal - 调用方的取消信号。
   * @returns 密钥；没有时 undefined。
   */
  async function resolveCredential(ref, signal) {
    throwIfAborted(signal)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(ref)
        const value = resolved?.value
        if (typeof value === 'string' && value.length > 0) return value
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
        // 凭据中心读失败不应直接中断：继续尝试环境变量。
      }
    }
    const ambient = process.env[ref]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  /**
   * 向一个端点发一次请求（含退避重试）。
   *
   * @param target - 端点与模型等目标参数。
   * @param request - 归一化搜索请求。
   * @param options - 本次搜索的配置快照。
   * @param apiKey - 密钥。
   * @param signal - 调用方的取消信号。
   * @returns `{ response, endpoint, attempts }`。
   */
  async function dispatch(target, request, options, apiKey, signal) {
    const endpoint = `${target.baseURL.replace(/\/+$/u, '')}/messages`
    const body = buildBody(request.query, { ...options, model: target.model })
    const headers = buildHeaders(apiKey, { ...options, sessionId: target.sessionId })
    let lastError
    for (let attempt = 0; attempt <= options.retryCount; attempt += 1) {
      throwIfAborted(signal)
      if (attempt > 0) {
        const delay = Math.min(RETRY_BASE_DELAY_MS * attempt, RETRY_MAX_DELAY_MS)
        await sleep(delay, signal)
      }
      options.recordRequest?.({ endpoint, apiVersion: options.apiVersion, body })
      let response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers,
          body: JSON.stringify(body),
          ...(signal !== undefined ? { signal } : {}),
        })
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
        lastError = webError(`Search request to ${endpoint} failed: ${String(error)}`, WEB_PROVIDER_ERROR, { cause: error })
        continue
      }
      if (response.ok) {
        try {
          return { response: await response.json(), endpoint, attempts: attempt + 1 }
        } catch (error) {
          if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
          lastError = webError(
            `Search endpoint ${endpoint} returned an unprocessable response body: ${String(error)}`,
            WEB_PROVIDER_ERROR,
            { cause: error },
          )
          continue
        }
      }
      let detail = ''
      try {
        detail = describeHttpError(await response.text())
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
      }
      const message = `Search endpoint ${endpoint} returned HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`
      lastError = webError(message, WEB_PROVIDER_ERROR)
      if (!RETRYABLE_STATUS.has(response.status)) break
    }
    throw lastError ?? webError(`Search endpoint ${endpoint} failed`, WEB_PROVIDER_ERROR)
  }

  return {
    id: SEARCH_PROVIDER_ID,

    /**
     * 本地可用性检查，不发网络请求。
     *
     * @returns 配置足以发起一次搜索时为 true。
     */
    available() {
      const options = resolveOptions()
      return (
        (typeof options.apiKey === 'string' && options.apiKey.length > 0) ||
        options.apiKeyEnv.length > 0
      ) && URL.canParse(options.baseURL) && options.maxTokens > 0 && options.maxUses > 0
    },

    /**
     * 执行一次搜索。
     *
     * @param request - 归一化搜索请求。
     * @param signal - 调用方的取消信号。
     * @returns 归一化搜索结果。
     */
    async search(request, signal) {
      const options = resolveOptions()
      const startedAt = Date.now()

      const cached = cache.get(request, options)
      if (cached !== undefined) {
        options.recordResponse?.({
          endpoint: `${options.baseURL.replace(/\/+$/u, '')}/messages`,
          model: options.model,
          cached: true,
          fallback: false,
          attempts: 0,
          durationMs: Date.now() - startedAt,
          sourceCount: cached.sources.length,
          snippetCount: cached.sources.filter((source) => source.snippet !== undefined).length,
          answerChars: cached.content?.length ?? 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
        })
        return cached
      }

      const primaryKey = options.apiKey.length > 0 ? options.apiKey : await resolveCredential(options.apiKeyEnv, signal)
      if (primaryKey === undefined) {
        throw webError(
          `OpenCode Go search has no API key for "${options.apiKeyEnv}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-ocgo config`,
          WEB_PROVIDER_CREDENTIAL_MISSING,
        )
      }

      let response
      let endpoint
      let attempts
      let fallback = false
      try {
        const result = await dispatch(
          { baseURL: options.baseURL, model: options.model, sessionId: options.sessionId },
          request,
          options,
          primaryKey,
          signal,
        )
        response = result.response
        endpoint = result.endpoint
        attempts = result.attempts
      } catch (error) {
        if (error?.code === 'WEB_ABORTED') throw error
        if (!options.fallbackEnabled) throw error
        const fallbackKey =
          options.fallbackApiKey.length > 0
            ? options.fallbackApiKey
            : await resolveCredential(options.fallbackApiKeyEnv, signal)
        if (fallbackKey === undefined) {
          throw webError(
            `${String(error?.message ?? error)}\n\nFallback to the official endpoint was skipped: no API key for "${options.fallbackApiKeyEnv}".`,
            WEB_PROVIDER_ERROR,
            { cause: error },
          )
        }
        fallback = true
        const result = await dispatch(
          { baseURL: options.fallbackBaseURL, model: options.fallbackModel, sessionId: '' },
          request,
          options,
          fallbackKey,
          signal,
        )
        response = result.response
        endpoint = result.endpoint
        attempts = result.attempts
      }

      const mapped = mapResponse(response, options.snippetMaxChars, options.answerMaxChars)
      const usage = usageOf(response)
      const durationMs = Date.now() - startedAt
      options.recordResponse?.({
        endpoint,
        model: fallback ? options.fallbackModel : options.model,
        cached: false,
        fallback,
        attempts,
        durationMs,
        sourceCount: mapped.sources.length,
        snippetCount: mapped.sources.filter((source) => source.snippet !== undefined).length,
        answerChars: mapped.content?.length ?? 0,
        ...usage,
      })
      cache.set(request, options, mapped)
      return mapped
    },
  }
}

/** 供 index.js 复用的默认值再导出，避免两处硬编码漂移。 */
export const PROVIDER_DEFAULTS = {
  answerMaxChars: DEFAULT_ANSWER_MAX_CHARS,
  apiVersion: DEFAULT_API_VERSION,
  baseURL: DEFAULT_BASE_URL,
  fallbackBaseURL: DEFAULT_FALLBACK_BASE_URL,
  fallbackModel: DEFAULT_FALLBACK_MODEL,
  maxTokens: DEFAULT_MAX_TOKENS,
  maxUses: DEFAULT_MAX_USES,
  model: DEFAULT_MODEL,
  retryCount: DEFAULT_RETRY_COUNT,
  snippetMaxChars: DEFAULT_SNIPPET_MAX_CHARS,
  sessionId: PROCESS_SESSION_ID,
}

export { REQUEST_EVENT }
