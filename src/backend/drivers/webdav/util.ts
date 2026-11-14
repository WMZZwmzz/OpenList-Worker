import CryptoJS from "crypto-js"
import { randomHex } from "../rand"
import { WebdavAddition, WebdavFile, WebdavLinkResult } from "./types"

export function fixSlash(s: string): string {
  if (!s.endsWith("/")) {
    s += "/"
  }
  return s
}

export function fixSlashes(s: string): string {
  if (!s.startsWith("/")) {
    s = "/" + s
  }
  return fixSlash(s)
}

export function joinPath(path0: string, path1: string): string {
  const p0 = path0.replace(/\/+$/, "")
  const p1 = path1.replace(/^\/+/, "")
  if (!p0 && !p1) return "/"
  if (!p0) return "/" + p1
  if (!p1) return p0
  return `${p0}/${p1}`
}

export function pathEscape(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
}

/**
 * 释放未被消费的响应体，避免连接一直挂到 GC（Cloudflare Workers 下未消费的
 * body 会占住子请求/连接配额）。cancel 失败不影响主流程。
 */
async function discardBody(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel()
  } catch {
    // ignore: body 可能已被消费或已关闭
  }
}

/**
 * Decode XML predefined entities and numeric character references.
 * F-239 / 上游 #140：multistatus 里的文本值必须做 XML 实体解码。正则抽取的
 * displayname / href 原样保留 `&amp;`，会得到 `a&amp;b.txt` 这种名字，后续
 * 所有路径操作都打到不存在的远端路径（stat/MOVE/DELETE 全 404）。
 *
 * 单遍回调查表，避免 `&amp;lt;` 这类输入被二次解码。
 */
export function decodeXmlEntities(s: string): string {
  return s.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
    (m) => {
      if (m === "&amp;") return "&"
      if (m === "&lt;") return "<"
      if (m === "&gt;") return ">"
      if (m === "&quot;") return '"'
      if (m === "&apos;") return "'"
      const hex = /^&#x/i.test(m)
      const num = hex ? m.slice(3, -1) : m.slice(2, -1)
      const code = hex ? parseInt(num, 16) : parseInt(num, 10)
      // Keep the reference verbatim unless the code point is a valid XML 1.0
      // Char (#x9/#xA/#xD, #x20-#xD7FF, #xE000-#xFFFD, #x10000-#x10FFFF).
      // XML-invalid points (NUL, #xFFFF non-characters, surrogates, out of
      // range) would otherwise poison the parsed name/path, and out-of-range
      // values would crash the parse with a RangeError.
      if (
        Number.isNaN(code) ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === 0xfffe ||
        code === 0xffff ||
        (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd)
      ) {
        return m
      }
      return String.fromCodePoint(code)
    },
  )
}

/**
 * Robust WebDAV XML Multistatus parser.
 * Handles diverse namespace prefixes (d:, D:, a:, xmlns="DAV:") and case variations.
 */
export function parseMultistatusXml(
  xml: string,
  targetPath: string,
): { self?: WebdavFile; items: WebdavFile[] } {
  const items: WebdavFile[] = []
  let selfItem: WebdavFile | undefined

  // Regex to extract all <...response> ... </...response> blocks
  const responseRegex =
    /<(?:[a-zA-Z0-9_-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?response>/gi
  let respMatch: RegExpExecArray | null

  while ((respMatch = responseRegex.exec(xml)) !== null) {
    const respBlock = respMatch[1]

    // Extract href
    const hrefMatch =
      /<(?:[a-zA-Z0-9_-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?href>/i.exec(
        respBlock,
      )
    if (!hrefMatch) continue
    const rawHref = hrefMatch[1].trim()
    // XML-unescape first: the upstream XML-escapes the href text. Decoding XML
    // entities before percent-decoding avoids double-decoding a percent-encoded
    // literal entity (e.g. `%26amp%3B` must stay `&amp;`, not become `&`);
    // XML decoding never produces `%`, so the order is safe.
    const xmlDecodedHref = decodeXmlEntities(rawHref)
    let decodedHref = xmlDecodedHref
    try {
      decodedHref = decodeURIComponent(xmlDecodedHref)
    } catch {
      // ignore URI decode error; keep the XML-decoded text
    }

    // Extract propstat with 200 OK
    const propstatRegex =
      /<(?:[a-zA-Z0-9_-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?propstat>/gi
    let propstatMatch: RegExpExecArray | null
    let propContent = ""

    while ((propstatMatch = propstatRegex.exec(respBlock)) !== null) {
      const psBlock = propstatMatch[1]
      const statusMatch =
        /<(?:[a-zA-Z0-9_-]+:)?status\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?status>/i.exec(
          psBlock,
        )
      const statusText = statusMatch ? statusMatch[1] : ""
      if (
        statusText.includes("200") ||
        statusText.toLowerCase().includes("ok")
      ) {
        const propMatch =
          /<(?:[a-zA-Z0-9_-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?prop>/i.exec(
            psBlock,
          )
        if (propMatch) {
          propContent = propMatch[1]
          break
        }
      }
    }

    if (!propContent) continue

    // Extract isFolder from resourcetype
    const isFolder =
      /<(?:[a-zA-Z0-9_-]+:)?resourcetype\b[^>]*>[\s\S]*?<(?:[a-zA-Z0-9_-]+:)?collection\b/i.test(
        propContent,
      )

    // Extract displayname
    const dnMatch =
      /<(?:[a-zA-Z0-9_-]+:)?displayname\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?displayname>/i.exec(
        propContent,
      )
    let displayName = dnMatch ? decodeXmlEntities(dnMatch[1].trim()) : ""

    // Derive name from href if displayname is missing or is pure path
    const cleanHref = decodedHref.replace(/\/+$/, "")
    const hrefBaseName = cleanHref ? cleanHref.split("/").pop() || "" : ""
    // F-241：注释承诺「displayname 缺失或是纯路径时回退 href basename」，
    // 原实现只做了缺失回退。有的服务器把 displayname 写成完整路径
    //（/dav/file.txt），直接当 name 会拼出 /dav/dav/file.txt 的双重前缀。
    if (
      displayName &&
      (displayName === decodedHref ||
        displayName.replace(/\/+$/, "") === cleanHref ||
        displayName.includes("/"))
    ) {
      displayName = ""
    }
    const name = displayName || hrefBaseName

    // Extract content length (size)
    const lenMatch =
      /<(?:[a-zA-Z0-9_-]+:)?getcontentlength\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?getcontentlength>/i.exec(
        propContent,
      )
    const size = isFolder
      ? 0
      : lenMatch
        ? parseInt(lenMatch[1].trim(), 10) || 0
        : 0

    // Extract last modified
    const modMatch =
      /<(?:[a-zA-Z0-9_-]+:)?getlastmodified\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?getlastmodified>/i.exec(
        propContent,
      )
    let modified = new Date().toISOString()
    if (modMatch) {
      const parsedDate = new Date(modMatch[1].trim())
      if (!isNaN(parsedDate.getTime())) {
        modified = parsedDate.toISOString()
      }
    }

    // Extract content type & etag
    const ctMatch =
      /<(?:[a-zA-Z0-9_-]+:)?getcontenttype\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?getcontenttype>/i.exec(
        propContent,
      )
    const contentType = ctMatch ? ctMatch[1].trim() : undefined

    const etagMatch =
      /<(?:[a-zA-Z0-9_-]+:)?getetag\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?getetag>/i.exec(
        propContent,
      )
    const etag = etagMatch
      ? etagMatch[1].trim().replace(/^"|"$/g, "")
      : undefined

    const file: WebdavFile = {
      name,
      path: decodedHref,
      size,
      modified,
      isFolder,
      contentType,
      etag,
    }

    // Check if this response represents the directory itself
    const normTarget = targetPath.replace(/\/+$/, "").toLowerCase()
    const normHref = cleanHref.toLowerCase()

    // F-240：normTarget 为空（targetPath 为 "/"）时 `endsWith("")` 恒真，会把
    // 首个 response 无条件当成目录自身吞掉。空 target 只匹配空 href。
    const isSelf =
      normTarget === ""
        ? normHref === ""
        : normHref === normTarget || normHref.endsWith(normTarget)

    if (!selfItem && isSelf) {
      selfItem = file
    } else {
      items.push(file)
    }
  }

  return { self: selfItem, items }
}

/**
 * Digest Auth Support
 */
interface DigestParts {
  realm?: string
  nonce?: string
  qop?: string
  opaque?: string
  algorithm?: string
}

export function parseDigestChallenge(header: string): DigestParts {
  const parts: DigestParts = {}
  // F-238：auth-param 必须按 RFC 2617 语法解析——引号内的逗号不是分隔符
  //（realm="My Realm, Admin"），键名不区分大小写（Realm=/QOP= 同样有效）。
  const matchParts = splitAuthParams(header.replace(/^digest\s+/i, ""))
  for (const part of matchParts) {
    const eqIdx = part.indexOf("=")
    if (eqIdx !== -1) {
      const key = part.slice(0, eqIdx).trim().toLowerCase()
      const val = unquoteAuthValue(part.slice(eqIdx + 1).trim())
      if (key === "realm") parts.realm = val
      else if (key === "nonce") parts.nonce = val
      else if (key === "qop") parts.qop = val
      else if (key === "opaque") parts.opaque = val
      else if (key === "algorithm") parts.algorithm = val
    }
  }
  return parts
}

/** 按逗号切分，但跳过双引号内的逗号（支持反斜杠转义） */
function splitAuthParams(input: string): string[] {
  const out: string[] = []
  let current = ""
  let inQuotes = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === "\\" && inQuotes && i + 1 < input.length) {
      current += ch + input[i + 1]
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
      continue
    }
    if (ch === "," && !inQuotes) {
      out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

function unquoteAuthValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1")
  }
  return value
}

/**
 * F-237：RFC 7616 的 SHA-256 / SHA-512（及其 -sess 变体）必须真正参与计算。
 * 原实现只处理 MD5 系列，其它算法把 ha1 留空后仍用 MD5 计算 response，
 * 对只提供 SHA-256 Digest 的服务器必然 401（存储整体不可用）。
 */
function resolveDigestHash(algorithm: string): {
  hash: (input: string) => string
  sess: boolean
} {
  const alg = algorithm.toUpperCase()
  const sess = alg.endsWith("-SESS")
  const base = sess ? alg.slice(0, -"-SESS".length) : alg
  switch (base) {
    case "MD5":
      return { hash: (v) => CryptoJS.MD5(v).toString(), sess }
    case "SHA-256":
      return { hash: (v) => CryptoJS.SHA256(v).toString(), sess }
    case "SHA-512":
      return { hash: (v) => CryptoJS.SHA512(v).toString(), sess }
    default:
      // 不支持的算法必须响亮失败，不能再用空 ha1 发一次注定 401 的请求。
      throw new Error(
        `[WebDAV] Unsupported Digest algorithm "${algorithm}"; ` +
          `use Basic auth or a server offering MD5 / SHA-256 / SHA-512 Digest`,
      )
  }
}

/**
 * F-238：qop 是服务端提供的可选项列表，客户端应选一个自己实现的值。
 * 只实现了 `auth`（没有 body 可算 auth-int），列表里没有 auth 就明确报错，
 * 而不是声明 qop=auth-int 却发一个空 ha2。
 */
function selectDigestQop(raw?: string): "" | "auth" {
  const options = (raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (!options.length) return ""
  if (options.includes("auth")) return "auth"
  throw new Error(
    `[WebDAV] Unsupported Digest qop "${raw}" (only "auth" is implemented)`,
  )
}

export function computeDigestAuth(
  parts: DigestParts,
  username: string,
  password: string,
  method: string,
  uri: string,
  nc: number = 1,
): string {
  const ncStr = nc.toString(16).padStart(8, "0")
  // S-04：Digest 认证的 cnonce 必须用 CSPRNG（原 Math.random）。
  const cnonce = randomHex(16)
  const realm = parts.realm || ""
  const nonce = parts.nonce || ""
  const algorithm = (parts.algorithm || "MD5").toUpperCase()
  const qop = selectDigestQop(parts.qop)
  const { hash, sess } = resolveDigestHash(algorithm)

  let ha1 = hash(`${username}:${realm}:${password}`)
  if (sess) {
    ha1 = hash(`${ha1}:${nonce}:${cnonce}`)
  }

  // ha2 对 qop=auth 与 RFC 2069（无 qop）都是 H(method:uri)
  const ha2 = hash(`${method}:${uri}`)

  const response = qop
    ? hash(`${ha1}:${nonce}:${ncStr}:${cnonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${nonce}:${ha2}`)

  let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`
  if (algorithm) {
    authHeader += `, algorithm=${algorithm}`
  }
  if (qop) {
    authHeader += `, qop=${qop}, nc=${ncStr}, cnonce="${cnonce}"`
  }
  if (parts.opaque) {
    authHeader += `, opaque="${parts.opaque}"`
  }
  return authHeader
}

/**
 * SharePoint SAML Auth via SOAP
 */
const SHAREPOINT_LOGIN_URLS: Record<string, string> = {
  com: "https://login.microsoftonline.com",
  cn: "https://login.chinacloudapi.cn",
  us: "https://login.microsoftonline.us",
  de: "https://login.microsoftonline.de",
}

export async function getSharepointCookie(
  username: string,
  password: string,
  siteUrl: string,
): Promise<string> {
  const urlObj = new URL(siteUrl)
  const hostParts = urlObj.hostname.split(".")
  const tld = hostParts[hostParts.length - 1]
  const loginBase =
    SHAREPOINT_LOGIN_URLS[tld] || "https://login.microsoftonline.com"
  const loginUrl = `${loginBase}/extSTS.srf`

  const samlRequest = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
xmlns:a="http://www.w3.org/2005/08/addressing"
xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
<s:Header>
<a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/02/trust/RST/Issue</a:Action>
<a:ReplyTo>
<a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address>
</a:ReplyTo>
<a:To s:mustUnderstand="1">${loginUrl}</a:To>
<o:Security s:mustUnderstand="1"
 xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
<o:UsernameToken>
  <o:Username>${username.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</o:Username>
  <o:Password>${password.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</o:Password>
</o:UsernameToken>
</o:Security>
</s:Header>
<s:Body>
<t:RequestSecurityToken xmlns:t="http://schemas.xmlsoap.org/ws/2005/02/trust">
<wsp:AppliesTo xmlns:wsp="http://schemas.xmlsoap.org/ws/2004/09/policy">
  <a:EndpointReference>
    <a:Address>${siteUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</a:Address>
  </a:EndpointReference>
</wsp:AppliesTo>
<t:KeyType>http://schemas.xmlsoap.org/ws/2005/05/identity/NoProofKey</t:KeyType>
<t:RequestType>http://schemas.xmlsoap.org/ws/2005/02/trust/Issue</t:RequestType>
<t:TokenType>urn:oasis:names:tc:SAML:1.0:assertion</t:TokenType>
</t:RequestSecurityToken>
</s:Body>
</s:Envelope>`

  const tokenResp = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
    body: samlRequest,
  })

  if (!tokenResp.ok) {
    throw new Error(`SharePoint SAML auth failed with HTTP ${tokenResp.status}`)
  }

  const tokenXml = await tokenResp.text()
  const tokenMatch =
    /<(?:[a-zA-Z0-9_-]+:)?BinarySecurityToken\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?BinarySecurityToken>/i.exec(
      tokenXml,
    )

  if (!tokenMatch) {
    // Check if error response
    const faultMatch =
      /<(?:[a-zA-Z0-9_-]+:)?Text\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?Text>/i.exec(
        tokenXml,
      )
    const errText = faultMatch
      ? faultMatch[1]
      : "Failed to obtain BinarySecurityToken"
    throw new Error(`SharePoint login failed: ${errText}`)
  }

  const binaryToken = tokenMatch[1].trim()
  const signinUrl = `https://${urlObj.host}/_forms/default.aspx?wa=wsignin1.0`

  const signinResp = await fetch(signinUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: binaryToken,
    redirect: "manual",
  })

  let rtFa = ""
  let fedAuth = ""

  // Extract set-cookie
  const getCookies = (resp: Response) => {
    const rawCookies: string[] = []
    if (resp.headers.getSetCookie) {
      rawCookies.push(...resp.headers.getSetCookie())
    } else {
      const sc = resp.headers.get("set-cookie")
      if (sc) rawCookies.push(sc)
    }
    for (const c of rawCookies) {
      const matchRtFa = /rtFa=([^;]+)/.exec(c)
      if (matchRtFa) rtFa = matchRtFa[1]
      const matchFed = /FedAuth=([^;]+)/.exec(c)
      if (matchFed) fedAuth = matchFed[1]
    }
  }

  getCookies(signinResp)

  if (!rtFa || !fedAuth) {
    // Some endpoints may redirect once more
    const location = signinResp.headers.get("location")
    if (location) {
      const redirectUrl = new URL(location, signinUrl).toString()
      const followResp = await fetch(redirectUrl, {
        method: "GET",
        headers: {
          Cookie: `rtFa=${rtFa}; FedAuth=${fedAuth}`,
        },
        redirect: "manual",
      })
      getCookies(followResp)
    }
  }

  // F-242：重定向补取分支要求两个 cookie 齐全（`!rtFa || !fedAuth`），
  // 最终检查也必须同样苛刻——只拿到一个就返回 `rtFa=; FedAuth=xxx` 这种
  // 半套凭据，SharePoint 会一直 401 且没有重试路径，存储持续不可用。
  if (!rtFa || !fedAuth) {
    throw new Error(
      "SharePoint auth failed: rtFa / FedAuth cookies not returned",
    )
  }

  return `rtFa=${rtFa}; FedAuth=${fedAuth}`
}

/**
 * WebDAV HTTP Client
 */
export class WebdavClient {
  private address: string
  private username: string
  private password: string
  private isSharepoint: boolean
  private sharepointCookie: string = ""
  private digestParts: DigestParts | null = null
  private ncCount: number = 0

  constructor(addition: WebdavAddition) {
    this.address = addition.address.replace(/\/+$/, "")
    this.username = addition.username || ""
    this.password = addition.password || ""
    this.isSharepoint = addition.vendor === "sharepoint"
  }

  async init(): Promise<void> {
    if (this.isSharepoint) {
      this.sharepointCookie = await getSharepointCookie(
        this.username,
        this.password,
        this.address,
      )
    }
  }

  private buildUrl(remotePath: string): string {
    const cleanPath = remotePath.replace(/^\/+/, "")
    if (!cleanPath) return this.address
    return `${this.address}/${pathEscape(cleanPath)}`
  }

  /**
   * self 判定用的路径必须包含服务器看到的完整 URL 路径（含 address 的
   * base path）。之前传的是虚拟 remotePath，根目录时它是 "/"，归一为空串后
   * `endsWith("")` 恒真，会把首个 response 当成目录自身吞掉（F-240）。
   */
  private selfTargetPath(remotePath: string): string {
    try {
      const url = new URL(this.buildUrl(remotePath))
      try {
        return decodeURIComponent(url.pathname)
      } catch {
        return url.pathname
      }
    } catch {
      return remotePath
    }
  }

  private getAuthHeaders(method: string, uri: string): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.isSharepoint && this.sharepointCookie) {
      headers["Cookie"] = this.sharepointCookie
    } else if (this.digestParts) {
      this.ncCount++
      headers["Authorization"] = computeDigestAuth(
        this.digestParts,
        this.username,
        this.password,
        method,
        uri,
        this.ncCount,
      )
    } else if (this.username || this.password) {
      const basicToken = btoa(
        unescape(encodeURIComponent(`${this.username}:${this.password}`)),
      )
      headers["Authorization"] = `Basic ${basicToken}`
    }
    return headers
  }

  private async request(
    method: string,
    remotePath: string,
    options: {
      headers?: Record<string, string>
      body?: BodyInit | null
      redirect?: RequestRedirect
    } = {},
  ): Promise<Response> {
    const fullUrl = this.buildUrl(remotePath)
    const origin = new URL(fullUrl).origin

    // A-74：不再用 redirect:"follow" 让运行时自动跟随——Basic/Digest/Cookie
    // 会随重定向被发往新 host。这里手动跟随，但只允许同源跳转（最多 5 跳）。
    let currentUrl = fullUrl
    let currentMethod = method
    let currentBody = options.body
    let headers: Record<string, string> = {}
    let resp!: Response
    for (let hop = 0; hop <= 5; hop++) {
      const urlObj = new URL(currentUrl)
      const uri = urlObj.pathname + urlObj.search
      headers = {
        ...this.getAuthHeaders(currentMethod, uri),
        ...(options.headers || {}),
      }
      resp = await fetch(currentUrl, {
        method: currentMethod,
        headers,
        body: currentBody,
        redirect: "manual",
      })
      if (![301, 302, 303, 307, 308].includes(resp.status)) break
      const location = resp.headers.get("location")
      if (!location) break
      const next = new URL(location, currentUrl)
      if (next.origin !== origin) {
        throw new Error(
          `WebDAV redirect blocked: cross-origin redirect to ${next.origin}`,
        )
      }
      if (hop === 5) throw new Error("WebDAV redirect loop (too many redirects)")
      currentUrl = next.toString()
      if (
        resp.status === 303 ||
        ((resp.status === 301 || resp.status === 302) &&
          currentMethod !== "GET" &&
          currentMethod !== "HEAD")
      ) {
        currentMethod = "GET"
        currentBody = null
      }
    }

    // Handle 401 Digest Auth negotiation
    if (resp.status === 401 && !this.isSharepoint) {
      const wwwAuth = resp.headers.get("www-authenticate") || ""
      if (/digest/i.test(wwwAuth)) {
        this.digestParts = parseDigestChallenge(wwwAuth)
        this.ncCount = 1
        const urlObj = new URL(currentUrl)
        const uri = urlObj.pathname + urlObj.search
        const retryAuth = computeDigestAuth(
          this.digestParts,
          this.username,
          this.password,
          currentMethod,
          uri,
          this.ncCount,
        )
        const retryHeaders = {
          ...headers,
          Authorization: retryAuth,
        }
        resp = await fetch(currentUrl, {
          method: currentMethod,
          headers: retryHeaders,
          body: currentBody,
          redirect: "manual",
        })
      }
    }

    return resp
  }

  /**
   * PROPFIND - List directory contents (Depth: 1)
   */
  async readDir(remotePath: string): Promise<WebdavFile[]> {
    const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getetag/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`

    const resp = await this.request("PROPFIND", remotePath, {
      headers: {
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
        Accept: "application/xml, text/xml",
      },
      body: propfindXml,
    })

    if (resp.status === 404) {
      throw new Error(`Directory not found: ${remotePath}`)
    }

    if (resp.status !== 207 && !resp.ok) {
      const errText = await resp.text()
      throw new Error(
        `WebDAV PROPFIND failed with status ${resp.status}: ${errText || resp.statusText}`,
      )
    }

    const xml = await resp.text()
    const { items } = parseMultistatusXml(xml, this.selfTargetPath(remotePath))
    return items
  }

  /**
   * PROPFIND - Stat single file or directory (Depth: 0)
   */
  async stat(remotePath: string): Promise<WebdavFile> {
    const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getetag/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`

    const resp = await this.request("PROPFIND", remotePath, {
      headers: {
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
        Accept: "application/xml, text/xml",
      },
      body: propfindXml,
    })

    if (resp.status === 404) {
      throw new Error(`Object not found: ${remotePath}`)
    }

    if (resp.status !== 207 && !resp.ok) {
      const errText = await resp.text()
      throw new Error(
        `WebDAV PROPFIND failed with status ${resp.status}: ${errText || resp.statusText}`,
      )
    }

    const xml = await resp.text()
    const { self, items } = parseMultistatusXml(
      xml,
      this.selfTargetPath(remotePath),
    )
    const result = self || items[0]
    if (!result) {
      throw new Error(`Object not found in PROPFIND response: ${remotePath}`)
    }
    return result
  }

  /**
   * MKCOL - Create directory
   */
  async mkdir(remotePath: string): Promise<void> {
    const resp = await this.request("MKCOL", remotePath)
    if (resp.status === 201 || resp.status === 405) {
      return
    }
    throw new Error(`WebDAV MKCOL failed with status ${resp.status}`)
  }

  /**
   * Recursive directory creation (mkdir -p)
   */
  async mkdirAll(remotePath: string): Promise<void> {
    const resp = await this.request("MKCOL", remotePath)
    if (resp.status === 201 || resp.status === 405) {
      return
    }
    if (resp.status === 409) {
      const parts = remotePath.split("/").filter(Boolean)
      let current = ""
      for (const part of parts) {
        current += "/" + part
        const subResp = await this.request("MKCOL", current)
        if (subResp.status !== 201 && subResp.status !== 405) {
          throw new Error(
            `WebDAV MkdirAll failed at ${current} with status ${subResp.status}`,
          )
        }
      }
      return
    }
    throw new Error(`WebDAV MkdirAll failed with status ${resp.status}`)
  }

  /**
   * MOVE - Move / Rename
   */
  async move(
    oldPath: string,
    newPath: string,
    overwrite: boolean = true,
  ): Promise<void> {
    await this.transferWithParentRetry("MOVE", oldPath, newPath, overwrite)
  }

  /**
   * COPY - Copy
   */
  async copy(
    oldPath: string,
    newPath: string,
    overwrite: boolean = true,
  ): Promise<void> {
    await this.transferWithParentRetry("COPY", oldPath, newPath, overwrite)
  }

  /**
   * MOVE/COPY 共用的「父目录缺失（409）→ mkdirAll → 重试一次」流程。
   *
   * F-236：原实现是 409 时 `return this.move(...)` 的无界递归——服务器持续
   * 返回 409（目标进自身子树、源被锁等）而 MKCOL 正常时，每轮 2 个请求无限
   * 循环，直接打爆 Workers 的子请求配额 / 挂死 Node 请求。这里改成显式计数：
   * 只补建一次父目录，第二次仍是 409 就抛错，与同文件 put() 的有界重试一致。
   */
  private async transferWithParentRetry(
    method: "MOVE" | "COPY",
    oldPath: string,
    newPath: string,
    overwrite: boolean,
  ): Promise<void> {
    const maxAttempts = 2
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const destUrl = this.buildUrl(newPath)
      const resp = await this.request(method, oldPath, {
        headers: {
          Destination: destUrl,
          Overwrite: overwrite ? "T" : "F",
        },
      })
      if (resp.status === 201 || resp.status === 204) {
        await discardBody(resp)
        return
      }

      if (resp.status === 409 && attempt < maxAttempts) {
        const parentDir = newPath.substring(0, newPath.lastIndexOf("/"))
        if (parentDir) {
          await discardBody(resp)
          await this.mkdirAll(parentDir)
          continue
        }
      }

      await discardBody(resp)
      throw new Error(`WebDAV ${method} failed with status ${resp.status}`)
    }
    // maxAttempts 循环必然以 return 或 throw 结束，这里只是类型收窄。
    throw new Error(`WebDAV ${method} failed: retry budget exhausted`)
  }

  /**
   * DELETE - Remove file or directory
   */
  async remove(remotePath: string): Promise<void> {
    const resp = await this.request("DELETE", remotePath)
    if (resp.status === 200 || resp.status === 204 || resp.status === 404) {
      return
    }
    throw new Error(`WebDAV DELETE failed with status ${resp.status}`)
  }

  /**
   * PUT - Upload file
   */
  async put(
    remotePath: string,
    content: ArrayBuffer | Uint8Array | string | Blob,
    contentType?: string,
  ): Promise<void> {
    const headers: Record<string, string> = {}
    if (contentType) {
      headers["Content-Type"] = contentType
    }

    let resp = await this.request("PUT", remotePath, {
      headers,
      body: content as BodyInit,
    })

    if (resp.status === 200 || resp.status === 201 || resp.status === 204) {
      return
    }

    if (resp.status === 409) {
      const parentDir = remotePath.substring(0, remotePath.lastIndexOf("/"))
      if (parentDir) {
        await this.mkdirAll(parentDir)
        resp = await this.request("PUT", remotePath, {
          headers,
          body: content as BodyInit,
        })
        if (resp.status === 200 || resp.status === 201 || resp.status === 204) {
          return
        }
      }
    }

    throw new Error(`WebDAV PUT failed with status ${resp.status}`)
  }

  /**
   * Get direct download link & auth headers
   */
  getLink(remotePath: string): WebdavLinkResult {
    const fullUrl = this.buildUrl(remotePath)
    const urlObj = new URL(fullUrl)
    const uri = urlObj.pathname + urlObj.search
    const headers = this.getAuthHeaders("GET", uri)
    return {
      url: fullUrl,
      headers,
    }
  }
}
