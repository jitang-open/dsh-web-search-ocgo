/**
 * 结构化错误。
 *
 * 为什么不直接用 `@deepseek-ai/dsh-web` 的 `WebError`：
 * 从插件自己的目录**无法解析** `@deepseek-ai/dsh-*`（实测 1/8 可解析），
 * 上游 fork 之所以能 import，是靠 `~/.dsh/profiles/node_modules/@deepseek-ai/*`
 * 这个指向 **dsh 0.1.5-rc.3 旧版本**的残留链接 —— 版本错配随时会坏。
 *
 * `WebError` 的真实形状就是 `class extends Error { readonly code: string }`
 * （见 `@deepseek-ai/dsh-llm/lib/types/error.d.ts`），所以这里手工构造同形状对象：
 * 上层按 `error.code` 路由，不依赖 `instanceof`。
 */

/** provider 失败（网络、HTTP 非 2xx、响应不可解析）。 */
export const WEB_PROVIDER_ERROR = 'WEB_PROVIDER_ERROR'

/** 调用方取消。 */
export const WEB_ABORTED = 'WEB_ABORTED'

/** 缺少可用凭证。 */
export const WEB_PROVIDER_CREDENTIAL_MISSING = 'WEB_PROVIDER_CREDENTIAL_MISSING'

/**
 * 构造一个与 `HarnessError` / `WebError` 同形状的错误。
 *
 * @param message - 面向模型与用户的说明。
 * @param code - 机器可路由的失败分类。
 * @param options - 标准 `ErrorOptions`，用于挂 `cause`。
 * @returns 带只读 `code` 的 `Error`。
 */
export function webError(message, code, options) {
  const error = new Error(message, options)
  error.name = 'WebError'
  Object.defineProperty(error, 'code', {
    value: code,
    enumerable: true,
    writable: false,
    configurable: true,
  })
  return error
}

/**
 * 判断一个错误是否为取消。
 *
 * @param error - 待判断的值。
 * @returns 是 `AbortSignal` 触发的取消时为 true。
 */
export function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * 在调用方已取消时抛出稳定的取消错误。
 *
 * @param signal - 调用方的取消信号。
 */
export function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortedError(signal)
}

/**
 * 构造稳定的取消错误，保留调用方给出的原因。
 *
 * @param signal - 调用方的取消信号。
 * @param fallback - 信号没有 reason 时的兜底原因。
 * @returns 带 `WEB_ABORTED` 的错误。
 */
export function abortedError(signal, fallback) {
  return webError('OpenCode Go search aborted', WEB_ABORTED, {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}
