/**
 * KV 代理共享模块
 *
 * EdgeOne Edge Functions 约定：
 * - 目录 functions/<name>/index.js 自动生成路由 /<name>
 * - 以 `_` 开头的文件为共享模块，不生成路由
 * - KV 绑定名在运行时直接可用（官方示例做法，非 env.KV）
 *
 * 鉴权策略（三层）：
 *  1. 内部调用：X-Internal-Call 常量时间比对**完整**密钥
 *     —— 用于 Node 云函数（初始化、后台任务等无用户 token 的场景）
 *  2. 用户调用：真实校验 HS256 JWT 签名 + exp/nbf + 管理员角色
 *     —— 用于外部直接访问 /kv-* 的请求
 *  3. 其余一律 401
 *
 * JWT 密钥来源与 Node 侧保持一致：
 *  env.JWT_SECRET -> KV 中的 openlist_jwt_secret -> （都没有则拒绝用户调用）
 */

const JWT_SECRET_KV_KEY = "openlist_jwt_secret"
const ADMIN_ROLE = 2

/**
 * 与后端主链路一致的持久化键（F-121）。
 *
 * - `openlist_revoked_tokens`：登出/OTP 兑换后写入的 jti 注销名单
 *   （middlewares.ts 的 REVOKED_KV_KEY，格式 [{ jti, exp }]）。
 * - `openlist_config`：DB_FORMAT=map 时整库 JSON 所在的键；用户表里的
 *   `token_epoch` 是改密 / 关闭 2FA 后的令牌版本号（M-3）。
 *
 * 本文件是 /kv-* 数据面的唯一鉴权点。历史上它只校验签名/exp/角色，
 * 于是管理员改密或登出后，被泄露的旧 token 打主站 API 会被 epoch/注销名单
 * 拦住，直接打 /kv-get、/kv-put 却仍可通过（最长 7 天），可整库读写并窃取
 * JWT_SECRET。边缘本来就有 KV 读能力，这两项完全可以复核。
 */
const REVOKED_KV_KEY = "openlist_revoked_tokens"
const CONFIG_KV_KEY = "openlist_config"
/** 整库快照的短 TTL 缓存：一条用户 token 的 /kv-* 请求通常不会连发多次 */
const DB_SNAPSHOT_TTL_MS = 5000

/* ─────────────────────────── KV 绑定解析 ─────────────────────────── */

/**
 * 解析 KV 绑定。
 *
 * 绑定名固定为 `KV`。官方示例中绑定名是直接可用的全局标识符，
 * 这里兼容 env 挂载与全局两种形态。
 */
export function resolveKv(env) {
  const v = env?.KV
  if (isKvLike(v)) return v
  const gv = globalThis?.KV
  if (isKvLike(gv)) return gv
  return null
}

function isKvLike(v) {
  return !!v && typeof v.get === "function" && typeof v.put === "function"
}

/* ─────────────────────────── 密钥获取 ─────────────────────────── */

/**
 * 获取 JWT 密钥，优先级与 Node 侧 getJwtSecret 一致。
 *
 * **不缓存**。KV 密钥可能被 Node 侧随时写入或轮换，任何形式的模块级
 * 缓存（哪怕带 TTL）都会让本实例在一段时间内持有旧值，导致
 * X-Internal-Call 鉴权失败。env 读取本身几乎无开销，KV 读取仅在
 * 未配置 env 时发生，成本可接受。用最简单的方式换取"永不失效"。
 *
 * @returns {Promise<string|null>}
 */
export async function getJwtSecret(env) {
  // 1) 环境变量。F-123：只要求**非空**，与 Node 侧 driver/kv.ts 的 getProxySecret
  //    保持一致（"长度 >= 16" 是运维建议，不是程序可以替用户决定的门槛）。
  //    历史实现要求 >= 16：当 JWT_SECRET 为 1-15 字符时，Node 侧判定「配置合法 →
  //    选中代理驱动」，边缘侧却取不到密钥 → 所有 /kv-* 永久 401 "invalid internal
  //    call"，且报错完全不提长度问题。同一变量在两处有两种阈值是纯粹的缺陷。
  const envSecret = env?.JWT_SECRET || globalThis?.JWT_SECRET
  if (typeof envSecret === "string" && envSecret.trim().length > 0) {
    return envSecret
  }

  // 2) KV 持久化密钥（与 Node 侧共用 openlist_jwt_secret）
  try {
    const kv = resolveKv(env)
    if (kv) {
      const val = await kv.get(JWT_SECRET_KV_KEY, { type: "text" })
      if (typeof val === "string" && val.trim().length > 0) {
        return val
      }
    }
  } catch {
    // 读取失败则视为无密钥
  }

  return null
}

/* ─────────────────────────── 吊销校验（F-121） ─────────────────────────── */

/**
 * 读取一个 KV 文本值（兼容两种 get 签名），失败返回 null。
 * 鉴权路径上的辅助读取：任何异常都按「读不到」处理，不阻断。
 */
async function readKvText(env, key) {
  const kv = resolveKv(env)
  if (!kv) return null
  try {
    const val = await kv.get(key, { type: "text" })
    if (val === null || val === undefined) return null
    if (typeof val === "string") return val
    if (typeof val?.text === "function") return await val.text()
    return String(val)
  } catch {
    try {
      const val = await kv.get(key)
      if (val === null || val === undefined) return null
      if (typeof val === "string") return val
      if (typeof val?.text === "function") return await val.text()
      return String(val)
    } catch {
      return null
    }
  }
}

/** 整库快照缓存（仅用于 epoch 复核，5s TTL）。 */
let dbSnapshotCache = { ts: 0, db: null }

/**
 * 读取持久化库快照（DB_FORMAT=map 时整库在 `openlist_config`）。
 *
 * 取不到（键不存在 / 驱动不是 KV / 解析失败）返回 null —— 此时无法复核 epoch，
 * 保持与修复前一致的行为（放行），绝不因为边缘读不到库而拒绝全部请求。
 */
async function readDbSnapshot(env) {
  const now = Date.now()
  if (dbSnapshotCache.db && now - dbSnapshotCache.ts < DB_SNAPSHOT_TTL_MS) {
    return dbSnapshotCache.db
  }
  const raw = await readKvText(env, CONFIG_KV_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.users)) {
      dbSnapshotCache = { ts: now, db: parsed }
      return parsed
    }
  } catch {
    // 不是整库 JSON（key 格式的标记键等）：无法复核
  }
  return null
}

/**
 * 令牌是否仍然有效：jti 注销名单 + token epoch（改密 / 关 2FA 后失效）。
 *
 * 与后端主链路对齐：
 *   - middlewares.ts 的 REVOKED_KV_KEY（登出时写入 [{ jti, exp }]）；
 *   - pkg/permission.ts 的 `payloadEpoch !== userEpoch → 拒绝`。
 *
 * 边缘拿不到用户表时（D1/MySQL/DO 部署），epoch 复核自动跳过（fail-open），
 * 这与修复前的行为一致、不会误伤；KV 部署下则能真正拦住改密后的旧 token。
 */
async function isTokenStillValid(env, payload) {
  const now = Math.floor(Date.now() / 1000)

  // 1) jti 注销名单
  if (payload.jti) {
    const raw = await readKvText(env, REVOKED_KV_KEY)
    if (raw) {
      try {
        const list = JSON.parse(raw)
        if (
          Array.isArray(list) &&
          list.some(
            (item) =>
              item &&
              item.jti === payload.jti &&
              Number(item.exp) > now, // 过期条目自然失效
          )
        ) {
          return { ok: false, reason: "token has been revoked" }
        }
      } catch {
        // 名单损坏：不阻断（与主链路 ensureRevokedLoaded 的降级一致）
      }
    }
  }

  // 2) token epoch（历史 token 没有该 claim，跳过）
  if (payload.epoch !== undefined) {
    const db = await readDbSnapshot(env)
    if (db) {
      const users = Array.isArray(db.users) ? db.users : []
      const user =
        users.find(
          (u) => u && payload.id !== undefined && String(u.id) === String(payload.id),
        ) || users.find((u) => u && u.username === payload.username)
      if (user) {
        const userEpoch = Number(user.token_epoch ?? 0) || 0
        if (Number(payload.epoch) !== userEpoch) {
          return { ok: false, reason: "token epoch mismatch" }
        }
      }
    }
  }

  return { ok: true }
}

/* ─────────────────────────── 鉴权 ─────────────────────────── */

/**
 * 常量时间字符串比较（防时序攻击）
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/* ── base64url 工具 ── */
function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)))
}

function bytesToB64url(bytes) {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * 校验 HS256 JWT：签名 + exp + nbf。
 * @returns {Promise<object|null>} 校验通过的 payload，失败返回 null
 */
export async function verifyJwt(token, secret) {
  if (!secret) return null

  const parts = String(token).split(".")
  if (parts.length !== 3) return null

  const [headerB64, payloadB64, signB64] = parts

  // 1) 头部算法必须为 HS256，拒绝 alg=none 等降级攻击
  let header
  try {
    header = b64urlToJson(headerB64)
  } catch {
    return null
  }
  if (!header || header.alg !== "HS256") return null

  // 2) 验签
  let keyMat
  try {
    keyMat = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    )
  } catch {
    return null
  }

  let signature
  try {
    signature = b64urlToBytes(signB64)
  } catch {
    return null
  }

  let valid
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      keyMat,
      signature,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    )
  } catch {
    valid = false
  }
  if (!valid) return null

  // 3) 时间与角色校验
  let payload
  try {
    payload = b64urlToJson(payloadB64)
  } catch {
    return null
  }
  if (!payload) return null

  const now = Math.floor(Date.now() / 1000)
  // H-1：exp 缺失或非数字时**必须拒绝**。
  // 历史实现是 `typeof exp === "number" && now >= exp`，于是 exp:"abc" /
  // 完全没有 exp 的 token 永不过期 —— 一旦泄漏就是永久管理员凭据。
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return null
  }
  if (now >= payload.exp) return null
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) {
      return null
    }
    if (now < payload.nbf) return null
  }
  // 2FA 待兑换令牌只能用于 /api/auth/otp/login，不得当会话用（与主站一致）。
  if (payload.type === "otp_pending" || payload.otp_pending === true) return null
  // iss / aud 若存在必须匹配（兼容历史无该字段的 token，但拒绝错值）。
  if (payload.iss !== undefined && payload.iss !== "openlist") return null
  if (payload.aud !== undefined && payload.aud !== "openlist-api") return null

  return payload
}

/**
 * 统一鉴权入口
 *
 * @returns {Promise<{ok: boolean, mode: "internal"|"user"|"anonymous", reason?: string}>}
 */
export async function authorize(request, env) {
  /* ── 1) 内部调用（Node 云函数） ── */
  const internal = request.headers.get("X-Internal-Call")
  if (internal) {
    const secret = await getJwtSecret(env)
    // 使用**完整密钥**比对（不做截断）。
    //
    // 历史实现只比对前 16 个字符，导致熵从 256 bit 降到 64 bit，
    // 且内部通道会绕过后续的管理员角色校验 —— 一旦猜中即可任意读写 KV。
    // 现在要求提交完整密钥，熵与 JWT_SECRET 一致。
    if (secret && timingSafeEqual(internal, secret)) {
      return { ok: true, mode: "internal" }
    }
    // 带了内部调用头但不匹配：直接拒绝，不继续尝试用户鉴权，
    // 避免用错误头绕过后续逻辑
    return { ok: false, mode: "anonymous", reason: "invalid internal call" }
  }

  /* ── 2) 用户调用（真实校验 JWT） ── */
  const auth = request.headers.get("Authorization") || ""
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7)
    const secret = await getJwtSecret(env)

    if (!secret) {
      return {
        ok: false,
        mode: "anonymous",
        reason: "no JWT secret configured on edge",
      }
    }

    const payload = await verifyJwt(token, secret)
    if (!payload) {
      return { ok: false, mode: "anonymous", reason: "invalid token" }
    }

    // 管理员角色校验：KV 为数据面，仅管理员可读写
    if (Number(payload.role) !== ADMIN_ROLE) {
      return { ok: false, mode: "user", reason: "admin role required" }
    }

    // F-121：吊销旁路封堵 —— 与主链路一致地校验 jti 注销名单与 token epoch。
    // 边缘取不到用户表时（D1/MySQL/DO 部署）epoch 复核会跳过，见 isTokenStillValid。
    const stillValid = await isTokenStillValid(env, payload)
    if (!stillValid.ok) {
      return { ok: false, mode: "user", reason: stillValid.reason || "token revoked" }
    }

    return { ok: true, mode: "user" }
  }

  return { ok: false, mode: "anonymous", reason: "no credentials" }
}

/* ─────────────────────────── 响应工具 ─────────────────────────── */

/** 统一 JSON 响应，禁止缓存 */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

export function unauthorized(message = "Unauthorized") {
  return json({ error: message }, 401)
}

export function forbidden(message = "Forbidden") {
  return json({ error: message }, 403)
}

export function kvMissing() {
  return json(
    {
      error:
        "KV binding not available in Edge Function. " +
        "Check that the KV namespace is bound to Edge Functions (not Node Functions).",
    },
    503,
  )
}

/**
 * 根据鉴权结果返回合适的错误响应
 */
export function deny(auth) {
  if (auth.mode === "user") return forbidden(auth.reason || "Forbidden")
  return unauthorized(auth.reason || "Unauthorized")
}

// 供路由模块复用的验签工具（导出以便测试）
export { b64urlToBytes, bytesToB64url, timingSafeEqual }
