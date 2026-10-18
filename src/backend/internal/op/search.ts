import { listItems } from "./storage"
import { FileItem } from "../driver/base"

export interface SearchOptions {
  parent?: string
  keywords?: string
  /** 0 = all, 1 = folder only, 2 = file only */
  scope?: number
  page?: number
  per_page?: number
  /** Max directory depth to traverse (default 10) */
  max_depth?: number
  /** Max items to collect before truncating (default 500) */
  max_results?: number
  /**
   * 条目可见性判定。listItems 本身不套 meta，所以搜索必须由调用方给出这道过滤，
   * 否则密码目录 / read_users / hide 规则会被搜索结果原样吐出来。
   * 返回 false 的条目既不进结果，也不递归进入。
   */
  isVisible?: (parent: string, item: FileItem) => boolean | Promise<boolean>
}

export interface SearchResultItem extends FileItem {
  /** Virtual parent directory where this file resides */
  parent: string
}

export interface SearchResult {
  content: SearchResultItem[]
  total: number
}

/**
 * Recursively search for files/directories matching `keywords` within `parent`.
 * Traverses directories through `listItems` (honoring driver abstractions).
 */
export async function search(
  opts: SearchOptions = {},
  env?: any,
): Promise<SearchResult> {
  const rootPath = (opts.parent || "/").replace(/\/+/g, "/") || "/"
  const keyword = String(opts.keywords || "")
    .trim()
    .toLowerCase()
  const scope = opts.scope ?? 0
  const page = Math.max(1, opts.page || 1)
  const perPage = Math.max(1, Math.min(100, opts.per_page || 30))
  const maxDepth = Math.min(20, Math.max(0, opts.max_depth ?? 10))
  const maxResults = Math.min(2000, Math.max(1, opts.max_results ?? 500))

  const matches: SearchResultItem[] = []

  async function walk(dirPath: string, depth: number) {
    if (depth > maxDepth || matches.length >= maxResults) return

    let items: FileItem[] = []
    try {
      const res = await listItems(dirPath)
      items = res.content || []
    } catch {
      // If listing this branch fails (e.g. storage offline), continue search elsewhere
      return
    }

    for (const item of items) {
      if (matches.length >= maxResults) break

      const isDir = !!item.is_dir
      const subPath =
        dirPath === "/" ? `/${item.name}` : `${dirPath}/${item.name}`

      // 调用方的可见性过滤（meta 密码 / read_users / hide）：不可见的条目既不
      // 作为结果返回，也不向下递归，否则搜索结果会把子树整个暴露出去。
      if (opts.isVisible && !(await opts.isVisible(dirPath, item))) continue

      const nameMatch = !keyword || item.name.toLowerCase().includes(keyword)
      // 挂载点虚拟文件夹（storage.ts 合并虚拟子挂载时 sign 为空），
      // 本身不显示，但仍需递归进入搜索其内部文件
      const isMountPoint = isDir && !item.sign

      let scopeMatch = true
      if (scope === 1 && !isDir) scopeMatch = false
      if (scope === 2 && isDir) scopeMatch = false

      // 挂载点不作为结果项返回（避免搜到 "123云盘" 这类虚拟文件夹本身）
      if (!isMountPoint && nameMatch && scopeMatch) {
        matches.push({
          ...item,
          parent:
            dirPath.endsWith("/") && dirPath !== "/"
              ? dirPath.slice(0, -1)
              : dirPath,
        })
      }

      if (isDir) {
        await walk(subPath, depth + 1)
      }
    }
  }

  await walk(rootPath, 0)

  const total = matches.length
  const offset = (page - 1) * perPage
  const pageItems = matches.slice(offset, offset + perPage)

  return {
    content: pageItems,
    total,
  }
}
