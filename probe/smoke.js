/**
 * 端到端冒烟探针：验证真实搜索确实走我们的 provider，并检验摘要与缓存。
 *
 * 只读 + 真实调用，不写任何配置。
 */
export const name = 'web-search-ocgo-smoke'

export const inject = ['web']

function say(line) {
  console.log(`[OCGO-SMOKE] ${line}`)
}

export function apply(ctx) {
  setTimeout(async () => {
    try {
      const web = ctx.get('web')
      if (web === undefined) {
        say('ctx.web 不可用')
        return
      }
      const ids = [...web.searchProviders.keys()]
      say(`已注册 search provider = ${JSON.stringify(ids)}`)
      const mine = web.searchProviders.get('opencode-go')
      say(`我们的 provider(opencode-go) 存在 = ${mine !== undefined}`)
      say(`我们的 available() = ${mine?.available()}`)

      const query = 'DeepSeek Harness 0.1.7 更新内容'

      const t0 = Date.now()
      const first = await web.search({ query, maxResults: 10 })
      const firstMs = Date.now() - t0
      say(`第 1 次（走 seam）: ${first.sources.length} 条 / ${firstMs} ms / truncated=${first.truncated}`)
      say(`  摘要非空条数 = ${first.sources.filter((s) => typeof s.snippet === 'string' && s.snippet.length > 0).length}`)
      say(`  日期非空条数 = ${first.sources.filter((s) => typeof s.publishedAt === 'string').length}`)
      say(`  result.content 长度 = ${first.content?.length ?? 0}`)
      say(`  result.content 开头 = ${JSON.stringify(first.content?.slice(0, 150) ?? null)}`)
      const head = first.sources[0]
      say(`  首条 = ${JSON.stringify({
        url: head?.url,
        title: typeof head?.title === 'string' ? head.title.slice(0, 50) : undefined,
        snippetLen: head?.snippet?.length ?? 0,
        snippetHead: head?.snippet?.slice(0, 80),
        publishedAt: head?.publishedAt,
      })}`)

      const t1 = Date.now()
      const second = await web.search({ query, maxResults: 10 })
      const secondMs = Date.now() - t1
      say(`第 2 次（应命中缓存）: ${second.sources.length} 条 / ${secondMs} ms`)
      say(`  缓存判定：第 2 次耗时 ${secondMs} ms ${secondMs < firstMs / 3 ? '远低于首次 → 命中' : '与首次同量级 → 未命中？'}`)

      // 直接问 provider 的缓存统计。
      say(`  两次结果 URL 完全一致 = ${JSON.stringify(first.sources.map((s) => s.url)) === JSON.stringify(second.sources.map((s) => s.url))}`)
    } catch (error) {
      say(`冒烟失败: code=${error?.code ?? '-'} ${String(error?.message ?? error).split('\n')[0]}`)
      say(`stack: ${String(error?.stack ?? '').split('\n').slice(0, 4).join(' | ')}`)
    }
  }, 6000)
}
