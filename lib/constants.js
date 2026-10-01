/**
 * 常量：provider 身份、OpenCode Go 协议头、默认值与事件名。
 *
 * 这些值全部来自实测（见 dsh-web-search-ocgo-plan.md §3），改动前请先复测。
 */

/**
 * 本插件注册到 `ctx.web` 的 provider id。
 *
 * 故意**不复用**官方的 `deepseek-official`：那样必须禁用官方 entry，
 * 且与官方 provider 语义混淆。用独立 id 后，官方 provider 仍留在注册表里，
 * 用户在设置页把 `web.searchProvider` 改回 `deepseek-official` 即可一键回滚。
 */
export const SEARCH_PROVIDER_ID = 'opencode-go'

/** OpenCode Go 强制要求的会话头；缺失即 HTTP 400 `MissingSessionID`。 */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session'

/** 标识调用方的头，Go 侧建议携带。 */
export const OPENCODE_CLIENT_HEADER = 'x-opencode-client'

/** 该头的取值。 */
export const OPENCODE_CLIENT_VALUE = 'dsh'

/** 默认端点（不含 `/messages`）。 */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

/** 默认模型。Go 端点只认 `deepseek-v4-flash` / `deepseek-v4.1-flash`。 */
export const DEFAULT_MODEL = 'deepseek-v4.1-flash'

/** Anthropic 协议版本头。 */
export const DEFAULT_API_VERSION = '2023-06-01'

/** 生成 token 上限。 */
export const DEFAULT_MAX_TOKENS = 4096

/**
 * `web_search` 服务端工具的 `max_uses` 上限。
 *
 * 实测（bench/maxuses-report.md）：该值对成本与结果条数**都没有影响** ——
 * 32 次请求的 `server_tool_use.web_search_requests` 恒为 1，`max_uses` 从未被触及。
 * 因此保持官方的 5，不为「省钱」下调（下调只有硬截断风险，没有收益）。
 */
export const DEFAULT_MAX_USES = 5

/** 失败回退用的官方端点（不含 `/messages`）。 */
export const DEFAULT_FALLBACK_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/**
 * 失败回退用的模型。
 *
 * 官方端点只认 `deepseek-flash` / `deepseek-v4-pro`；
 * 传 `deepseek-v4.1-flash` 会 HTTP 400。
 */
export const DEFAULT_FALLBACK_MODEL = 'deepseek-flash'

/** 查询缓存默认存活时间（毫秒）。 */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000

/** 查询缓存默认条目上限。 */
export const DEFAULT_CACHE_MAX_ENTRIES = 50

/** 摘要截断的默认字符数；0 表示不截断。 */
export const DEFAULT_SNIPPET_MAX_CHARS = 300

/**
 * `result.content`（模型对搜索结果的总结）的默认截断字符数；0 表示**不返回**该字段。
 *
 * 实测（bench/dump-response.mjs）：`web_search_result` 的字段只有
 * `[type, title, url, encrypted_content, page_age]` —— **没有 `content`**，
 * `page_age` 是 `null`，`text` 块也没有 `citations`。所以官方 provider 那条
 * 「只取 citations 当摘要」的路径注定是 0% 覆盖率，不是 bug 而是结构性的。
 *
 * 真正的可用内容在 **`text` 块**里：模型基于搜索结果写出的总结（实测 1699 字符，
 * 含具体版本号、日期与功能清单）。`WebSearchResult.content` 的契约原文就是
 * 「provider-generated answer text, search context, or summary」—— 这里正是它的用途。
 * 官方 provider 完全没填这个字段，这才是最大的质量差异点。
 */
export const DEFAULT_ANSWER_MAX_CHARS = 2000

/** 失败重试的默认次数（不含首次请求）。 */
export const DEFAULT_RETRY_COUNT = 1

/**
 * 请求事件名。
 *
 * 与官方 provider 保持同名同结构，这样 dsh-web-search-ocgo-plan.md §7 里
 * 那段「按事件 JSON 解析」的会话日志核对脚本可以继续用。
 */
export const REQUEST_EVENT = 'web/deepseek-search-llm-request'

/**
 * 响应统计**不再写会话事件**（原 `web/ocgo-search-response` 已移除）。
 *
 * 原因：harness 的 `Session.append()` 只接受 `surfaceOp` / `sourceEventSeqs`，
 * **没有写 `ignorable` 的入口**；而读路径
 * （`dsh-session-persistence` 的 `validateStoredEvents`）会拒绝任何不在
 * `KNOWN_SESSION_EVENT_TYPES` 里、又没标 `ignorable: true` 的事件类型 ——
 * 哪怕只有一条，整份会话日志都会拒绝加载（"历史加载失败"）。
 *
 * 官方 provider 也只写 `REQUEST_EVENT`，不写响应事件。统计改由
 * `index.js` 的 `recordResponse` 走 logger / console 输出。
 */

/** 用户 agent 未提供 UA 时使用的标识。 */
export const USER_AGENT = 'dsh-web-search-ocgo/0.1.0'
