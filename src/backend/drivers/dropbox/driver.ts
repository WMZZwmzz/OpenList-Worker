import {
  calcFileType,
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { DropboxAddition } from "./types"
import { DropboxApiClient } from "./util"

export class DropboxDriver implements StorageDriver {
  private addition: DropboxAddition
  private client: DropboxApiClient

  constructor(
    addition: DropboxAddition,
    onTokenRefreshed?: (tokens: {
      accessToken: string
      refreshToken: string
    }) => Promise<void>,
  ) {
    this.addition = addition
    this.client = new DropboxApiClient(addition, onTokenRefreshed)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private cleanPath(p: string): string {
    const s = "/" + (p || "").split("/").filter(Boolean).join("/")
    return s === "/" ? "" : s
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const clean = this.cleanPath(physicalPath)
    const files = await this.client.getFiles(clean)

    const items: FileItem[] = files.map((f) => {
      const isDir = f[".tag"] === "folder"
      const pathDisplay = f.path_display || f.path_lower || `/${f.name}`
      return {
        name: f.name,
        size: f.size || 0,
        is_dir: isDir,
        modified:
          f.server_modified || f.client_modified || new Date().toISOString(),
        sign: f.id || pathDisplay,
        type: calcFileType(f.name, isDir),
        raw_url: "",
      }
    })

    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    const clean = this.cleanPath(physicalPath)
    const name = clean.split("/").filter(Boolean).pop() || "root"

    if (!clean) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "/",
        type: 1,
        raw_url: "",
      }
    }

    try {
      const { link, metadata } = await this.client.getTemporaryLink(clean)
      // F-339：优先使用响应里自带的 metadata（真实 size / server_modified），
      // 而不是硬编码的 0 与「当前时间」。
      return {
        name: metadata?.name || name,
        size: metadata?.size || 0,
        is_dir: false,
        modified:
          metadata?.server_modified ||
          metadata?.client_modified ||
          new Date().toISOString(),
        sign: metadata?.id || clean,
        type: calcFileType(metadata?.name || name, false),
        raw_url: link,
      }
    } catch (e: any) {
      // F-336：get_temporary_link 对目录返回 path/not_file，可以据此回退成目录；
      // 但「对象不存在」「鉴权失败」「网络/限流」必须原样上抛，否则
      // /fs/get 与 WebDAV 会把不存在的路径或上游故障当成目录。
      const tag = String(e?.tag || "")
      if (tag === "not_file" || tag === "not_a_file") {
        return {
          name,
          size: 0,
          is_dir: true,
          modified: new Date().toISOString(),
          sign: clean,
          type: 1,
          raw_url: "",
        }
      }
      if (tag === "not_found") {
        throw new Error(`[Dropbox] path not found: ${clean}`)
      }
      throw e
    }
  }

  async link(
    virtualPath: string,
    physicalPath: string,
  ): Promise<{ url: string; headers?: Record<string, string> }> {
    const clean = this.cleanPath(physicalPath)
    const { link } = await this.client.getTemporaryLink(clean)
    return { url: link }
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    await this.client.createFolder(clean)
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const from = this.cleanPath(physicalPath)
    const parent = from.substring(0, from.lastIndexOf("/"))
    const to = parent ? `${parent}/${newName}` : `/${newName}`
    await this.client.move(from, to)
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    // physicalPath 是目标项自身的物理路径（op/storage.ts removeItems 逐项调用），
    // 直接删除它即可；不得再拼 name，否则指向 `<item>/<name>`，delete 404 报错。
    const target = this.cleanPath(physicalPath)
    await this.client.delete(target)
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 已是源/目标项自身的物理路径（op/storage.ts moveItems 逐项调用），
    // 直接作为 from/to 使用；不得再拼 name，否则指向 `<item>/<name>`，源/目标错位。
    const from = this.cleanPath(srcPhys)
    const to = this.cleanPath(dstPhys)
    await this.client.move(from, to)
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 已是源/目标项自身的物理路径（op/storage.ts copyItems 逐项调用），
    // 直接作为 from/to 使用；不得再拼 name，否则指向 `<item>/<name>`，源/目标错位。
    const from = this.cleanPath(srcPhys)
    const to = this.cleanPath(dstPhys)
    await this.client.copy(from, to)
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer | Uint8Array,
  ): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    // F-335/F-338：参数头改为纯 ASCII 的 JSON（非 Latin-1 文件名不再炸），
    // 且 >150MiB 的文件自动改走 upload_session 分片上传。
    await this.client.upload(clean, content)
  }

  async getDetails(): Promise<{ total_space?: number; used_space?: number }> {
    try {
      const usage = await this.client.getSpaceUsage()
      return {
        total_space: usage.allocation?.allocated || 0,
        used_space: usage.used || 0,
      }
    } catch {
      return {}
    }
  }
}
