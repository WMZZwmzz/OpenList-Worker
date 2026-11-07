import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverHalalCloudOpenAddition, HCloudFile } from "./types"
import { ClientHalalCloudOpen } from "./util"

function toNumber(v: string | number | undefined): number {
  if (typeof v === "number") return v
  if (typeof v === "string" && v.trim() !== "") return Number(v)
  return 0
}

function fileToItem(f: HCloudFile): FileItem {
  const isDir = f.dir === true
  const updateTs = toNumber(f.update_ts)
  const createTs = toNumber(f.create_ts)
  const ts = updateTs || createTs
  return {
    name: f.name || "",
    size: isDir ? 0 : toNumber(f.size),
    is_dir: isDir,
    modified: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
    sign: f.identity || f.path || "",
    type: calcFileType(f.name || "", isDir),
    raw_url: "",
  }
}

/** 规范化路径（根为 "/"） */
function normPath(p: string): string {
  if (!p || p === "/") return "/"
  return p.startsWith("/") ? p : "/" + p
}

export class DriverHalalCloudOpen implements StorageDriver {
  private client: ClientHalalCloudOpen
  private rootPath: string

  constructor(
    addition: DriverHalalCloudOpenAddition,
    persistRefreshToken?: (refreshToken: string) => void | Promise<void>,
  ) {
    this.client = new ClientHalalCloudOpen(addition, persistRefreshToken)
    this.rootPath = normPath(addition.root_folder_id || "/")
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private fullPath(physicalPath: string): string {
    const p = normPath(physicalPath)
    if (this.rootPath === "/") return p
    return p === "/" ? this.rootPath : this.rootPath + p
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const files = await this.client.listFiles(this.fullPath(physicalPath))
    return files.map(fileToItem)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const full = this.fullPath(physicalPath)
    const parts = full.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, -1).join("/")

    // F-337：父目录列表失败（token 刷新失败/网络错误/限流）必须向上抛，
    // 不能与「列表成功但没有这个名字」共用同一个 is_dir 占位目录。
    const files = await this.client.listFiles(
      parentPath === "//" ? "/" : parentPath,
    )
    const target = files.find((f) => f.name === name)
    if (target) {
      const item = fileToItem(target)
      if (!item.is_dir) {
        try {
          item.raw_url = await this.client.getDownloadUrl(
            target.path || full,
            target.identity || "",
          )
        } catch {
          item.raw_url_error = "[HalalCloud] failed to resolve download url"
        }
      }
      return item
    }

    // 列表成功但未命中：确认它是不是目录（列目标自身），否则 not found。
    try {
      await this.client.listFiles(full)
    } catch {
      throw new Error(`[HalalCloud] '${full}' not found`)
    }
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
    const full = this.fullPath(physicalPath)
    const parts = full.split("/").filter(Boolean)
    const name = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    await this.client.createDir(parentPath === "//" ? "/" : parentPath, name)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const full = this.fullPath(physicalPath)
    await this.client.rename(full, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const full = this.fullPath(physicalPath)
    const entry = await this.resolveEntry(full)
    await this.client.remove(entry.path, entry.identity, entry.isDir)
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    // dstDir 是虚拟目录，dstPhysical 才是目标项自身的物理路径（op 层契约）；
    // fullPath() 只接受物理路径，把虚拟 dstDir 传进来会重复拼入挂载前缀/root_folder_id。
    const srcFull = this.fullPath(srcPhysical)
    const dstFull = this.fullPath(dstPhysical)
    const entry = await this.resolveEntry(srcFull)
    await this.client.move(entry.path, dstFull, entry.identity)
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    // 同 move：目标路径由 dstPhysical 推导，与 dropbox 驱动一致。
    const srcFull = this.fullPath(srcPhysical)
    const dstFull = this.fullPath(dstPhysical)
    const entry = await this.resolveEntry(srcFull)
    await this.client.copy(entry.path, dstFull, entry.identity)
  }

  async put(): Promise<void> {
    throw new Error(
      "[HalalCloud] upload not supported in stateless environment",
    )
  }

  private async resolveEntry(
    full: string,
  ): Promise<{ path: string; identity: string; isDir: boolean }> {
    const parts = full.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const files = await this.client.listFiles(
      parentPath === "//" ? "/" : parentPath,
    )
    const target = files.find((f) => f.name === name)
    if (!target) throw new Error(`[HalalCloud] '${name}' not found`)
    return {
      path: target.path || full,
      identity: target.identity || "",
      isDir: target.dir === true,
    }
  }
}
