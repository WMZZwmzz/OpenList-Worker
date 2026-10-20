/**
 * 本地存储的真实路径校验（M-9）。
 *
 * `resolvePath` 对 `root_folder_path` 做的是**纯字符串**层面的钳制：它保证
 * 「拼出来的路径不以 `..` 段越界」，但 `fs.stat` / `createReadStream` /
 * `writeFile` 都会**跟随符号链接**。于是存储根内只要存在一个指向外部的软链
 * （例如运维图省事 `ln -s /etc shared/etc`，或攻击者通过可写挂载点建一个），
 * `GET /d/local/leak` 就能读到 `/etc/passwd`，写侧还能覆盖软链目标。
 *
 * 这里在真正落到 fs 之前用 `realpath` 把「解析后的真实路径」与「解析后的真实
 * 根目录」比一次，凡是逃出根目录的一律拒绝。
 *
 * 只依赖 node:fs / node:path（动态导入，Worker 环境不会被求值）。
 */

let fsp: any = null
let pathMod: any = null

async function load() {
  if (!fsp) {
    fsp = await import("fs/promises")
    pathMod = await import("path")
  }
}

const CASE_INSENSITIVE =
  typeof process !== "undefined" &&
  (process.platform === "win32" || process.platform === "darwin")

function normalizeForCompare(p: string): string {
  const unified = p.replace(/\\/g, "/").replace(/\/+$/, "")
  return CASE_INSENSITIVE ? unified.toLowerCase() : unified
}

/** target 是否等于 root 或位于 root 之下（两者都应是已 resolve 的绝对路径）。 */
export function isInsideRoot(root: string, target: string): boolean {
  const r = normalizeForCompare(root)
  const t = normalizeForCompare(target)
  if (!r) return true
  if (t === r) return true
  return t.startsWith(r === "/" ? "/" : r + "/")
}

/**
 * 对可能尚不存在的路径取「尽可能真实的」真实路径：
 * 逐级向上找第一个存在的祖先做 realpath，再把不存在的尾部拼回去。
 */
async function realpathBestEffort(target: string): Promise<string> {
  let current = target
  const missing: string[] = []
  for (;;) {
    try {
      const real = await fsp.realpath(current)
      return missing.length ? pathMod.join(real, ...missing.reverse()) : real
    } catch {
      const parent = pathMod.dirname(current)
      if (parent === current) return target
      missing.push(pathMod.basename(current))
      current = parent
    }
  }
}

/**
 * 断言 physicalPath 解析软链后仍在 rootFolder 之内。
 *
 * @param rootFolder 存储配置里的 root_folder_path；为空或 "/" 表示「无限制」
 *                   （与 resolvePath 对 root 的语义保持一致）
 * @throws Error 越界时抛出
 */
export async function assertLocalPathInsideRoot(
  physicalPath: string,
  rootFolder?: string | null,
): Promise<void> {
  if (!physicalPath) return
  const root = typeof rootFolder === "string" ? rootFolder.trim() : ""
  if (!root || root === "/" || root === "\\") return // 无限制，无从校验

  await load()
  const absRoot = pathMod.resolve(root)
  const absTarget = pathMod.resolve(physicalPath)

  let realRoot = absRoot
  try {
    realRoot = await fsp.realpath(absRoot)
  } catch {
    // 根目录本身不存在（尚未创建）：按字面路径比较即可
  }
  const realTarget = await realpathBestEffort(absTarget)

  if (!isInsideRoot(realRoot, realTarget)) {
    throw new Error(
      "path traversal blocked: symbolic link escapes storage root",
    )
  }
}
