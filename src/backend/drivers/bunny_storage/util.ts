// Bunny Storage helpers: URL building, object path normalization, CDN token signing
import { BunnyAddition, BunnyApiError } from "./types"

export const bunnyDefaultEndpoint = "storage.bunnycdn.com"
export const bunnyDefaultPlaceholder = ".openlist"

export function normalizeBaseURL(raw: string, fallback: string): string {
  let s = (raw || "").trim()
  if (!s) s = fallback
  if (!s) throw new Error("empty url")
  if (!s.includes("://")) s = "https://" + s
  const u = new URL(s)
  if (!u.host) throw new Error("invalid url: " + raw)
  u.pathname = u.pathname.replace(/\/+$/, "")
  return u.toString()
}

export function cleanObjectPath(path: string): string {
  if (!path) return "/"
  return "/" + path.replace(/^\/+/, "").split("/").filter(Boolean).join("/")
}

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

async function sha256Bytes(data: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))
}

async function hmacSha256Bytes(key: string, data: string): Promise<ArrayBuffer> {
  const keyMat = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return crypto.subtle.sign("HMAC", keyMat, new TextEncoder().encode(data))
}

function canonicalQuery(params: URLSearchParams): string {
  const keys = Array.from(params.keys())
    .filter((k) => k !== "token" && k !== "expires")
    .sort()
  return keys.map((k) => `${k}=${params.get(k) || ""}`).join("&")
}

export function storageURL(
  addition: BunnyAddition,
  path: string,
  dir: boolean,
): string {
  const endpoint = normalizeBaseURL(
    addition.endpoint,
    bunnyDefaultEndpoint,
  )
  const u = new URL(endpoint)
  const clean = cleanObjectPath(path)
  const zone = (addition.storage_zone_name || "").replace(/^\/+|\/+$/g, "")
  if (clean === "/") {
    u.pathname = `/${zone}/`
  } else {
    u.pathname = `/${zone}/${clean.replace(/^\/+/, "")}`
    if (dir && !u.pathname.endsWith("/")) u.pathname += "/"
  }
  return u.toString()
}

/**
 * F-409：剥离 cdn_base_url path 中的存储挂载前缀。
 *
 * 对应 Go 版 `trimCDNBasePath(u.Path, d.GetStorage().MountPath)`：管理员常把
 * 挂载路径写进 CDN 地址（如 https://cdn.example.com/BS/ 配合挂载 /BS），
 * 此时拼接对象路径前必须先去掉该前缀，否则会生成多一段挂载前缀的错误直链
 * （CDN 404）。
 */
export function trimCDNBasePath(basePath: string, mountPath: string): string {
  const norm = (p: string) =>
    ("/" + String(p || "").split("/").filter(Boolean).join("/")).replace(
      /\/+$/,
      "",
    )
  const base = norm(basePath)
  const mount = norm(mountPath)
  if (!mount || mount === "/") return base
  if (base === mount) return ""
  if (base.endsWith(mount)) {
    return base.slice(0, base.length - mount.length).replace(/\/+$/, "")
  }
  return base
}

export function cdnURL(
  addition: BunnyAddition,
  path: string,
  mountPath = "",
): string {
  const u = new URL(addition.cdn_base_url)
  const clean = cleanObjectPath(path)
  const basePath = trimCDNBasePath(u.pathname.replace(/\/+$/, ""), mountPath)
  if (clean === "/") {
    u.pathname = basePath ? basePath + "/" : "/"
  } else {
    u.pathname = basePath + "/" + clean.replace(/^\/+/, "")
  }
  return u.toString()
}

export async function signCDNURL(
  addition: BunnyAddition,
  rawURL: string,
  clientIP = "",
): Promise<string> {
  const hours = addition.sign_url_expire > 0 ? addition.sign_url_expire : 4
  const expires = Math.floor(Date.now() / 1000) + hours * 3600

  const u = new URL(rawURL)
  const params = canonicalQuery(u.searchParams)
  // F-408：文件名可能含裸 % （"50%off.zip"），decodeURIComponent 会抛
  // URIError 让该文件彻底不可访问。对齐 Go 的 url.PathUnescape 错误回退：
  // 解码失败时用原始 pathname 继续签名。
  let signaturePath = u.pathname
  try {
    signaturePath = decodeURIComponent(u.pathname)
  } catch {
    signaturePath = u.pathname
  }
  const method = (addition.cdn_token_method || "sha256").toLowerCase()
  // F-405：拉取区域开启 "Include Client IP" 时，Bunny 会把客户端 IP 追加到
  // 哈希消息末尾（sha256 与 hmac 两种模式都有）。此前该配置被解析后从未参与
  // 签名，导致所有签名直链 403。
  const ipSuffix = addition.cdn_token_include_ip ? clientIP : ""

  let token: string
  if (method === "hmac_sha256") {
    const mac = await hmacSha256Bytes(
      addition.cdn_token_key,
      signaturePath + String(expires) + params + ipSuffix,
    )
    token = "HS256-" + b64url(mac)
  } else {
    const sum = await sha256Bytes(
      addition.cdn_token_key +
        signaturePath +
        String(expires) +
        params +
        ipSuffix,
    )
    token = b64url(sum)
  }

  u.searchParams.set("token", token)
  u.searchParams.set("expires", String(expires))
  return u.toString()
}

export async function handleBunnyError(res: Response): Promise<void> {
  if (res.ok) return
  const text = (await res.text().catch(() => "")) || ""
  let message = text.trim()
  try {
    const arr = JSON.parse(text) as BunnyApiError[]
    if (arr?.length && arr[0].Message) message = arr[0].Message
  } catch {
    // ignore
  }
  throw new Error(`bunny storage request failed: ${res.status} ${message}`)
}
