import { getDb, saveDb } from "../model/db"
import { canonicalVirtualPath, decodePathFully } from "../../pkg/path"
import { clientIpFromContext } from "../../pkg/client-ip"
import { can, PermissionBit } from "../../pkg/permission"

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
// A-20：拿不到可信客户端标识时使用「全局桶」，阈值放宽到 20 次/10 分钟：
// 既避免历史实现「完全不限流、可无限爆破」，也降低攻击者故意输错锁死所有
// 匿名用户输入提取码的可用性影响。
const PWD_MAX_FAILS_UNTRUSTED = 20
const PWD_WINDOW_MS = 10 * 60 * 1000
const pwdFailures = new Map<string, { count: number; until: number }>()

function pwdFailureKey(shareId: string, clientKey?: string): string {
  return `${shareId}|${clientKey || "unknown"}`
}

function isPwdLocked(key: string, maxFails: number = PWD_MAX_FAILS): boolean {
  const rec = pwdFailures.get(key)
  if (!rec) return false
  if (Date.now() > rec.until) {
    pwdFailures.delete(key)
    return false
  }
  return rec.count >= maxFails
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
 * @param requestContext 平台请求上下文（可选）。提供 `waitUntil` 时访问计数的
 *        saveDb 会挂到 after-response 生命周期上；未提供时**显式 await**（F-041）。
 */
export async function resolveShare(
  reqPath: string,
  password: string,
  envCtx?: any,
  clientKey?: string,
  requestContext?: { waitUntil?: (promise: Promise<any>) => void },
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
  // A-62：创建者被禁用或已失去分享权限后，旧分享必须立即失效。
  // 对齐 Go SharingDB.Usable() 的 CanShare 校验。
  if (share.creator) {
    const creator = (db.users || []).find(
      (u: any) => u.username === share.creator,
    )
    if (!creator || creator.disabled) {
      return { ok: false, error: "share creator is unavailable" }
    }
    if (!can(creator, PermissionBit.SHARE)) {
      return { ok: false, error: "share creator is no longer allowed to share" }
    }
  }
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
  // A-20：IP 不可信（自托管未配置 TRUST_PROXY_HEADERS / CF-Connecting-IP）时，
  // 历史实现直接跳过全部锁定，4~6 位提取码可被无限爆破；注释声称的
  // 「退化为全局限流」并未实现。现在所有来源都参与计数：拿不到客户端标识时
  // 使用 "unknown" 全局桶，达到阈值同样锁定（代价是可能被短暂 DoS，但远好于
  // 提取码被穷举）。
  const trustedSource = !!clientKey && clientKey !== "unknown"
  const pwdKey = pwdFailureKey(shareId, trustedSource ? clientKey : "unknown")
  const maxFails = trustedSource ? PWD_MAX_FAILS : PWD_MAX_FAILS_UNTRUSTED
  if (share.pwd && isPwdLocked(pwdKey, maxFails)) {
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

  /**
   * S-2：访问计数只能记在**解析成功**之后。
   *
   * 历史实现把 `accessed+1` 与整库 saveDb 放在所有 containment 校验之前：
   * 匿名者对 `/@s/{id}/random` 反复探测（必然 400）也会持续触发
   * 「读全库 → 序列化 → 写全库」，并提前烧完 max_accessed 配额。
   *
   * F-041：计数落盘不能是「未 await 且未挂 waitUntil」的浮动 Promise。
   * Cloudflare Workers / EdgeOne 在响应返回后不保证未注册 waitUntil 的 Promise
   * 继续执行，整库序列化 + 网络写盘很可能被中途取消；`.catch(() => {})` 还会把
   * 失败完全吞掉。结果 `share.accessed >= share.max_accessed` 的配额不可靠。
   *
   * 现在：有 requestContext.waitUntil → 挂到 after-response；没有 → 显式 await
   * （调用方拿到的结果已经是「计数已尝试落盘」的状态）。
   */
  const recordAccess = async (): Promise<void> => {
    share.accessed = (share.accessed || 0) + 1
    const task = saveDb(db, envCtx).catch((err: any) => {
      // 计数落盘失败不影响分享本身可用：保持内存计数并继续
      console.warn("[Share] failed to persist access count:", err?.message || err)
    })
    if (typeof requestContext?.waitUntil === "function") {
      requestContext.waitUntil(task)
      return
    }
    await task
  }

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
    await recordAccess()
    return { ok: true, share, virtualList: true }
  }

  // A-04：单条路径分享既可能是文件也可能是目录。
  // 历史实现把「一条 files」一律当成单文件分享，rest 非空就直接拒绝，导致
  // 目录分享只能浏览第一层，任何子目录/子文件都 400/404（核心功能回归）。
  // 与上游 Go GetSharingUnwrapPath 对齐：Join(files[0], rest) 后仍做 containment。
  if (share.files.length === 1) {
    const root = normalize(share.files[0])
    if (!withinShare(root) || !withinCreatorRoot(root))
      return { ok: false, error: "path not found in share" }
    // 只有目录分享才允许子路径；单文件分享的任意尾随段都必须拒绝。
    if (rest.length > 0) {
      let rootIsDir = false
      try {
        const { getItem } = await import("./storage")
        const { item } = await getItem(root, { env: envCtx })
        rootIsDir = !!item?.is_dir
      } catch {
        rootIsDir = false
      }
      if (!rootIsDir) {
        return { ok: false, error: "path not found in share" }
      }
    }
    const single = normalize([root, ...rest].join("/"))
    if (!withinShare(single) || !withinCreatorRoot(single))
      return { ok: false, error: "path not found in share" }
    await recordAccess()
    return { ok: true, share, realPath: single }
  }

  // Multi-file share, sub-path: match by basename
  //
  // F-095：存储侧的段必须先解码再比较。`subName` 来自 normalize → decodePathFully
  // （完全解码），而历史数据里可能存在以百分号编码形式入库的条目（见 SEC-002 注释）。
  // 用原始段比较时，`/u1/my%20file.txt` 既匹配不上 `my file.txt` 也匹配不上
  // `my%20file.txt`（请求侧会被解码）—— 编码形态的分享条目其子路径永远不可访问。
  const subName = rest[0]
  const match = share.files.find((f: string) => {
    const segs = String(f).split("/").filter(Boolean)
    return decodePathFully(segs[segs.length - 1] || "") === subName
  })
  if (!match) return { ok: false, error: "path not found in share" }
  const real = normalize([normalize(match), ...rest.slice(1)].join("/"))
  if (!withinShare(real) || !withinCreatorRoot(real)) {
    return { ok: false, error: "path not found in share" }
  }
  await recordAccess()
  return { ok: true, share, realPath: real }
}

/** Extract the share id from a path like `/@s/abc/sub` or `/abc/sub` */
export function extractShareId(reqPath: string): string | null {
  const parts = normalize(reqPath).split("/").filter(Boolean)
  if (parts.length === 0) return null
  if (parts[0] === "@s") return parts[1] || null
  return parts[0]
}
