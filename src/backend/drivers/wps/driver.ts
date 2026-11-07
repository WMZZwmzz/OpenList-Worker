import {
  calcFileType,
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { WpsAddition, WpsFileInfo } from "./types"
import { WpsApiClient } from "./util"

interface ResolvedNode {
  kind: "root" | "group" | "folder" | "file"
  groupId: number
  fileId: number
  name: string
  isDir: boolean
  size: number
  modified: string
}

export class WpsDriver implements StorageDriver {
  private addition: WpsAddition
  private client: WpsApiClient

  constructor(addition: WpsAddition) {
    this.addition = addition
    this.client = new WpsApiClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private cleanPath(p: string): string {
    const s = "/" + (p || "").split("/").filter(Boolean).join("/")
    return s === "/" ? "/" : s
  }

  private async resolvePath(p: string): Promise<ResolvedNode | null> {
    const clean = this.cleanPath(p)
    if (clean === "/") {
      return {
        kind: "root",
        groupId: 0,
        fileId: 0,
        name: "root",
        isDir: true,
        size: 0,
        modified: new Date().toISOString(),
      }
    }

    const parts = clean.split("/").filter(Boolean)
    const groups = await this.client.getGroups()
    const group = groups.find((g) => g.name === parts[0])
    if (!group) return null

    const groupId = group.group_id || group.id || 0
    if (parts.length === 1) {
      return {
        kind: "group",
        groupId,
        fileId: 0,
        name: group.name,
        isDir: true,
        size: 0,
        modified: new Date().toISOString(),
      }
    }

    let currentParentId = 0
    let currentNode: ResolvedNode | null = null

    for (let i = 1; i < parts.length; i++) {
      const partName = parts[i]
      const files = await this.client.getFiles(groupId, currentParentId)
      const found: WpsFileInfo | undefined = files.find(
        (f) => f.fname === partName,
      )
      if (!found) return null

      const isDir = found.ftype === "folder"
      currentNode = {
        kind: isDir ? "folder" : "file",
        groupId,
        fileId: found.id,
        name: found.fname,
        isDir,
        size: found.fsize || 0,
        modified: found.mtime
          ? new Date(found.mtime * 1000).toISOString()
          : new Date().toISOString(),
      }
      currentParentId = found.id
    }

    return currentNode
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const clean = this.cleanPath(physicalPath)
    const node = await this.resolvePath(clean)
    if (!node || !node.isDir) {
      return []
    }

    if (node.kind === "root") {
      const groups = await this.client.getGroups()
      const items: FileItem[] = groups.map((g) => ({
        name: g.name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: String(g.group_id || g.id),
        type: 1,
        raw_url: "",
      }))
      return sortFileItems(
        items,
        this.addition.order_by,
        this.addition.order_direction,
      )
    }

    const files = await this.client.getFiles(node.groupId, node.fileId)
    const items: FileItem[] = files.map((f) => {
      const isDir = f.ftype === "folder"
      return {
        name: f.fname,
        size: f.fsize || 0,
        is_dir: isDir,
        modified: f.mtime
          ? new Date(f.mtime * 1000).toISOString()
          : new Date().toISOString(),
        sign: String(f.id),
        type: calcFileType(f.fname, isDir),
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
    const node = await this.resolvePath(clean)
    if (!node) {
      throw new Error(`Path not found: ${clean}`)
    }

    let rawUrl = ""
    if (!node.isDir && node.kind === "file") {
      try {
        rawUrl = await this.client.getDownloadUrl(node.groupId, node.fileId)
      } catch (e) {
        console.warn("[WPS] failed to get download url in get():", e)
      }
    }

    const item: FileItem = {
      name: node.name,
      size: node.size,
      is_dir: node.isDir,
      modified: node.modified,
      sign: String(node.fileId || node.groupId),
      type: calcFileType(node.name, node.isDir),
      raw_url: rawUrl,
    }
    // F-332：WPS 直链需要与 link() 相同的 User-Agent/Referer。框架没有 link
    // 通路，下载链路只走 get() → raw_url_headers（代理抓取时使用）。
    if (rawUrl) {
      item.raw_url_headers = {
        "User-Agent": this.client.getUA(),
        Referer: this.client.driveHost(),
      }
    }
    return item
  }

  async link(
    virtualPath: string,
    physicalPath: string,
  ): Promise<{ url: string; headers?: Record<string, string> }> {
    const clean = this.cleanPath(physicalPath)
    const node = await this.resolvePath(clean)
    if (!node || node.isDir || node.kind !== "file") {
      throw new Error(`Cannot get link for non-file: ${clean}`)
    }

    const url = await this.client.getDownloadUrl(node.groupId, node.fileId)
    return {
      url,
      headers: {
        "User-Agent": this.client.getUA(),
        Referer: this.client.driveHost(),
      },
    }
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    const parentPath = clean.substring(0, clean.lastIndexOf("/")) || "/"
    const dirName = clean.substring(clean.lastIndexOf("/") + 1)

    const parentNode = await this.resolvePath(parentPath)
    if (!parentNode || !parentNode.isDir || parentNode.kind === "root") {
      throw new Error(
        `Cannot create folder directly in root (groups are read-only)`,
      )
    }

    await this.client.createFolder(
      parentNode.groupId,
      parentNode.fileId,
      dirName,
    )
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 已是源/目标项自身的物理路径（op/storage.ts moveItems 逐项调用），
    // 参数即项路径：源直接用 srcPath，目标文件夹取 dstPath 去掉末段的父目录；
    // 不得再拼 name，否则会指向 <item>/<name>。
    const srcPath = this.cleanPath(srcPhys)
    const dstPath = this.cleanPath(dstPhys)
    const dstParentPath = dstPath.substring(0, dstPath.lastIndexOf("/")) || "/"
    const dstNode = await this.resolvePath(dstParentPath)
    if (!dstNode || !dstNode.isDir || dstNode.kind === "root") {
      throw new Error("Target destination directory not found")
    }
    const srcNode = await this.resolvePath(srcPath)
    // F-333：源解析失败必须报错，否则调用方收到成功但什么都没发生。
    if (!srcNode || srcNode.kind === "root" || srcNode.kind === "group") {
      throw new Error(`[WPS] Source not found: ${srcPath}`)
    }
    await this.client.move(
      srcNode.groupId,
      srcNode.fileId,
      dstNode.groupId,
      dstNode.fileId,
    )
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const srcNode = await this.resolvePath(this.cleanPath(physicalPath))
    if (!srcNode) {
      throw new Error("Source node not found")
    }

    await this.client.rename(srcNode.groupId, srcNode.fileId, newName)
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 已是源/目标项自身的物理路径（op/storage.ts copyItems 逐项调用），
    // 参数即项路径：源直接用 srcPath，目标文件夹取 dstPath 去掉末段的父目录；
    // 不得再拼 name，否则会指向 <item>/<name>。
    const srcPath = this.cleanPath(srcPhys)
    const dstPath = this.cleanPath(dstPhys)
    const dstParentPath = dstPath.substring(0, dstPath.lastIndexOf("/")) || "/"
    const dstNode = await this.resolvePath(dstParentPath)
    if (!dstNode || !dstNode.isDir || dstNode.kind === "root") {
      throw new Error("Target destination directory not found")
    }
    const srcNode = await this.resolvePath(srcPath)
    // F-333：同 move，源不存在时不能静默跳过。
    if (!srcNode || srcNode.kind === "root" || srcNode.kind === "group") {
      throw new Error(`[WPS] Source not found: ${srcPath}`)
    }
    await this.client.copy(
      srcNode.groupId,
      srcNode.fileId,
      dstNode.groupId,
      dstNode.fileId,
    )
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    // physicalPath 是目标项自身的物理路径（op/storage.ts removeItems 逐项调用），
    // 参数即项路径，直接解析它即可；再拼 name 会指向 <item>/<name>，resolvePath 返回 null
    // 后被静默跳过，接口成功但文件仍在。
    const node = await this.resolvePath(this.cleanPath(physicalPath))
    // F-333：源不存在时抛错（不能假成功）；root/group 属不可删除节点，同样报错。
    if (!node) {
      throw new Error(`[WPS] Source not found: ${physicalPath}`)
    }
    if (node.kind === "root" || node.kind === "group") {
      throw new Error(`[WPS] Cannot remove ${node.kind}: ${physicalPath}`)
    }
    await this.client.delete(node.groupId, node.fileId)
  }

  async put(
    _virtualPath: string,
    _physicalPath: string,
    _content: Buffer | Uint8Array,
  ): Promise<void> {
    // WPS 上传依赖分块协议（create/upload/commit），当前 util 层未实现任何上传接口。
    // 绝不能静默返回成功：op 层 putItem 会据此刻返回 200 并向客户端报告成功，
    // 而文件从未落盘（静默数据丢失）。显式失败以暴露「不支持」。
    throw new Error(
      "[WPS] upload is not supported: chunked upload protocol is not implemented",
    )
  }

  async getDetails(): Promise<{ total_space?: number; used_space?: number }> {
    try {
      const usage = await this.client.getStorageDetails()
      return {
        total_space: usage.total,
        used_space: usage.used,
      }
    } catch {
      return {}
    }
  }
}
