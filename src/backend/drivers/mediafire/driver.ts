import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverMediafireAddition } from "./types"
import { ClientMediafire, MFEntry } from "./util"

/**
 * F-418：MediaFire 的 created 是无时区标记的 "YYYY-MM-DD HH:MM:SS"（服务器本地
 * 时间），new Date 会按运行时本地时区解析，modified 随部署环境漂移；无法解析
 * 的字符串还会让 toISOString 抛 RangeError 拖垮整个 list。
 * 优先使用带时区标记的 created_utc，其次把 created 当 UTC 解析，并做有效性守卫。
 */
function mfModified(e: MFEntry): string {
  for (const value of [e.createdUtc, e.created]) {
    if (!value) continue
    let text = String(value).trim().replace(" ", "T")
    if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(text)) text = `${text}Z`
    const d = new Date(text)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
}

/** 目标项自身路径 → 其父目录物理路径 */
function parentOf(physicalPath: string): string {
  const parts = String(physicalPath || "").split("/").filter(Boolean)
  parts.pop()
  return "/" + parts.join("/")
}

function entryToItem(e: MFEntry): FileItem {
  return {
    name: e.name,
    size: e.size,
    is_dir: e.isDir,
    modified: mfModified(e),
    sign: "",
    type: calcFileType(e.name, e.isDir),
    raw_url: "",
  }
}

export class DriverMediafire implements StorageDriver {
  private client: ClientMediafire
  private pathCache = new Map<string, string>()

  constructor(addition: DriverMediafireAddition) {
    this.client = new ClientMediafire(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderKey = await this.resolveFolderId(physicalPath)
    const entries = await this.client.list(folderKey)
    return entries.map(entryToItem)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    if (parts.length === 0) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    }

    // F-412：列表/鉴权/网络失败必须向上传播；条目不存在时抛 not-found。
    // 之前 catch-all 会把它们伪装成伪造的目录或文件条目（raw_url 为空），
    // /fs/get 与 WebDAV 因此永远不 404。
    const rawName = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.resolveFolderId(parentPath)
    const entries = await this.client.list(parentId)
    const entry = entries.find((e) => e.name === rawName)
    if (!entry) {
      throw new Error(`[MediaFire] '${rawName}' not found`)
    }

    const item = entryToItem(entry)
    if (!entry.isDir) {
      try {
        item.raw_url = await this.client.getDownloadUrl(entry.id)
      } catch (e: any) {
        item.raw_url_error = e.message
      }
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveFolderId(parentPath)
    await this.client.mkdir(parentId, name)
    this.pathCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const { id, isDir } = await this.resolveEntry(physicalPath)
    await this.client.rename(id, newName, isDir)
    this.pathCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const { id, isDir } = await this.resolveEntry(physicalPath)
    await this.client.remove(id, isDir)
    this.pathCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const { id, isDir } = await this.resolveEntry(srcPhysical)
    // F-414：dstDir 是含挂载前缀的虚拟路径，resolveFolderId 只接受物理路径，
    // 直接用会在账户根目录里找与挂载前缀同名的文件夹。
    // dstPhysical 是「目标项自身」的物理路径，去掉末段即得目标父目录。
    const dstId = await this.resolveFolderId(parentOf(dstPhysical))
    await this.client.move(id, dstId, isDir)
    this.pathCache.clear()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const { id, isDir } = await this.resolveEntry(srcPhysical)
    // F-414：同上，使用物理目标路径的父目录。
    const dstId = await this.resolveFolderId(parentOf(dstPhysical))
    await this.client.copy(id, dstId, isDir)
    this.pathCache.clear()
  }

  async put(
    _virtualPath: string,
    _physicalPath: string,
    _content: Buffer,
  ): Promise<void> {
    throw new Error("[MediaFire] Direct put not supported in stateless environment")
  }

  /** 通过路径逐级解析文件夹 ID（根为 ""） */
  private async resolveFolderId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return ""
    if (this.pathCache.has(clean)) return this.pathCache.get(clean)!

    const parts = clean.split("/")
    let currentId = ""
    for (let i = 0; i < parts.length; i++) {
      const entries = await this.client.list(currentId)
      const target = entries.find((e) => e.isDir && e.name === parts[i])
      if (!target) throw new Error(`[MediaFire] Folder '${parts[i]}' not found`)
      currentId = target.id
      // F-417：查找键是 clean（无前导斜杠），写入必须同格式，
      // 否则两套键永不相等、缓存 100% 不命中。
      this.pathCache.set(parts.slice(0, i + 1).join("/"), currentId)
    }
    return currentId
  }

  /** 解析文件/目录的 id 与类型 */
  private async resolveEntry(physicalPath: string): Promise<{ id: string; isDir: boolean }> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.resolveFolderId(parentPath)
    const entries = await this.client.list(parentId)
    const entry = entries.find((e) => e.name === name)
    if (!entry) throw new Error(`[MediaFire] '${name}' not found`)
    return { id: entry.id, isDir: entry.isDir }
  }
}
