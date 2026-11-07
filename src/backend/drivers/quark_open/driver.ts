import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverQuarkOpenAddition, QuarkFile } from "./types"
import { ClientQuarkOpen } from "./util"

const DEFAULT_ROOT = "0"

export class DriverQuarkOpen implements StorageDriver {
  private client: ClientQuarkOpen
  private pathCache = new Map<string, string>()

  constructor(addition: DriverQuarkOpenAddition) {
    this.client = new ClientQuarkOpen(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private fileToItem(f: QuarkFile): FileItem {
    const isDir = f.file_type === "0"
    return {
      name: f.filename,
      size: f.size || 0,
      is_dir: isDir,
      modified: f.updated_at
        ? new Date(f.updated_at).toISOString()
        : new Date().toISOString(),
      sign: "",
      type: calcFileType(f.filename, isDir),
      thumb: f.thumbnail_url || "",
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
    try {
      const parentId = await this.resolveDirId(parentPath)
      const files = await this.client.getFiles(parentId)
      const file = files.find((f) => f.filename === rawName)
      if (file) {
        const item = this.fileToItem(file)
        if (!item.is_dir) {
          try {
            item.raw_url = await this.client.getDownloadUrl(file.fid)
            item.raw_url_headers = { Cookie: this.client.downloadCookie() }
          } catch (e: any) {
            item.raw_url_error = e.message
          }
        }
        return item
      }
    } catch {}

    // Fallback: 目录
    try {
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
    } catch {
      return {
        name: rawName,
        size: 0,
        is_dir: false,
        modified: new Date().toISOString(),
        sign: "",
        type: 0,
        raw_url: "",
      }
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
    const fid = await this.resolveAnyId(physicalPath)
    await this.client.rename(fid, newName)
    this.pathCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const fid = await this.resolveAnyId(physicalPath)
    await this.client.remove(fid)
    this.pathCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    // F-397：源条目既可能是文件也可能是目录，必须按任意类型解析。
    // 目标目录取 dstPhysical 的父级（dstDir 是含挂载前缀的虚拟路径，
    // 不能直接当作账号内路径逐段解析）。
    const fid = await this.resolveAnyId(srcPhysical)
    const dstId = await this.resolveDirId(this.parentPhysicalPath(dstPhysical))
    await this.client.move(fid, dstId)
    this.pathCache.clear()
  }

  /** 目标项物理路径的父目录（物理路径不含挂载前缀） */
  private parentPhysicalPath(physicalPath: string): string {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    segs.pop()
    return "/" + segs.join("/")
  }

  async copy(): Promise<void> {
    throw new Error("[QuarkOpen] copy not supported")
  }

  readonly rapidHashAlgos = ["md5", "sha1"]
  readonly rapidHashNeedsPieces = false

  async rapidUpload(
    _virtualPath: string,
    physicalPath: string,
    metadata: {
      size: number
      md5?: string
      sha1?: string
      readRange?: (start: number, length: number) => Promise<Uint8Array>
    },
  ): Promise<boolean> {
    const md5Hash = String(metadata.md5 || "").toLowerCase()
    const sha1Hash = String(metadata.sha1 || "").toLowerCase()
    if (!/^[0-9a-f]{32}$/.test(md5Hash)) return false
    if (!/^[0-9a-f]{40}$/.test(sha1Hash)) return false
    if (!metadata.readRange) return false
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "file"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveDirId(parentPath)
    return this.client.rapidUpload({
      parentId,
      fileName: name,
      size: metadata.size,
      md5: md5Hash,
      sha1: sha1Hash,
      readRange: metadata.readRange,
    })
  }

  async put(): Promise<void> {
    throw new Error("[QuarkOpen] upload not supported in stateless environment")
  }

  /**
   * F-397：按「中间段必须是目录、末段可以是文件或目录」解析物理路径。
   *
   * rename/remove/move 传入的是条目**自身**路径，末段对文件来说是
   * file_type "1"；此前复用只匹配目录的 resolveDirId，文件级操作全部抛
   * "Directory not found"。
   */
  private async resolveAnyId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return DEFAULT_ROOT
    if (this.pathCache.has(clean)) return this.pathCache.get(clean)!

    const parts = clean.split("/")
    let currentId = DEFAULT_ROOT
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1
      const files = await this.client.getFiles(currentId)
      const target = files.find(
        (f) => (isLast || f.file_type === "0") && f.filename === parts[i],
      )
      if (!target) {
        throw new Error(
          `[QuarkOpen] Path '${parts[i]}' not found in folder '${currentId}'`,
        )
      }
      currentId = target.fid
      if (!isLast) {
        const subPath = "/" + parts.slice(0, i + 1).join("/")
        this.pathCache.set(subPath, currentId)
      }
    }
    return currentId
  }

  private async resolveDirId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return DEFAULT_ROOT
    if (this.pathCache.has(clean)) return this.pathCache.get(clean)!

    const parts = clean.split("/")
    let currentId = DEFAULT_ROOT
    for (let i = 0; i < parts.length; i++) {
      const files = await this.client.getFiles(currentId)
      const target = files.find((f) => f.file_type === "0" && f.filename === parts[i])
      if (!target) throw new Error(`[QuarkOpen] Directory '${parts[i]}' not found`)
      currentId = target.fid
      const subPath = "/" + parts.slice(0, i + 1).join("/")
      this.pathCache.set(subPath, currentId)
    }
    return currentId
  }
}
