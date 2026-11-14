// Cloudreve V4 API 客户端
import { DriverCloudreveAddition, CloudreveFile, CloudreveListResp, CloudreveUrlResp } from "./types"

/**
 * 解包 Cloudreve V4 的统一响应信封 {"code":0,"data":...,"msg":""}（F-456）。
 * - 带信封：code !== 0 抛错，否则返回 data 字段；
 * - 无信封（极少数端点/代理返回裸 JSON）：HTTP 状态 >= 400 抛错，否则原样返回。
 */
export function unwrapEnvelope(
  payload: any,
  status: number,
): any {
  const isEnvelope =
    !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof payload.code === "number"
  if (isEnvelope) {
    if (payload.code !== 0) {
      const msg = payload.msg || payload.message || `code ${payload.code}`
      throw new Error(`[Cloudreve] ${msg}`)
    }
    return payload.data
  }
  if (status >= 400) {
    const msg = payload?.msg || payload?.message || `HTTP ${status}`
    throw new Error(`[Cloudreve] ${msg}`)
  }
  return payload
}

export class ClientCloudreve {
  private address: string
  private addition: DriverCloudreveAddition
  private accessToken = ""

  constructor(addition: DriverCloudreveAddition) {
    this.addition = addition
    this.address = (addition.address || "").replace(/\/+$/, "")
    this.accessToken = addition.access_token || ""
  }

  async init(): Promise<void> {
    if (!this.address) throw new Error("[Cloudreve] address is required")
    if (this.addition.username && this.addition.password) {
      await this.login()
    } else if (this.addition.refresh_token) {
      await this.refreshToken()
    }
  }

  private async login(): Promise<void> {
    const resp = await fetch(`${this.address}/api/v4/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.addition.username,
        password: this.addition.password,
      }),
    })
    const payload: any = await resp.json().catch(() => null)
    const data: any = unwrapEnvelope(payload, resp.status)
    if (data?.token) {
      this.accessToken = data.token
      if (data.refresh_token) this.addition.refresh_token = data.refresh_token
    } else {
      throw new Error("[Cloudreve] login failed")
    }
  }

  private async refreshToken(): Promise<void> {
    const resp = await fetch(`${this.address}/api/v4/session/renew`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.addition.refresh_token}`,
      },
    })
    const payload: any = await resp.json().catch(() => null)
    const data: any = unwrapEnvelope(payload, resp.status)
    if (data?.token) this.accessToken = data.token
  }

  private async request<T = any>(
    method: string,
    endpoint: string,
    body?: any,
    retry = false,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
    }
    if (this.addition.custom_ua) headers["User-Agent"] = this.addition.custom_ua
    const options: RequestInit = { method, headers }
    if (body) options.body = JSON.stringify(body)
    const resp = await fetch(`${this.address}/api/v4${endpoint}`, options)
    const payload: any = await resp.json().catch(() => null)
    const code = payload && typeof payload.code === "number" ? payload.code : undefined
    if ((resp.status === 401 || code === 401) && !retry) {
      if (this.addition.refresh_token) await this.refreshToken()
      else if (this.addition.username) await this.login()
      else throw new Error("[Cloudreve] unauthorized")
      return this.request<T>(method, endpoint, body, true)
    }
    // 无论 HTTP 状态码如何都检查信封 code（上游行为一致），失败不再静默。
    const data = unwrapEnvelope(payload, resp.status)
    if (data === null || data === undefined) return {} as T
    return data as T
  }

  async listFiles(uri: string): Promise<CloudreveFile[]> {
    const all: CloudreveFile[] = []
    let nextToken = ""
    // A-54：重复 token 保护 + 页数上限，避免服务端异常时无限翻页。
    const seenTokens = new Set<string>()
    let pages = 0
    const cleanUri = uri === "/" ? "/" : uri
    do {
      const params: Record<string, string> = {
        page_size: "100",
        uri: cleanUri,
        order_by: this.addition.order_by || "name",
        order_direction: this.addition.order_direction || "asc",
        page: "0",
      }
      if (nextToken) params.next_page_token = nextToken
      const qs = new URLSearchParams(params).toString()
      const resp = await this.request<CloudreveListResp>("GET", `/file?${qs}`)
      if (resp?.files) all.push(...resp.files)
      const next = resp?.pagination?.next_token || ""
      if (next && seenTokens.has(next)) break
      if (next) seenTokens.add(next)
      nextToken = next
      pages++
      if (pages > 1000) break
    } while (nextToken)
    return all
  }

  async getDownloadUrl(uri: string): Promise<string> {
    const resp = await this.request<CloudreveUrlResp>("POST", "/file/url", {
      uris: [uri],
      download: true,
    })
    const url = resp?.urls?.[0]?.url || ""
    if (!url) throw new Error("[Cloudreve] empty download url")
    return url
  }

  async mkdir(parentUri: string, name: string): Promise<void> {
    const uri = `${parentUri.replace(/\/+$/, "")}/${name}`
    await this.request("POST", "/file/create", {
      type: "folder",
      uri,
      error_on_conflict: true,
    })
  }

  async rename(uri: string, newName: string): Promise<void> {
    const idx = uri.lastIndexOf("/")
    const parent = idx >= 0 ? uri.slice(0, idx + 1) : "/"
    const newUri = `${parent}${newName}`
    await this.request("POST", "/file/rename", { uris: [uri], new_uri: newUri })
  }

  async move(uris: string[], dst: string, copy: boolean): Promise<void> {
    await this.request("POST", "/file/move", { uris, dst, copy })
  }

  async remove(uris: string[]): Promise<void> {
    await this.request("DELETE", "/file", {
      uris,
      unlink: false,
      skip_soft_delete: true,
    })
  }
}
