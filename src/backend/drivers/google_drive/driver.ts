import { StorageDriver, FileItem } from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import {
  GoogleDriveAddition,
  GoogleFile,
  GOOGLE_DRIVE_FOLDER_MIME,
} from "./types"
import { GoogleDriveClient } from "./util"

function googleFileToFileItem(f: GoogleFile): FileItem {
  // 快捷方式按其目标类型展示（文件夹快捷方式仍显示为目录）
  const isDir = (f.targetMimeType || f.mimeType) === GOOGLE_DRIVE_FOLDER_MIME
  return {
    name: f.name,
    size: f.size ? parseInt(f.size, 10) : 0,
    is_dir: isDir,
    modified: f.modifiedTime || f.createdTime || new Date().toISOString(),
    sign: "",
    type: isDir ? 1 : 0,
    thumb: f.thumbnailLink || "",
    raw_url: "",
  }
}

export class GoogleDrive implements StorageDriver {
  private client: GoogleDriveClient
  private addition: GoogleDriveAddition

  constructor(addition: GoogleDriveAddition) {
    this.addition = addition
    this.client = new GoogleDriveClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    // 文件夹快捷方式需要按目标 id 列子项
    const folderId = await this.client.resolveReadId(physicalPath)
    const files = await this.client.listFiles(folderId)
    const items = files.map(googleFileToFileItem)
    // F-361：order_by 是 Drive 专用的复合查询串（如
    // "folder,name,modifiedTime desc"），API 已按它排好序；再喂给
    // sortFileItems 会被本地排序覆盖掉 API 的排序（旧版启发式甚至把
    // modifiedTime 误读成「按修改时间」）。复合串只信任服务端排序，
    // 简单键（name/size/modified…）仍交给共享排序。
    const orderBy = this.addition.order_by
    if (orderBy && String(orderBy).includes(",")) {
      return items
    }
    return sortFileItems(
      items,
      orderBy,
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const fileId = await this.client.resolveFileId(physicalPath)
    const file = await this.client.getFile(fileId).catch(() => null)
    if (file) {
      // 快捷方式：写操作已作用在快捷方式本身，下载链接需指向目标。
      const targetId = file.shortcutDetails?.targetId
      const item = googleFileToFileItem({
        ...file,
        targetId,
        targetMimeType: file.shortcutDetails?.targetMimeType,
      })
      if (!item.is_dir) {
        item.raw_url = this.client.getDownloadUrl(
          targetId || fileId,
          targetId
            ? String(file.shortcutDetails?.targetMimeType || "")
            : String(file.mimeType || ""),
        )
        item.raw_url_headers = this.client.getDownloadHeaders()
      }
      return item
    }
    // Fallback: the path may be a folder that isn't found via getFile
    // (e.g. the storage root). Probe it by listing.
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    try {
      await this.client.listFiles(fileId)
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    } catch {}
    return {
      name,
      size: 0,
      is_dir: false,
      modified: new Date().toISOString(),
      sign: "",
      type: 0,
      raw_url: "",
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const { parentId, name } =
      await this.client.resolveParentAndName(physicalPath)
    await this.client.mkdir(parentId, name)
    this.client.invalidatePathCache(physicalPath)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const fileId = await this.client.resolveFileId(physicalPath)
    await this.client.rename(fileId, newName)
    this.client.invalidatePathCache(physicalPath)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const fileId = await this.client.resolveFileId(physicalPath)
    await this.client.remove(fileId)
    this.client.invalidatePathCache(physicalPath)
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.client.resolveFileId(srcPhysical)
    const srcParts = srcPhysical.split("/").filter(Boolean)
    srcParts.pop()
    const srcParentId = await this.client.resolveFileId(
      "/" + srcParts.join("/"),
    )
    // dstPhysical 是目标项自身的物理路径，父目录去掉末段即得；
    // dstDir 是虚拟路径（含挂载前缀），而 resolveFileId 期望物理路径，直接用会错位。
    const { parentId: dstParentId } =
      await this.client.resolveParentAndName(dstPhysical)
    await this.client.move(fileId, srcParentId, dstParentId)
    this.client.invalidatePathCache(srcPhysical)
    this.client.invalidatePathCache(dstPhysical)
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.client.resolveFileId(srcPhysical)
    // 目标父目录与目标名字均以 dstPhysical（目标项自身路径）为准。
    const { parentId: dstParentId, name } =
      await this.client.resolveParentAndName(dstPhysical)
    await this.client.copy(fileId, dstParentId, name)
    this.client.invalidatePathCache(dstPhysical)
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Uint8Array,
  ): Promise<void> {
    const { parentId, name } =
      await this.client.resolveParentAndName(physicalPath)
    await this.client.putFile(parentId, name, content)
    this.client.invalidatePathCache(physicalPath)
  }
}
