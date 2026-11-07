import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { Driver189TVAddition, Cloud189TVFile, Cloud189TVFolder } from "./types"
import { Client189TV } from "./util"

function parseTime(value: string | undefined): string {
  if (!value) return new Date().toISOString()
  const cleaned = value.trim().replace(/["']/g, "")
  // 格式如 "2024-01-15 10:30:00 +08" 或 "Jan 15, 2024 10:30:00 AM +08"
  const normalized = cleaned.replace(/ +08$/, "+08:00")
  const d = new Date(normalized)
  if (!isNaN(d.getTime())) return d.toISOString()
  return cleaned
}

function fileToItem(f: Cloud189TVFile | Cloud189TVFolder): FileItem {
  if ("parentId" in f || !("size" in f)) {
    const folder = f as Cloud189TVFolder
    return {
      name: folder.name,
      size: 0,
      is_dir: true,
      modified: parseTime(folder.lastOpTime || folder.createDate),
      sign: folder.id,
      type: 1,
    }
  }
  const file = f as Cloud189TVFile
  return {
    name: file.name,
    size: file.size,
    is_dir: false,
    modified: parseTime(file.lastOpTime || file.createDate),
    sign: file.id,
    type: calcFileType(file.name, false),
    thumb: file.icon?.smallUrl || "",
    raw_url: "",
  }
}

export class Driver189TV implements StorageDriver {
  private client: Client189TV
  private addition: Driver189TVAddition
  private pathCache = new Map<string, string>()

  constructor(
    addition: Driver189TVAddition,
    persistAccessToken?: (accessToken: string) => void | Promise<void>,
  ) {
    this.addition = addition
    this.client = new Client189TV(addition, persistAccessToken)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private isFamily(): boolean {
    return this.client.isFamily()
  }

  /**
   * 根目录 ID：读取用户配置的 root_folder_id，并按 Go 原版语义归一
   * （家庭云 "-11" 视为空、个人云 "" 视为 "-11"）。
   */
  private rootId(): string {
    const configured = (this.addition.root_folder_id || "").trim()
    if (this.isFamily()) return configured === "-11" ? "" : configured
    return configured === "" ? "-11" : configured
  }

  private beginOperation(): void {
    this.client.resetBudget()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    this.beginOperation()
    const parentId = await this.pathToId(physicalPath)
    const files = await this.client.getFiles(parentId, this.isFamily())
    return files.map(fileToItem)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    this.beginOperation()
    const parts = physicalPath.split("/").filter(Boolean)
    const rawName = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, -1).join("/")

    // 挂载根：没有上级目录可查，返回合成的目录项
    if (parts.length === 0) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.rootId(),
        type: 1,
        raw_url: "",
      }
    }

    // 目录解析 / 列表请求的异常必须向上抛出：会话过期、网络错误等
    // 不能被当成"这是一个空目录"，否则真实文件会被静默误报为文件夹。
    const parentId = await this.pathToId(parentPath)
    const files = await this.client.getFiles(parentId, this.isFamily())
    const target = files.find((f) => f.name === rawName)
    if (!target) {
      throw new Error(`[189TV] '${rawName}' not found`)
    }
    const item = fileToItem(target)
    if (!item.is_dir) {
      try {
        item.raw_url = await this.client.getFileDownloadUrl(
          target.id,
          this.isFamily(),
        )
        item.raw_url_headers = {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }
      } catch {
        item.raw_url_error = "[189TV] failed to resolve download url"
      }
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    this.beginOperation()
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    await this.client.mkdir(
      await this.pathToId(parentPath),
      name,
      this.isFamily(),
    )
    this.pathCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    this.beginOperation()
    const entry = await this.resolveEntry(physicalPath)
    await this.client.rename(entry.id, entry.isDir, newName, this.isFamily())
    this.pathCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    this.beginOperation()
    const entry = await this.resolveEntry(physicalPath)
    const name = physicalPath.split("/").filter(Boolean).pop() || ""
    await this.client.remove(entry.id, entry.isDir, name, this.isFamily())
    this.pathCache.clear()
  }

  /**
   * dstPhys 是目标项自身的物理路径（已含文件名），目标父目录需取其 dirname。
   * dstDir 是用户视角的虚拟路径（含挂载点 / base_path 前缀），不能用于在
   * 网盘内逐段解析目标目录。
   */
  private parentPhysicalPath(physicalPath: string): string {
    const segs = physicalPath.split("/").filter(Boolean)
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
    this.beginOperation()
    const entry = await this.resolveEntry(srcPhysical)
    const name = srcPhysical.split("/").filter(Boolean).pop() || ""
    await this.client.move(
      entry.id,
      entry.isDir,
      name,
      await this.pathToId(this.parentPhysicalPath(dstPhysical)),
      this.isFamily(),
    )
    this.pathCache.clear()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    this.beginOperation()
    const entry = await this.resolveEntry(srcPhysical)
    const name = srcPhysical.split("/").filter(Boolean).pop() || ""
    await this.client.copy(
      entry.id,
      entry.isDir,
      name,
      await this.pathToId(this.parentPhysicalPath(dstPhysical)),
      this.isFamily(),
    )
    this.pathCache.clear()
  }

  readonly rapidHashAlgos = ["md5"]
  readonly rapidHashNeedsPieces = false

  async rapidUpload(
    _virtualPath: string,
    physicalPath: string,
    metadata: { size: number; md5?: string },
  ): Promise<boolean> {
    this.beginOperation()
    const md5Hash = String(metadata.md5 || "").toLowerCase()
    if (!/^[0-9a-f]{32}$/.test(md5Hash)) return false
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "file"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.pathToId(parentPath)
    const reused = await this.client.rapidUploadCreate(
      parentId,
      name,
      metadata.size,
      md5Hash,
      this.isFamily(),
    )
    if (reused) this.pathCache.clear()
    return reused
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    this.beginOperation()
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "file"
    const parentPath = "/" + parts.join("/")
    await this.client.upload(
      await this.pathToId(parentPath),
      name,
      // Buffer 本身即 Uint8Array，避免整包重复拷贝
      content,
      this.isFamily(),
    )
    this.pathCache.clear()
  }

  private async resolveEntry(
    physicalPath: string,
  ): Promise<{ id: string; isDir: boolean }> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.pathToId(parentPath)
    const files = await this.client.getFiles(parentId, this.isFamily())
    const target = files.find((f) => f.name === name)
    if (!target) throw new Error(`[189TV] '${name}' not found`)
    const isDir = "parentId" in target || !("size" in target)
    return { id: target.id, isDir }
  }

  /** 物理路径 → 目录 ID（根目录取 addition.root_folder_id 并按 Go 语义归一） */
  private async pathToId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) {
      return this.rootId()
    }
    if (this.pathCache.has(clean)) return this.pathCache.get(clean)!

    const parts = clean.split("/")
    let currentId = this.rootId()
    for (let i = 0; i < parts.length; i++) {
      const files = await this.client.getFiles(currentId, this.isFamily())
      const target = files.find(
        (f) => f.name === parts[i] && "parentId" in f,
      ) as Cloud189TVFolder | undefined
      if (!target) {
        throw new Error(`[189TV] Directory '${parts[i]}' not found`)
      }
      currentId = target.id
      const subPath = "/" + parts.slice(0, i + 1).join("/")
      this.pathCache.set(subPath, currentId)
    }
    return currentId
  }
}
