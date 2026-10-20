import {
  collapsePathSegments,
  canonicalVirtualPath,
  decodePathFully,
} from "./path"

export enum UserRole {
  GENERAL = 0,
  GUEST = 1,
  ADMIN = 2,
}

export const JWT_ISSUER = "openlist"
export const JWT_AUDIENCE = "openlist-api"

/**
 * JWT 的 iss/aud 校验：新签发的 token 必须带正确的值；历史上没有这两个 claim
 * 的 token 仍接受（避免升级即全员掉线），但带错值的一律拒绝，防止同一密钥被
 * 其它服务复用后互相认账。
 */
export function jwtClaimsAcceptable(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false
  if (payload.iss !== undefined && payload.iss !== JWT_ISSUER) return false
  if (payload.aud !== undefined && payload.aud !== JWT_AUDIENCE) return false
  return true
}

export const PermissionBit = {
  SEE_HIDES: 0, // 1 << 0 = 1
  ACCESS_WITHOUT_PASSWORD: 1, // 1 << 1 = 2
  OFFLINE_DOWNLOAD: 2, // 1 << 2 = 4
  WRITE_CONTENT: 3, // 1 << 3 = 8 (mkdir / upload)
  RENAME: 4, // 1 << 4 = 16
  MOVE: 5, // 1 << 5 = 32
  COPY: 6, // 1 << 6 = 64
  DELETE: 7, // 1 << 7 = 128
  WEBDAV_READ: 8, // 1 << 8 = 256
  WEBDAV_MANAGE: 9, // 1 << 9 = 512
  FTP_READ: 10, // 1 << 10 = 1024
  FTP_MANAGE: 11, // 1 << 11 = 2048
  READ_ARCHIVES: 12, // 1 << 12 = 4096
  DECOMPRESS: 13, // 1 << 13 = 8192
  SHARE: 14, // 1 << 14 = 16384
  CUSTOMIZE_SHARE_ID: 15, // 1 << 15 = 32768
} as const

export interface UserPermissionObj {
  id?: number
  username?: string
  role: number
  permission: number
  disabled?: boolean
  base_path?: string
}

/**
 * 按 token subject 定位用户。
 *
 * 旧写法是 `u.id === payload.id || u.username === payload.username`，两个条件
 * 任一命中即通过：删号后重建同名用户、或用户改名后旧 id 被复用，都会让一张
 * 仍在有效期内的旧 token 认到别人身上。现在以 id 为准，只有历史签发的 token
 * （不含 id）才回退按用户名匹配。
 */
export function findUserByTokenPayload(
  users: any[] | undefined,
  payload: any,
): any {
  if (!Array.isArray(users) || !payload) return null
  let user: any = null
  if (payload.id !== undefined && payload.id !== null) {
    user =
      users.find((u: any) => String(u.id) === String(payload.id)) || null
  } else if (payload.username) {
    user = users.find((u: any) => u.username === payload.username) || null
  }
  if (!user) return null

  // M-3：token 版本号。改密 / 管理员改密 / 关闭 2FA 会递增它，从而让该用户
  // 此前签发的所有 JWT 立即失效（此前只能等 7 天自然过期）。没有该字段的
  // 历史 token / 历史用户都按 0 处理，升级不影响已登录用户。
  const payloadEpoch = Number(payload?.epoch ?? 0) || 0
  const userEpoch = Number(user.token_epoch ?? 0) || 0
  if (payloadEpoch !== userEpoch) return null

  return user
}

/**
 * 递增用户的 token 版本号，使其已签发的 JWT 全部失效（M-3）。
 *
 * 调用点：用户自助改密、管理员改他人密码、关闭 2FA。调用方负责 saveDb。
 */
export function bumpTokenEpoch(user: any): void {
  if (!user) return
  user.token_epoch = (Number(user.token_epoch ?? 0) || 0) + 1
}

export function isGuest(user?: UserPermissionObj | null): boolean {
  return !user || user.role === UserRole.GUEST
}

export function isAdmin(user?: UserPermissionObj | null): boolean {
  return !!user && user.role === UserRole.ADMIN
}

export function isGeneral(user?: UserPermissionObj | null): boolean {
  return !!user && user.role === UserRole.GENERAL
}

export function can(
  user: UserPermissionObj | null | undefined,
  bitIndex: number,
): boolean {
  if (!user) return false
  if (user.disabled) return false
  if (isAdmin(user)) return true
  if (isGuest(user)) return false
  return ((user.permission >> bitIndex) & 1) === 1
}

export function canSeeHides(user?: UserPermissionObj | null): boolean {
  return can(user, PermissionBit.SEE_HIDES)
}

export function canWrite(user?: UserPermissionObj | null): boolean {
  return can(user, PermissionBit.WRITE_CONTENT)
}

export function canRename(user?: UserPermissionObj | null): boolean {
  return can(user, PermissionBit.RENAME)
}

export function canMove(user?: UserPermissionObj | null): boolean {
  return can(user, PermissionBit.MOVE)
}

export function canCopy(user?: UserPermissionObj | null): boolean {
  return can(user, PermissionBit.COPY)
}

export function canRemove(user?: UserPermissionObj | null): boolean {
  return can(user, PermissionBit.DELETE)
}

/**
 * 规范化路径段：合并重复斜杠、丢弃 "."，并用栈折叠 ".."。
 *
 * 关键点：栈为空时的 ".." 会被**钳制在根**（`stack.pop()` 作用于空数组是
 * 空操作），因此结果永远以 "/" 开头且不含 ".." 段，无法向上逃逸。
 */
export function normalizeSegments(p: string): string {
  const stack: string[] = []
  for (const seg of String(p || "").split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  return "/" + stack.join("/")
}

/**
 * 计算用户请求路径对应的实际存储路径（结合用户的根目录 base_path）：
 * 1. 忽略以 /@s 开头的分享虚拟路径
 * 2. 若用户 base_path 为空或 "/"，直接返回规范化后的 reqPath
 * 3. 若用户 base_path 为非空路径（如 "/photos"），将 reqPath 拼接到 base_path 之后：
 *    - reqPath = "/" 或 "" -> "/photos"
 *    - reqPath = "/sub" -> "/photos/sub"
 *    - reqPath = "sub" -> "/photos/sub"
 *
 * 安全不变量（必须长期保持）：**返回值只可能等于 base_path 或位于其下**，且始终
 * 是「与 resolvePath 同源的规范形式」：先按 resolvePath 的方式做多重百分号解码 +
 * 段折叠，再要求结果不得越过用户自己的根目录（`..`、`%2e%2e`、`%252e%252e` 等写法
 * 在 base_path 处被钳制）。
 *
 * 历史缺陷：本函数只做字符串拼接，`..` 段留给下游 resolvePath() 折叠。于是
 * `/photos/alice` + `/../bob/x` 会解析成 `/photos/bob/x` —— 用户根目录被越过。
 * 因为拼接后才规范化，下游只保证「不逃出存储物理根」，并不保证「不逃出用户
 * 根」，两者不是同一约束。
 *
 * 同源很重要：meta 覆盖判定、签名计算、hide/read_users 检查都是字符串比较，而真正
 * 定位存储时 resolvePath 会先解码再折叠 `..`。不同源就会出现
 * `/public/../secret/x.txt` 被判成「不在保护区内」（免签名/免密码），实际却读到
 * `/secret/x.txt`。
 */
export function getActualPath(
  user?: UserPermissionObj | null,
  reqPath: string = "/",
): string {
  const p = reqPath || "/"
  if (p.startsWith("/@s")) {
    return p
  }

  let basePath = (user?.base_path || "/").trim()
  if (!basePath || basePath === "/") {
    // 没有 base_path 时也返回规范形式：resolvePath 之后会解码并折叠 `..`，而 meta
    // 覆盖判定与签名计算都是字符串比较，两者必须同源——否则
    // `/public/../secret/x.txt` 会被判成「不在保护区内」（免签名），却照样读得到。
    return canonicalVirtualPath(p.startsWith("/") ? p : `/${p}`)
  }

  const cleanReq = p.startsWith("/") ? p : `/${p}`
  if (cleanReq === "/") {
    return canonicalVirtualPath(basePath)
  }

  const joined = `${basePath}${cleanReq}`
  const baseStack = decodePathFully(basePath)
    .split("/")
    .filter((s) => s !== "" && s !== ".")

  // 统一取「多重解码 + 段折叠」的规范形式（与 resolvePath 同源），并在用户自己的
  // 根目录处钳制：既堵住 base_path 逃逸，也让 meta 覆盖 / 签名判定看到同一个路径。
  const clamped = collapsePathSegments(
    decodePathFully(joined),
    baseStack.length,
  )
  return clamped.length === 0 ? basePath : "/" + clamped.join("/")
}

/**
 * 判断某个实际路径是否位于用户根目录之内（含等于根目录本身）。
 *
 * 供网关类入口（S3 / WebDAV）在把请求路径交给存储层之前做二次确认使用：
 * 这些入口直接操作「全局虚拟路径」，不走 getActualPath 的拼接语义，因此需要
 * 一个显式的范围检查，避免受限用户越出 base_path。
 */
export function isWithinUserRoot(
  user: UserPermissionObj | null | undefined,
  actualPath: string,
): boolean {
  const root = getActualPath(user, "/")
  const target = normalizeSegments(actualPath)
  if (root === "/") return true
  return target === root || target.startsWith(root + "/")
}
