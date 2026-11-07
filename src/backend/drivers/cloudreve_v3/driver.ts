import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverCloudreveV3Addition, CloudreveV3Object } from "./types"
import { ClientCloudreveV3 } from "./util"

function fileToItem(f: CloudreveV3Object): FileItem {
  const isDir = f.type === "dir"
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified: f.date || f.create_date || new Date().toISOString(),
    sign: f.id,
    type: calcFileType(f.name, isDir),
    raw_url: "",
  }
}

/** 规范化 uri（根为 "/"） */
function normUri(p: string): string {
  if (!p || p === "/") return "/"
  return p.startsWith("/") ? p : "/" + p
}

/**
 * 物理路径的父目录 uri（根为 "/"）。
 * F-434：move/copy 的 dst 必须是底层命名空间里的物理路径——op 层传入的 dstDir
 * 是含挂载前缀的虚拟路径，只有 dstPhys 才是已剥离挂载前缀/拼上 root_folder_path
 * 的物理路径（与 srcDir 的推导方式对称）。
 */
export function parentUri(physicalPath: string): string {
  const parts = String(physicalPath || "")
    .split("/")
    .filter(Boolean)
  return parts.length > 1 ? "/" + parts.slice(0, -1).join("/") : "/"
}

export class DriverCloudreveV3 implements StorageDriver {
  private client: ClientCloudreveV3

  constructor(
    addition: DriverCloudreveV3Addition,
    persistCookie?: (cookie: string) => void | Promise<void>,
  ) {
    this.client = new ClientCloudreveV3(addition, persistCookie)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const files = await this.client.listFiles(normUri(physicalPath))
    return files.map(fileToItem)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const uri = normUri(physicalPath)
    const parts = uri.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    const parentUri = "/" + parts.slice(0, -1).join("/")

    // F-439：父目录列表失败（鉴权/网络/目录不存在）必须向上抛，
    // 不能和「列表成功但没有这个名字」共用同一个合成目录。
    const files = await this.client.listFiles(parentUri === "//" ? "/" : parentUri)
    const file = files.find((f) => f.name === name)
    if (file) {
      const item = fileToItem(file)
      if (!item.is_dir) {
        try {
          item.raw_url = await this.client.getDownloadUrl(file.id)
          item.raw_url_headers = this.client.downloadHeaders()
        } catch (e: any) {
          item.raw_url_error = e.message
        }
      }
      return item
    }

    // 未命中：只有确认它是目录（列它自己能成功）才返回目录条目，否则 404。
    try {
      await this.client.listFiles(uri)
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    } catch {
      throw new Error(`[Cloudreve] '${uri}' not found`)
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    await this.client.mkdir(normUri(physicalPath))
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const entry = await this.resolveEntry(physicalPath)
    await this.client.rename(entry.src, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const entry = await this.resolveEntry(physicalPath)
    await this.client.remove(entry.src)
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    // F-434：source 与 destination 都必须来自物理路径，虚拟 dstDir 会把文件
    // 移到挂载树之外的错误目录（root_folder_path / 子路径挂载时）。
    const entry = await this.resolveEntry(srcPhysical)
    await this.client.move(
      parentUri(srcPhysical),
      parentUri(dstPhysical),
      entry.src,
    )
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    // F-434：同 move，目标父目录由物理路径派生。
    const entry = await this.resolveEntry(srcPhysical)
    await this.client.copy(
      parentUri(srcPhysical),
      parentUri(dstPhysical),
      entry.src,
    )
  }

  async put(): Promise<void> {
    throw new Error(
      "[Cloudreve] Direct put not supported in stateless environment",
    )
  }

  private async resolveEntry(
    physicalPath: string,
  ): Promise<{ src: { dirs: string[]; items: string[] }; isDir: boolean }> {
    const uri = normUri(physicalPath)
    const parts = uri.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentUri = "/" + parts.slice(0, -1).join("/")
    const files = await this.client.listFiles(
      parentUri === "//" ? "/" : parentUri,
    )
    const target = files.find((f) => f.name === name)
    if (!target) throw new Error(`[Cloudreve] '${name}' not found`)
    const isDir = target.type === "dir"
    const src = isDir
      ? { dirs: [target.id], items: [] }
      : { dirs: [], items: [target.id] }
    return { src, isDir }
  }
}
