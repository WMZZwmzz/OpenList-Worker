import { Context } from "hono"
import { getDb } from "../internal/model/db"
import { findUserByTokenPayload, jwtClaimsAcceptable, UserRole } from "./permission"

/**
 * Common utilities for OpenList backend services.
 */

export * from "./xml"
export * from "./path"
export * from "./errs"
export * from "./generic"
export * from "./http"
export * from "./crypto"
export * from "./stream"

// Format byte sizes to human-readable strings
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes"
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i]
}

// Check administrator authorization from context
let shortStaticTokenWarned = false

export async function checkAdminAuth(c: Context): Promise<boolean> {
  // 静态 API token（api_token / API_TOKEN）
  if (await isStaticApiToken(c)) return true

  const authHeader = c.req.header("Authorization")
  if (!authHeader) return false
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader

  // JWT：管理员登录用户也视为管理员（登录用户变管理员判定）
  try {
    const { verify } = await import("hono/jwt")
    const { getJwtSecret, isTokenRevoked } = await import(
      "../server/middlewares"
    )
    const secret = await getJwtSecret(c)
    const payload: any = await verify(token, secret, "HS256")
    if (!jwtClaimsAcceptable(payload)) return false
    // 注销黑名单对管理端同样生效：此前只有 authUserFromReq 检查，admin/mcp/
    // task 路由走 checkAdminAuth，管理员登出后旧 token 仍能继续管理。
    if (await isTokenRevoked(payload?.jti as string, c.env)) return false
    if (payload && payload.role === 2) {
      // 确认该用户存在于 DB、未被禁用，且「当前」角色仍是管理员。
      // JWT 里的 role 是签发时刻的快照（有效期 7 天），只信它会让降权/改名
      // 对已签发的 token 无效——管理权限必须以 DB 为准。
      const db = await getDb(c.env)
      const user = findUserByTokenPayload(db.users, payload)
      return !!(user && !user.disabled && user.role === UserRole.ADMIN)
    }
  } catch {}
  return false
}

/**
 * 仅判断请求是否携带匹配的静态 API token。
 *
 * 该凭据只来自独立的 `api_token` 设置或 `API_TOKEN` 环境变量，**不再**复用
 * `settings.token`：后者历史上是 115 / PikPak / Thunder 等驱动的 token 配置项，
 * 管理员为驱动随手填入一个长值，就会意外造出一个可登录管理面的全权凭据
 * （SEC-012）。迁移方式：在原管理界面把要用于 API 的值复制到 `api_token`。
 */
export async function isStaticApiToken(c: Context): Promise<boolean> {
  const authHeader = c.req.header("Authorization")
  if (!authHeader) return false
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader
  const db = await getDb(c.env)
  const tokenSetting = (db.settings || []).find(
    (s: any) => s.key === "api_token",
  )
  const envToken =
    (c as any).env?.API_TOKEN ||
    (typeof process !== "undefined" ? process.env?.API_TOKEN : "") ||
    ""
  const expected = String(tokenSetting?.value || envToken || "")
  if (!expected) return false
  if (expected.trim().length < 16) {
    if (!shortStaticTokenWarned) {
      shortStaticTokenWarned = true
      console.warn(
        "[Auth] api_token 少于 16 字符，已拒绝将其作为管理 API 令牌使用。",
      )
    }
    return false
  }
  const tokenBytes = new TextEncoder().encode(token)
  const expectedBytes = new TextEncoder().encode(expected)
  if (tokenBytes.length !== expectedBytes.length) return false
  let match = 0
  for (let i = 0; i < tokenBytes.length; i++) {
    match |= tokenBytes[i] ^ expectedBytes[i]
  }
  return match === 0
}
