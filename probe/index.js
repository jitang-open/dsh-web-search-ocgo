/**
 * 探针 v2：判定「上游 fork 是否真的活着」+「静态 import dsh 包能否成功」。
 *
 * v1 结论：从项目目录动态 import `@deepseek-ai/dsh-*` 全部 ERR_MODULE_NOT_FOUND。
 * 但上游 fork 静态 import 了同样的包却没有加载失败日志 —— 必须查清这个矛盾。
 */
import z from '@deepseek-ai/schemastery'

export const name = 'web-search-ocgo-probe'

/** 需要 web seam 才能检查 provider 注册表。 */
export const inject = ['web']

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('OPENCODE_API_KEY').volatile(),
})

function say(line) {
  console.log(`[OCGO-PROBE2] ${line}`)
}

export function apply(ctx, config) {
  say('='.repeat(70))
  say(`plugin loaded, execArgv=${JSON.stringify(process.execArgv)}`)
  say(`NODE_OPTIONS = ${process.env.NODE_OPTIONS ?? '(unset)'}`)
  say(`NODE_PATH = ${process.env.NODE_PATH ?? '(unset)'}`)

  setTimeout(async () => {
    try {
      const web = ctx.get('web')
      say(`web service present = ${web !== undefined}`)
      if (web === undefined) return

      say(`web own props = ${JSON.stringify(Object.getOwnPropertyNames(web))}`)

      // 直接窥探 provider 注册表：判定上游 fork 是否成功注册了 deepseek-official。
      const registry = web.searchProviders ?? web['searchProviders']
      say(`searchProviders raw type = ${Object.prototype.toString.call(registry)}`)
      if (registry instanceof Map) {
        say(`已注册 search provider ids = ${JSON.stringify([...registry.keys()])}`)
      } else if (registry !== undefined && typeof registry === 'object') {
        say(`已注册 search provider ids(对象键) = ${JSON.stringify(Object.keys(registry))}`)
      } else {
        say(`searchProviders 不可直接窥探（值=${String(registry)}）`)
      }

      // 尝试用上游 fork 应占用的 id 注册：若报重复，说明它活着。
      try {
        const dispose = ctx.web.registerSearchProvider({
          id: 'deepseek-official',
          available: () => false,
          search: async () => ({ sources: [], truncated: false }),
        })
        say('注册 deepseek-official 成功 —— 说明该 id 未被占用（上游 fork 未注册！）')
        dispose()
      } catch (error) {
        say(`注册 deepseek-official 被拒 = ${error?.code ?? '-'} / ${String(error?.message ?? error).split('\n')[0]}`)
        say('  → 若为 WEB_DUPLICATE_PROVIDER，说明上游 fork 确实活着并占用了该 id')
      }

      // 真跑一次搜索，看选择逻辑能否解析出 provider。
      try {
        const result = await ctx.web.search({ query: 'DeepSeek Harness', maxResults: 2 })
        say(`web.search 成功：sources=${result.sources.length} truncated=${result.truncated}`)
        say(`  首个 url = ${result.sources[0]?.url ?? '(空)'}`)
        say(`  snippet 长度 = ${result.sources[0]?.snippet?.length ?? 0}`)
      } catch (error) {
        say(`web.search 失败 = ${error?.code ?? '-'} / ${String(error?.message ?? error).split('\n')[0]}`)
      }
    } catch (error) {
      say(`探测抛错: ${String(error?.stack ?? error)}`)
    }
  }, 6000)
}
