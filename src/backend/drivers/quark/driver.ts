import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { QuarkAddition, QuarkFile } from "./types"
import { QuarkClient } from "./util"

function quarkFileToFileItem(f: QuarkFile): FileItem {
  const isDir = !f.file
  const modTime = f.updated_at
    ? new Date(f.updated_at).toISOString()
    : new Date().toISOString()

  return {
    name: f.file_name,
    size: f.size || 0,
    is_dir: isDir,
    modified: modTime,
    sign: "",
    type: calcFileType(f.file_name, isDir),
    thumb: f.thumbnail || "",
    raw_url: "",
  }
}

export class QuarkDriver implements StorageDriver {
  private client: QuarkClient
  private pathFileIdCache = new Map<string, string>()
  /** F-322：客户端刷新的 cookie，等待 op 层 flushPendingDriverState 持久化 */
  private pendingCookie: string | null = null

  constructor(addition: QuarkAddition) {
    // F-322：接上 onCookieUpdate，夸克轮换 __puus/__pus 后由
    // consumePendingCookie() 交给 op 层写回存储配置。此前回调无人接线，
    // 无状态运行时上新 isolate 只能拿到 DB 里的旧 cookie（全面 401）。
    this.client = new QuarkClient(addition, (newCookie) => {
      this.pendingCookie = newCookie
      addition.cookie = newCookie
    })
  }

  /** 由 op 层 flushPendingDriverState 调用；返回并清空待持久化的 cookie */
  consumePendingCookie(): string | null {
    const cookie = this.pendingCookie
    this.pendingCookie = null
    return cookie
  }

  /**
   * F-321：rename/remove/move 成功后按路径前缀失效 pathFileIdCache。
   * 驱动实例被 op 层跨请求缓存复用（storage.ts driverCache），缓存一旦陈旧，
   * 旧路径会持续解析到已删除/已改名的 fid。
   */
  private invalidatePath(physicalPath: string): void {
    const clean = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
      .join("/")
    if (!clean) {
      // 根路径操作影响整棵树
      this.pathFileIdCache.clear()
      return
    }
    const prefix = clean + "/"
    for (const key of Array.from(this.pathFileIdCache.keys())) {
      const norm = key.replace(/^\/+/, "")
      if (norm === clean || norm.startsWith(prefix)) {
        this.pathFileIdCache.delete(key)
      }
    }
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFileId(physicalPath)
    const files = await this.client.getFiles(folderId)
    return files.map(quarkFileToFileItem)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const fileId = await this.resolveFileId(physicalPath)
    const rawName = parts[parts.length - 1] || "root"
    const decodedName = (() => {
      try {
        return decodeURIComponent(rawName)
      } catch {
        return rawName
      }
    })()
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    const parentId = await this.resolveFileId(parentPath)

    const files = await this.client.getFiles(parentId)
    const file = files.find(
      (f) =>
        f.fid === fileId ||
        f.file_name === rawName ||
        f.file_name === decodedName,
    )

    let downloadLink = ""
    let downloadHeaders: Record<string, string> | undefined
    try {
      const linkRes = await this.client.getDownloadUrl(fileId, decodedName)
      downloadLink = linkRes.url
      downloadHeaders = linkRes.headers
    } catch (e: any) {
      console.warn(
        `[Quark/UC] getDownloadUrl warning for ${rawName}:`,
        e.message,
      )
    }

    if (file) {
      const item = quarkFileToFileItem(file)
      item.raw_url = downloadLink
      item.raw_url_headers = downloadHeaders
      return item
    }

    // Fallback: the path may be a folder that isn't listed in its parent
    // (e.g. the storage root). Probe it by listing — if it lists, it's a folder.
    try {
      await this.client.getFiles(fileId)
      return {
        name: decodedName || "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    } catch {}

    return {
      name: decodedName || "root",
      size: 0,
      is_dir: false,
      modified: new Date().toISOString(),
      sign: "",
      type: 0,
      raw_url: downloadLink,
      raw_url_headers: downloadHeaders,
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "新文件夹"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveFileId(parentPath)
    await this.client.mkdir(parentId, name)
    this.invalidatePath(physicalPath)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(physicalPath)
    await this.client.rename(fileId, newName)
    this.invalidatePath(physicalPath)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const fileId = await this.resolveFileId(physicalPath)
    await this.client.remove([fileId])
    this.invalidatePath(physicalPath)
  }

  /**
   * dstPhys 是目标项自身的物理路径（已含文件名），目标父目录取其 dirname。
   * dstDir 是用户视角的虚拟路径（含挂载点 / base_path 前缀），不能直接当作
   * 夸克盘内的相对路径逐段解析。
   */
  private parentPhysicalPath(physicalPath: string): string {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    segs.pop()
    return "/" + segs.join("/")
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(srcPhysical)
    const dstId = await this.resolveFileId(this.parentPhysicalPath(dstPhysical))
    await this.client.move([fileId], dstId)
    this.invalidatePath(srcPhysical)
    this.invalidatePath(dstPhysical)
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(srcPhysical)
    const dstId = await this.resolveFileId(this.parentPhysicalPath(dstPhysical))
    await this.client.copy([fileId], dstId)
    this.invalidatePath(dstPhysical)
  }

  async put(
    _virtualPath: string,
    _physicalPath: string,
    _content: Uint8Array,
  ): Promise<void> {
    throw new Error(
      "[Quark/UC] Direct put not supported in stateless environment",
    )
  }

  private async resolveFileId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return this.client.getRootFolderId()
    if (this.pathFileIdCache.has(clean)) return this.pathFileIdCache.get(clean)!

    const parts = clean.split("/")
    let currentId = this.client.getRootFolderId()

    for (let i = 0; i < parts.length; i++) {
      const rawPart = parts[i]
      const decodedPart = (() => {
        try {
          return decodeURIComponent(rawPart)
        } catch {
          return rawPart
        }
      })()

      const items = await this.client.getFiles(currentId)
      const target = items.find(
        (f) =>
          f.file_name === rawPart ||
          f.file_name === decodedPart ||
          f.fid === rawPart,
      )
      if (!target) {
        throw new Error(
          `[Quark/UC] Path '${rawPart}' not found in folder '${currentId}'`,
        )
      }
      currentId = target.fid
      const subPath = "/" + parts.slice(0, i + 1).join("/")
      this.pathFileIdCache.set(subPath, currentId)
    }

    return currentId
  }
}
