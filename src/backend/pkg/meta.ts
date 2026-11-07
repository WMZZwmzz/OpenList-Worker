import { getDb } from "../internal/model/db"
import type { UserPermissionObj } from "./permission"
import { isAdmin } from "./permission"
import { canonicalVirtualPath } from "./path"

/**
 * Meta 消费层（对齐 Go server/common/check.go）。
 *
 * Meta 定义了路径级别的权限、密码、隐藏、自定义内容等规则，
 * 本模块提供判断用户是否能访问/读/写某路径、以及获取 readme/header 的函数。
 */

export interface Meta {
  id: number
  path: string
  password: string
  p_sub: boolean
  read_users: number[]
  read_users_sub: boolean
  write_users: number[]
  write_users_sub: boolean
  write: boolean
  w_sub: boolean
  hide: string
  h_sub: boolean
  readme: string
  r_sub: boolean
  header: string
  header_sub: boolean
}

/**
 * F-062: `getNearestMeta` 只返回「最近一条」meta，但 read_users / write_users
 * 白名单的项目语义是「遍历**所有**覆盖该路径的 meta」（sign.ts
 * isReadUsersRestricted 就是这么做的）。canAccess / canRead / canWrite 是同步
 * 函数、自己无法查库，所以在 getNearestMeta 取库时把同一批 metas 关联到返回的
 * 对象上（WeakMap：不改导出签名、不污染 Meta 结构、对象被回收即释放）。判定
 * 函数拿到这些对象时会按 sign.ts 的口径遍历全部覆盖的 meta。
 *
 * 只有经由本模块 getNearestMeta 得到的 meta 才有这层关联；测试里手写的 meta
 * 对象退化为原来的单条判定。
 */
const metaScope = new WeakMap<Meta, Meta[]>()

function coveringMetas(meta: Meta): Meta[] {
  const scoped = metaScope.get(meta)
  return scoped && scoped.length > 0 ? scoped : [meta]
}

/**
 * 获取覆盖指定路径的最近祖先 meta（向上递归查找）。
 * 对齐 Go op.GetNearestMeta (internal/op/meta.go:27-65)。
 *
 * F-063: 路径比较必须大小写不敏感 —— 同文件的 metaCoversPath（:71）以及
 * sign.ts 的 getNearestMeta/metaCoversPath 全部 toLowerCase，而这里曾用大小写
 * 敏感的 `===`。在大小写不敏感的存储（Windows/macOS 本地驱动）上，配置
 * `/Photos` 而请求 `/photos` 会取到 null → canAccess 直接放行，meta 密码与
 * read_users 全部静默失效；/d 侧却因为用不敏感版本判定「需要签名」，同一条
 * ACL 在两个端点给出相反结论。
 */
export async function getNearestMeta(
  path: string,
  env?: any,
): Promise<Meta | null> {
  const db = await getDb(env)
  const metas = (db.metas || []) as Meta[]
  if (metas.length === 0) return null

  const cleanPath = fixAndCleanPath(path).toLowerCase()

  const withScope = (meta: Meta | undefined | null): Meta | null => {
    if (!meta) return null
    metaScope.set(meta, metas)
    return meta
  }

  // 直接匹配（大小写不敏感）
  const exact = metas.find(
    (m: Meta) => fixAndCleanPath(m.path).toLowerCase() === cleanPath,
  )
  if (exact) return withScope(exact)

  // 向上递归查找祖先
  let current = cleanPath
  while (current !== "/") {
    const parent = current.substring(0, current.lastIndexOf("/")) || "/"
    const match = metas.find(
      (m: Meta) => fixAndCleanPath(m.path).toLowerCase() === parent,
    )
    if (match) return withScope(match)
    current = parent
  }
  return null
}

/**
 * 判断 meta 是否覆盖目标路径（相等或祖先 + sub 开关）。
 * 对齐 Go common.MetaCoversPath (server/common/check.go:83-99)。
 */
export function metaCoversPath(
  metaPath: string,
  reqPath: string,
  applyToSubFolder: boolean,
): boolean {
  const mp = fixAndCleanPath(metaPath)
  const rp = fixAndCleanPath(reqPath)
  if (mp.toLowerCase() === rp.toLowerCase()) return true
  if (!applyToSubFolder) return false
  let current = rp
  while (current !== "/") {
    current = current.substring(0, current.lastIndexOf("/")) || "/"
    if (mp.toLowerCase() === current.toLowerCase()) return true
  }
  return false
}

/**
 * 路径规范化（L-7）。
 *
 * 历史上这里只合并斜杠、不折叠 `..`，而 `pkg/sign.ts` 与 `resolvePath` 用的是
 * 「多重解码 + 段折叠」的 canonicalVirtualPath。两套实现并存时，meta 覆盖判定
 * （字符串比较）与真正定位存储的路径会分叉：`/public/../secret/x` 可能被判成
 * 「不在 meta 保护范围内」，实际却读到 `/secret/x`。
 *
 * 现在统一到 canonicalVirtualPath，与签名判定、存储解析同源。
 */
function fixAndCleanPath(p: string): string {
  return canonicalVirtualPath(p)
}

/**
 * 目录密码的恒时比较（A-3）。
 *
 * `!==` 会在第一个不同字符处短路，逐字符的时序差理论上可用于还原密码。
 * 分享口令早已用恒时比较（internal/op/share.ts），这里补齐一致性。
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const left = String(a ?? "")
  const right = String(b ?? "")
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }
  return diff === 0
}

/**
 * 判断用户能否访问路径（密码 + read_users）。
 * 对齐 Go common.CanAccess (server/common/check.go:57-65)。
 *
 * F-062: read_users 分支不再只看传入的那一条（最近）meta，而是遍历所有覆盖
 * 该路径的 meta（任一命中且用户不在名单即拒绝），与 sign.ts isReadUsersRestricted
 * 同口径。密码仍只看最近 meta（密码不继承，与 Go 一致）。
 */
export function canAccess(
  user: UserPermissionObj | null,
  meta: Meta | null,
  path: string,
  password: string = "",
): boolean {
  // 管理员无视所有限制
  if (user && isAdmin(user)) return true

  if (!meta) return true

  // 密码保护：meta.password 非空 + 覆盖路径 → 需密码
  if (
    meta.password &&
    meta.password.trim() !== "" &&
    metaCoversPath(meta.path, path, meta.p_sub)
  ) {
    if (!timingSafeStringEqual(password, meta.password)) return false
  }

  // read_users 白名单：遍历所有覆盖路径的 meta，任一命中且用户不在名单即拒绝
  for (const m of coveringMetas(meta)) {
    if (!m || !Array.isArray(m.read_users) || m.read_users.length === 0) {
      continue
    }
    if (!metaCoversPath(m.path, path, !!m.read_users_sub)) continue
    if (!user || !m.read_users.includes(user.id ?? 0)) return false
  }

  return true
}

/**
 * 判断用户能否读取路径（read_users 白名单）。
 * 对齐 Go common.CanRead (server/common/check.go:21-28)。
 *
 * F-067: 旧实现只把 `user === null` 当系统上下文，随后直接读 `user.id`：
 * 传入 undefined（匿名请求 c.get("user") 的常见形态）且 meta 命中 read_users
 * 时抛 TypeError → 本应 403 的请求变成 500。这里改走可选链，undefined 按
 * 「无权限的普通访问者」处理（与 canAccess 一致），null 仍是系统上下文。
 */
export function canRead(
  user: UserPermissionObj | null | undefined,
  meta: Meta | null,
  path: string,
): boolean {
  // nil user（内部/系统上下文）无视限制
  if (user === null) return true
  if (user && isAdmin(user)) return true
  if (!meta) return true

  const uid = user?.id ?? 0
  for (const m of coveringMetas(meta)) {
    if (!m || !Array.isArray(m.read_users) || m.read_users.length === 0) {
      continue
    }
    if (!metaCoversPath(m.path, path, !!m.read_users_sub)) continue
    if (!user || !m.read_users.includes(uid)) return false
  }
  return true
}

/**
 * 判断用户能否写入路径（write_users 白名单）。
 * 对齐 Go common.CanWrite (server/common/check.go:30-41)。
 *
 * F-067: 同 canRead，undefined 不再触发 TypeError。
 */
export function canWrite(
  user: UserPermissionObj | null | undefined,
  meta: Meta | null,
  path: string,
): boolean {
  if (user === null) return true
  if (user && isAdmin(user)) return true
  if (!meta) return true

  const uid = user?.id ?? 0
  for (const m of coveringMetas(meta)) {
    if (!m || !Array.isArray(m.write_users) || m.write_users.length === 0) {
      continue
    }
    if (!metaCoversPath(m.path, path, !!m.write_users_sub)) continue
    if (!user || !m.write_users.includes(uid)) return false
  }
  return true
}

/**
 * 判断路径能否绕过用户写权限开关（meta.write + w_sub）。
 * 对齐 Go common.CanWriteContentBypassUserPerms (server/common/check.go:43-51)。
 *
 * 返回 true 表示即使用户无写权限也可写（目录管理员强制开启）。
 */
export function canWriteContentBypassUserPerms(
  meta: Meta | null,
  path: string,
): boolean {
  if (!meta) return false
  return meta.write && metaCoversPath(meta.path, path, meta.w_sub)
}

/**
 * 获取路径的 readme（meta.readme + r_sub）。
 * 对齐 Go handles/fsread.go:187-192 getReadme。
 */
export function getReadme(meta: Meta | null, path: string): string {
  if (!meta || !meta.readme) return ""
  if (metaCoversPath(meta.path, path, meta.r_sub)) {
    return meta.readme
  }
  return ""
}

/**
 * 获取路径的 header（meta.header + header_sub）。
 * 对齐 Go handles/fsread.go:194-199 getHeader。
 */
export function getHeader(meta: Meta | null, path: string): string {
  if (!meta || !meta.header) return ""
  if (metaCoversPath(meta.path, path, meta.header_sub)) {
    return meta.header
  }
  return ""
}

/**
 * 判断文件名是否被 meta.hide 正则隐藏（h_sub 控制子目录）。
 * 对齐 Go common.CanSeeHides (server/common/check.go:67-81)。
 *
 * 返回 true = 被隐藏（需过滤掉）。
 */
/**
 * 灾难性回溯形状（组内已有量词、组外又套量词）与超长模式：hide 要对每个远端
 * 文件名跑一遍，`(a+)+$` 这类配置在 30 字符的输入上就能把实例 CPU 打满。
 * 管理端保存时拒绝，运行时对历史数据直接跳过该条模式。
 */
const HIDE_PATTERN_MAX_LEN = 256
const NESTED_QUANTIFIER =
  /\((?:[^()]|\([^()]*\))*(?:[*+?]|\{[^}]*\})[^)]*\)(?:[*+?]|\{[^}]*\})/
const BACKREFERENCE = /\\[1-9]/
const QUANTIFIED_GROUP = /\(([^()]*)\)(?:[*+]|\{\d+,\})/g

/**
 * 被量词修饰的分组里含「有前缀重叠的候选」时（`(a|aa)+`、`(a|a?)+`），
 * 回溯会随输入长度指数增长。`(a|b)+` 这类互斥单字符分支是安全的，保留。
 */
function hasRiskyQuantifiedAlternation(pattern: string): boolean {
  QUANTIFIED_GROUP.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = QUANTIFIED_GROUP.exec(pattern))) {
    const alternatives = match[1].split("|").map((s) => s.trim())
    if (alternatives.length < 2) continue
    if (alternatives.some((a) => /[*+?{]/.test(a))) return true
    for (const a of alternatives) {
      for (const b of alternatives) {
        if (a !== b && b.startsWith(a)) return true
      }
    }
  }
  return false
}

export function isSafeHidePattern(pattern: string): boolean {
  if (pattern.length > HIDE_PATTERN_MAX_LEN) return false
  if (NESTED_QUANTIFIER.test(pattern)) return false
  if (BACKREFERENCE.test(pattern)) return false
  if (hasRiskyQuantifiedAlternation(pattern)) return false
  // 多个无界量词串联（`a*a*a*a*b`）的回溯是多项式级，数量一多同样会打满 CPU。
  const unbounded = pattern.match(/(?:[*+]|\{\d+,\})/g) || []
  if (unbounded.length > 3) return false
  return true
}

export function isHidden(
  meta: Meta | null,
  path: string,
  fileName: string,
): boolean {
  if (!meta || !meta.hide || meta.hide.trim() === "") return false
  if (!metaCoversPath(meta.path, path, meta.h_sub)) return false

  const patterns = meta.hide
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
  for (const pattern of patterns) {
    if (!isSafeHidePattern(pattern)) continue
    try {
      const re = new RegExp(pattern)
      if (re.test(fileName)) return true
    } catch {
      // 忽略非法正则
    }
  }
  return false
}

/**
 * 校验 hide 字段正则合法性（对齐 Go handles/meta.go:71-80 validHide）。
 * 返回 null = 合法；返回错误正则行 = 非法。
 */
export function validateHide(hide: string): string | null {
  if (!hide || hide.trim() === "") return null
  const lines = hide
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
  for (const line of lines) {
    if (!isSafeHidePattern(line)) return line
    try {
      new RegExp(line)
    } catch {
      return line
    }
  }
  return null
}
