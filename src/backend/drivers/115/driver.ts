import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { Driver115Addition, Cloud115File } from "./types"
import { Client115 } from "./util"
import { sha1 } from "../../pkg/crypto"

function fileToItem(f: Cloud115File): FileItem {
  const isDir = f.Fc === "0"
  const modTime = f.Upt ? new Date(f.Upt * 1000).toISOString() : new Date().toISOString()
  return {
    name: f.Fn,
    size: f.FS || 0,
    is_dir: isDir,
    modified: modTime,
    sign: "",
    type: calcFileType(f.Fn, isDir),
    thumb: f.Thumbnail || "",
    raw_url: "",
  }
}

export class Driver115 implements StorageDriver {
  private client: Client115
  private pathCache = new Map<string, string>()

  constructor(addition: Driver115Addition) {
    this.client = new Client115(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const cid = await this.client.resolvePathId(physicalPath, this.pathCache)
    const files = await this.client.getFiles(cid)
    return files.map(fileToItem)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const rawName = parts[parts.length - 1] || "root"
    // physicalPath 已由上游完全解码（db.ts decodePathFully），此处不能再
    // decodeURIComponent：字面名含 %XX 的条目会与解码后的同名条目混淆。
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.client.resolvePathId(parentPath, this.pathCache)
    const files = await this.client.getFiles(parentId)
    const file = files.find((f) => f.Fn === rawName || f.Fid === rawName)

    if (file) {
      const item = fileToItem(file)
      if (!item.is_dir && file.Pc) {
        try {
          const url = await this.client.getDownloadUrl(file.Pc, file.Fid)
          item.raw_url = url
        } catch (e: any) {
          item.raw_url_error = e.message
        }
      }
      return item
    }

    // Fallback: path 可能是文件夹（根目录等未在父目录列出）
    try {
      const fid = await this.client.resolvePathId(physicalPath, this.pathCache)
      await this.client.getFiles(fid)
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
    const parentId = await this.client.resolvePathId(parentPath, this.pathCache)
    await this.client.mkdir(parentId, name)
    // 变更后必须失效路径缓存：驱动实例按 storage.id_modified 跨请求复用，
    // 残留的 path→fid 映射会让后续 list/remove/move 命中已失效的旧对象。
    this.pathCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const fid = await this.client.resolvePathId(physicalPath, this.pathCache)
    await this.client.rename(fid, newName)
    this.pathCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    parts.pop()
    const parentPath = "/" + parts.join("/")
    const parentId = await this.client.resolvePathId(parentPath, this.pathCache)
    const fid = await this.client.resolvePathId(physicalPath, this.pathCache)
    await this.client.remove([fid], parentId)
    this.pathCache.clear()
  }

  /**
   * dstPhys 是**目标项自身**的物理路径（已含文件名），目标父目录需取其
   * dirname。dstDir 是用户视角的虚拟路径（含挂载点/base_path 前缀），不能
   * 当作 115 账号内的路径解析，否则挂载点非根时必然移/复制到错误目录或报错。
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
    const fid = await this.client.resolvePathId(srcPhysical, this.pathCache)
    const dstId = await this.client.resolvePathId(
      this.parentPhysicalPath(dstPhysical),
      this.pathCache,
    )
    await this.client.move(dstId, [fid])
    this.pathCache.clear()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const fid = await this.client.resolvePathId(srcPhysical, this.pathCache)
    const dstId = await this.client.resolvePathId(
      this.parentPhysicalPath(dstPhysical),
      this.pathCache,
    )
    await this.client.copy(dstId, [fid])
    this.pathCache.clear()
  }

  readonly rapidHashAlgos = ["sha1"]
  readonly rapidHashNeedsPieces = false

  async rapidUpload(
    _virtualPath: string,
    physicalPath: string,
    metadata: {
      size: number
      sha1?: string
      readRange?: (start: number, length: number) => Promise<Uint8Array>
    },
  ): Promise<boolean> {
    const sha1Full = String(metadata.sha1 || "").toUpperCase()
    if (!/^[0-9A-F]{40}$/.test(sha1Full) || !metadata.readRange) return false
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "file"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.client.resolvePathId(
      parentPath,
      this.pathCache,
    )
    const preSize = Math.min(128 * 1024, metadata.size)
    const preId = (
      await sha1(await metadata.readRange(0, preSize))
    ).toUpperCase()
    let initResp = await this.client.uploadInit({
      fileName: name,
      fileSize: metadata.size,
      target: parentId,
      fileId: sha1Full,
      preId,
    })
    if (initResp.status === 2) return true
    if ([6, 7, 8].includes(Number(initResp.status)) && initResp.sign_check) {
      const [start, end] = initResp.sign_check
        .split("-")
        .map((value) => parseInt(value, 10))
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const signVal = (
          await sha1(await metadata.readRange(start, end - start + 1))
        ).toUpperCase()
        initResp = await this.client.uploadInit({
          fileName: name,
          fileSize: metadata.size,
          target: parentId,
          fileId: sha1Full,
          preId,
          signKey: initResp.sign_key,
          signVal,
        })
        return initResp.status === 2
      }
    }
    return false
  }

  async put(
    _virtualPath: string,
    _physicalPath: string,
    _content: Buffer,
  ): Promise<void> {
    throw new Error("[115] Direct put not supported in stateless environment")
  }
}
