import { Hono, type Context } from "hono"
import { sign, verify } from "hono/jwt"
import { getDb, saveDb } from "../internal/model/db"
import {
  findUserByTokenPayload,
  bumpTokenEpoch,
  JWT_ISSUER,
  JWT_AUDIENCE,
  jwtClaimsAcceptable,
} from "../pkg/permission"
import { clientIpFromContext } from "../pkg/client-ip"
import {
  getJwtSecret,
  getUserFromContext,
  revokeToken,
  isTokenRevoked,
  generateCSRFToken,
} from "./middlewares"
import {
  generateTotpSecret,
  generateTotpCode,
  generateBackupCodes,
  verifyTotpCode,
  buildOtpauthUrl,
  buildQrImageUrl,
} from "../pkg/totp"
import {
  listUserSshKeys,
  addUserSshKey,
  deleteUserSshKey,
} from "../internal/op/sshkey"
import {
  staticHash,
  saltedHash,
  generateSalt,
  setUserPassword,
  isHex64,
  passwordStampOf,
  isPasswordStampValid,
  constantTimeEqualHex,
} from "../pkg/password"
import { setCSRFToken, clearCSRFToken } from "../pkg/csrf"
import { getAuditLogger } from "../pkg/audit"
import {
  OTP_PENDING_TYPE,
  OTP_PENDING_TTL_SEC,
  isOtpPendingPayload,
} from "../pkg/otp-pending"

export const authRouter = new Hono()
export const meRouter = new Hono()

// --- 登录防爆破（增强版：KV 共享 + 指数退避）---
// 2026-09-08 安全增强：
// 1. 使用 KV 存储失败计数，支持多实例共享
// 2. 指数退避锁定时间，增加暴力破解成本
// 3. 失败达到阈值后要求额外验证（预留验证码集成）
const LOGIN_MAX_FAILURES = 5
const LOGIN_MAX_FAILURES_GLOBAL = 20
const LOGIN_LOCK_MS = 15 * 60 * 1000
const LOGIN_MAX_LOCK_MS = 24 * 60 * 60 * 1000 // 最长锁定 24 小时
/**
 * 用户名维度（与 IP 无关）锁定的**固定**时长。
 *
 * 这一维是全实例共享的：衰减窗口由攻击者的请求量决定，因此绝不能像 IP 维那样
 * 指数增长——否则任何人只要持续失败就能把某个账号（例如 admin）锁到 24 小时，
 * 被锁者自己也无法自解（解锁只发生在登录成功时）。
 */
const LOGIN_GLOBAL_LOCK_MS = 15 * 60 * 1000
const loginFailures = new Map<
  string,
  { count: number; lockedUntil: number; attempts: number }
>()

/**
 * 登录锁定用的客户端地址。统一走 clientIpFromContext：只有 Cloudflare 的
 * request.cf.clientIp，或显式 TRUST_PROXY_HEADERS=1 时才采信代理头。
 */
function clientIpOf(c: Context): string {
  return clientIpFromContext(c)
}

/** 拿不到可信来源 IP 时返回 null（不再用字面量 "unknown" 当键）。 */
function loginIpOf(c: Context): string | null {
  const ip = clientIpOf(c)
  if (!ip || ip === "unknown") return null
  return ip
}

let warnedNoClientIp = false

/**
 * 是否启用「IP + 用户名」维度的锁定。
 *
 * 不具备可信来源 IP 的部署（EdgeOne / Vercel / 自托管且未设
 * TRUST_PROXY_HEADERS=1）里，所有请求都会落到同一个键上：攻击者匿名连打 5 次
 * 就能让真实管理员得到 429，且锁定时长指数增长到 24h，每轮到期重复即可长期
 * 锁死管理员。因此这一维在这种部署下必须退化为「只有用户名维度」
 * （阈值 20、固定 15 分钟），并通过 LOGIN_LOCK_BY_IP=0 支持显式关闭。
 */
function loginLockByIpEnabled(c: Context): boolean {
  const env = (c as any)?.env || {}
  const raw =
    env.LOGIN_LOCK_BY_IP ??
    (typeof process !== "undefined" ? process.env?.LOGIN_LOCK_BY_IP : "")
  if (raw === "0" || raw === "false") return false
  const ip = loginIpOf(c)
  if (!ip) {
    if (!warnedNoClientIp) {
      warnedNoClientIp = true
      console.warn(
        "[Auth] 无法获取可信客户端 IP（非 Cloudflare 且 TRUST_PROXY_HEADERS!=1）：" +
          "登录锁定按 IP 维度已自动关闭，仅保留用户名维度（20 次失败 / 固定 15 分钟）。" +
          "如需按 IP 限流，请按部署拓扑设置 TRUST_PROXY_HEADERS=1；" +
          "如需显式关闭 IP 维度，设置 LOGIN_LOCK_BY_IP=0。",
      )
    }
    return false
  }
  return true
}

/** IP 维度的锁定键；IP 不可信或 IP 维度已关闭时返回 null。 */
function loginKey(c: Context, username: string): string | null {
  if (!loginLockByIpEnabled(c)) return null
  return `${loginIpOf(c)}|${String(username || "").toLowerCase()}`
}

// 与 IP 无关的用户名维度计数，用于抵御「伪造 IP 绕过锁定」的分布式爆破。
function globalLoginKey(username: string): string {
  return `__global__|${String(username || "").toLowerCase()}`
}

/**
 * 计算指数退避锁定时间
 * 第 1-5 次失败：15 分钟
 * 第 6-10 次失败：30 分钟
 * 第 11-15 次失败：1 小时
 * 第 16+ 次失败：最长 24 小时
 */
function calculateLockDuration(attempts: number): number {
  const baseTime = LOGIN_LOCK_MS
  const multiplier = Math.pow(2, Math.floor(attempts / 5))
  return Math.min(baseTime * multiplier, LOGIN_MAX_LOCK_MS)
}

async function bumpLoginFailure(
  key: string,
  maxFailures: number,
  env: any,
  maxLockMs: number = LOGIN_MAX_LOCK_MS,
): Promise<void> {
  const now = Date.now()
  let rec = loginFailures.get(key) || { count: 0, lockedUntil: 0, attempts: 0 }

  // 尝试从 KV 读取（多实例共享）
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      const kvKey = `login_fail:${key}`
      let val: any = null
      try {
        val = await kvInfo.binding.get(kvKey, "text")
      } catch {
        val = await kvInfo.binding.get(kvKey)
      }
      if (val && typeof val.text === "function") {
        val = await val.text()
      }
      if (val) {
        try {
          rec = JSON.parse(String(val))
        } catch {
          // 解析失败，使用默认值
        }
      }
    }
  } catch {
    // KV 不可用，回退到内存模式
  }

  if (rec.lockedUntil > now) return // already locked

  rec.count += 1
  rec.attempts += 1

  if (rec.count >= maxFailures) {
    const lockDuration = Math.min(calculateLockDuration(rec.attempts), maxLockMs)
    rec.lockedUntil = now + lockDuration
    rec.count = 0
    console.warn(
      `[Auth] Login attempts exceeded for ${key}. Locked for ${Math.round(lockDuration / 60000)} minutes (attempt #${rec.attempts}).`,
    )
  }

  loginFailures.set(key, rec)

  // 持久化到 KV
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      const kvKey = `login_fail:${key}`
      const payload = JSON.stringify(rec)
      // 设置 TTL 为最长锁定时间 + 1 小时
      const ttl = Math.ceil((LOGIN_MAX_LOCK_MS + 3600000) / 1000)
      if (typeof kvInfo.binding.put === "function") {
        await kvInfo.binding.put(kvKey, payload, { expirationTtl: ttl })
      }
    }
  } catch (err) {
    console.warn("[Auth] Failed to persist login failure to KV:", err)
  }
}

export async function isLoginLocked(
  c: Context,
  username: string,
  env: any,
): Promise<boolean> {
  // 懒清理：Map 过大时清掉已过锁定期/无锁定的条目，防止无限增长
  if (loginFailures.size > 10000) {
    const now = Date.now()
    for (const [k, v] of loginFailures) {
      if (v.lockedUntil < now && v.count === 0) loginFailures.delete(k)
    }
  }

  const now = Date.now()
  const ipKey = loginKey(c, username)
  const globalKey = globalLoginKey(username)
  // IP 不可信（或 IP 维度被关闭）时只查用户名维度，绝不把所有人共用同一个键
  const keys = ipKey ? [ipKey, globalKey] : [globalKey]

  // 检查内存缓存
  let rec = ipKey ? loginFailures.get(ipKey) : undefined
  let grec = loginFailures.get(globalKey)

  // 尝试从 KV 读取（多实例共享）
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      for (const key of keys) {
        const kvKey = `login_fail:${key}`
        let val: any = null
        try {
          val = await kvInfo.binding.get(kvKey, "text")
        } catch {
          val = await kvInfo.binding.get(kvKey)
        }
        if (val && typeof val.text === "function") {
          val = await val.text()
        }
        if (val) {
          try {
            const data = JSON.parse(String(val))
            if (key === ipKey) rec = data
            if (key === globalKey) grec = data
            // 同步到内存缓存
            loginFailures.set(key, data)
          } catch {
            // 解析失败
          }
        }
      }
    }
  } catch {
    // KV 不可用，使用内存数据
  }

  if (rec && rec.lockedUntil > now) return true
  if (grec && grec.lockedUntil > now) return true
  return false
}

export async function recordLoginFailure(
  c: Context,
  username: string,
  env: any,
): Promise<void> {
  const ipKey = loginKey(c, username)
  if (ipKey) {
    await bumpLoginFailure(ipKey, LOGIN_MAX_FAILURES, env, LOGIN_MAX_LOCK_MS)
  }
  // 用户名维度始终生效：这是「攻击者换 IP」时唯一的兜底，但锁定时长固定，
  // 避免被用来长期锁死某个账号（见 LOGIN_GLOBAL_LOCK_MS 注释）。
  await bumpLoginFailure(
    globalLoginKey(username),
    LOGIN_MAX_FAILURES_GLOBAL,
    env,
    LOGIN_GLOBAL_LOCK_MS,
  )
}

export async function clearLoginFailures(
  c: Context,
  username: string,
  env: any,
): Promise<void> {
  const ipKey = loginKey(c, username)
  const globalKey = globalLoginKey(username)
  const keys = ipKey ? [ipKey, globalKey] : [globalKey]

  for (const key of keys) loginFailures.delete(key)

  // 从 KV 中删除
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      for (const key of keys) {
        const kvKey = `login_fail:${key}`
        if (typeof kvInfo.binding.delete === "function") {
          await kvInfo.binding.delete(kvKey)
        }
      }
    }
  } catch (err) {
    console.warn("[Auth] Failed to clear login failures from KV:", err)
  }
}

// OpenList/AList StaticHash —— 前端 /login/hash 提交的哈希算法。
// 与新密码模块 pkg/password.staticHash 一致，保留旧名以兼容既有调用。
export async function hashPasswordSHA256(
  plainPassword: string,
): Promise<string> {
  return staticHash(plainPassword)
}

/**
 * 校验前端提交的静态哈希是否匹配该用户（等价 Go User.ValidatePwdStaticHash）。
 *
 * 只接受 Go 双层格式：password === saltedHash(inputStatic, user.salt)。
 *
 * 历史遗留格式（bcrypt / 无 salt 的单层 SHA256）不再被支持，也不再在登录成功
 * 后自动升级为双层格式 —— 与 Go 行为完全一致：没有 salt 的存储值一律不可验证。
 * 遗留账号请通过 ADMIN_PASS 显式重置，或由管理员在后台改密。
 */
export async function verifyUserStaticHash(
  user: any,
  inputStatic: string,
): Promise<boolean> {
  const stored = String(user?.password || "")
    .trim()
    .toLowerCase()
  const input = String(inputStatic || "")
    .trim()
    .toLowerCase()
  if (!stored || !isHex64(input) || !isHex64(stored)) return false
  if (user?.salt) {
    const expect = (await saltedHash(input, String(user.salt))).toLowerCase()
    return constantTimeEqualHex(stored, expect)
  }
  // 历史单层 sha256（无 salt 字段）：读兼容，登录成功后由调用方迁移到双层。
  return constantTimeEqualHex(stored, input)
}

/**
 * 校验明文密码（/login、改密旧密码校验、WebDAV Basic Auth 共用）。
 */
export async function verifyUserPassword(
  user: any,
  plain: string,
): Promise<boolean> {
  const stored = String(user?.password || "").trim()
  if (!stored) return false
  return verifyUserStaticHash(user, await staticHash(plain))
}

/**
 * 16 random bytes as hex — used whenever a password must exist but no
 * explicit one was provided. Never use a constant fallback instead.
 */
export function generateRandomPassword(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** 生成 JWT 唯一标识（jti），用于注销黑名单精确失效单个 token */
function generateJti(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

// Ensure admin user exists in DB KV space with a default password if unset
export async function getOrInitUsers(envCtx: any) {
  const db = await getDb(envCtx)
  if (!db.users || db.users.length === 0) {
    const envPass =
      (envCtx && envCtx.ADMIN_PASS) ||
      (typeof process !== "undefined" ? process.env?.ADMIN_PASS : "") ||
      ""
    const guest = {
      id: 2,
      username: "guest",
      password: "",
      role: 1,
      permission: 0,
      base_path: "/",
      disabled: false,
      sso_id: "",
      allow_ldap: false,
      pwd_update_at: new Date().toISOString(),
    }
    if (envPass) {
      // 显式配置了 ADMIN_PASS：自动初始化 admin（保持兼容）
      const admin: any = {
        id: 1,
        username: "admin",
        password: "",
        role: 2,
        permission: 0,
        base_path: "/",
        disabled: false,
        sso_id: "",
        allow_ldap: false,
        pwd_update_at: new Date().toISOString(),
      }
      await setUserPassword(admin, envPass)
      // 自愈：数据库中完全没有用户时补回 admin/guest 占位用户。
      //
      // 注意：这里构建出的库在「尚无密码、也无其它实体」时会被 saveDb 的写前守卫
      // 判定为空壳。只有在当前库可信（曾成功读取过真实配置）时才允许强制落盘，
      // 否则宁可拒绝写入，也不要让「读取失败后的空库」被误当成已完成初始化。
      db.users = [admin, guest]
    } else {
      // 未初始化：仅创建 guest，admin 由 Web 安装向导（POST /api/public/init/setup）创建
      db.users = [guest]
    }
    // 只有配置了 ADMIN_PASS（或已存在真实管理员）时，这份库才不是空壳，
    // 才应该落盘。未配置时应等待 init/setup 完成初始化，而不是抢先写入一个
    // 未初始化的占位库（会被 saveDb 的写前守卫拦截）。
    const persisted = await saveDb(db, envCtx)
    if (!persisted) {
      console.warn(
        "[Auth] getOrInitUsers: skipped persisting an uninitialized placeholder DB " +
          "(expected until POST /api/public/init/setup completes).",
      )
    }
  } else {
    const adminUser = db.users.find((u: any) => u.role === 2)
    // FIX(F-11): the old logic silently reset any non-64-hex password (e.g. a
    // legacy PBKDF2 hash) back to admin/admin — meaning a routine upgrade
    // could quietly reopen the admin account to the world. New behavior:
    //   ADMIN_PASS set     -> explicit reset to that value (operator intent)
    //   password empty    -> random password, printed once to the log
    //   legacy-format     -> LEFT UNTOUCHED, only a warning is logged, so an
    //                        existing deployment is never locked out nor
    //                        silently reset by upgrading.
    const adminPass = adminUser ? String(adminUser.password || "").trim() : ""
    const isValidFormat = /^[0-9a-f]{64}$/i.test(adminPass)
    if (adminUser && !isValidFormat) {
      const envPass =
        (envCtx && envCtx.ADMIN_PASS) ||
        (typeof process !== "undefined" ? process.env?.ADMIN_PASS : "") ||
        ""
      if (envPass) {
        await setUserPassword(adminUser, envPass)
        await saveDb(db, envCtx)
      } else if (!adminPass) {
        // 未初始化：不再自动生成随机密码，交由 Web 安装向导（POST /api/public/init/setup）完成。
        // 前端会在 /api/public/init_status 返回未初始化时自动跳转到安装向导。
        console.warn(
          "[SECURITY] Admin password is empty and no ADMIN_PASS is set — the system is NOT initialized. " +
            "Open the site in a browser to run the setup wizard, or set ADMIN_PASS to initialize automatically.",
        )
      } else {
        console.warn(
          "[SECURITY] Admin password uses a legacy hash format this build cannot verify; " +
            "it has been left untouched. Log in with your existing password and re-set it, " +
            "or set ADMIN_PASS to force a reset. It will NOT be reset to a default value.",
        )
      }
    }
  }
  return { db, users: db.users }
}

export async function authUserFromReq(
  c: any,
): Promise<{ db: any; user: any } | null> {
  const authHeader = c.req.header("Authorization")
  if (!authHeader) return null
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader
  try {
    const secret = await getJwtSecret(c)
    const payload = await verify(token, secret, "HS256")
    if (!jwtClaimsAcceptable(payload)) return null
    // 2FA 未完成的待兑换令牌绝不能当会话凭证用（H-2）
    if (isOtpPendingPayload(payload)) return null
    if (await isTokenRevoked(payload?.jti as string, c.env)) return null
    const db = await getDb(c.env)
    if (!db.users) db.users = []
    const user = findUserByTokenPayload(db.users, payload)
    // 禁用/已删除用户一律视为未认证。
    //
    // 安全不变量：身份解析必须复检「当前是否仍被允许」。JWT 只证明「签发时刻
    // 身份合法」，不证明「现在仍然合法」。历史上这里缺少 disabled 判断，导致
    // 管理员禁用某用户后，其既有令牌在 S3 网关等直接复用本函数的入口仍然可用
    // （核心 API 走 getUserFromContext 有该检查，网关入口没有）。
    if (!user || user.disabled) return null
    // 密码指纹：改密后旧令牌立即失效（对齐 Go middlewares.Auth 的 PwdTS 比对）。
    // 历史缺陷：JWT 只携带 {id, username, role}，改密不使既有令牌失效。
    if (!isPasswordStampValid(payload, user)) return null
    return { db, user }
  } catch {
    return null
  }
}

/**
 * TOTP 重放防护：verifyTotpCode 带 ±1 窗口（约 60~90s 内同一枚码都算有效），
 * 因此一枚码可被重复使用。这里记录「已消费」的码并在窗口期内拒绝第二次。
 */
const usedTotpCodes = new Map<string, number>()
const TOTP_CODE_TTL_MS = 90 * 1000

function consumeTotpCode(userId: any, code: string): boolean {
  const now = Date.now()
  const key = `${userId}:${code}`
  const seenAt = usedTotpCodes.get(key)
  if (seenAt !== undefined && now - seenAt < TOTP_CODE_TTL_MS) return false
  if (usedTotpCodes.size > 4096) {
    for (const [k, t] of usedTotpCodes) {
      if (now - t >= TOTP_CODE_TTL_MS) usedTotpCodes.delete(k)
    }
  }
  usedTotpCodes.set(key, now)
  return true
}

/**
 * 备用恢复码：命中即作废（单次使用），存储的是哈希值。
 * 返回 true 表示本次登录用掉了一个恢复码。
 */
async function tryConsumeBackupCode(
  matchedUser: any,
  input: string,
  db: any,
  c: any,
): Promise<boolean> {
  const stored = matchedUser.otp_backup_codes
  if (!Array.isArray(stored) || stored.length === 0) return false
  const normalized = input.trim().toUpperCase().replace(/\s/g, "")
  if (!normalized) return false
  const hashed = await staticHash(normalized)
  const idx = stored.findIndex(
    (item: string) =>
      typeof item === "string" && constantTimeEqualHex(item, hashed),
  )
  if (idx < 0) return false
  stored.splice(idx, 1)
  matchedUser.otp_backup_codes = stored
  try {
    // 直接用登录流程已持有的那份 db：重新 getDb 可能取到另一个对象，
    // 作废就会写不到正在被持久化的实例上，同一枚恢复码便可用两次。
    const target = (db?.users || []).find((u: any) => u.id === matchedUser.id)
    if (target) {
      target.otp_backup_codes = stored
      await saveDb(db, c.env)
    }
  } catch (e: any) {
    console.warn("[Auth] 恢复码作废写入失败:", e?.message || e)
  }
  return true
}

async function checkUserOtp(matchedUser: any, body: any, c: any, db: any) {
  if (!matchedUser.otp_secret) {
    return { ok: true, code: 200, httpStatus: 200 as const, message: "ok" }
  }
  const otpCode = String(body.otp_code || body.code || "").trim()
  if (!otpCode) {
    return {
      ok: false,
      code: 402,
      httpStatus: 200 as const,
      message: "OTP code required",
    }
  }
  const valid = await verifyTotpCode(matchedUser.otp_secret, otpCode)
  if (!valid) {
    // 验证器不在手边时用恢复码登录：命中即作废（单次使用）
    if (await tryConsumeBackupCode(matchedUser, otpCode, db, c)) {
      return {
        ok: true,
        code: 200,
        httpStatus: 200 as const,
        message: "ok (backup code)",
      }
    }
    return {
      ok: false,
      code: 401,
      httpStatus: 401 as const,
      message: "Invalid OTP code",
    }
  }
  if (!consumeTotpCode(matchedUser.id, otpCode)) {
    return {
      ok: false,
      code: 401,
      httpStatus: 401 as const,
      message: "OTP code already used",
    }
  }
  // 跨 isolate / 冷启动的重放：内存 Map 不共享，必须把「最后一次消费的码」
  // 落到共享 DB。同一枚码在 TOTP 有效窗口内第二次出现一律拒绝。
  const now = Date.now()
  const lastAt = Number(matchedUser.otp_last_at || 0)
  if (
    matchedUser.otp_last_code === otpCode &&
    now - lastAt < TOTP_CODE_TTL_MS
  ) {
    return {
      ok: false,
      code: 401,
      httpStatus: 401 as const,
      message: "OTP code already used",
    }
  }
  matchedUser.otp_last_code = otpCode
  matchedUser.otp_last_at = now
  try {
    await saveDb(db, c.env)
  } catch (e: any) {
    console.warn("[Auth] 记录 TOTP 消费状态失败:", e?.message || e)
  }
  return { ok: true, code: 200, httpStatus: 200 as const, message: "ok" }
}

/**
 * 2FA「待兑换」令牌。
 *
 * 背景（H-2）：TOTP 原先只挂在 `/login` 与 `/login/hash` 上。SSO 与 WebAuthn
 * 两条通道直接签发 7 天完整 JWT，于是「管理员开了 2FA」对这两条路径完全没有
 * 约束——一枚已注册的 Passkey、或 IdP 侧的一个会话，就能绕过 6 位验证码。
 *
 * 现在这两条通道在发现账号 `otp_secret` 非空时**只签发本类型的短时令牌**
 * （5 分钟、只能用于兑换，不能访问任何业务接口），必须带 TOTP / 恢复码到
 * `POST /api/auth/otp/login` 兑换完整 token。
 *
 * 类型常量与判定放在 pkg/otp-pending（middlewares 也要用，避免循环依赖）。
 */
export { OTP_PENDING_TYPE, isOtpPendingPayload } from "../pkg/otp-pending"

export async function issueOtpPendingToken(
  user: any,
  c: Context,
): Promise<string> {
  const payload = {
    type: OTP_PENDING_TYPE,
    id: user.id,
    username: user.username,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + OTP_PENDING_TTL_SEC,
    jti: generateJti(),
  }
  const secret = await getJwtSecret(c)
  return await sign(payload, secret)
}

/**
 * 把待兑换令牌升级为完整会话令牌。
 *
 * 请求：`Authorization: Bearer <pending>`，body `{ otp_code }`（或 `{ code }`，
 * 与 /login 的字段一致；恢复码走同一字段）。
 */
authRouter.post("/otp/login", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const authHeader = c.req.header("Authorization") || ""
  const pending = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader
  if (!pending) {
    return c.json(
      { code: 401, message: "otp pending token required", data: null },
      401,
    )
  }

  let payload: any
  try {
    payload = await verify(pending, await getJwtSecret(c), "HS256")
  } catch {
    return c.json(
      { code: 401, message: "invalid or expired otp pending token", data: null },
      401,
    )
  }
  if (!jwtClaimsAcceptable(payload) || !isOtpPendingPayload(payload)) {
    return c.json(
      { code: 401, message: "not an otp pending token", data: null },
      401,
    )
  }
  if (await isTokenRevoked(payload?.jti, c.env)) {
    return c.json(
      { code: 401, message: "otp pending token already used", data: null },
      401,
    )
  }

  const db = await getDb(c.env)
  const user = (db.users || []).find((u: any) => u.id === payload.id)
  if (!user || user.disabled) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  // 未开启 2FA 的账号不应当走这条路：pending 令牌只由 SSO/WebAuthn 在检测到
  // otp_secret 时签发，出现这种情况说明令牌来源异常。
  if (!user.otp_secret) {
    return c.json(
      { code: 400, message: "2FA is not enabled for this account", data: null },
      400,
    )
  }

  const otpCheck = await checkUserOtp(user, body, c, db)
  if (!otpCheck.ok) {
    // 与口令登录同一套锁定计数：否则 6 位码可以被无限试碰。
    await getAuditLogger().logLoginFailure(c, user.username, "Invalid OTP code")
    await recordLoginFailure(c, user.username, c.env)
    return c.json(
      { code: otpCheck.code, message: otpCheck.message, data: null },
      otpCheck.httpStatus,
    )
  }
  await clearLoginFailures(c, user.username, c.env)

  // pending 令牌一次性使用：兑换成功即撤销，避免同一枚被反复尝试兑换
  await revokeToken(
    String(payload.jti || ""),
    Number(payload.exp || 0),
    c.env,
  )

  const fullPayload = {
    id: user.id,
    username: user.username,
    role: user.role,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    jti: generateJti(),
    // M-3：token 版本号，改密/关 2FA 后旧 token 立即失效
    epoch: Number(user.token_epoch ?? 0) || 0,
  }
  const secret = await getJwtSecret(c)
  const token = await sign(fullPayload, secret)
  const csrfToken = setCSRFToken(c)
  await getAuditLogger().logLoginSuccess(c, user.username)

  return c.json({
    code: 200,
    message: "success",
    data: { token, csrf_token: csrfToken },
  })
})

// POST /api/auth/login
authRouter.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const username = (body.username || "").trim()
  const rawPassword = body.password || ""

  // 防爆破：IP+用户名维度连续失败锁定（KV 共享 + 指数退避）
  if (await isLoginLocked(c, username, c.env)) {
    return c.json(
      {
        code: 429,
        message:
          "Too many failed login attempts for this account/IP. Please try again later.",
        data: null,
      },
      429,
    )
  }

  const db = await getDb(c.env)
  const { users } = await getOrInitUsers(c.env)

  const matchedUser = users.find(
    (u: any) => u.username === username && !u.disabled,
  )

  if (matchedUser) {
    // 明文登录：服务端先 StaticHash，再比对存储哈希（仅 Go 双层格式）
    const isPasswordValid = await verifyUserPassword(matchedUser, rawPassword)

    if (isPasswordValid) {
      // 遗留格式（bcrypt / 无盐单层 SHA256）登录成功后自动升级为 Go 双层哈希
      const stored = String(matchedUser.password || "").trim()
      const needsMigrate =
        /^\$2[aby]\$/.test(stored) || (!matchedUser.salt && isHex64(stored))
      if (needsMigrate) {
        console.log(`[Auth] Upgrading password hash for user: ${username}`)
        await setUserPassword(matchedUser, rawPassword)
        await saveDb(db, c.env)
      }

      const otpCheck = await checkUserOtp(matchedUser, body, c, db)
      if (!otpCheck.ok) {
        // 二次验证失败同样计入锁定：密码已泄露的攻击者若能无限试碰 6 位 TOTP 码，
        // 2FA 就形同虚设（/login 与 /login/hash 两条路径都要盖到）。
        await getAuditLogger().logLoginFailure(c, username, "Invalid OTP code")
        await recordLoginFailure(c, username, c.env)
        return c.json(
          { code: otpCheck.code, message: otpCheck.message, data: null },
          otpCheck.httpStatus,
        )
      }
      await clearLoginFailures(c, username, c.env)

      // 生成 JWT Token
      const payload = {
        id: matchedUser.id,
        username: matchedUser.username,
        role: matchedUser.role,
        // 密码指纹（对齐 Go common.UserClaims.PwdTS）：改密后旧令牌立即失效
        pwd_ts: passwordStampOf(matchedUser),
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        jti: generateJti(),
        // M-3：token 版本号
        epoch: Number(matchedUser.token_epoch ?? 0) || 0,
      }
      const secret = await getJwtSecret(c)
      const token = await sign(payload, secret)

      // 生成 CSRF Token
      const csrfToken = setCSRFToken(c)

      // 记录审计日志
      const auditLogger = getAuditLogger()
      await auditLogger.logLoginSuccess(c, username)

      return c.json({
        code: 200,
        message: "success",
        data: { token, csrf_token: csrfToken },
      })
    }
  }

  // 登录失败 - 记录审计日志
  const auditLogger = getAuditLogger()
  await auditLogger.logLoginFailure(c, username, "Invalid credentials")

  await recordLoginFailure(c, username, c.env)
  return c.json({ code: 401, message: "Invalid credentials", data: null }, 401)
})

// POST /api/auth/login/hash
authRouter.post("/login/hash", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const username = (body.username || "").trim()
  const inputHash = String(body.password || "")
    .trim()
    .toLowerCase()

  // 防爆破：与 /login 同一计数体系（KV 共享 + 指数退避）
  if (await isLoginLocked(c, username, c.env)) {
    return c.json(
      {
        code: 429,
        message:
          "Too many failed login attempts for this account/IP. Please try again later.",
        data: null,
      },
      429,
    )
  }

  const db = await getDb(c.env)
  const { users } = await getOrInitUsers(c.env)

  const matchedUser = users.find(
    (u: any) => u.username === username && !u.disabled,
  )

  if (matchedUser && inputHash.length === 64) {
    const isHashValid = await verifyUserStaticHash(matchedUser, inputHash)

    if (isHashValid) {
      // 无盐单层 SHA256 旧数据 -> 升级为 Go 双层哈希（无需明文）
      if (!matchedUser.salt) {
        console.log(`[Auth] Upgrading password hash for user: ${username}`)
        matchedUser.salt = generateSalt()
        matchedUser.password = await saltedHash(inputHash, matchedUser.salt)
        matchedUser.pwd_update_at = new Date().toISOString()
        await saveDb(db, c.env)
      }

      const otpCheck = await checkUserOtp(matchedUser, body, c, db)
      if (!otpCheck.ok) {
        // 二次验证失败同样计入锁定：密码已泄露的攻击者若能无限试碰 6 位 TOTP 码，
        // 2FA 就形同虚设（/login 与 /login/hash 两条路径都要盖到）。
        await getAuditLogger().logLoginFailure(c, username, "Invalid OTP code")
        await recordLoginFailure(c, username, c.env)
        return c.json(
          { code: otpCheck.code, message: otpCheck.message, data: null },
          otpCheck.httpStatus,
        )
      }
      await clearLoginFailures(c, username, c.env)

      // 生成 JWT Token
      const payload = {
        id: matchedUser.id,
        username: matchedUser.username,
        role: matchedUser.role,
        // 密码指纹（对齐 Go common.UserClaims.PwdTS）：改密后旧令牌立即失效
        pwd_ts: passwordStampOf(matchedUser),
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        jti: generateJti(),
        // M-3：token 版本号
        epoch: Number(matchedUser.token_epoch ?? 0) || 0,
      }
      const secret = await getJwtSecret(c)
      const token = await sign(payload, secret)

      // 生成 CSRF Token
      const csrfToken = setCSRFToken(c)

      // 记录审计日志
      const auditLogger = getAuditLogger()
      await auditLogger.logLoginSuccess(c, username)

      return c.json({
        code: 200,
        message: "success",
        data: { token, csrf_token: csrfToken },
      })
    }
  }

  // 登录失败 - 记录审计日志
  const auditLogger = getAuditLogger()
  await auditLogger.logLoginFailure(c, username, "Invalid credentials")

  await recordLoginFailure(c, username, c.env)
  return c.json({ code: 401, message: "Invalid credentials", data: null }, 401)
})

// POST /api/me/update or /me/update
export const meUpdateHandler = async (c: any) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const { db, user } = auth
  const body = await c.req.json().catch(() => ({}))

  if (body.username && body.username.trim() !== "") {
    const newUsername = body.username.trim()
    const exists = db.users.some(
      (u: any) => u.id !== user.id && u.username === newUsername,
    )
    if (exists) {
      return c.json(
        { code: 400, message: "Username already exists", data: null },
        400,
      )
    }
    user.username = newUsername
  }

  if (body.password && body.password.trim() !== "") {
    // 改密必须证明持有旧口令：否则一次 token 泄露（日志、Referer、被 XSS 偷走）
    // 就直接变成账号接管，而且用户无法察觉旧口令仍可用。
    // 尚未设置口令的账号（安装初始 / SSO 预建）允许首次直接设置。
    if (user.password) {
      const oldPassword = String(body.old_password ?? "")
      if (!(await verifyUserPassword(user, oldPassword))) {
        return c.json(
          { code: 403, message: "Incorrect original password", data: null },
          403,
        )
      }
    }
    await setUserPassword(user, body.password.trim())
    // M-3：改密后撤销该用户所有已签发 token（否则泄露的 token 还能用 7 天）
    bumpTokenEpoch(user)
  }

  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: null })
}

// GET /api/me
export const meHandler = async (c: any) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled) {
    return c.json(
      {
        code: 401,
        message: "Unauthorized",
        data: null,
      },
      401,
    )
  }

  return c.json({
    code: 200,
    message: "success",
    data: {
      id: user.id,
      username: user.username,
      role: user.role,
      permission: user.permission ?? 0,
      base_path: user.base_path || "/",
      disabled: !!user.disabled,
      sso_id: user.sso_id || "",
      allow_ldap: !!user.allow_ldap,
      otp: !!user.otp_secret,
    },
  })
}

authRouter.get("/me", meHandler)
authRouter.post("/me/update", meUpdateHandler)

export const logoutHandler = async (c: any) => {
  // 真正失效 token：解析 Authorization 头中的 JWT，将其 jti 加入注销黑名单
  const authHeader = c.req.header("Authorization")
  if (authHeader) {
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.substring(7)
      : authHeader
    try {
      const secret = await getJwtSecret(c)
      const payload: any = await verify(token, secret, "HS256")
      if (payload?.jti) {
        await revokeToken(payload.jti, payload.exp, c.env)
      }
    } catch {
      // token 无效则无需注销
    }
  }

  // 清除 CSRF Token
  clearCSRFToken(c)

  // 记录审计日志
  const auditLogger = getAuditLogger()
  await auditLogger.logLogout(c)

  return c.json({
    code: 200,
    message: "success",
    data: null,
  })
}

authRouter.get("/logout", logoutHandler)
authRouter.post("/logout", logoutHandler)

// GET /api/auth/csrf — 获取 CSRF token（添加日期: 2026-09-05）
authRouter.get("/csrf", async (c) => {
  try {
    const token = await generateCSRFToken(c)
    return c.json({
      code: 200,
      message: "success",
      data: { csrf_token: token },
    })
  } catch (err: any) {
    return c.json(
      { code: 500, message: "Failed to generate CSRF token", data: null },
      500,
    )
  }
})

// POST /api/auth/2fa/generate — returns a fresh TOTP secret + QR image
authRouter.post("/2fa/generate", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const { user } = auth
  if (user.otp_secret) {
    return c.json(
      { code: 400, message: "2FA already enabled", data: null },
      400,
    )
  }
  const secret = generateTotpSecret()
  const otpauth = buildOtpauthUrl(secret, user.username)
  const qr = await buildQrImageUrl(otpauth)
  return c.json({
    code: 200,
    message: "success",
    data: { qr, secret },
  })
})

// POST /api/auth/2fa/verify — validate a code against the generated secret,
// then persist it on the user so future logins require the TOTP code.
authRouter.post("/2fa/verify", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const { db, user } = auth
  const body = await c.req.json().catch(() => ({}))
  const code = String(body.code || "").trim()
  const secret = String(body.secret || "").trim()
  if (!secret) {
    return c.json(
      { code: 400, message: "Missing secret parameter", data: null },
      400,
    )
  }
  if (!/^[A-Z2-7]+$/i.test(secret)) {
    return c.json(
      { code: 400, message: "Invalid secret format", data: null },
      400,
    )
  }
  // 开启 2FA 属于敏感状态变更，需要一次口令复核：token 被偷的攻击者否则可以
  // 静默绑定一个自己生成的 TOTP secret，把账号变成「他知道二次因子」的状态。
  if (user.password) {
    const password = String(body.password ?? "")
    if (!(await verifyUserPassword(user, password))) {
      return c.json(
        { code: 403, message: "Incorrect password", data: null },
        403,
      )
    }
  }
  const valid = await verifyTotpCode(secret, code)
  if (!valid) {
    return c.json({ code: 400, message: "Invalid code", data: null }, 400)
  }
  user.otp_secret = secret.toUpperCase()
  // 恢复码：仅在开启 2FA 时明文返回一次，库内只存哈希，登录时单次消费。
  const backupCodes = generateBackupCodes(10)
  user.otp_backup_codes = await Promise.all(
    backupCodes.map((code) =>
      staticHash(code.trim().toUpperCase().replace(/\s/g, "")),
    ),
  )
  await saveDb(db, c.env)
  return c.json({
    code: 200,
    message: "success",
    data: { backup_codes: backupCodes },
  })
})

// Current user SSH Key sub-routes (/api/me/sshkey/*)
meRouter.get("/sshkey/list", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const keys = await listUserSshKeys(auth.user.id, c.env)
  return c.json({
    code: 200,
    message: "success",
    data: { content: keys, total: keys.length },
  })
})

meRouter.post("/sshkey/add", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const body = await c.req.json().catch(() => ({}))
  try {
    const key = await addUserSshKey(
      auth.user.id,
      body.key || body.public_key || "",
      body.name || body.title || "",
      c.env,
    )
    return c.json({
      code: 200,
      message: "success",
      data: key,
    })
  } catch (err: any) {
    return c.json(
      {
        code: 400,
        message: err.message || "Failed to add SSH key",
        data: null,
      },
      400,
    )
  }
})

meRouter.post("/sshkey/delete", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const id = c.req.query("id")
  if (!id) {
    return c.json(
      { code: 400, message: "Missing id parameter", data: null },
      400,
    )
  }
  const removed = await deleteUserSshKey(auth.user.id, id, c.env)
  if (!removed) {
    return c.json({ code: 404, message: "SSH key not found", data: null }, 404)
  }
  const keys = await listUserSshKeys(auth.user.id, c.env)
  return c.json({
    code: 200,
    message: "success",
    data: keys,
  })
})
