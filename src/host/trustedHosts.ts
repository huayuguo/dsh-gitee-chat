/**
 * 本部署对外声明的可信 authority —— browser-trust fence 用的那把尺。
 *
 * 事实来源（按优先级合并，去重）：
 *
 *   1. `webStartup` 服务 —— `@deepseek-ai/dsh-web-app/startup` 用
 *      `WEB_STARTUP_SERVICE = "webStartup"` 发布的**本次 Web 调用参数**：
 *      `trustedHosts` 就是 `--trusted-host` 的值，`publicUrl` 是 `--public-url`
 *      公告的入口。dsh 0.2.x 起是这个名字。
 *   2. `webRuntime` —— 旧版 dsh 里的半个服务，只在没有 `webStartup` 时兜底。
 *      **曾经的 bug 就出在这里**：插件只读 `webRuntime`，而 0.2.x 全树没有任何
 *      插件 provide 它 → 可信列表恒为空 → 公网入口一律 403
 *      「请求未通过浏览器信任栅栏」。
 *   3. `DSH_GITEE_CHAT_TRUSTED_HOSTS` 环境变量（逗号分隔）—— 反向代理改写
 *      Host、或宿主没把 authority 告诉插件的部署，留一个不用改宿主的口子。
 *
 * 只读：任何一个来源缺席都不算错，fence 会退回「只信 loopback」，这是安全默认。
 * 这里**不做**authority 合法性校验（那是 fence 的 parseAuthority 的事）：
 * 解析不出来的条目只是永不命中，不会放宽任何东西。
 *
 * @module dsh-gitee-chat/host/trustedHosts
 */

/** 追加可信 authority 的环境变量名（逗号分隔，可写多个）。 */
export const TRUSTED_HOSTS_ENV = 'DSH_GITEE_CHAT_TRUSTED_HOSTS'

/** 宿主提供 Web 调用参数的服务名：新名优先，旧名兜底。 */
const STARTUP_SERVICES = ['webStartup', 'webRuntime'] as const

/** 宿主服务查找面（cordis `ctx.get` 的结构子集）。 */
export interface ServiceLookup {
  get(name: string): unknown
}

/** 读 Web 调用参数服务里我们关心的那两个字段。 */
interface WebStartupLike {
  trustedHosts?: unknown
  publicUrl?: unknown
}

/** 只留非空字符串，别的形状一律丢弃（宿主字段变了也只是少一条，不至于抛）。 */
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
}

/** `--public-url` 的 authority（`host` 或 `host:port`，默认端口会归一掉）；解析不了返回空。 */
function authorityOfPublicUrl(publicUrl: unknown): string[] {
  if (typeof publicUrl !== 'string' || publicUrl.trim() === '') return []
  try {
    const url = new URL(publicUrl)
    return url.hostname === '' ? [] : [url.host]
  } catch {
    return []
  }
}

/** 环境变量里的逗号分隔列表。 */
function envAuthorities(value: string | undefined): string[] {
  return stringsOf(value?.split(','))
}

/**
 * 合并本部署声明的可信 authority。
 * @param ctx - 插件上下文（读 `webStartup` / `webRuntime`）。
 * @param env - 环境变量来源，测试注入用。
 * @returns 去重后的 authority 列表，顺序 = 宿主 trustedHosts → publicUrl → 环境变量。
 */
export function trustedHostsOf(ctx: ServiceLookup, env: Record<string, string | undefined> = process.env): string[] {
  const authorities: string[] = []
  for (const serviceName of STARTUP_SERVICES) {
    const service = ctx.get(serviceName) as WebStartupLike | undefined
    if (service === undefined || service === null) continue
    authorities.push(...stringsOf(service.trustedHosts), ...authorityOfPublicUrl(service.publicUrl))
    // 主体服务命中就不再看旧名：两个都在时只有新名是本次调用的真值。
    if (serviceName === 'webStartup') break
  }
  authorities.push(...envAuthorities(env[TRUSTED_HOSTS_ENV]))
  return [...new Set(authorities)]
}
