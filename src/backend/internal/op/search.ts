import { listItems } from "./storage"
import { getDb } from "../model/db"
import { FileItem } from "../driver/base"
import { canAccess, getNearestMeta } from "../../pkg/meta"
import type { Meta } from "../../pkg/meta"
import type { UserPermissionObj } from "../../pkg/permission"

/**
 * 某个虚拟目录下由「其他存储挂载」产生的虚拟目录名（F-092）。
 *
 * 与 `listItems` 的挂载合并逻辑同源（storage.ts：mount_path 归一化后取
 * 当前目录下的第一段，跳过自身与根）。返回空集表示该目录下没有挂载点。
 */
export function virtualMountNamesAt(db: any, dirPath: string): Set<string> {
  const cleanListedPath =
    "/" + String(dirPath || "").split("/").filter(Boolean).join("/")
  const names = new Set<string>()
  const storages = Array.isArray(db?.storages) ? db.storages : []
  const prefix = cleanListedPath === "/" ? "/" : cleanListedPath + "/"

  for (const s of storages) {
    if (s?.disabled) continue
    const mount = "/" + String(s?.mount_path || "").split("/").filter(Boolean).join("/")
    // 与 storage.ts 一致：不把当前目录自身、根挂载当作子挂载
    if (mount === cleanListedPath || mount === "/") continue
    if (!mount.startsWith(prefix)) continue
    const name = mount.slice(prefix.length).split("/").filter(Boolean)[0]
    if (name) names.add(name)
  }
  return names
}

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
  /**
   * 访问者。提供时对每个结果做 meta 判定过滤（密码保护 + read_users 白名单），
   * 对齐 Go handles.Search 传给 SearchFiltered 的 filter 闭包；不提供时
   * （内部调用 / 管理员构建索引）不做过滤，与历史行为一致。
   */
  user?: UserPermissionObj | null
  /** 目录访问密码（meta.password） */
  password?: string
  /**
   * 调用方补充的可见性判定（hide 规则等）。listItems 本身不套 meta，搜索必须
   * 由调用方给出这道过滤，否则密码目录 / read_users / hide 规则会被搜索结果
   * 原样吐出来。返回 false 的条目既不进结果，也不递归进入。
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
  const enforceAcl = opts.user !== undefined

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

    // 与 Go 一致：meta 取「父目录」的最近 meta，再对子项自身路径做判定
    let dirMeta: Meta | null = null
    if (enforceAcl) {
      try {
        dirMeta = await getNearestMeta(dirPath, env)
      } catch {
        dirMeta = null
      }
    }

    // 本目录下由存储挂载合并出的虚拟目录名（F-092）。
    //
    // 历史实现用 `isDir && !item.sign` 识别挂载点，但绝大多数驱动对真实目录
    // 同样返回空 sign（local / google_drive / onedrive / webdav / aliyundrive_open…），
    // 于是这些驱动下**所有真实文件夹**都被当作挂载点从结果里剔除：目录名永远
    // 搜不到，scope=1（仅文件夹）恒为空。改为按 db.storages 计算当前目录下的
    // 挂载点名集合，只排除这些确实由 storage.ts 合并出来的虚拟项。
    let mountNames = new Set<string>()
    if (items.length > 0) {
      try {
        mountNames = virtualMountNamesAt(await getDb(env), dirPath)
      } catch {
        mountNames = new Set<string>()
      }
    }

    for (const item of items) {
      if (matches.length >= maxResults) break

      const isDir = !!item.is_dir
      const subPath =
        dirPath === "/" ? `/${item.name}` : `${dirPath}/${item.name}`

      // meta 访问控制：密码保护 / read_users 白名单覆盖的内容不出现在搜索
      // 结果里。历史缺陷：搜索完全跳过 meta 判定——实测直连被密码保护而
      // 被拒的目录，其文件名/大小仍能被搜出来（信息泄露）。
      if (
        enforceAcl &&
        !canAccess(opts.user!, dirMeta, subPath, opts.password || "")
      ) {
        continue
      }

      // 调用方的可见性过滤（hide 规则等）：不可见的条目既不作为结果返回，也不
      // 向下递归，否则搜索结果会把子树整个暴露出去。
      if (opts.isVisible && !(await opts.isVisible(dirPath, item))) continue

      const nameMatch = !keyword || item.name.toLowerCase().includes(keyword)
      // 挂载点虚拟文件夹（其他存储挂载到本目录下时由 listItems 合并出的项），
      // 本身不显示，但仍需递归进入搜索其内部文件
      const isMountPoint = isDir && mountNames.has(item.name)

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
