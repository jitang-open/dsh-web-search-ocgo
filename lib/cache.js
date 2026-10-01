/**
 * 查询缓存：同 query + 同配置的搜索结果在 TTL 内直接复用，命中即 0 token。
 *
 * 为什么这是真正的省钱抓手（实测依据见 bench/maxuses-report.md）：
 * `max_uses` 对 token 成本**没有影响**（总 prompt 恒定在 ~8.1k），
 * 而每次搜索都是一次完整的模型请求。agent 常重复搜同一关键词，
 * 命中缓存才是唯一确定的 0 token 路径。
 *
 * 实现是带 TTL 的 LRU：`Map` 的插入顺序即最近使用顺序，
 * 命中时删除再插入把它移到队尾，超限时从队首淘汰。
 */

/**
 * 创建一个查询缓存。
 *
 * @param options - 读取当前配置的回调集合（每次访问都重新读取，支持设置页 live 改动）。
 * @param options.resolveEnabled - 返回缓存是否启用。
 * @param options.resolveTtlMs - 返回条目存活毫秒数；<= 0 表示不缓存。
 * @param options.resolveMaxEntries - 返回条目上限；<= 0 表示不缓存。
 * @param options.now - 取当前时间的函数，便于测试注入。
 * @returns 缓存实例。
 */
export function createQueryCache({ resolveEnabled, resolveTtlMs, resolveMaxEntries, now = () => Date.now() }) {
  /** key -> { value, expiresAt }，按最近使用顺序排列。 */
  const entries = new Map()

  /** 累计命中次数，用于响应事件与 doctor。 */
  let hits = 0

  /** 累计未命中次数。 */
  let misses = 0

  /**
   * 计算缓存键：查询词 + 会影响结果的端点/模型/参数。
   *
   * 不把 apiKey 放进键：同一份结果与密钥无关，且密钥不应出现在内存键里。
   *
   * @param request - 本次搜索的请求。
   * @param options - 本次搜索解析出的端点与参数。
   * @returns 稳定字符串键。
   */
  function keyOf(request, options) {
    return JSON.stringify([
      request.query,
      request.maxResults ?? null,
      options.baseURL,
      options.model,
      options.maxUses,
      options.maxTokens,
      options.snippetMaxChars,
    ])
  }

  return {
    /**
     * 读一条缓存。
     *
     * @param request - 本次搜索的请求。
     * @param options - 本次搜索解析出的端点与参数。
     * @returns 命中且未过期时返回结果，否则 undefined。
     */
    get(request, options) {
      if (!resolveEnabled()) return undefined
      const ttl = resolveTtlMs()
      if (!(ttl > 0) || !(resolveMaxEntries() > 0)) return undefined
      const key = keyOf(request, options)
      const entry = entries.get(key)
      if (entry === undefined) {
        misses += 1
        return undefined
      }
      if (entry.expiresAt <= now()) {
        entries.delete(key)
        misses += 1
        return undefined
      }
      entries.delete(key)
      entries.set(key, entry)
      hits += 1
      return entry.value
    },

    /**
     * 写一条缓存。
     *
     * @param request - 本次搜索的请求。
     * @param options - 本次搜索解析出的端点与参数。
     * @param value - 要缓存的搜索结果。
     */
    set(request, options, value) {
      if (!resolveEnabled()) return
      const ttl = resolveTtlMs()
      const max = resolveMaxEntries()
      if (!(ttl > 0) || !(max > 0)) return
      const key = keyOf(request, options)
      entries.delete(key)
      entries.set(key, { value, expiresAt: now() + ttl })
      while (entries.size > max) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
    },

    /** 清空缓存。 */
    clear() {
      entries.clear()
    },

    /**
     * 统计快照，供响应事件与 doctor 使用。
     *
     * @returns 当前条目数、命中与未命中计数。
     */
    stats() {
      return { size: entries.size, hits, misses }
    },
  }
}
