import { getDb, saveDb } from "../model/db"
import { canonicalVirtualPath, decodePathFully } from "../../pkg/path"
import { clientIpFromContext } from "../../pkg/client-ip"

/**
 * Share path resolution for /@s/{shareId}/... (frontend browsing)
 * and /{shareId}/... (after stripping /sd prefix in raw downloads).
 */

export interface ShareResolveResult {
  ok: boolean
  error?: string
  share?: any
  /** Mapped real storage path (single-file shares or sub-paths) */
  realPath?: string
  /** Multi-file share root — frontend should render a virtual list */
  virtualList?: boolean
}

// FIX(C-3): the old implementation only did filter(Boolean), so ".." segments
// survived verbatim and `/@s/{id}/../../../` escalated a single-file share
// into browsing the entire storage root (verified at runtime).
// Backslashes are normalized first for the same reason as resolvePath (C-2).
//
// FIX(SEC-002): 折叠前必须先做百分号解码。历史数据里可能存在以 `%2e%2e` 形式
// 入库的分享条目：只认字面 `..` 时，本函数把它当成普通段保留在白名单里，而消费
// 端 resolvePath 会解码并折叠成 `..`，白名单校验与真实落点就此分叉。
const normalize = (p: string) => {
  const view = decodePathFully(String(p || ""))
  const stack: string[] = []
  for (const seg of view.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      stack.pop() // clamp at the share root instead of escaping upward
      continue
    }
    stack.push(seg)
  }
  return "/" + stack.join("/")
}

/** 定长摘要式的逐字节比较，避免分享密码被按时序侧信道逐位猜出。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * 分享口令的暴破节流。
 *
 * 分享提取码通常是 4~6 位短码，而 `/@s/...`、`/sd/...` 都是匿名可达端点；
 * `max_accessed` 统计的是「解析成功次数」，错口令压根不计入，所以必须有独立的
 * 失败记账，否则一枚提取码可以在几分钟内被穷举完。
 */
const PWD_MAX_FAILS = 8
const PWD_WINDOW_MS = 10 * 60 * 1000
const pwdFailures = new Map<string, { count: number; until: number }>()

function pwdFailureKey(shareId: string, clientKey?: string): string {
  return `${shareId}|${clientKey || "unknown"}`
}

function isPwdLocked(key: string): boolean {
  const rec = pwdFailures.get(key)
  if (!rec) return false
  if (Date.now() > rec.until) {
    pwdFailures.delete(key)
    return false
  }
  return rec.count >= PWD_MAX_FAILS
}

function bumpPwdFailure(key: string): void {
  const now = Date.now()
  const rec = pwdFailures.get(key)
  if (!rec || now > rec.until) {
    pwdFailures.set(key, { count: 1, until: now + PWD_WINDOW_MS })
  } else {
    rec.count += 1
  }
  if (pwdFailures.size > 10000) {
    for (const [k, v] of pwdFailures) {
      if (now > v.until) pwdFailures.delete(k)
    }
  }
}

/** 调用方可传入的连接标识（Cloudflare 真实 IP 或受信反代头） */
export function shareClientKey(c: any): string {
  try {
    return clientIpFromContext(c)
  } catch {
    return "unknown"
  }
}

/**
 * Resolve a share request path.
 * @param reqPath e.g. `/@s/abc`, `/@s/abc/sub`, or `/abc/sub` (already stripped /sd)
 * @param password share password from frontend ("" if none)
 * @param clientKey 调用方连接标识，用于口令失败计数（可选）
 */
export async function resolveShare(
  reqPath: string,
  password: string,
  envCtx?: any,
  clientKey?: string,
): Promise<ShareResolveResult> {
  const clean = normalize(reqPath)
  const parts = clean.split("/").filter(Boolean)
  if (parts.length < 1) {
    return { ok: false, error: "Invalid share path" }
  }

  // Strip leading "@s" segment if present
  let shareId: string
  let rest: string[]
  if (parts[0] === "@s") {
    if (parts.length < 2) return { ok: false, error: "Invalid share path" }
    shareId = parts[1]
    rest = parts.slice(2)
  } else {
    shareId = parts[0]
    rest = parts.slice(1)
  }

  const db = await getDb(envCtx)
  const share = (db.shares || []).find((s: any) => s.id === shareId)
  if (!share) return { ok: false, error: "share not found" }
  if (share.disabled) return { ok: false, error: "share has been disabled" }
  if (share.expires) {
    const expiresAt = new Date(share.expires)
    // 无法解析的过期时间按「已过期」处理（fail-closed）：否则写入一个格式不符
    // 的 expires 就能让分享永久有效。
    if (Number.isNaN(expiresAt.getTime()) || expiresAt < new Date()) {
      return { ok: false, error: "share has expired" }
    }
  }
  if (
    share.max_accessed > 0 &&
    share.accessed !== undefined &&
    share.accessed >= share.max_accessed
  ) {
    return { ok: false, error: "share access count exceeded" }
  }
  const pwdKey = pwdFailureKey(shareId, clientKey)
  if (share.pwd && isPwdLocked(pwdKey)) {
    return { ok: false, error: "too many wrong passwords, please try later" }
  }
  if (
    share.pwd &&
    !constantTimeEqual(String(share.pwd), String(password ?? ""))
  ) {
    bumpPwdFailure(pwdKey)
    return { ok: false, error: "wrong password" }
  }
  if (share.pwd) pwdFailures.delete(pwdKey)
  if (!share.files || share.files.length === 0) {
    return { ok: false, error: "share is empty" }
  }

  // Count this access
  share.accessed = (share.accessed || 0) + 1
  saveDb(db, envCtx).catch(() => {})

  // FIX(C-3): containment check. Whatever normalize() produces, the result
  // must stay inside one of the explicitly shared paths.
  const allowedRoots: string[] = (share.files || []).map((f: string) =>
    normalize(f),
  )
  const withinShare = (p: string) =>
    allowedRoots.some((a) => p === a || p.startsWith(a === "/" ? "/" : a + "/"))

  /**
   * 落点必须仍在创建者自己的根目录内。
   *
   * 老数据里可能已经存有 `/u1/%2e%2e/...` 这类条目（创建时的 sanitizer 尚未解码）：
   * 消费端解码后就会落到别人的目录下。这里以「创建者的 base_path」为准再兜一道，
   * 管理员（base_path="/"）不受影响。
   */
  const withinCreatorRoot = (p: string): boolean => {
    const creator = (db.users || []).find(
      (u: any) => u.username === share.creator,
    )
    const base = String(creator?.base_path || "/").trim()
    if (!base || base === "/") return true
    const canonicalBase = canonicalVirtualPath(base)
    return p === canonicalBase || p.startsWith(canonicalBase + "/")
  }

  // 多文件分享的根：前端会直接遍历 share.files 逐项取条目，所以历史脏数据必须
  // 在这里就规范到创建者根目录之内，否则列表本身就成了越权读取的通道。
  if (share.files.length > 1 && rest.length === 0) {
    const safeFiles = allowedRoots.filter((p) => p && withinCreatorRoot(p))
    if (safeFiles.length === 0) {
      return { ok: false, error: "share is empty" }
    }
    share.files = safeFiles
    return { ok: true, share, virtualList: true }
  }

  // Single-file share: one file has no sub-paths, so trailing segments are
  // always suspicious — reject instead of concatenating them.
  if (share.files.length === 1) {
    if (rest.length > 0) return { ok: false, error: "path not found in share" }
    const single = normalize(share.files[0])
    if (!withinCreatorRoot(single))
      return { ok: false, error: "path not found in share" }
    return { ok: true, share, realPath: single }
  }

  // Multi-file share, sub-path: match by basename
  const subName = rest[0]
  const match = share.files.find((f: string) => {
    const segs = String(f).split("/").filter(Boolean)
    return segs[segs.length - 1] === subName
  })
  if (!match) return { ok: false, error: "path not found in share" }
  const real = normalize([normalize(match), ...rest.slice(1)].join("/"))
  if (!withinShare(real) || !withinCreatorRoot(real)) {
    return { ok: false, error: "path not found in share" }
  }
  return { ok: true, share, realPath: real }
}

/** Extract the share id from a path like `/@s/abc/sub` or `/abc/sub` */
export function extractShareId(reqPath: string): string | null {
  const parts = normalize(reqPath).split("/").filter(Boolean)
  if (parts.length === 0) return null
  if (parts[0] === "@s") return parts[1] || null
  return parts[0]
}
