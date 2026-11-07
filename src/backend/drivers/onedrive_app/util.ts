import { Addition, onedriveHostMap } from "./meta"
import { File, Files, DriveResp } from "./types"
import { chunkSizeBytes, buildUrl } from "../onedrive/util"

export function getMetaUrl(
  d: Addition,
  auth: boolean,
  reqPath: string,
  suffix?: string,
): string {
  const hostMap = onedriveHostMap[d.region] || onedriveHostMap["global"]
  if (auth) {
    return hostMap.oauth
  }

  const normalized = reqPath ? reqPath.replace(/\\/g, "/") : ""
  if (!normalized || normalized === "/") {
    if (suffix) {
      return `${hostMap.api}/v1.0/users/${d.email}/drive/root/${suffix}`
    }
    return `${hostMap.api}/v1.0/users/${d.email}/drive/root`
  }

  let trimmed = normalized.startsWith("/") ? normalized.slice(1) : normalized
  if (trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1)
  }

  if (!trimmed || trimmed === "") {
    if (suffix) {
      return `${hostMap.api}/v1.0/users/${d.email}/drive/root/${suffix}`
    }
    return `${hostMap.api}/v1.0/users/${d.email}/drive/root`
  }

  // F-312：段已是解码后的字面文件名，与 onedrive/util.ts 的 buildUrl 一致，
  // 只做 encodeURIComponent，不再 decodeURIComponent（否则含转义序列的名字会错位）。
  return buildUrl(`${hostMap.api}/v1.0/users/${d.email}`, reqPath, suffix)
}

export async function accessToken(
  d: Addition & { accessToken?: string },
): Promise<void> {
  let lastErr: any = null
  for (let i = 0; i < 3; i++) {
    try {
      await _accessToken(d)
      return
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error("Failed to get access token")
}

async function _accessToken(
  d: Addition & { accessToken?: string },
): Promise<void> {
  if (!d.client_id || !d.client_secret) {
    throw new Error("empty client_id or client_secret")
  }
  if (!d.tenant_id) {
    throw new Error("empty tenant_id")
  }

  const hostMap = onedriveHostMap[d.region] || onedriveHostMap["global"]
  const url = `${hostMap.oauth}/${d.tenant_id}/oauth2/token`

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: d.client_id,
    client_secret: d.client_secret,
    resource: `${hostMap.api}/`,
    scope: `${hostMap.api}/.default`,
  }).toString()

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })

  const data = (await resp.json()) as any
  if (data.error) {
    throw new Error(data.error_description || data.error)
  }
  if (!data.access_token) {
    throw new Error("empty token returned from Microsoft identity platform")
  }

  d.accessToken = data.access_token
  ;(d as any).onTokenUpdate?.(d.accessToken)
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
    (typeof data === "string" ||
      data instanceof Uint8Array ||
      data instanceof ArrayBuffer ||
      (typeof Buffer !== "undefined" && Buffer.isBuffer(data)))

  const init: RequestInit = {
    method: method.toUpperCase(),
    headers: {
      Authorization: `Bearer ${d.accessToken}`,
      ...(data !== undefined && !isBinary
        ? { "Content-Type": "application/json" }
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
      await accessToken(d)
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

export async function getFiles(
  d: Addition & { accessToken?: string },
  reqPath: string,
): Promise<File[]> {
  const childrenUrl = getMetaUrl(
    d,
    false,
    reqPath,
    "children?$top=1000&$expand=thumbnails($select=medium)&$select=id,name,size,fileSystemInfo,lastModifiedDateTime,@microsoft.graph.downloadUrl,file,folder,parentReference",
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
  const url = getMetaUrl(d, false, reqPath)
  return requestApi<File>(d, url, "GET")
}

export async function getDrive(
  d: Addition & { accessToken?: string },
): Promise<DriveResp> {
  const hostMap = onedriveHostMap[d.region] || onedriveHostMap["global"]
  const api = `${hostMap.api}/v1.0/users/${d.email}/drive`
  return requestApi<DriveResp>(d, api, "GET", undefined, true)
}

export async function getDirectUploadInfo(
  d: Addition & { accessToken?: string },
  reqPath: string,
) {
  const url = getMetaUrl(d, false, reqPath, "createUploadSession")
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
