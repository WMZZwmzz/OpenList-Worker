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
  if (payload.id !== undefined && payload.id !== null) {
    return users.find((u: any) => String(u.id) === String(payload.id)) || null
  }
  if (payload.username) {
    return users.find((u: any) => u.username === payload.username) || null
  }
  return null
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
 * 计算用户请求路径对应的实际存储路径（结合用户的根目录 base_path）：
 * 1. 忽略以 /@s 开头的分享虚拟路径
 * 2. 若用户 base_path 为空或 "/"，直接返回规范化后的 reqPath
 * 3. 若用户 base_path 为非空路径（如 "/photos"），将 reqPath 拼接到 base_path 之后：
 *    - reqPath = "/" 或 "" -> "/photos"
 *    - reqPath = "/sub" -> "/photos/sub"
 *    - reqPath = "sub" -> "/photos/sub"
 *
 * 返回值始终是「与 resolvePath 同源的规范形式」：先按 resolvePath 的方式做多重
 * 百分号解码 + 段折叠，再要求结果不得越过用户自己的根目录（`..`、`%2e%2e`、
 * `%252e%252e`、`...` 等写法在 base_path 处被钳制）。
 *
 * 同源很重要：meta 覆盖判定、签名计算、hide/read_users 检查都是字符串比较，
 * 而真正定位存储时 resolvePath 会先解码再折叠 `..`。不同源就会出现
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

  if (!basePath.startsWith("/")) {
    basePath = `/${basePath}`
  }
  if (basePath.endsWith("/") && basePath.length > 1) {
    basePath = basePath.replace(/\/+$/, "")
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
