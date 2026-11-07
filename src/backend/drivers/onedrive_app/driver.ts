import { StorageDriver, FileItem } from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { Addition } from "./meta"
import { fileToObj } from "./types"
import { chunkSizeBytes } from "../onedrive/util"
import {
  accessToken,
  requestApi,
  getFiles,
  getFile,
  getDrive,
  getMetaUrl,
  getDirectUploadInfo,
} from "./util"

/**
 * F-355：addition 里布尔字段可能是字符串（parseAddition 只做 JSON.parse）。
 * 构造函数用 `!!` 强转会把 "false"/"0" 变成 true，且 init() 里为字符串写的
 * 归一化分支从此不可达。这里在入口处就按字符串语义归一化。
 */
function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const v = value.trim().toLowerCase()
    if (v === "true" || v === "1") return true
    if (v === "false" || v === "0" || v === "") return false
  }
  return fallback
}

export class OnedriveAPP implements StorageDriver {
  root_folder_path: string = "/"
  region: string = "global"
  client_id: string = ""
  client_secret: string = ""
  tenant_id: string = ""
  email: string = ""
  chunk_size: number = 5
  custom_host: string = ""
  disable_disk_usage: boolean = false
  enable_direct_upload: boolean = false
  order_by: string = "filename"
  order_direction: string = "asc"

  accessToken: string = ""
  onTokenUpdate?: (token: string) => void

  constructor(
    addition?: Partial<Addition>,
    onTokenUpdate?: (token: string) => void,
  ) {
    if (addition) {
      if (addition.root_folder_path !== undefined)
        this.root_folder_path = String(addition.root_folder_path)
      if (addition.region !== undefined) this.region = String(addition.region)
      if (addition.client_id !== undefined)
        this.client_id = String(addition.client_id)
      if (addition.client_secret !== undefined)
        this.client_secret = String(addition.client_secret)
      if (addition.tenant_id !== undefined)
        this.tenant_id = String(addition.tenant_id)
      if (addition.email !== undefined) this.email = String(addition.email)
      if (addition.chunk_size !== undefined)
        this.chunk_size = Number(addition.chunk_size) || 5
      if (addition.custom_host !== undefined)
        this.custom_host = String(addition.custom_host)
      if (addition.disable_disk_usage !== undefined)
        this.disable_disk_usage = toBool(addition.disable_disk_usage, false)
      if (addition.enable_direct_upload !== undefined)
        this.enable_direct_upload = toBool(addition.enable_direct_upload, false)
      if (addition.order_by !== undefined)
        this.order_by = String(addition.order_by)
      if (addition.order_direction !== undefined)
        this.order_direction = String(addition.order_direction)
    }
    this.onTokenUpdate = onTokenUpdate
  }

  async init(): Promise<void> {
    if (typeof this.chunk_size === "string") {
      this.chunk_size = parseInt(this.chunk_size as string) || 5
    }
    if (typeof this.disable_disk_usage === "string") {
      this.disable_disk_usage =
        (this.disable_disk_usage as string).toLowerCase() === "true"
    }
    if (typeof this.enable_direct_upload === "string") {
      this.enable_direct_upload =
        (this.enable_direct_upload as string).toLowerCase() === "true"
    }

    if (this.chunk_size < 1) {
      this.chunk_size = 5
    }

    if (this.client_id && this.client_secret && this.tenant_id) {
      await accessToken(this)
    }
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const files = await getFiles(this, physicalPath)
    const items = files.map((f) => {
      const obj = fileToObj(f, "")
      let rawUrl = f["@microsoft.graph.downloadUrl"] || obj.url || ""
      if (this.custom_host && rawUrl) {
        try {
          const u = new URL(rawUrl)
          u.host = this.custom_host
          rawUrl = u.toString()
        } catch {}
      }
      return {
        name: obj.name,
        size: obj.size,
        is_dir: obj.isFolder,
        modified: obj.modified,
        sign: "",
        type: obj.isFolder ? 1 : 0,
        thumb: obj.thumbnail || "",
        raw_url: rawUrl,
      }
    })
    return sortFileItems(items, this.order_by, this.order_direction)
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    const f = await getFile(this, physicalPath)
    const obj = fileToObj(f, "")
    let rawUrl = f["@microsoft.graph.downloadUrl"] || obj.url || ""
    if (this.custom_host && rawUrl) {
      try {
        const u = new URL(rawUrl)
        u.host = this.custom_host
        rawUrl = u.toString()
      } catch {}
    }
    return {
      name: obj.name,
      size: obj.size,
      is_dir: obj.isFolder,
      modified: obj.modified,
      sign: "",
      type: obj.isFolder ? 1 : 0,
      thumb: obj.thumbnail || "",
      raw_url: rawUrl,
    }
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const parentPath = physicalPath.split("/").slice(0, -1).join("/") || "/"
    const dirName = physicalPath.split("/").filter(Boolean).pop() || ""

    const url = getMetaUrl(this, false, parentPath, "children")
    const data = {
      name: dirName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "rename",
    }
    await requestApi(this, url, "POST", data)
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const data = {
      name: newName,
    }
    const url = getMetaUrl(this, false, physicalPath)
    await requestApi(this, url, "PATCH", data)
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    // physicalPath 是目标项自身的物理路径（op/storage.ts 逐项调用），
    // 参数即目标项路径，不得再拼 name，否则指向 <item>/<name>，DELETE 404 导致对象仍然存在。
    const url = getMetaUrl(this, false, physicalPath)
    await requestApi(this, url, "DELETE")
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 是源/目标项自身的物理路径（已含 name，参数即目标项路径，
    // 不得再拼 name，否则指向 <item>/<name>）：
    // 目标父目录取 dstPhys 去掉末段（直接 GET dstPhys 拿到的是目标项本身，通常还不存在），
    // 目标名字以 dstPhys 末段为准，源项路径则直接使用 srcPhys。
    const dstParentPath = dstPhys.split("/").slice(0, -1).join("/") || "/"
    const dstUrl = getMetaUrl(this, false, dstParentPath)
    const dstRes = await requestApi<any>(this, dstUrl, "GET")
    const dstId = dstRes.id
    const driveId = dstRes.parentReference?.driveId

    const data = {
      parentReference: {
        id: dstId,
        ...(driveId ? { driveId } : {}),
      },
      name: dstPhys.split("/").filter(Boolean).pop() || "",
    }
    const url = getMetaUrl(this, false, srcPhys)
    await requestApi(this, url, "PATCH", data)
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // 与 move 同理：参数是目标项自身路径，不得再拼 name；
    // 目标父目录 = dstPhys 去掉末段，目标名字取 dstPhys 末段，源项路径直接使用 srcPhys。
    const dstParentPath = dstPhys.split("/").slice(0, -1).join("/") || "/"
    const dstUrl = getMetaUrl(this, false, dstParentPath)
    const dstRes = await requestApi<any>(this, dstUrl, "GET")
    const dstId = dstRes.id
    const driveId = dstRes.parentReference?.driveId

    const data = {
      parentReference: {
        id: dstId,
        ...(driveId ? { driveId } : {}),
      },
      name: dstPhys.split("/").filter(Boolean).pop() || "",
    }
    const url = getMetaUrl(this, false, srcPhys, "copy")
    await requestApi(this, url, "POST", data)
  }

  /**
   * 上传单个分块并校验响应。Graph 要求按序上传：只有上一块被接受后才能前进，
   * 因此任何失败都必须抛出，否则会话永远不会提交，而 put() 会以“成功”返回。
   * 5xx / 429 / 408 按官方建议做有限次退避重试；404（会话过期）、416 等直接失败。
   */
  private async uploadChunk(
    uploadUrl: string,
    chunk: Buffer,
    start: number,
    total: number,
  ): Promise<void> {
    const byteSize = chunk.length
    const maxAttempts = 3
    let lastError: Error | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(byteSize),
          "Content-Range": `bytes ${start}-${start + byteSize - 1}/${total}`,
        },
        body: chunk as any,
      })
      if (res.status === 200 || res.status === 201 || res.status === 202) return
      let detail = ""
      try {
        detail = await res.text()
      } catch {}
      lastError = new Error(
        `[OneDriveApp] chunk upload failed: HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      )
      const retryable =
        res.status >= 500 || res.status === 429 || res.status === 408
      if (!retryable || attempt === maxAttempts) break
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 8000)),
      )
    }
    throw lastError || new Error("[OneDriveApp] chunk upload failed")
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    if (content.length <= 4 * 1024 * 1024) {
      const url = getMetaUrl(this, false, physicalPath, "content")
      await requestApi(this, url, "PUT", content)
    } else {
      const url = getMetaUrl(this, false, physicalPath, "createUploadSession")
      const metadata = {
        item: { "@microsoft.graph.conflictBehavior": "rename" },
      }
      const res: any = await requestApi(this, url, "POST", metadata)
      const uploadUrl = res?.uploadUrl
      if (!uploadUrl) {
        throw new Error("failed to get upload URL from response")
      }

      const DEFAULT = chunkSizeBytes(this.chunk_size)
      let finish = 0
      const size = content.length

      while (finish < size) {
        const left = size - finish
        const byteSize = Math.min(left, DEFAULT)
        const chunk = content.slice(finish, finish + byteSize)

        await this.uploadChunk(uploadUrl, chunk, finish, size)
        finish += byteSize
      }
    }
  }

  async getDetails(): Promise<{
    total?: number
    used?: number
    free?: number
  }> {
    if (this.disable_disk_usage) {
      return {}
    }
    const drive = await getDrive(this)
    return {
      total: drive.quota.total,
      used: drive.quota.used,
      free: drive.quota.remaining,
    }
  }

  async getDirectUploadInfo(physicalPath: string) {
    if (!this.enable_direct_upload) {
      throw new Error("Direct upload is not enabled")
    }
    return getDirectUploadInfo(this, physicalPath)
  }
}
