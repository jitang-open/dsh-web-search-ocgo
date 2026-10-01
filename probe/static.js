/**
 * 静态导入测试：文件顶部就 import 三个 dsh 包。
 *
 * 如果 dsh 的 loader 能解析它们，这个 entry 会正常挂载并打印 OK；
 * 如果不能，ESM 链接阶段就会失败，日志里应出现 `failed to import`
 * —— 这正是上游 fork 在文档 §2.2 里描述的现象，用来定位真实原因。
 */
import { WebError } from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'

export const name = 'web-search-ocgo-probe-static'

export const inject = []

export function apply() {
  console.log(`[OCGO-PROBE-STATIC] 静态导入全部成功！`)
  console.log(`[OCGO-PROBE-STATIC] WebError=${typeof WebError} credentialRef=${typeof credentialRef} SessionLogOffset=${typeof SessionLogOffset}`)
}
