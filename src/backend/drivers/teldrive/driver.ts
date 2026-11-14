import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverTeldriveAddition, TeldriveFile } from "./types"
import { ClientTeldrive } from "./util"

/** 物理路径的父目录（根为 "/"），F-477 */
export function parentPath(physicalPath: string): string {
  const parts = String(physicalPath || "")
    .split("/")
    .filter(Boolean)
  return parts.length > 1 ? "/" + parts.slice(0, -1).join("/") : "/"
}

/**
 * pathCache 条目 TTL（F-484）。驱动实例经 driverCache 跨请求复用，远端
 * （TelDrive 自己的管理界面）删除/重建同名目录后，缓存的旧 id 会指向已删除
 * 的对象；TTL 保证最多 5 分钟后自动重新解析，写入操作另外强制刷新。
 */
const PATH_CACHE_TTL_MS = 5 * 60 * 1000

function fileToItem(f: TeldriveFile): FileItem {
  const isDir = f.type === "folder"
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified: f.updatedAt || f.createdAt || new Date().toISOString(),
    sign: "",
    type: calcFileType(f.name, isDir),
    raw_url: "",
  }
}

export class DriverTeldrive implements StorageDriver {
  private client: ClientTeldrive
  private addition: DriverTeldriveAddition
  private pathCache = new Map<string, { id: string; expires: number }>()

  constructor(addition: DriverTeldriveAddition) {
    this.addition = addition
    this.client = new ClientTeldrive(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  /** 物理路径：拼接 root_path 前缀（F-481，与 kodbox/ipfs_api 的 fullPath 一致） */
  private fullPath(physicalPath: string): string {
    const root = (this.addition.root_path || "").replace(/^\/+|\/+$/g, "")
    const p = String(physicalPath || "").replace(/^\/+/, "")
    if (!root) return "/" + p
    return "/" + (p ? `${root}/${p}` : root)
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const files = await this.client.listFiles(this.fullPath(physicalPath))
    return files.map(fileToItem)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const full = this.fullPath(physicalPath)
    const parts = full.split("/").filter(Boolean)
    const rawName = parts[parts.length - 1] || "root"
    const parent = parentPath(full)

    // F-483：父目录列表失败（鉴权/限流/网络）必须向上抛，不能降级成假文件。
    const files = await this.client.listFiles(parent)
    const file = files.find((f) => f.name === rawName)
    if (file) {
      const item = fileToItem(file)
      if (!item.is_dir) {
        item.raw_url = this.client.downloadUrl(file.id)
        item.raw_url_headers = this.client.downloadHeaders()
      }
      return item
    }

    // 列表成功但没有该名字：只有「列它自己能成功」才确认是目录，否则 not found。
    try {
      await this.client.listFiles(full)
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
      throw new Error(`[TelDrive] '${full}' not found`)
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    await this.client.mkdir(this.fullPath(physicalPath))
    this.pathCache.clear()
  }

  async rename(
    _virtualPath: string,
    _physicalPath: string,
    _newName: string,
  ): Promise<void> {
    throw new Error("[TelDrive] rename not supported")
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    // F-484：写入操作强制重新解析，避免命中过期 id。
    const id = await this.resolveFileId(physicalPath, true)
    await this.client.remove(id)
    this.pathCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    // F-477：dstDir 是含挂载前缀的虚拟路径；目标目录必须从物理路径派生
    // （去掉目标项自身的名字），与 srcPhysical 保持同一命名空间。
    const srcId = await this.resolveFileId(srcPhysical, true)
    const dstId = await this.resolveFileId(parentPath(dstPhysical), true)
    await this.client.move([srcId], dstId)
    this.pathCache.clear()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    _srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    throw new Error("[TelDrive] copy not supported")
  }

  async put(
    _virtualPath: string,
    _physicalPath: string,
    _content: Uint8Array,
  ): Promise<void> {
    throw new Error("[TelDrive] Direct put not supported in stateless environment")
  }

  private async resolveFileId(
    physicalPath: string,
    force = false,
  ): Promise<string> {
    const clean = this.fullPath(physicalPath)
      .split("/")
      .filter(Boolean)
      .join("/")
    if (!clean) return "/"
    const key = "/" + clean
    if (!force) {
      const hit = this.pathCache.get(key)
      // F-484：过期条目必须丢弃，否则跨请求复用时会返回陈旧 id。
      if (hit && hit.expires > Date.now()) return hit.id
      if (hit) this.pathCache.delete(key)
    }

    const parts = clean.split("/")
    let currentPath = ""
    let currentId = "/"
    for (let i = 0; i < parts.length; i++) {
      const files = await this.client.listFiles(currentPath === "" ? "/" : currentPath)
      const target = files.find((f) => f.name === parts[i])
      if (!target) {
        throw new Error(`[TelDrive] Path '${parts[i]}' not found`)
      }
      currentId = target.id
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : `/${parts[i]}`
      this.pathCache.set(currentPath, {
        id: currentId,
        expires: Date.now() + PATH_CACHE_TTL_MS,
      })
    }
    return currentId
  }
}
