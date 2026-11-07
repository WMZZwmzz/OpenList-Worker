import { StorageDriver, FileItem } from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { onedriveHostMap, Addition } from "./meta"
import { fileToObj } from "./types"

import {
  refreshTokenOnce,
  requestApi,
  getFiles,
  getFile,
  getDrive,
  getDirectUploadInfo,
  buildUrl,
  chunkSizeBytes,
} from "./util"

/**
 * F-314：addition 里的布尔字段可能是字符串（parseAddition 只做 JSON.parse）。
 * 构造函数若用 `!!` 强转，`"false"` / `"0"` 会变成 true，且 init() 里专为
 * 字符串准备的归一化分支永远不可达。这里在入口处就按字符串语义归一化。
 */
export function toBool(
  value: unknown,
  fallback: boolean,
): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const v = value.trim().toLowerCase()
    if (v === "true" || v === "1") return true
    if (v === "false" || v === "0" || v === "") return false
  }
  return fallback
}

export class Onedrive implements StorageDriver {
  // Properties mapped from Addition
  root_folder_path: string = "/"
  region: string = "global"
  is_sharepoint: boolean = false
  use_online_api: boolean = true
  api_url_address: string = "https://api.oplist.org/onedrive/renewapi"
  client_id: string = ""
  client_secret: string = ""
  redirect_uri: string = "https://api.oplist.org/onedrive/callback"
  refresh_token: string = ""
  site_id: string = ""
  chunk_size: number = 5
  custom_host: string = ""
  disable_disk_usage: boolean = false
  enable_direct_upload: boolean = false
  order_by: string = "filename"
  order_direction: string = "asc"

  accessToken: string = ""
  onTokenUpdate?: (token: string) => void | Promise<void>

  constructor(
    addition?: Partial<Addition>,
    onTokenUpdate?: (token: string) => void | Promise<void>,
  ) {
    if (addition) {
      if (addition.root_folder_path !== undefined)
        this.root_folder_path = String(addition.root_folder_path)
      if (addition.region !== undefined) this.region = String(addition.region)
      if (addition.is_sharepoint !== undefined)
        this.is_sharepoint = toBool(addition.is_sharepoint, false)
      if (addition.use_online_api !== undefined)
        this.use_online_api = toBool(addition.use_online_api, true)
      if (addition.api_url_address !== undefined)
        this.api_url_address = String(addition.api_url_address)
      if (addition.client_id !== undefined)
        this.client_id = String(addition.client_id)
      if (addition.client_secret !== undefined)
        this.client_secret = String(addition.client_secret)
      if (addition.redirect_uri !== undefined)
        this.redirect_uri = String(addition.redirect_uri)
      if (addition.refresh_token !== undefined)
        this.refresh_token = String(addition.refresh_token)
      if (addition.site_id !== undefined)
        this.site_id = String(addition.site_id)
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
    // Normalize types from DB addition which might be strings
    if (typeof this.is_sharepoint === "string") {
      this.is_sharepoint =
        (this.is_sharepoint as string).toLowerCase() === "true"
    }
    if (typeof this.use_online_api === "string") {
      this.use_online_api =
        (this.use_online_api as string).toLowerCase() === "true"
    }
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
    if (this.refresh_token) {
      await refreshTokenOnce(this)
    }
  }

  private getMetaUrl(
    isAuth: boolean,
    reqPath: string,
    suffix?: string,
  ): string {
    const hostMap = onedriveHostMap[this.region] || onedriveHostMap["global"]
    if (isAuth) {
      return hostMap.oauth
    }
    const apiBase = this.is_sharepoint
      ? `${hostMap.api}/v1.0/sites/${this.site_id}`
      : `${hostMap.api}/v1.0/me`
    // F-312：段已是 resolvePath 解码后的字面文件名，不能再 decodeURIComponent
    // （会把畸形转义路径中的 `b%20c` 解码成 `b c` 指向另一个对象），
    // 直接复用 list/get 使用的 buildUrl 保持完全一致。
    return buildUrl(apiBase, reqPath, suffix)
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

    const url = this.getMetaUrl(false, parentPath, "children")
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
    const url = this.getMetaUrl(false, physicalPath)
    await requestApi(this, url, "PATCH", data)
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    // physicalPath 是目标项自身的物理路径（op/storage.ts 逐项调用），
    // 参数即目标项路径，不得再拼 name，否则指向 <item>/<name>，DELETE 404 导致对象仍然存在。
    const url = this.getMetaUrl(false, physicalPath)
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
    const dstUrl = this.getMetaUrl(false, dstParentPath)
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
    const url = this.getMetaUrl(false, srcPhys)
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
    const dstUrl = this.getMetaUrl(false, dstParentPath)
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
    const url = this.getMetaUrl(false, srcPhys, "copy")
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
        `[OneDrive] chunk upload failed: HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      )
      const retryable =
        res.status >= 500 || res.status === 429 || res.status === 408
      if (!retryable || attempt === maxAttempts) break
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 8000)),
      )
    }
    throw lastError || new Error("[OneDrive] chunk upload failed")
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    if (content.length <= 4 * 1024 * 1024) {
      // upSmall
      const url = this.getMetaUrl(false, physicalPath, "content")
      await requestApi(this, url, "PUT", content)
    } else {
      // upBig
      const url = this.getMetaUrl(false, physicalPath, "createUploadSession")
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

  /**
   * F-317：enable_direct_upload 之前只被解析/归一化却没有任何消费方，
   * /fs/get_direct_upload_info 对 OneDrive 永远返回 data:null。这里补上
   * 直传凭证签发（与 onedrive_app 对齐），让该配置真正生效。
   */
  async getDirectUploadInfo(
    dstDir: string,
    fileName?: string,
  ): Promise<{ UploadURL: string; ChunkSize: number; Method: string }> {
    if (!this.enable_direct_upload) {
      throw new Error("Direct upload is not enabled")
    }
    const parts = String(dstDir || "")
      .split("/")
      .filter(Boolean)
    const name = fileName || parts.pop() || ""
    const parent = parts.join("/")
    const target = parent ? `/${parent}/${name}` : `/${name}`
    return getDirectUploadInfo(this, target)
  }
}
