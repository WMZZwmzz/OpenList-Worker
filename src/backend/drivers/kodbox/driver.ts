import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverKodboxAddition } from "./types"
import { ClientKodbox } from "./util"

/** 物理路径的父目录（根为 "/"），F-467 */
export function parentPath(physicalPath: string): string {
  const parts = String(physicalPath || "")
    .split("/")
    .filter(Boolean)
  return parts.length > 1 ? "/" + parts.slice(0, -1).join("/") : "/"
}

export class DriverKodbox implements StorageDriver {
  private client: ClientKodbox
  private addition: DriverKodboxAddition

  constructor(addition: DriverKodboxAddition) {
    this.addition = addition
    this.client = new ClientKodbox(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  /** 物理路径：拼接 root_path 前缀 */
  private fullPath(physicalPath: string): string {
    const root = (this.addition.root_path || "").replace(/^\/+|\/+$/g, "")
    const p = physicalPath.replace(/^\/+/, "")
    if (!root) return "/" + p
    return "/" + (p ? `${root}/${p}` : root)
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const entries = await this.client.list(this.fullPath(physicalPath))
    return entries.map((e) => ({
      name: e.name,
      size: e.size || 0,
      is_dir: e.type === "folder",
      modified: e.modifyTime
        ? new Date(e.modifyTime * 1000).toISOString()
        : new Date().toISOString(),
      sign: "",
      type: calcFileType(e.name, e.type === "folder"),
      raw_url: "",
    }))
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const full = this.fullPath(physicalPath)
    const parts = full.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, -1).join("/")
    // A-24：列取失败（401/限流/网络）必须抛出，不能吞成 0 字节文件。
    const entries = await this.client.list(
      parentPath === "//" ? "/" : parentPath,
    )
    const entry = entries.find((e) => e.name === name)
    if (entry) {
      const item: FileItem = {
        name: entry.name,
        size: entry.size || 0,
        is_dir: entry.type === "folder",
        modified: entry.modifyTime
          ? new Date(entry.modifyTime * 1000).toISOString()
          : new Date().toISOString(),
        sign: "",
        type: calcFileType(entry.name, entry.type === "folder"),
        raw_url: "",
      }
      if (!item.is_dir) {
        item.raw_url = this.client.downloadUrl(entry.path || full)
      }
      return item
    }

    // Fallback: 目录；解析失败直接抛出（上层转 404）。
    await this.client.list(full)
    return {
      name,
      size: 0,
      is_dir: true,
      modified: new Date().toISOString(),
      sign: "",
      type: 1,
      raw_url: "",
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    await this.client.mkdir(this.fullPath(physicalPath))
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    await this.client.rename(this.fullPath(physicalPath), newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    const full = this.fullPath(physicalPath)
    const parts = full.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const list = names.length ? names : [name]
    for (const n of list) {
      const target = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}/${n}` : `/${n}`
      await this.client.remove(target, n)
    }
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    // F-467：dstDir 是含挂载前缀的虚拟路径，fullPath() 再拼 root_path 后会指向
    // 不存在的远端目录；目标父目录必须取自物理路径 dstPhysical。
    const srcFull = this.fullPath(srcPhysical)
    const srcParts = srcFull.split("/").filter(Boolean)
    const srcName = srcParts[srcParts.length - 1]
    const dstFull = this.fullPath(parentPath(dstPhysical))
    const targets = names.length ? names : [srcName]
    for (const n of targets) {
      const src = srcParts.length > 1 ? `/${srcParts.slice(0, -1).join("/")}/${n}` : `/${n}`
      await this.client.move(src, n, dstFull)
    }
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    // F-467：同 move，目标父目录取物理路径。
    const srcFull = this.fullPath(srcPhysical)
    const srcParts = srcFull.split("/").filter(Boolean)
    const srcName = srcParts[srcParts.length - 1]
    const dstFull = this.fullPath(parentPath(dstPhysical))
    const targets = names.length ? names : [srcName]
    for (const n of targets) {
      const src = srcParts.length > 1 ? `/${srcParts.slice(0, -1).join("/")}/${n}` : `/${n}`
      await this.client.copy(src, n, dstFull)
    }
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Uint8Array,
  ): Promise<void> {
    const full = this.fullPath(physicalPath)
    const parts = full.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "file"
    const dir = "/" + parts.slice(0, -1).join("/")
    await this.client.put(dir === "//" ? "/" : dir, name, content)
  }
}
