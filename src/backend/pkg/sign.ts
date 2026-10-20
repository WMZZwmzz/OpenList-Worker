import { getDb } from "../internal/model/db"
import { getJwtSecret } from "../server/middlewares"
import { hmacSha256 } from "./crypto"
import { canonicalVirtualPath } from "./path"
import { getEnableSign } from "../internal/driver/storageopts"

/**
 * 下载链接签名（防盗链 / 链接过期）。
 *
 * 启用条件（管理后台设置）：
 * - sign_all === "true"：所有下载链接签发 HMAC 签名；
 * - link_expiration > 0：链接有效期（**小时**，对齐 Go/官方文档），超期失效；
 *   为 0 表示**永不过期**（Go：`LinkExpiration == 0` → `sign.NotExpired`）。
 * 两者都关闭时本模块完全静默（enabled=false），行为与未启用完全一致。
 *
 * 签名格式：`${expires}.${hmacSha256(virtualPath:expires, secret)}`；
 * `expires === 0` 表示永不过期，验签时不做超期判定（对齐 Go pkg/sign 的
 * `expires != 0` 分支）。密钥由 getJwtSecret（env.JWT_SECRET → KV/D1 持久化随机
 * → 进程内随机）派生的专用子密钥，不再与 JWT 直接共用同一字符串，无需额外配置。
 *
 * 与 Go 的差异（有意保留，不影响判签结果）：Go 用 `base64url(hmac) + ":" +
 * expire`，这里用 `expire + "." + hex(hmac)`，两种实现的签名不互通。
 */

/** 恒定时间比较（十六进制字符串），避免 HMAC 验签被时序侧信道攻击（M-1） */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export interface SignPolicy {
  enabled: boolean
  /** 签名有效期（**秒**）。0 表示永不过期（对齐 Go 的 expire == 0 语义）。 */
  expiresIn: number
}

export async function getSignPolicy(c: any): Promise<SignPolicy> {
  try {
    const db = await getDb(c?.env)
    const settings: Record<string, string> = {}
    for (const s of db.settings || []) settings[s.key] = s.value
    const signAll = settings.sign_all === "true"
    // link_expiration 的单位是**小时**：Go 用 time.Duration(expire)*time.Hour，
    // 官方文档（configuration/global.md）亦写明 "in hours"，0 = 永不过期。
    const linkExpHours = parseInt(settings.link_expiration, 10) || 0
    if (!signAll && linkExpHours <= 0) {
      return { enabled: false, expiresIn: 0 }
    }
    return {
      enabled: true,
      expiresIn: linkExpHours > 0 ? linkExpHours * 3600 : 0,
    }
  } catch {
    return { enabled: false, expiresIn: 0 }
  }
}

/**
 * 规范化路径（在 Go utils.FixAndCleanPath 的合并斜杠语义之上，额外做与
 * resolvePath 同源的「多重解码 + `..` 折叠」）。
 *
 * meta 覆盖判定用的是字符串比较，而真正定位存储时 resolvePath 会先解码再折叠：
 * 不同源就会出现 `/public/../secret/x.txt` 被判成「不在 meta 保护区内」（免签名），
 * 实际却读到 `/secret/x.txt`。
 */
function fixAndCleanPath(p: string): string {
  return canonicalVirtualPath(p)
}

/**
 * meta 是否覆盖该路径（对齐 Go server/common.MetaCoversPath）。
 * applyToSubFolder 为 false 时只匹配自身，为 true 时向上匹配所有祖先。
 */
export function metaCoversPath(
  metaPath: string,
  reqPath: string,
  applyToSubFolder: boolean,
): boolean {
  const mp = fixAndCleanPath(metaPath).toLowerCase()
  let rp = fixAndCleanPath(reqPath).toLowerCase()
  if (mp === rp) return true
  if (!applyToSubFolder) return false
  while (rp !== "/") {
    rp = fixAndCleanPath(rp.split("/").slice(0, -1).join("/"))
    if (mp === rp) return true
  }
  return false
}

/**
 * 取距离该路径最近的 meta（对齐 Go op.GetNearestMeta）：
 * 从自身逐级向上查找，返回首个存在的 meta。
 */
export async function getNearestMeta(
  c: any,
  reqPath: string,
): Promise<any | null> {
  try {
    const db = await getDb(c?.env)
    const metas = db.metas || []
    if (!metas.length) return null
    let p = fixAndCleanPath(reqPath)
    for (;;) {
      const hit = metas.find(
        (m: any) => fixAndCleanPath(m.path).toLowerCase() === p.toLowerCase(),
      )
      if (hit) return hit
      if (p === "/") return null
      p = fixAndCleanPath(p.split("/").slice(0, -1).join("/"))
    }
  } catch {
    return null
  }
}

/**
 * 该路径所在存储是否开启了存储级签名（对齐 Go common.IsStorageSignEnabled）。
 *
 * Go 版通过 op.GetBalancedStorage(path) 由路径反查存储，再读 EnableSign。
 * 这里用 storage 层已有的 resolvePath 做同样的解析，避免重复实现路径匹配。
 */
export async function isStorageSignEnabled(
  c: any,
  reqPath: string,
): Promise<boolean> {
  try {
    const { resolvePath } = await import("../internal/model/db")
    const resolved = await resolvePath(reqPath)
    if (!resolved?.storage) return false
    return getEnableSign(resolved.storage)
  } catch {
    return false
  }
}

/**
 * 该路径是否处于「密码保护」状态（对齐 Go server/handles.isEncrypt）。
 *
 * Go 的 isEncrypt 判定顺序为：存储级 EnableSign → meta 密码 → 其余 false。
 */
export async function isEncryptPath(c: any, reqPath: string): Promise<boolean> {
  // 对齐 Go：存储级 EnableSign 优先于 meta 密码分支
  if (await isStorageSignEnabled(c, reqPath)) return true
  const meta = await getNearestMeta(c, reqPath)
  if (!meta || !meta.password) return false
  return metaCoversPath(meta.path, reqPath, !!meta.p_sub)
}

/**
 * 下载是否必须携带签名（对齐 Go server/middlewares.needSign）。
 *
 * Go 的 /d、/p 是「公开下载端点」，链路为
 *   PathParse → Down(sign.Verify) → downloadLimiter → handles.Down/Proxy
 * 全程没有 Auth 中间件。是否放行只取决于本函数：
 *   - sign_all 开启              → 需要签名
 *   - （TS 扩展）link_expiration → 需要签名
 *   - meta 设了密码且覆盖该路径  → 需要签名
 *   - 否则                       → 无需签名，直接公开访问
 */
/**
 * meta 用 read_users 限定了可读用户但没有密码。Go 的 isEncrypt 不看这一项，
 * 于是这类路径的直链是公开的；本项目在 /fs/list、/fs/get 签发签名时已经按
 * canAccess 校验过请求者，所以把这类路径也纳入「必须签名」，read_users 才能
 * 真正约束住公开下载端点。
 */
async function isReadUsersRestricted(
  c: any,
  reqPath: string,
): Promise<boolean> {
  let metas: any[] = []
  try {
    const db = await getDb(c?.env)
    metas = db.metas || []
  } catch {
    return false
  }
  // 必须遍历**所有**覆盖该路径的 meta，而不是只看最近的一条：
  //   - 最近 meta 可能只是子目录的 readme/hide 配置（无 read_users），
  //     若只看它，祖先目录的 read_users 白名单就被整体忽略；
  //   - 子目录开关字段是 `read_users_sub`（meta.ts:115/:140 的 canAccess/
  //     canRead 用的就是它）。这里曾误写成 `r_sub`——那是 readme 的子目录
  //     开关，默认 false，于是「只配 read_users、不开密码」的目录在 /d 上
  //     对任意子路径都判定为「无需签名」，比 meta.path 深一层即可匿名下载。
  for (const meta of metas) {
    if (!meta || !Array.isArray(meta.read_users) || meta.read_users.length === 0)
      continue
    if (metaCoversPath(meta.path, reqPath, !!meta.read_users_sub)) return true
  }
  return false
}

export async function needDownloadSign(
  c: any,
  reqPath: string,
): Promise<boolean> {
  const policy = await getSignPolicy(c)
  if (policy.enabled) return true
  if (await isReadUsersRestricted(c, reqPath)) return true
  return await isEncryptPath(c, reqPath)
}

/**
 * 签名有效期（**秒**，0 = 永不过期）。
 *
 * link_expiration 以小时配置、为 0 时表示永不过期（对齐 Go sign.Sign 在
 * LinkExpiration == 0 时走 NotExpired）。meta 密码保护路径即使未开
 * sign_all/link_expiration 也需要签发签名，此时返回 0（永久），与 Go 一致。
 */
export async function getSignExpiresIn(c: any): Promise<number> {
  try {
    const db = await getDb(c?.env)
    for (const s of db.settings || []) {
      if (s.key === "link_expiration") {
        const hours = parseInt(s.value, 10) || 0
        if (hours > 0) return hours * 3600
        break
      }
    }
  } catch {}
  return 0
}

/**
 * 下载签名专用子密钥：由 JWT 签名密钥派生，但不直接复用同一字符串。
 * 一把密钥同时用于「会话 JWT」和「下载链接签名」时，任何一侧的签名 oracle
 * 都可能被拿去伪造另一侧的凭证。
 *
 * M-4：优先使用 `settings.download_sign_secret`（管理端
 * `POST /api/admin/setting/reset_token` 写入的轮换密钥）。这样「重置链接密钥」
 * 才真的能让既有直链立即失效；此前该端点写的是 `settings.token`——那是 115 /
 * PikPak / Thunder 驱动的凭据槽位，签名层根本不读，结果旧直链一条都没失效，
 * 反而把驱动配置改坏。
 */
async function getDownloadSignKey(c: any): Promise<string> {
  try {
    const db = await getDb(c?.env)
    const row = (db.settings || []).find(
      (s: any) => s.key === "download_sign_secret",
    )
    const secret = row?.value ? String(row.value).trim() : ""
    if (secret) {
      // 再套一层 HMAC：数据库里的值即使被读走，也不能直接当 HMAC 原钥使用
      const jwtSecret = await getJwtSecret(c)
      return await hmacSha256(`openlist-download-sign-v2:${secret}`, jwtSecret)
    }
  } catch {
    // 读不到配置时回退到纯 JWT 派生，保持既有的签名可用性
  }
  const jwtSecret = await getJwtSecret(c)
  return hmacSha256("openlist-download-sign-v1", jwtSecret)
}

/**
 * 签发下载签名。
 *
 * `expiresIn === 0` 表示**永不过期**（对齐 Go sign.NotExpired 的 expire=0），
 * 传负数仍会得到「已过期」的签名（对齐 Go 传负 duration 的行为）。
 */
export async function signDownloadPath(
  c: any,
  virtualPath: string,
  expiresIn: number,
): Promise<string> {
  const secret = await getDownloadSignKey(c)
  const expires =
    expiresIn === 0 ? 0 : Math.floor(Date.now() / 1000) + expiresIn
  const hmac = await hmacSha256(
    `${canonicalVirtualPath(virtualPath)}:${expires}`,
    secret,
  )
  return `${expires}.${hmac}`
}

export async function verifyDownloadSign(
  c: any,
  virtualPath: string,
  sign: string,
): Promise<boolean> {
  const dot = sign.lastIndexOf(".")
  if (dot <= 0) return false
  const expires = parseInt(sign.slice(0, dot), 10)
  const hmac = sign.slice(dot + 1)
  if (!Number.isFinite(expires)) return false
  // expires === 0 表示永不过期（对齐 Go HMACSign.Verify 的 `expires != 0` 判定）
  if (expires !== 0 && expires <= Math.floor(Date.now() / 1000)) {
    return false
  }
  const secret = await getDownloadSignKey(c)
  const expect = await hmacSha256(
    `${canonicalVirtualPath(virtualPath)}:${expires}`,
    secret,
  )
  return constantTimeEqualHex(expect, hmac)
}
