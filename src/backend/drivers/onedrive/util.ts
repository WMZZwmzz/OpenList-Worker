import { Addition, onedriveHostMap } from "./meta"
import { File, Files, Metadata, DriveResp, Host } from "./types"

/**
 * F-316：refresh_token 是长期凭据，放进 GET 查询串会留在第三方与各级代理的
 * 访问日志里。优先用 POST 表单体传递；仅当上游 renew 接口不支持 POST（返回
 * 非 2xx / 非 JSON / 不含 token）时才回退到历史 GET 形态，保证刷新不中断。
 */
async function refreshViaOnlineApi(
  d: Addition & { accessToken?: string },
): Promise<void> {
  const params: Record<string, string> = {
    refresh_ui: d.refresh_token,
    server_use: "true",
    driver_txt: "onedrive_pr",
  }

  let data: any = null
  try {
    const resp = await fetch(d.api_url_address, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    })
    if (resp.ok) {
      data = await resp.json().catch(() => null)
    }
  } catch {
    data = null
  }

  if (!data || !data.refresh_token || !data.access_token) {
    // 兼容旧版 renew 接口（只接受 GET 查询参数）
    const qs = new URLSearchParams(params).toString()
    const resp = await fetch(`${d.api_url_address}?${qs}`)
    data = await resp.json().catch(() => ({}))
  }

  if (!data?.refresh_token || !data?.access_token) {
    if (data?.text) {
      throw new Error(`failed to refresh token: ${data.text}`)
    }
    throw new Error("empty token returned from official API")
  }
  d.accessToken = data.access_token
  d.refresh_token = data.refresh_token
  await (d as any).onTokenUpdate?.(d.refresh_token)
}

/**
 * F-315：驱动实例在同一 isolate 内被所有并发请求共享；token 过期时若每个 401
 * 各自刷新，会并行发出多次刷新并各自走 onTokenUpdate 落库（整库读改写竞态，
 * 旧 token 可能覆盖已轮换的新 token）。这里按驱动实例做 singleflight：
 * 同一实例上并发的刷新只执行一次，其余调用共享同一个 Promise。
 */
const refreshInFlight = new WeakMap<object, Promise<void>>()

export function refreshTokenOnce(
  d: Addition & { accessToken?: string },
): Promise<void> {
  const key = d as unknown as object
  const pending = refreshInFlight.get(key)
  if (pending) return pending
  const task = refreshToken(d).finally(() => {
    refreshInFlight.delete(key)
  })
  refreshInFlight.set(key, task)
  return task
}

export async function refreshToken(
  d: Addition & { accessToken?: string },
): Promise<void> {
  // Use online API
  if (d.use_online_api && d.api_url_address) {
    await refreshViaOnlineApi(d)
    return
  }

  // Use local client
  if (!d.client_id || !d.client_secret) {
    throw new Error("empty ClientID or ClientSecret")
  }

  const hostMap = onedriveHostMap[d.region] || onedriveHostMap["global"]
  const url = `${hostMap.oauth}/common/oauth2/v2.0/token`

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: d.client_id,
      client_secret: d.client_secret,
      redirect_uri: d.redirect_uri,
      refresh_token: d.refresh_token,
    }).toString(),
  })

  // F-318：微软 OAuth 端点失败时返回 HTTP 400 + {error, error_description}
  // （也可能是 HTML 错误页）。必须透出真正原因，而不是笼统的 "Empty token"。
  const text = await resp.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!resp.ok || !data?.refresh_token) {
    const detail = [data?.error, data?.error_description]
      .filter(Boolean)
      .join(": ")
    const reason =
      detail || (text ? text.slice(0, 500) : "") || "empty response"
    throw new Error(`failed to refresh token (HTTP ${resp.status}): ${reason}`)
  }
  d.refresh_token = data.refresh_token
  d.accessToken = data.access_token
  await (d as any).onTokenUpdate?.(d.refresh_token)
}

export async function requestApi<T>(
  d: Addition & { accessToken?: string },
  url: string,
  method: string,
  data?: any,
  noRetry?: boolean,
): Promise<T> {
  const isBinary =
    data !== undefined &&
    (data instanceof Uint8Array ||
      data instanceof ArrayBuffer ||
      (typeof Buffer !== "undefined" && Buffer.isBuffer(data)))

  const init: RequestInit = {
    method: method.toUpperCase(),
    headers: {
      Authorization: `Bearer ${d.accessToken}`,
      ...(data !== undefined
        ? {
            "Content-Type": isBinary
              ? "application/octet-stream"
              : "application/json",
          }
        : {}),
    },
    ...(data !== undefined
      ? { body: isBinary ? (data as any) : JSON.stringify(data) }
      : {}),
  }
  const res = await fetch(url, init)
  if (!res.ok) {
    let errData: any
    try {
      errData = (await res.json()).error
    } catch {
      errData = null
    }
    const errCode = errData?.code
    if (
      (errCode === "InvalidAuthenticationToken" ||
        errCode === "ExpiredAuthenticationToken" ||
        res.status === 401) &&
      !noRetry
    ) {
      await refreshTokenOnce(d)
      return requestApi(d, url, method, data, true)
    }
    throw new Error(errData?.message || `Request failed: ${res.status}`)
  }
  // 204 No Content / 202 Accepted 均为无响应体的成功响应：
  // Graph 的 copy 返回 202 + 空 body（进度由 Location 头监控），
  // 直接 res.json() 会抛 SyntaxError，导致复制成功却报失败。
  if (res.status === 204 || res.status === 202) return undefined as unknown as T
  const text = await res.text()
  if (!text) return undefined as unknown as T
  return JSON.parse(text) as T
}

function cleanSubPath(p: string): string {
  if (!p || p === "/") return "/drive/root"
  const trimmed = p.startsWith("/") ? p.slice(1) : p
  return `/drive/root:/${trimmed}`
}

export function buildUrl(
  api: string,
  reqPath: string,
  suffix?: string,
): string {
  const normalized = reqPath.replace(/\\/g, "/")
  if (!normalized || normalized === "/") {
    if (suffix) {
      return `${api}/drive/root/${suffix}`
    }
    return `${api}/drive/root`
  }
  let trimmed = normalized.startsWith("/") ? normalized.slice(1) : normalized
  if (trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1)
  }
  if (!trimmed || trimmed === "") {
    if (suffix) {
      return `${api}/drive/root/${suffix}`
    }
    return `${api}/drive/root`
  }
  const encoded = trimmed.split("/").map(encodeURIComponent).join("/")
  if (suffix) {
    return `${api}/drive/root:/${encoded}:/${suffix}`
  }
  return `${api}/drive/root:/${encoded}:`
}

export async function getFiles(
  d: Addition & { accessToken?: string },
  reqPath: string,
): Promise<File[]> {
  const hostMap = onedriveHostMap[d.region] || onedriveHostMap["global"]
  const apiBase = d.is_sharepoint
    ? `${hostMap.api}/v1.0/sites/${d.site_id}`
    : `${hostMap.api}/v1.0/me`

  const childrenUrl = buildUrl(
    apiBase,
    reqPath,
    "children?$top=1000&$expand=thumbnails($select=medium)&$select=id,name,size,fileSystemInfo,@microsoft.graph.downloadUrl,file,folder,parentReference",
  )
  let nextLink: string | undefined = childrenUrl

  const res: File[] = []
  while (nextLink) {
    const files: Files = await requestApi(d, nextLink, "GET")
    if (files.value) {
      res.push(...files.value)
    }
    nextLink = files["@odata.nextLink"]
  }
  return res
}

export async function getFile(
  d: Addition & { accessToken?: string },
  reqPath: string,
): Promise<File> {
  const hostMap = onedriveHostMap[d.region] || onedriveHostMap["global"]
  const apiBase = d.is_sharepoint
    ? `${hostMap.api}/v1.0/sites/${d.site_id}`
    : `${hostMap.api}/v1.0/me`

  const url = buildUrl(apiBase, reqPath)
  return requestApi<File>(d, url, "GET")
}

/**
 * F-313：Graph 上传会话要求每个 byte range 必须是 320 KiB（327,680 字节）的
 * 整数倍，否则大文件在最后一块提交时会报错。把配置的 MiB 值取整到最近的
 * 320 KiB 倍数（至少 1 个单元），比直接乘以 1024*1024 更安全。
 */
export function alignChunkBytes(bytes: number): number {
  const UNIT = 320 * 1024
  const units = Math.max(1, Math.round(bytes / UNIT))
  return units * UNIT
}

export function chunkSizeBytes(chunkSizeMb: number | string): number {
  const mb = Number(chunkSizeMb)
  const safeMb = Number.isFinite(mb) && mb > 0 ? mb : 5
  return alignChunkBytes(safeMb * 1024 * 1024)
}

export function toAPIMetadata(
  modTime: Date | null,
  createTime: Date | null,
): Metadata {
  const metadata: Metadata = {
    fileSystemInfo: {},
  }
  if (modTime) {
    metadata.fileSystemInfo!.lastModifiedDateTime = modTime.toISOString()
  }
  if (createTime) {
    metadata.fileSystemInfo!.createdDateTime = createTime.toISOString()
  }
  if (!createTime && modTime) {
    metadata.fileSystemInfo!.createdDateTime = modTime.toISOString()
  }
  return metadata
}

export async function updateMetadata(
  d: Addition & { accessToken?: string },
  reqPath: string,
  metadata: Metadata,
): Promise<void> {
  const hostMap = onedriveHostMap[d.region] || onedriveHostMap["global"]
  const apiBase = d.is_sharepoint
    ? `${hostMap.api}/v1.0/sites/${d.site_id}`
    : `${hostMap.api}/v1.0/me`

  const url = buildUrl(apiBase, reqPath)
  await requestApi(d, url, "PATCH", metadata)
}

export async function getDrive(
  d: Addition & { accessToken?: string },
): Promise<DriveResp> {
  const hostMap = onedriveHostMap[d.region] || onedriveHostMap["global"]
  let api = ""
  if (d.is_sharepoint) {
    api = `${hostMap.api}/v1.0/sites/${d.site_id}/drive`
  } else {
    api = `${hostMap.api}/v1.0/me/drive`
  }
  return requestApi<DriveResp>(d, api, "GET", undefined, true)
}

export async function getDirectUploadInfo(
  d: Addition & { accessToken?: string },
  reqPath: string,
) {
  const hostMap = onedriveHostMap[d.region] || onedriveHostMap["global"]
  const apiBase = d.is_sharepoint
    ? `${hostMap.api}/v1.0/sites/${d.site_id}`
    : `${hostMap.api}/v1.0/me`

  const url = buildUrl(apiBase, reqPath, "createUploadSession")

  const metadata = {
    item: {
      "@microsoft.graph.conflictBehavior": "rename",
    },
  }
  const res: any = await requestApi(d, url, "POST", metadata)
  const uploadUrl = res.uploadUrl
  if (!uploadUrl) {
    throw new Error("failed to get upload URL from response")
  }
  return {
    UploadURL: uploadUrl,
    ChunkSize: chunkSizeBytes(d.chunk_size),
    Method: "PUT",
  }
}
