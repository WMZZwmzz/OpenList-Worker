import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverDoubaoAddition, DoubaoFile } from "./types"
import { ClientDoubao } from "./util"

const DEFAULT_ROOT = "0"

export class DriverDoubao implements StorageDriver {
  private client: ClientDoubao
  private pathCache = new Map<string, string>()

  constructor(addition: DriverDoubaoAddition) {
    this.client = new ClientDoubao(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private fileToItem(f: DoubaoFile): FileItem {
    const isDir = f.node_type === 1
    return {
      name: f.name,
      size: f.size || 0,
      is_dir: isDir,
      modified: f.update_time
        ? new Date(f.update_time * 1000).toISOString()
        : new Date().toISOString(),
      sign: "",
      type: calcFileType(f.name, isDir),
      raw_url: "",
    }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const dirId = await this.resolveDirId(physicalPath)
    const files = await this.client.getFiles(dirId)
    return files.map((f) => this.fileToItem(f))
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const rawName = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, -1).join("/")

    // 父目录解析/列表请求的异常必须向上传播；仅当列表成功且确无该名字时
    // 才进入目录兜底/not found，避免把瞬时故障伪装成「文件存在」。
    const parentId = await this.resolveDirId(parentPath)
    const files = await this.client.getFiles(parentId)
    const file = files.find((f) => f.name === rawName)
    if (file) {
      const item = this.fileToItem(file)
      if (!item.is_dir) {
        try {
          item.raw_url = await this.client.getDownloadUrl(file)
          item.raw_url_headers = this.client.downloadHeaders()
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
    // physicalPath 是条目自身的物理路径；resolveDirId 只匹配目录
    //（node_type===1），文件必须用 resolveEntry 按名称匹配。
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
    // F-467 同类：dstDir 是含挂载前缀的虚拟路径，resolveDirId 只认豆包账号内
    // 路径；目标父目录必须从物理路径 dstPhysical 派生（去掉条目自身的名字）。
    const entry = await this.resolveEntry(srcPhysical)
    const dstSegs = String(dstPhysical || "")
      .split("/")
      .filter(Boolean)
    dstSegs.pop()
    const dstId = await this.resolveDirId("/" + dstSegs.join("/"))
    await this.client.move(entry.id, entry.parentId, dstId)
    this.pathCache.clear()
  }

  async copy(): Promise<void> {
    throw new Error("[Doubao] copy not supported")
  }

  async put(): Promise<void> {
    throw new Error("[Doubao] upload not supported in stateless environment")
  }

  private async resolveDirId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return DEFAULT_ROOT
    if (this.pathCache.has(clean)) return this.pathCache.get(clean)!

    const parts = clean.split("/")
    let currentId = DEFAULT_ROOT
    for (let i = 0; i < parts.length; i++) {
      const files = await this.client.getFiles(currentId)
      const target = files.find((f) => f.node_type === 1 && f.name === parts[i])
      if (!target) throw new Error(`[Doubao] Directory '${parts[i]}' not found`)
      currentId = target.id
      const subPath = "/" + parts.slice(0, i + 1).join("/")
      this.pathCache.set(subPath, currentId)
    }
    return currentId
  }

  private async resolveEntry(physicalPath: string): Promise<{ id: string; parentId: string; isDir: boolean }> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.resolveDirId(parentPath)
    const files = await this.client.getFiles(parentId)
    const file = files.find((f) => f.name === name)
    if (!file) throw new Error(`[Doubao] '${name}' not found`)
    return { id: file.id, parentId: file.parent_id || parentId, isDir: file.node_type === 1 }
  }
}
