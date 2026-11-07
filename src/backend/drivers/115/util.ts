// 115 Open API 客户端
// 协议以官方 115-sdk-go 为准（同时也是 drivers/115open 使用的同一套协议）：
//   - 列表/信息类接口是 GET + query；
//   - 写操作是 POST + x-www-form-urlencoded，参数名为 file_name/file_ids/to_cid/pick_code 等；
//   - 响应信封是 { state, code, message, data }，code 99 或 401 开头表示 token 失效。
import {
  Driver115Addition,
  Cloud115File,
  Cloud115ListResp,
  Cloud115UserInfoResp,
  Cloud115DownResp,
} from "./types"

const API_BASE = "https://proapi.115.com/open"
const PASSPORT_BASE = "https://passportapi.115.com"
const UA = "Mozilla/5.0 115disk/42.0.0.2"

// 文件 API（路径相对 API_BASE）
const ApiFsGetFiles = "/ufile/files"
const ApiFsMkdir = "/folder/add"
const ApiFsUpdate = "/ufile/update"
const ApiFsMove = "/ufile/move"
const ApiFsCopy = "/ufile/copy"
const ApiFsDelete = "/ufile/delete"
const ApiFsDownUrl = "/ufile/downurl"
const ApiUploadInit = "/upload/init"
const ApiUserInfo = "/user/info"
const ApiRefreshToken = `${PASSPORT_BASE}/open/refreshToken`

/** 单页上限（115 Open API 的 limit 上限为 1000） */
const PAGE_SIZE = 1000
/** 分页兜底上限，避免服务端异常时无限翻页 */
const MAX_PAGES = 200

/** 401 开头或 99 的错误码 → token 失效，需要刷新（对应 SDK Is401Started） */
function isAuthError(code: number): boolean {
  return code === 99 || String(code).startsWith("401")
}

/**
 * 115 Open API 的文件对象字段全部是小写（fid/fn/fc/fs/pc/upt/pid，见
 * 115-sdk-go fs.go GetFilesResp_File）。驱动的其余代码统一按大写字段
 * （Cloud115File）工作，因此这里做一次小写 → 大写归一化。
 * 同时兼容个别历史响应形态（n/file_name/name、s/size 等）。
 */
function normalizeFile(raw: any): Cloud115File {
  const rawFc = raw?.fc ?? raw?.Fc ?? raw?.category
  return {
    Fid: String(raw?.fid ?? raw?.Fid ?? raw?.id ?? ""),
    Fn: String(raw?.fn ?? raw?.Fn ?? raw?.n ?? raw?.file_name ?? raw?.name ?? ""),
    Fc: rawFc === undefined || rawFc === null ? "" : String(rawFc),
    FS: Number(raw?.fs ?? raw?.FS ?? raw?.s ?? raw?.size ?? 0) || 0,
    Sha1: raw?.sha1 ?? raw?.Sha1,
    Pc: raw?.pc ?? raw?.Pc ?? raw?.pick_code,
    Thumbnail: raw?.thumb ?? raw?.Thumbnail ?? raw?.thumbnail,
    Upt: raw?.upt ?? raw?.Upt ?? raw?.tu ?? raw?.updated_at,
    Pid: raw?.pid ?? raw?.Pid ?? raw?.cid,
  }
}

export class Client115 {
  private accessToken: string
  private refreshToken: string
  private addition: Driver115Addition
  private rootId: string
  /** 进行中的刷新（singleflight）：并发 401 只刷新一次，避免 refresh_token 轮换后败者报错 */
  private refreshInFlight: Promise<void> | null = null
  private onTokenUpdate?: (accessToken: string) => void | Promise<void>

  constructor(
    addition: Driver115Addition,
    onTokenUpdate?: (accessToken: string) => void | Promise<void>,
  ) {
    this.addition = addition
    this.accessToken = addition.access_token || ""
    this.refreshToken = addition.refresh_token || ""
    this.rootId = addition.root_folder_id || "0"
    this.onTokenUpdate = onTokenUpdate
  }

  getRootFolderId(): string {
    return this.rootId
  }

  async init(): Promise<void> {
    if (!this.accessToken) {
      throw new Error("[115] access_token is required")
    }
    await this.getUserInfo()
  }

  /**
   * 发送一次 Open API 请求。
   * - GET 走 query，POST 走 x-www-form-urlencoded（与 SDK ReqWithForm 一致）；
   * - 非 JSON / HTTP 错误一律抛错，绝不把失败吞成"空成功"；
   * - token 失效时刷新并重试一次（skipAuthRetry 防止无限递归）。
   */
  private async request<T = any>(
    path: string,
    opts: {
      method?: "GET" | "POST"
      query?: Record<string, string | number | undefined>
      form?: Record<string, string | number | undefined>
      base?: string
      skipAuthRetry?: boolean
    } = {},
  ): Promise<T> {
    const { method = "GET", query, form, base = API_BASE } = opts
    const doReq = async (): Promise<any> => {
      const url = new URL(base + path)
      for (const [k, v] of Object.entries(query || {})) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v))
      }
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": UA,
      }
      if (this.accessToken) {
        headers["Authorization"] = `Bearer ${this.accessToken}`
      }
      let body: string | undefined
      if (method === "POST") {
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        const params = new URLSearchParams()
        for (const [k, v] of Object.entries(form || {})) {
          if (v !== undefined && v !== "") params.set(k, String(v))
        }
        body = params.toString()
      }

      let resp: Response
      try {
        resp = await fetch(url.toString(), { method, headers, body })
      } catch (e: any) {
        throw new Error(
          `[115] 网络错误: ${e?.message || String(e)}（${url.pathname}）`,
        )
      }

      const text = await resp.text()
      let data: any
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(
          `[115] 无法解析的上游响应（HTTP ${resp.status}，${url.pathname}）: ${text.slice(0, 200)}`,
        )
      }
      if (!resp.ok && (data?.state !== false || !data?.code)) {
        throw new Error(
          `[115] 上游 HTTP ${resp.status}（${url.pathname}）: ${text.slice(0, 200)}`,
        )
      }
      return data
    }

    const data = await doReq()

    const failed = data?.state === false || data?.state === undefined
    if (failed) {
      const code = Number(data?.code ?? data?.errno ?? data?.errcode ?? 0)
      if (isAuthError(code) && !opts.skipAuthRetry) {
        await this.refreshAccessToken()
        const retry = await this.request<T>(path, {
          ...opts,
          skipAuthRetry: true,
        })
        return retry
      }
      const message =
        data?.message ||
        data?.error ||
        data?.errmsg ||
        (Object.keys(data || {}).length === 0 ? "空响应" : "API error")
      throw new Error(`[115] ${message} (code ${code})`)
    }
    return data as T
  }

  async getUserInfo(): Promise<Cloud115UserInfoResp> {
    return this.request<Cloud115UserInfoResp>(ApiUserInfo)
  }

  /**
   * 刷新 access_token（passportapi/open/refreshToken，form 表单）。
   * 并发调用共享同一个进行中的 Promise（singleflight）。
   */
  async refreshAccessToken(): Promise<void> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.performRefresh().finally(() => {
        this.refreshInFlight = null
      })
    }
    await this.refreshInFlight
  }

  private async performRefresh(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error("[115] refresh_token is required")
    }
    const form = new URLSearchParams()
    form.set("refresh_token", this.refreshToken)
    let resp: Response
    try {
      resp = await fetch(ApiRefreshToken, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
        },
        body: form.toString(),
      })
    } catch (e: any) {
      throw new Error(`[115] refresh token 网络错误: ${e?.message || String(e)}`)
    }
    const text = await resp.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(
        `[115] refresh token 失败（HTTP ${resp.status}，非 JSON 响应）: ${text.slice(0, 200)}`,
      )
    }
    const tokens = data?.data || data
    if (!tokens?.access_token) {
      throw new Error(`[115] refresh token failed: ${text.slice(0, 200)}`)
    }
    this.accessToken = tokens.access_token
    this.addition.access_token = tokens.access_token
    if (tokens.refresh_token) {
      this.refreshToken = tokens.refresh_token
      this.addition.refresh_token = tokens.refresh_token
    }
    await this.onTokenUpdate?.(this.accessToken)
  }

  /** 目录列表：按 count 做 offset 翻页，避免超过 1000 条的目录被静默截断 */
  async getFiles(cid: string): Promise<Cloud115File[]> {
    const result: Cloud115File[] = []
    let offset = 0
    for (let page = 0; page < MAX_PAGES; page++) {
      const resp = await this.request<Cloud115ListResp>(ApiFsGetFiles, {
        query: {
          cid,
          limit: PAGE_SIZE,
          offset,
          asc: this.addition.order_direction === "asc" ? 1 : 0,
          o: this.addition.order_by || "user_utime",
          show_dir: 1,
          cur: 1,
        },
      })
      const rows = Array.isArray(resp?.data)
        ? resp.data
        : Array.isArray(resp?.files)
          ? resp.files
          : []
      const items = rows.map(normalizeFile)
      result.push(...items)
      const count = Number(resp?.count)
      if (items.length === 0) break
      if (Number.isFinite(count) && count > 0 && result.length >= count) break
      if (items.length < PAGE_SIZE) break
      offset += items.length
    }
    return result
  }

  /**
   * 通过路径逐级解析文件夹 ID（缓存由 driver 层管理）。
   * 上游已把 virtualPath 完全解码后作为 physical 传入，这里不能再 decode，
   * 否则字面名含 %XX 的条目会与解码后的同名条目混淆。
   */
  async resolvePathId(
    path: string,
    cache: Map<string, string>,
  ): Promise<string> {
    const clean = path.split("/").filter(Boolean).join("/")
    if (!clean) return this.rootId
    if (cache.has(clean)) return cache.get(clean)!

    const parts = clean.split("/")
    let currentId = this.rootId
    for (let i = 0; i < parts.length; i++) {
      const rawPart = parts[i]
      const files = await this.getFiles(currentId)
      const target = files.find((f) => f.Fn === rawPart || f.Fid === rawPart)
      if (!target) {
        throw new Error(`[115] Path '${rawPart}' not found in '${currentId}'`)
      }
      currentId = target.Fid
      const subPath = "/" + parts.slice(0, i + 1).join("/")
      cache.set(subPath, currentId)
    }
    return currentId
  }

  async mkdir(pid: string, name: string): Promise<void> {
    await this.request(ApiFsMkdir, {
      method: "POST",
      form: { pid, file_name: name },
    })
  }

  async rename(fid: string, name: string): Promise<void> {
    await this.request(ApiFsUpdate, {
      method: "POST",
      form: { file_id: fid, file_name: name },
    })
  }

  /** 移动：SDK 参数为 file_ids（逗号分隔）+ to_cid */
  async move(pid: string, fids: string[]): Promise<void> {
    await this.request(ApiFsMove, {
      method: "POST",
      form: { file_ids: fids.join(","), to_cid: pid },
    })
  }

  /** 复制：SDK 参数为 pid + file_id */
  async copy(pid: string, fids: string[]): Promise<void> {
    await this.request(ApiFsCopy, {
      method: "POST",
      form: { pid, file_id: fids.join(","), no_dupli: "1" },
    })
  }

  /** 删除：SDK 参数为 file_ids（逗号分隔）+ parent_id */
  async remove(fids: string[], parentId = "0"): Promise<void> {
    await this.request(ApiFsDelete, {
      method: "POST",
      form: { file_ids: fids.join(","), parent_id: parentId },
    })
  }

  /** Upload-init probe used by hash-based rapid upload. */
  async uploadInit(opts: {
    fileName: string
    fileSize: number
    target: string
    fileId: string
    preId: string
    signKey?: string
    signVal?: string
  }): Promise<{
    status?: number
    sign_key?: string
    sign_check?: string
    file_id?: string
  }> {
    const resp = await this.request<any>(ApiUploadInit, {
      method: "POST",
      form: {
        file_name: opts.fileName,
        file_size: String(opts.fileSize),
        target: `U_1_${opts.target}`,
        fileid: opts.fileId,
        preid: opts.preId,
        sign_key: opts.signKey || "",
        sign_val: opts.signVal || "",
      },
    })
    return resp?.data || resp || {}
  }

  /**
   * 下载链接：真实响应是 Record<fid, { url: { url } }>（见 drivers/115open），
   * 因此优先按 fid 取值，缺失时才退化到单条记录。
   */
  async getDownloadUrl(pickCode: string, fileId?: string): Promise<string> {
    const resp = await this.request<Cloud115DownResp>(ApiFsDownUrl, {
      method: "POST",
      form: { pick_code: pickCode },
    })
    const data: any = resp?.data || {}
    const entry = fileId && data?.[fileId] ? data[fileId] : Object.values(data)[0]
    const url =
      (entry as any)?.url?.url ||
      (typeof (entry as any)?.url === "string" ? (entry as any).url : "") ||
      (resp as any)?.url ||
      ""
    if (!url) throw new Error("[115] empty download url")
    return url
  }
}
