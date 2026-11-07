// MediaFire API 客户端
import {
  DriverMediafireAddition,
  MediafireApiResp,
  MediafireContent,
  MediafireLinks,
  MediafireFolderCreate,
} from "./types"

const API_BASE = "https://www.mediafire.com/api/1.5"
const HOST_BASE = "https://www.mediafire.com"

export interface MFEntry {
  id: string
  name: string
  size: number
  isDir: boolean
  created: string
  createdUtc?: string
}

export class ClientMediafire {
  private cookie: string
  private sessionToken: string
  private chunkSize: number
  private orderBy: string
  private orderDirection: string

  constructor(addition: DriverMediafireAddition) {
    this.cookie = addition.cookie || ""
    this.sessionToken = addition.session_token || ""
    this.chunkSize = addition.chunk_size || 200
    this.orderBy = addition.order_by || "name"
    this.orderDirection = addition.order_direction || "asc"
  }

  async init(): Promise<void> {
    if (!this.cookie) throw new Error("[MediaFire] cookie is required")
    if (!this.sessionToken) {
      await this.getSessionToken()
    }
  }

  private async postForm<T = any>(
    endpoint: string,
    data: Record<string, string>,
    retried = false,
  ): Promise<T> {
    const form = new URLSearchParams({
      session_token: this.sessionToken,
      response_format: "json",
      ...data,
    })
    const resp = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: this.cookie,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Origin: HOST_BASE,
        Referer: `${HOST_BASE}/`,
      },
      body: form.toString(),
    })

    // F-410：HTTP 状态码与非 JSON 响应都不再被静默当成成功（以前
    // `resp.json().catch(() => ({}))` 会把 5xx / 登录页变成空对象）。
    const text = await resp.text()
    const snippet = text ? text.replace(/\s+/g, " ").slice(0, 200) : "(empty)"
    if (!resp.ok) {
      // F-415：session_token / cookie 失效时 MediaFire 常返回 4xx 或登录页，
      // 重新从 cookie 换一次 session_token 并重试一次。
      if (!retried && (await this.tryRefreshSession())) {
        return this.postForm<T>(endpoint, data, true)
      }
      throw new Error(
        `[MediaFire] HTTP ${resp.status} on ${endpoint}: ${snippet}`,
      )
    }

    let json: any
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      if (!retried && (await this.tryRefreshSession())) {
        return this.postForm<T>(endpoint, data, true)
      }
      throw new Error(
        `[MediaFire] non-JSON response on ${endpoint} (HTTP ${resp.status}): ${snippet}`,
      )
    }

    if (!retried && this.isSessionError(json)) {
      if (await this.tryRefreshSession()) {
        return this.postForm<T>(endpoint, data, true)
      }
    }
    return json as T
  }

  /** 重新换取 session_token；失败时返回 false，让调用方抛出原始错误 */
  private async tryRefreshSession(): Promise<boolean> {
    try {
      await this.getSessionToken()
      return true
    } catch {
      return false
    }
  }

  /** result 形如 "Success" 时才算成功；其余（含缺失）一律视为失败 */
  private isSessionError(json: any): boolean {
    const r = json?.response
    if (!r || r.result === "Success") return false
    const code = String(r.error ?? r.code ?? "")
    const message = String(r.message || "")
    return (
      code === "1271" ||
      /session/i.test(message) ||
      /cookie/i.test(message) ||
      /not\s*logged\s*in/i.test(message)
    )
  }

  private async getSessionToken(): Promise<void> {
    const resp = await fetch(`${HOST_BASE}/application/get_session_token.php`, {
      method: "POST",
      headers: {
        Cookie: this.cookie,
        Origin: HOST_BASE,
        Referer: `${HOST_BASE}/`,
        "Content-Length": "0",
      },
    })
    if (!resp.ok) {
      throw new Error(
        `[MediaFire] failed to get session token: HTTP ${resp.status}`,
      )
    }
    const data: any = await resp.json().catch(() => ({}))
    const token = data?.response?.session_token
    if (!token) throw new Error("[MediaFire] failed to get session token from cookie")
    this.sessionToken = token
  }

  private checkResult(result?: string): void {
    // F-410：result 缺失（undefined/null）以前会被放行，把失败当成功。
    if (result !== "Success") {
      throw new Error(`[MediaFire] API error: ${result || "missing result"}`)
    }
  }

  async list(folderKey: string): Promise<MFEntry[]> {
    const entries: MFEntry[] = []
    let chunk = 1
    let more = true
    while (more) {
      const foldersResp = await this.postForm<MediafireApiResp<MediafireContent>>(
        "/folder/get_content.php",
        {
          folder_key: folderKey,
          content_type: "folders",
          chunk: String(chunk),
          chunk_size: String(this.chunkSize),
          details: "yes",
          order_direction: this.orderDirection,
          order_by: this.orderBy,
          filter: "",
        },
      )
      const filesResp = await this.postForm<MediafireApiResp<MediafireContent>>(
        "/folder/get_content.php",
        {
          folder_key: folderKey,
          content_type: "files",
          chunk: String(chunk),
          chunk_size: String(this.chunkSize),
          details: "yes",
          order_direction: this.orderDirection,
          order_by: this.orderBy,
          filter: "",
        },
      )
      // F-410：list() 以前是唯一不校验 result 的方法，错误响应会被当成空目录。
      this.checkResult(foldersResp.response?.result)
      this.checkResult(filesResp.response?.result)
      const folders = foldersResp.response?.folder_content?.folders || []
      const files = filesResp.response?.folder_content?.files || []
      for (const f of folders) {
        entries.push({
          id: f.folderkey,
          name: f.name,
          size: 0,
          isDir: true,
          created: f.created || "",
          createdUtc: f.created_utc,
        })
      }
      for (const f of files) {
        entries.push({
          id: f.quickkey,
          name: f.filename,
          size: parseInt(f.size, 10) || 0,
          isDir: false,
          created: f.created || "",
          createdUtc: f.created_utc,
        })
      }
      more =
        foldersResp.response?.folder_content?.more_chunks === "yes" ||
        filesResp.response?.folder_content?.more_chunks === "yes"
      chunk++
    }
    return entries
  }

  async getDownloadUrl(quickKey: string): Promise<string> {
    const resp = await this.postForm<MediafireApiResp<MediafireLinks>>("/file/get_links.php", {
      quick_key: quickKey,
      link_type: "direct_download",
    })
    this.checkResult(resp.response?.result)
    const url = resp.response?.links?.[0]?.direct_download || resp.response?.links?.[0]?.normal_download
    if (!url) throw new Error("[MediaFire] no download link found")
    return url
  }

  async mkdir(parentKey: string, name: string): Promise<string> {
    const resp = await this.postForm<MediafireApiResp<MediafireFolderCreate>>(
      "/folder/create.php",
      { parent_key: parentKey, foldername: name },
    )
    this.checkResult(resp.response?.result)
    return resp.response?.folder_key || ""
  }

  async rename(id: string, name: string, isDir: boolean): Promise<void> {
    if (isDir) {
      const resp = await this.postForm<MediafireApiResp<any>>("/folder/update.php", {
        folder_key: id,
        foldername: name,
      })
      this.checkResult(resp.response?.result)
    } else {
      const resp = await this.postForm<MediafireApiResp<any>>("/file/update.php", {
        quick_key: id,
        filename: name,
      })
      this.checkResult(resp.response?.result)
    }
  }

  async move(id: string, dstKey: string, isDir: boolean): Promise<void> {
    if (isDir) {
      const resp = await this.postForm<MediafireApiResp<any>>("/folder/move.php", {
        folder_key_src: id,
        folder_key_dst: dstKey,
      })
      this.checkResult(resp.response?.result)
    } else {
      const resp = await this.postForm<MediafireApiResp<any>>("/file/move.php", {
        quick_key: id,
        folder_key: dstKey,
      })
      this.checkResult(resp.response?.result)
    }
  }

  async copy(id: string, dstKey: string, isDir: boolean): Promise<void> {
    if (isDir) {
      const resp = await this.postForm<MediafireApiResp<any>>("/folder/copy.php", {
        folder_key_src: id,
        folder_key_dst: dstKey,
      })
      this.checkResult(resp.response?.result)
    } else {
      const resp = await this.postForm<MediafireApiResp<any>>("/file/copy.php", {
        quick_key: id,
        folder_key: dstKey,
      })
      this.checkResult(resp.response?.result)
    }
  }

  async remove(id: string, isDir: boolean): Promise<void> {
    if (isDir) {
      const resp = await this.postForm<MediafireApiResp<any>>("/folder/delete.php", {
        folder_key: id,
      })
      this.checkResult(resp.response?.result)
    } else {
      const resp = await this.postForm<MediafireApiResp<any>>("/file/delete.php", {
        quick_key: id,
      })
      this.checkResult(resp.response?.result)
    }
  }
}
