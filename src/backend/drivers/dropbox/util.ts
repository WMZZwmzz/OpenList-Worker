import {
  DropboxAddition,
  DropboxFileEntry,
  DropboxListResp,
  DropboxCurrentAccountResp,
  DropboxSpaceUsageResp,
} from "./types"
import { assertSafeUrl } from "../../pkg/http"

/**
 * Dropbox 的参数头。F-335：`Dropbox-API-Arg` 的头值必须是 ByteString，
 * 直接放 JSON.stringify 的结果会让任何非 Latin-1 文件名（中文/emoji…）在
 * fetch 构造请求时抛 TypeError；128-255 区间的字符还会被按单字节发送，
 * UTF-8 语义被破坏。
 *
 * 这里把 JSON 里的非 ASCII 字符转成等价的 `\uXXXX` 转义（JSON 规范内的
 * 合法写法，服务端解析后仍是原始字符），保证头值恒为纯 ASCII，且沿用
 * 官方 `Dropbox-API-Arg` 头名，不依赖任何未文档化的变体。
 */
function toAsciiJson(json: string): string {
  return json.replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  )
}

function apiArgHeader(arg: unknown): Record<string, string> {
  return { "Dropbox-API-Arg": toAsciiJson(JSON.stringify(arg)) }
}

/** 单次 /2/files/upload 的上限（Dropbox 硬限制 150 MiB） */
const SINGLE_UPLOAD_LIMIT = 150 * 1024 * 1024
/** upload_session 的 append 分片：必须是 4 MiB 的倍数（最后一块除外） */
const SESSION_CHUNK_SIZE = 8 * 1024 * 1024

function parseErrorSummary(text: string): string {
  try {
    return String(JSON.parse(text)?.error_summary || "")
  } catch {
    return ""
  }
}

/** Dropbox 错误体形如 {"error":{".tag":"path","path":{".tag":"not_file"}}} */
function parseErrorTag(text: string): string {
  try {
    const data = JSON.parse(text)
    const err = data?.error
    const nested =
      err?.path?.[".tag"] ?? err?.lookup?.[".tag"] ?? err?.[".tag"] ?? ""
    const fromSummary = String(data?.error_summary || "").split("/")[1] || ""
    return String(nested || fromSummary)
  } catch {
    return ""
  }
}

export class DropboxApiClient {
  private addition: DropboxAddition
  private onTokenRefreshed?: (tokens: {
    accessToken: string
    refreshToken: string
  }) => Promise<void>
  private base = "https://api.dropboxapi.com"
  private contentBase = "https://content.dropboxapi.com"
  /** 单次上传上限（可被测试覆盖，默认 Dropbox 的 150 MiB 硬限制） */
  private singleUploadLimit = SINGLE_UPLOAD_LIMIT
  /** upload_session 分片大小（可被测试覆盖，默认 8 MiB） */
  private sessionChunkSize = SESSION_CHUNK_SIZE

  constructor(
    addition: DropboxAddition,
    onTokenRefreshed?: (tokens: {
      accessToken: string
      refreshToken: string
    }) => Promise<void>,
  ) {
    this.addition = addition
    this.onTokenRefreshed = onTokenRefreshed
  }

  async refreshToken(): Promise<void> {
    if (this.addition.use_online_api && this.addition.api_url_address) {
      // F-340：该字段会把 refresh_token 发出去，必须先做 SSRF 校验，
      // 与 aliyundrive_open 的 FIX(H-2) 保持一致。
      assertSafeUrl(this.addition.api_url_address, "Dropbox api_url_address")
      const u = new URL(this.addition.api_url_address)
      u.searchParams.set("refresh_ui", this.addition.refresh_token)
      u.searchParams.set("server_use", "true")
      u.searchParams.set("driver_txt", "dropboxs_go")

      const res = await fetch(u.toString())
      if (!res.ok) {
        throw new Error(`Failed to refresh token: HTTP ${res.status}`)
      }
      const data = (await res.json()) as any
      if (!data.access_token) {
        throw new Error(data.text || "Empty token returned from renew API")
      }
      this.addition.access_token = data.access_token
      if (data.refresh_token) {
        this.addition.refresh_token = data.refresh_token
      }
    } else {
      const url = `${this.base}/oauth2/token`
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.addition.refresh_token,
        client_id: this.addition.client_id || "",
        client_secret: this.addition.client_secret || "",
      })

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Failed to refresh token: HTTP ${res.status} - ${text}`)
      }
      const data = (await res.json()) as any
      this.addition.access_token = data.access_token
      if (data.refresh_token) {
        this.addition.refresh_token = data.refresh_token
      }
    }

    if (this.onTokenRefreshed) {
      await this.onTokenRefreshed({
        accessToken: this.addition.access_token || "",
        refreshToken: this.addition.refresh_token || "",
      })
    }
  }

  async request<T = any>(
    uri: string,
    options: {
      method?: string
      body?: any
      isContentApi?: boolean
      customHeaders?: Record<string, string>
    } = {},
    retry = true,
  ): Promise<T> {
    if (!this.addition.access_token) {
      await this.refreshToken()
    }

    const host = options.isContentApi ? this.contentBase : this.base
    const url = `${host}${uri}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.addition.access_token}`,
      ...options.customHeaders,
    }

    if (this.addition.root_namespace_id) {
      headers["Dropbox-API-Path-Root"] = JSON.stringify({
        ".tag": "root",
        root: this.addition.root_namespace_id,
      })
    }

    let requestBody: any = undefined
    if (options.body !== undefined) {
      if (
        typeof options.body === "object" &&
        !(options.body instanceof Uint8Array) &&
        !(options.body instanceof ArrayBuffer) &&
        !(options.body instanceof ReadableStream)
      ) {
        headers["Content-Type"] = "application/json"
        requestBody = JSON.stringify(options.body)
      } else {
        requestBody = options.body
      }
    }

    const res = await fetch(url, {
      method: options.method || "POST",
      headers,
      body: requestBody,
    })

    if (!res.ok) {
      const text = await res.text()
      const isAuthErr =
        res.status === 401 ||
        text.includes("expired_access_token") ||
        text.includes("invalid_access_token")

      if (retry && isAuthErr) {
        await this.refreshToken()
        return this.request<T>(uri, options, false)
      }

      // F-336：把 Dropbox 的 error_summary/.tag 结构化附加到 Error 上，
      // 供驱动层区分「对象不存在」「是目录」「其它故障」。
      const err = new Error(`Dropbox API error (${res.status}): ${text}`) as Error & {
        status?: number
        tag?: string
        errorSummary?: string
      }
      err.status = res.status
      err.errorSummary = parseErrorSummary(text)
      err.tag = parseErrorTag(text)
      throw err
    }

    const contentType = res.headers.get("content-type") || ""
    if (contentType.includes("application/json")) {
      return (await res.json()) as T
    }
    return (await res.text()) as any
  }

  async init(): Promise<void> {
    if (!this.addition.access_token && this.addition.refresh_token) {
      await this.refreshToken()
    }
    if (!this.addition.root_namespace_id) {
      try {
        const account = await this.getCurrentAccount()
        if (account.root_info?.root_namespace_id) {
          this.addition.root_namespace_id = account.root_info.root_namespace_id
        }
      } catch (e) {
        console.warn("[Dropbox] failed to get root namespace ID:", e)
      }
    }
  }

  async getCurrentAccount(): Promise<DropboxCurrentAccountResp> {
    return this.request<DropboxCurrentAccountResp>(
      "/2/users/get_current_account",
      {
        method: "POST",
        body: null,
      },
    )
  }

  async getSpaceUsage(): Promise<DropboxSpaceUsageResp> {
    return this.request<DropboxSpaceUsageResp>("/2/users/get_space_usage", {
      method: "POST",
      body: null,
    })
  }

  async getFiles(dirPath: string): Promise<DropboxFileEntry[]> {
    const cleanPath = dirPath === "/" || dirPath === "" ? "" : dirPath
    let resp = await this.request<DropboxListResp>("/2/files/list_folder", {
      method: "POST",
      body: {
        path: cleanPath,
        recursive: false,
        include_deleted: false,
        include_has_explicit_shared_members: false,
        include_mounted_folders: true,
        include_non_downloadable_files: false,
        limit: 2000,
      },
    })

    const entries: DropboxFileEntry[] = [...resp.entries]
    while (resp.has_more) {
      resp = await this.request<DropboxListResp>(
        "/2/files/list_folder/continue",
        {
          method: "POST",
          body: { cursor: resp.cursor },
        },
      )
      entries.push(...resp.entries)
    }

    return entries
  }

  /**
   * F-339：get_temporary_link 的响应同时带有 metadata（size、server_modified …），
   * 之前只取 link 丢弃了它，导致 get() 只能返回 size 0 与「当前时间」。
   */
  async getTemporaryLink(
    filePath: string,
  ): Promise<{ link: string; metadata?: DropboxFileEntry }> {
    return this.request<{ link: string; metadata?: DropboxFileEntry }>(
      "/2/files/get_temporary_link",
      {
        method: "POST",
        body: { path: filePath },
      },
    )
  }

  /**
   * F-338：/2/files/upload 单次上限 150 MiB，更大文件必须走
   * upload_session/start + append_v2 + finish。之前一律单次上传，
   * 超过 150 MiB 的文件必然失败。
   */
  async upload(path: string, content: Uint8Array): Promise<void> {
    const commit = {
      path,
      mode: "overwrite",
      autorename: false,
      mute: false,
      strict_conflict: false,
    }

    if (content.length <= this.singleUploadLimit) {
      await this.request("/2/files/upload", {
        method: "POST",
        isContentApi: true,
        customHeaders: {
          ...apiArgHeader(commit),
          "Content-Type": "application/octet-stream",
        },
        body: content,
      })
      return
    }

    const total = content.length
    const firstEnd = Math.min(this.sessionChunkSize, total)
    const started = await this.request<{ session_id: string }>(
      "/2/files/upload_session/start",
      {
        method: "POST",
        isContentApi: true,
        customHeaders: {
          ...apiArgHeader({ close: false }),
          "Content-Type": "application/octet-stream",
        },
        body: content.subarray(0, firstEnd),
      },
    )
    const sessionId = started.session_id
    if (!sessionId) {
      throw new Error("Dropbox upload_session/start returned no session_id")
    }
    let offset = firstEnd

    while (total - offset > this.sessionChunkSize) {
      const end = offset + this.sessionChunkSize
      await this.request("/2/files/upload_session/append_v2", {
        method: "POST",
        isContentApi: true,
        customHeaders: {
          ...apiArgHeader({ cursor: { session_id: sessionId, offset } }),
          "Content-Type": "application/octet-stream",
        },
        body: content.subarray(offset, end),
      })
      offset = end
    }

    await this.request("/2/files/upload_session/finish", {
      method: "POST",
      isContentApi: true,
      customHeaders: {
        ...apiArgHeader({
          cursor: { session_id: sessionId, offset },
          commit,
        }),
        "Content-Type": "application/octet-stream",
      },
      body: content.subarray(offset),
    })
  }

  async createFolder(folderPath: string): Promise<void> {
    await this.request("/2/files/create_folder_v2", {
      method: "POST",
      body: {
        path: folderPath,
        autorename: false,
      },
    })
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    await this.request("/2/files/move_v2", {
      method: "POST",
      body: {
        from_path: fromPath,
        to_path: toPath,
        autorename: false,
        allow_ownership_transfer: false,
        allow_shared_folder: false,
      },
    })
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    await this.request("/2/files/copy_v2", {
      method: "POST",
      body: {
        from_path: fromPath,
        to_path: toPath,
        autorename: false,
        allow_ownership_transfer: false,
        allow_shared_folder: false,
      },
    })
  }

  async delete(filePath: string): Promise<void> {
    await this.request("/2/files/delete_v2", {
      method: "POST",
      body: { path: filePath },
    })
  }
}
