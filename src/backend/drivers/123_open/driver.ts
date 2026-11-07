import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { Driver123OpenAddition, File123 } from "./types"
import { Client123Open } from "./util"

const DEFAULT_ROOT = "0"

function parseTime(s?: string): string {
  if (!s) return new Date().toISOString()
  // "2006-01-02 15:04:05" (UTC+8)
  const t = new Date(s.replace(" ", "T") + "+08:00")
  return isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString()
}

export class Driver123Open implements StorageDriver {
  private client: Client123Open
  private pathCache = new Map<string, string>()
  private rootFolderId: string

  constructor(addition: Driver123OpenAddition) {
    this.client = new Client123Open(addition)
    this.rootFolderId = addition.root_folder_id || DEFAULT_ROOT
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private fileToItem(f: File123): FileItem {
    const isDir = f.type === 1
    return {
      name: f.filename,
      size: f.size || 0,
      is_dir: isDir,
      modified: parseTime(f.update_at),
      sign: "",
      type: calcFileType(f.filename, isDir),
      raw_url: "",
    }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const fid = await this.resolveDirId(physicalPath)
    const files = await this.client.getFiles(fid)
    return files.map((f) => this.fileToItem(f))
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const rawName = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, -1).join("/")

    // 父目录解析/列表请求的异常（网络、鉴权、限流）必须向上传播，
    // 不得与「条目不存在」共用同一分支。
    const parentId = await this.resolveDirId(parentPath)
    const files = await this.client.getFiles(parentId)
    const file = files.find((f) => f.filename === rawName)
    if (file) {
      const item = this.fileToItem(file)
      if (!item.is_dir) {
        try {
          item.raw_url = await this.client.getDownloadUrl(file.fileId)
        } catch (e: any) {
          item.raw_url_error = e.message
        }
      }
      return item
    }

    // 不是文件：确认是否为真实存在的目录，否则抛 not found。
    await this.resolveDirId(physicalPath)
    return {
      name: rawName,
      size: 0,
      is_dir: true,
      modified: new Date().toISOString(),
      sign: "",
      type: 1,
      raw_url: "",
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveDirId(parentPath)
    await this.client.mkdir(parentId, name)
    this.pathCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const entry = await this.resolveEntry(physicalPath)
    await this.client.rename(entry.id, newName)
    this.pathCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const entry = await this.resolveEntry(physicalPath)
    await this.client.remove(entry.id)
    this.pathCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const entry = await this.resolveEntry(srcPhysical)
    // dstPhysical 是目标项自身的物理路径，目标目录取去掉末段后的父目录。
    const dstParent =
      "/" +
      dstPhysical
        .split("/")
        .filter(Boolean)
        .slice(0, -1)
        .join("/")
    const dstId = await this.resolveDirId(dstParent)
    await this.client.move(entry.id, dstId)
    this.pathCache.clear()
  }

  async copy(): Promise<void> {
    throw new Error("[123Open] copy not supported")
  }

  readonly rapidHashAlgos = ["sha1"]
  readonly rapidHashNeedsPieces = false

  async rapidUpload(
    _virtualPath: string,
    physicalPath: string,
    metadata: { size: number; sha1?: string },
  ): Promise<boolean> {
    const sha1Hash = String(metadata.sha1 || "").toLowerCase()
    if (!/^[0-9a-f]{40}$/.test(sha1Hash)) return false
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "file"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveDirId(parentPath)
    const numericId = Number(parentId)
    if (!Number.isSafeInteger(numericId)) return false
    const result = await this.client.sha1Reuse(
      numericId,
      name,
      sha1Hash,
      metadata.size,
      1,
    )
    return result.reuse === true
  }

  async put(): Promise<void> {
    throw new Error("[123Open] upload not supported in stateless environment")
  }

  private async resolveDirId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return this.rootFolderId
    if (this.pathCache.has(clean)) return this.pathCache.get(clean)!

    const parts = clean.split("/")
    let currentId = this.rootFolderId
    for (let i = 0; i < parts.length; i++) {
      const files = await this.client.getFiles(currentId)
      const target = files.find((f) => f.type === 1 && f.filename === parts[i])
      if (!target) throw new Error(`[123Open] Directory '${parts[i]}' not found`)
      currentId = String(target.fileId)
      const subPath = "/" + parts.slice(0, i + 1).join("/")
      this.pathCache.set(subPath, currentId)
    }
    return currentId
  }

  private async resolveEntry(physicalPath: string): Promise<{ id: number; isDir: boolean }> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.resolveDirId(parentPath)
    const files = await this.client.getFiles(parentId)
    const file = files.find((f) => f.filename === name)
    if (!file) throw new Error(`[123Open] '${name}' not found`)
    return { id: file.fileId, isDir: file.type === 1 }
  }
}
