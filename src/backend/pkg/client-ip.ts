/**
 * 统一的客户端 IP 提取。
 *
 * 之前各处直接采信 `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For`：
 * 在 Cloudflare 上边缘会覆盖这些头，但在 EdgeOne / 自托管 / Vercel 等环境，
 * 客户端可以自己带，攻击者因此能每次换一个 IP 绕过登录锁定与限流。
 *
 * 规则：
 * 1. Cloudflare 运行时注入的 `request.cf.clientIp` 最可信；
 * 2. 仅当显式设置 `TRUST_PROXY_HEADERS=1` 时，才采信反代写入的
 *    `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For`；
 * 3. 否则返回 "unknown"（限流退化为全局限流，仍能挡住单实例滥用）。
 *
 * EdgeOne 等平台需要按自己的部署拓扑设置 TRUST_PROXY_HEADERS=1。
 */
export function clientIpFromContext(c: any): string {
  try {
    const cfIp = c?.req?.raw?.cf?.clientIp
    if (cfIp) return String(cfIp)
  } catch {}

  const env = c?.env || {}
  const trust =
    env.TRUST_PROXY_HEADERS === "1" ||
    env.TRUST_PROXY_HEADERS === "true" ||
    (typeof process !== "undefined" &&
      (process.env?.TRUST_PROXY_HEADERS === "1" ||
        process.env?.TRUST_PROXY_HEADERS === "true"))
  if (trust) {
    try {
      const cf = c.req.header("CF-Connecting-IP")
      if (cf) return cf
      const real = c.req.header("x-real-ip")
      if (real) return real
      const forwarded = c.req.header("x-forwarded-for")
      if (forwarded) return forwarded.split(",")[0].trim()
    } catch {}
  }
  return "unknown"
}
