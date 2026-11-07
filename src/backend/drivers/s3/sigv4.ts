// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/s3
import { DogeCredentials } from "./types"

const encoder = new TextEncoder()

function toBytes(data: string | Uint8Array): any {
  if (typeof data === "string") return encoder.encode(data)
  return data
}

function hexEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }
  return hex
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(data))
  return hexEncode(digest)
}

export async function hmacSha256Raw(
  key: string | Uint8Array,
  data: string | Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, toBytes(data))
  return new Uint8Array(sig)
}

export async function hmacSha256Hex(
  key: string | Uint8Array,
  data: string | Uint8Array,
): Promise<string> {
  const raw = await hmacSha256Raw(key, data)
  return hexEncode(raw)
}

export async function hmacSha1Hex(
  key: string | Uint8Array,
  data: string | Uint8Array,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBytes(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, toBytes(data))
  return hexEncode(sig)
}

export function rfc3986UriEncode(str: string, encodeSlash = true): string {
  let result = encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  )
  if (!encodeSlash) {
    result = result.replace(/%2F/g, "/")
  }
  return result
}

/**
 * F-148：SigV4 的 canonical query string 必须按 RFC 3986 编码——空格编成 %20、
 * 字面 "+" 编成 %2B。URLSearchParams 走的是 application/x-www-form-urlencoded
 * 规则（空格 → "+"），若直接把它 toString() 的结果当作 wire URL，服务端收到的
 * "+" 与签名里的 "%20" 不一致，必然 SignatureDoesNotMatch。
 *
 * 因此 wire 侧也统一用本函数序列化 query，使签名内容与实际发送字节完全一致。
 * 排序规则按 AWS 规范：先比编码后的 key，再比编码后的 value。
 */
export function buildCanonicalQueryString(
  params: Array<[string, string]>,
): string {
  const encoded = params.map(
    ([k, v]) => [rfc3986UriEncode(k), rfc3986UriEncode(v)] as [string, string],
  )
  encoded.sort(([ak, av], [bk, bv]) => {
    if (ak !== bk) return ak < bk ? -1 : 1
    if (av === bv) return 0
    return av < bv ? -1 : 1
  })
  return encoded.map(([k, v]) => `${k}=${v}`).join("&")
}

/**
 * 把 canonical 形式的 query 写回 URL。`URL.search` 的 setter 只做最小转义，
 * 不会把 `%20` 改写成 "+"，因此回写后的 URL 与 canonical query 逐字节一致。
 */
function applyCanonicalQuery(url: URL, canonicalQuery: string): void {
  url.search = canonicalQuery
}

export function formatAmzDates(date: Date = new Date()): {
  amzDate: string
  dateStamp: string
} {
  const pad = (n: number) => n.toString().padStart(2, "0")
  const year = date.getUTCFullYear()
  const month = pad(date.getUTCMonth() + 1)
  const day = pad(date.getUTCDate())
  const hours = pad(date.getUTCHours())
  const minutes = pad(date.getUTCMinutes())
  const seconds = pad(date.getUTCSeconds())

  const dateStamp = `${year}${month}${day}`
  const amzDate = `${dateStamp}T${hours}${minutes}${seconds}Z`
  return { amzDate, dateStamp }
}

export async function getSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string = "s3",
): Promise<Uint8Array> {
  const kSecret = "AWS4" + secretAccessKey
  const kDate = await hmacSha256Raw(kSecret, dateStamp)
  const kRegion = await hmacSha256Raw(kDate, region)
  const kService = await hmacSha256Raw(kRegion, service)
  const kSigning = await hmacSha256Raw(kService, "aws4_request")
  return kSigning
}

export interface SignRequestOptions {
  method: string
  url: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  headers?: Record<string, string>
  body?: string | Uint8Array | null
  service?: string
  date?: Date
}

export async function signS3Headers(
  opts: SignRequestOptions,
): Promise<{ headers: Record<string, string>; url: string }> {
  const {
    method,
    url: rawUrl,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    headers = {},
    body = null,
    service = "s3",
    date = new Date(),
  } = opts

  const parsedUrl = new URL(rawUrl)
  const { amzDate, dateStamp } = formatAmzDates(date)

  const payloadHash =
    body !== null && body !== undefined
      ? await sha256Hex(body)
      : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

  const finalHeaders: Record<string, string> = { ...headers }
  finalHeaders["host"] = parsedUrl.host
  finalHeaders["x-amz-date"] = amzDate
  finalHeaders["x-amz-content-sha256"] = payloadHash
  if (sessionToken) {
    finalHeaders["x-amz-security-token"] = sessionToken
  }

  // Canonical headers
  const sortedHeaderKeys = Object.keys(finalHeaders)
    .map((k) => k.toLowerCase())
    .sort()

  let canonicalHeaders = ""
  for (const k of sortedHeaderKeys) {
    const rawVal = Object.entries(finalHeaders).find(
      ([origKey]) => origKey.toLowerCase() === k,
    )?.[1]
    const val = (rawVal || "").trim().replace(/\s+/g, " ")
    canonicalHeaders += `${k}:${val}\n`
  }

  const signedHeaders = sortedHeaderKeys.join(";")

  // Canonical URI
  // parsedUrl.pathname is already percent-encoded by the URL constructor
  // (e.g. Chinese characters → %E5%B1%8F…). We must decode it first to
  // avoid double-encoding (%→%25) which would produce a wrong signature.
  const rawPathname = parsedUrl.pathname || "/"
  let decodedPathname: string
  try {
    decodedPathname = decodeURIComponent(rawPathname)
  } catch {
    decodedPathname = rawPathname
  }
  const canonicalUri = rfc3986UriEncode(decodedPathname, false)

  // Canonical Query String
  const queryParams: [string, string][] = []
  parsedUrl.searchParams.forEach((val, key) => {
    queryParams.push([key, val])
  })
  const canonicalQueryString = buildCanonicalQueryString(queryParams)
  // F-148：把 canonical query 回写到 wire URL，保证实际请求与签名一致
  //（URLSearchParams 会把空格序列化成 "+"，与签名的 "%20" 不匹配）。
  applyCanonicalQuery(parsedUrl, canonicalQueryString)

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const canonicalRequestHash = await sha256Hex(canonicalRequest)

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n")

  const signingKey = await getSigningKey(
    secretAccessKey,
    dateStamp,
    region,
    service,
  )
  const signature = await hmacSha256Hex(signingKey, stringToSign)

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  finalHeaders["authorization"] = authorizationHeader

  return {
    headers: finalHeaders,
    url: parsedUrl.toString(),
  }
}

export interface PresignUrlOptions {
  method?: string
  url: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  expiresInSeconds?: number
  service?: string
  date?: Date
  customQueryParams?: Record<string, string>
}

export async function presignS3Url(opts: PresignUrlOptions): Promise<string> {
  const {
    method = "GET",
    url: rawUrl,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiresInSeconds = 14400, // 4 hours default
    service = "s3",
    date = new Date(),
    customQueryParams = {},
  } = opts

  const parsedUrl = new URL(rawUrl)
  const { amzDate, dateStamp } = formatAmzDates(date)
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`

  // Base query params for presigned URL。F-148：全部先在 Map 里累积，最后用
  // RFC 3986 规则一次性序列化并回写 URL（而不是 searchParams.set + toString，
  // 后者会把空格编成 "+"，与签名的 "%20" 不一致 → SignatureDoesNotMatch）。
  const queryParams = new Map<string, string>()
  parsedUrl.searchParams.forEach((val, key) => {
    if (key.toLowerCase() !== "x-amz-signature") {
      queryParams.set(key, val)
    }
  })
  queryParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
  queryParams.set("X-Amz-Credential", `${accessKeyId}/${credentialScope}`)
  queryParams.set("X-Amz-Date", amzDate)
  queryParams.set("X-Amz-Expires", expiresInSeconds.toString())
  queryParams.set("X-Amz-SignedHeaders", "host")

  if (sessionToken) {
    queryParams.set("X-Amz-Security-Token", sessionToken)
  }

  for (const [k, v] of Object.entries(customQueryParams)) {
    if (k.toLowerCase() !== "x-amz-signature") {
      queryParams.set(k, v)
    }
  }

  // Same double-encoding fix as in signS3Headers: decode first.
  const rawPathname2 = parsedUrl.pathname || "/"
  let decodedPathname2: string
  try {
    decodedPathname2 = decodeURIComponent(rawPathname2)
  } catch {
    decodedPathname2 = rawPathname2
  }
  const canonicalUri = rfc3986UriEncode(decodedPathname2, false)

  const canonicalQueryString = buildCanonicalQueryString([
    ...queryParams.entries(),
  ])

  const hostHeader = parsedUrl.host
  const canonicalHeaders = `host:${hostHeader}\n`
  const signedHeaders = "host"
  const payloadHash = "UNSIGNED-PAYLOAD"

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const canonicalRequestHash = await sha256Hex(canonicalRequest)
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n")

  const signingKey = await getSigningKey(
    secretAccessKey,
    dateStamp,
    region,
    service,
  )
  const signature = await hmacSha256Hex(signingKey, stringToSign)

  // F-148：签名串用 canonical 形式（%20/%2B），wire URL 必须逐字节相同，
  // 否则服务端按收到的 "+" 重算会得到不同签名。X-Amz-Signature 追加在末尾。
  applyCanonicalQuery(
    parsedUrl,
    canonicalQueryString
      ? `${canonicalQueryString}&X-Amz-Signature=${signature}`
      : `X-Amz-Signature=${signature}`,
  )
  return parsedUrl.toString()
}

/**
 * DogeCloud temporary token generator
 * Endpoint: https://api.dogecloud.com/auth/tmp_token.json
 */
export async function getDogeCredentials(
  accessKey: string,
  secretKey: string,
): Promise<DogeCredentials> {
  const apiPath = "/auth/tmp_token.json"
  const reqBody = JSON.stringify({
    channel: "OSS_FULL",
    scopes: ["*"],
  })

  const signStr = apiPath + "\n" + reqBody
  const sign = await hmacSha1Hex(secretKey, signStr)
  const authorization = `TOKEN ${accessKey}:${sign}`

  const resp = await fetch("https://api.dogecloud.com" + apiPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: reqBody,
  })

  if (!resp.ok) {
    throw new Error(
      `DogeCloud tmp_token request failed with HTTP ${resp.status}`,
    )
  }

  const json: any = await resp.json()
  if (json.code !== 200 || !json.data || !json.data.Credentials) {
    throw new Error(
      `DogeCloud tmp_token error (${json.code}): ${json.msg || "unknown"}`,
    )
  }

  return {
    accessKeyId: json.data.Credentials.accessKeyId,
    secretAccessKey: json.data.Credentials.secretAccessKey,
    sessionToken: json.data.Credentials.sessionToken,
    expiredAt: json.data.ExpiredAt,
  }
}
