/**
 * 路径编码工具（对齐 Go pkg/utils/path.go）。
 *
 * 独立成文件是为了让 internal/op/storage.ts 这类底层模块能直接引用，
 * 而不必把 pkg/utils 的整条依赖链（hono / model/db / 其他子模块）拉进来，
 * 避免 storage → utils → db → storage 的循环导入。
 */

/** 把任意字符串转成可安全嵌入 RegExp 的字面量，避免输入变成正则元字符。 */
export function escapeRegExp(value: string): string {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 与 internal/model/db.ts resolvePath() 完全一致的「多重百分号解码」视图。
 *
 * 这里必须**一直解码到稳定**，不能只解固定次数：`%2e%2e` 每多套一层就多一个
 * `%25`，固定 4 次会被 5 层编码绕过（判定时仍是普通段，真正落盘时再解一次就
 * 成了 `..`）。每次成功解码都会缩短字符串并减少 `%` 数量，因此循环必然收敛；
 * 上限只是防御性兜底（33 层编码的字符串长度已超过任何请求体上限）。
 */
const MAX_DECODE_ROUNDS = 64

export function decodePathFully(value: string): string {
  let out = String(value ?? "")
  for (let i = 0; i < MAX_DECODE_ROUNDS; i++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(out)
    } catch {
      // 解码失败沿用当前值，与 resolvePath 一致
      break
    }
    if (decoded === out) break
    out = decoded
  }
  return out
    .replace(/\\/g, "/")
    .replace(/%5c/gi, "/")
    .replace(/%2f/gi, "/")
    .replace(/\.{3,}/g, "..")
    .replace(/\/+/g, "/")
}

/** 段是否为 `..`：resolvePath 把 3 个及以上点也归一成 `..`，所以 `...` 同样上跳。 */
function isParentSegment(seg: string): boolean {
  return /^\.+$/.test(seg) && seg.length >= 2
}

/**
 * 按 resolvePath 的段语义折叠 `.`/`..`，并在 stackLimit 处钳制（不越过该层）。
 * stackLimit 传用户 base_path 的段数，即可让 `..` 永远弹不出用户自己的根目录。
 */
export function collapsePathSegments(
  view: string,
  stackLimit: number,
): string[] {
  const stack: string[] = []
  for (const seg of String(view ?? "").split("/")) {
    if (seg === "" || seg === ".") continue
    if (isParentSegment(seg)) {
      if (stack.length > stackLimit) stack.pop()
      continue
    }
    stack.push(seg)
  }
  return stack
}

/** 视图里是否残留会向上跳的段（含百分号编码形式）。 */
export function hasParentSegment(view: string): boolean {
  return String(view ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .some((seg) => isParentSegment(seg))
}

/**
 * 虚拟路径的规范形式：与 resolvePath 完全同款的「多重解码 + 段折叠」。
 *
 * meta 覆盖判定、签名计算、hide/read_users 检查用的都是字符串前缀比较；而真正
 * 定位存储时 resolvePath 会先解码再折叠 `..`。两者不同源时就会出现：
 * `/public/../secret/x.txt` 对 meta 判定「不在保护区内」（无需签名），
 * resolvePath 却把它折叠成 `/secret/x.txt` 照样读到。统一走这一个函数。
 */
export function canonicalVirtualPath(value: string): string {
  const stack = collapsePathSegments(decodePathFully(String(value || "/")), 0)
  const out = "/" + stack.join("/")
  return out === "" ? "/" : out
}

/**
 * 逐段百分号编码下载路径（对齐 Go pkg/utils.EncodePath(path, true)）。
 *
 * Go 用的是 url.PathEscape 的 encodePath 模式：非保留字符 A-Za-z0-9-._~
 * 与子分隔符 $&+,:;=@ 原样保留，其余（`%`、`?`、`#`、空格、非 ASCII 等）
 * 逐字节百分号编码；路径分隔符 `/` 保留（Go 先按段切分再编码，结果相同）。
 *
 * 为什么下载链接必须编码：raw_url 会被前端原样当 href/src 使用
 *   - 路径里未编码的 `?` / `#` 会被浏览器当成 query / fragment 截断；
 *   - 路径里出现裸 `%`（如 "100%.txt"）会让服务端 decodeURIComponent 抛
 *     URIError（raw.ts 的路径解析），而 Go 因编码了 `%` 不会遇到。
 */
export function encodeDownloadPath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`
  return p.replace(/[^A-Za-z0-9\-_.~$&+,:;=@/]/gu, (ch) => {
    try {
      return encodeURIComponent(ch)
    } catch {
      // 孤立代理项等非法 UTF-16：原样保留，绝不因编码失败抛错
      return ch
    }
  })
}
