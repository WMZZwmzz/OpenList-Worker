import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverChaoXingAddition, ChaoXingFile } from "./types"
import { ClientChaoXing } from "./util"

function fileToItem(f: ChaoXingFile): FileItem {
  const c = f.content
  if (c.folderName) {
    return {
      name: c.folderName,
      size: 0,
      is_dir: true,
      modified: f.inserttime
        ? new Date(f.inserttime).toISOString()
        : new Date().toISOString(),
      sign: String(f.id),
      type: 1,
    }
  }
  const fileId = c.fileId || c.objectId || ""
  return {
    name: c.name || "",
    size: Number(c.size) || 0,
    is_dir: false,
    modified: c.uploadDate
      ? new Date(c.uploadDate).toISOString()
      : new Date().toISOString(),
    sign: `${f.id}$${fileId}`,
    type: calcFileType(c.name || "", false),
    raw_url: "",
  }
}

export class DriverChaoXing implements StorageDriver {
  private client: ClientChaoXing
  private addition: DriverChaoXingAddition
  private pathCache = new Map<string, string>()

  constructor(
    addition: DriverChaoXingAddition,
    persistCookie?: (cookie: string) => void | Promise<void>,
  ) {
    this.addition = addition
    this.client = new ClientChaoXing(addition, persistCookie)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentId = await this.pathToId(physicalPath)
    const files = await this.client.getFiles(parentId)
    return files.map((f) => fileToItem(f))
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const rawName = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, -1).join("/")

    // 父目录解析/列表请求的异常必须向上传播（让 op 层报 5xx），
    // 只有「列表成功且确无该名字」才进入目录兜底/not found。
    const parentId = await this.pathToId(parentPath)
    const files = await this.client.getFiles(parentId)
    const target = files.find(
      (f) => (f.content.folderName || f.content.name) === rawName,
    )
    if (target) {
      const item = fileToItem(target)
      if (!item.is_dir) {
        const fileId = item.sign.split("$")[1] || ""
        if (fileId) {
          try {
            const resp = await this.client.link(fileId)
            item.raw_url = resp.download
            item.raw_url_headers = this.client.downloadHeaders()
          } catch {
            item.raw_url_error = "[ChaoXing] failed to resolve download url"
          }
        }
      }
      return item
    }

    // 不是列表中的条目：确认是否为真实存在的目录，否则抛 not found。
    const dirId = await this.pathToId(physicalPath)
    return {
      name: rawName,
      size: 0,
      is_dir: true,
      modified: new Date().toISOString(),
      sign: dirId,
      type: 1,
      raw_url: "",
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    await this.client.mkdir(await this.pathToId(parentPath), name)
    this.pathCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const entry = await this.resolveEntry(physicalPath)
    if (!entry.isDir) {
      throw new Error("[ChaoXing] 此网盘不支持修改文件名")
    }
    await this.client.renameFolder(entry.id, newName)
    this.pathCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const entry = await this.resolveEntry(physicalPath)
    await this.client.remove(entry.id, entry.isDir)
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
    // dstPhysical 是目标项自身的物理路径，目标目录取去掉末段后的父目录；
    // 虚拟 dstDir 含挂载前缀，pathToId 只在物理根内解析，不能直接使用。
    const dstParent =
      "/" +
      dstPhysical
        .split("/")
        .filter(Boolean)
        .slice(0, -1)
        .join("/")
    await this.client.move(entry.id, await this.pathToId(dstParent), entry.isDir)
    this.pathCache.clear()
  }

  async copy(): Promise<void> {
    throw new Error("[ChaoXing] copy not supported")
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Uint8Array,
  ): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "file"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.pathToId(parentPath)
    await this.client.upload(parentId, name, new Uint8Array(content))
    this.pathCache.clear()
  }

  private async resolveEntry(
    physicalPath: string,
  ): Promise<{ id: string; isDir: boolean }> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.pathToId(parentPath)
    const files = await this.client.getFiles(parentId)
    const target = files.find(
      (f) => (f.content.folderName || f.content.name) === name,
    )
    if (!target) throw new Error(`[ChaoXing] '${name}' not found`)
    return { id: String(target.id), isDir: !!target.content.folderName }
  }

  /** 物理路径 → 目录 ID（根目录默认 "-1"，可通过 root_folder_id 覆盖） */
  private async pathToId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    const rootId = this.addition.root_folder_id || "-1"
    if (!clean) return rootId
    if (this.pathCache.has(clean)) return this.pathCache.get(clean)!

    const parts = clean.split("/")
    let currentId = rootId
    for (let i = 0; i < parts.length; i++) {
      const files = await this.client.getFiles(currentId)
      const target = files.find((f) => f.content.folderName === parts[i])
      if (!target) {
        throw new Error(`[ChaoXing] Directory '${parts[i]}' not found`)
      }
      currentId = String(target.id)
      const subPath = parts.slice(0, i + 1).join("/")
      this.pathCache.set(subPath, currentId)
    }
    return currentId
  }
}
