// Azure Blob Storage driver — 通过 REST API + SharedKey/SAS 认证访问 Azure Blob
// 移植自 OpenList Go 版 drivers/azure_blob。
// 目录采用「虚拟目录」语义（List Blobs delimiter=/），目录标记为空 blob。
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { AzureBlobAddition, AzureListResult } from "./types"

function extractAccountName(endpoint: string): string {
  let e = endpoint.replace(/^https?:\/\//, "")
  const idx = e.indexOf(".")
  return (idx >= 0 ? e.slice(0, idx) : e).toLowerCase()
}

function ensureTrailingSlash(p: string): string {
  return p.endsWith("/") ? p : p + "/"
}

function joinPath(a: string, b: string): string {
  const left = String(a || "").replace(/\/+$/, "")
  const right = String(b || "").replace(/^\/+/, "")
  if (!left) return right
  if (!right) return left
  return left + "/" + right
}

/** 逐段编码 blob 路径（保留 "/"），签名与发送使用同一编码形式 */
function encodeBlobPath(path: string): string {
  return String(path || "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

async function hmacSha256Base64(
  data: string,
  key: Uint8Array,
): Promise<string> {
  const keyMat = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign(
    "HMAC",
    keyMat,
    new TextEncoder().encode(data),
  )
  return bytesToBase64(new Uint8Array(sig))
}

/** XML 实体反转义（F-454）：blob 名可含 & < > 等字符，Azure 会在 XML 里转义 */
function unescapeXml(str: string): string {
  return str.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
    switch (e) {
      case "amp":
        return "&"
      case "lt":
        return "<"
      case "gt":
        return ">"
      case "quot":
        return '"'
      case "apos":
        return "'"
      default: {
        const code = e.startsWith("#x")
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
    }
  })
}

// 简单 XML 提取：从 Azure List Blobs 响应中提取 blob/prefix 信息
function parseListBlobsXml(xml: string): AzureListResult {
  const result: AzureListResult = { blobs: [], prefixes: [] }
  const blobRe = /<Blob>([\s\S]*?)<\/Blob>/g
  const prefixRe =
    /<BlobPrefix>[\s\S]*?<Name>([^<]+)<\/Name>[\s\S]*?<\/BlobPrefix>/g
  let m: RegExpExecArray | null
  while ((m = blobRe.exec(xml))) {
    const block = m[1]
    const name = unescapeXml(
      (block.match(/<Name>([^<]+)<\/Name>/) || [])[1] || "",
    )
    if (name.endsWith("/")) continue
    const size = parseInt(
      (block.match(/<Content-Length>(\d+)<\/Content-Length>/) || [])[1] || "0",
      10,
    )
    const modified =
      (block.match(/<Last-Modified>([^<]+)<\/Last-Modified>/) || [])[1] || ""
    result.blobs.push({
      name,
      size,
      modified: modified
        ? new Date(modified).toISOString()
        : new Date().toISOString(),
    })
  }
  while ((m = prefixRe.exec(xml))) {
    result.prefixes.push(unescapeXml(m[1]))
  }
  result.nextMarker = unescapeXml(
    (xml.match(/<NextMarker>([^<]*)<\/NextMarker>/) || [])[1] || "",
  )
  return result
}

/** 解析 List Blobs（无 delimiter）响应：全部 blob 名 + 翻页标记（F-451） */
function parseBlobNamesXml(xml: string): {
  names: string[]
  nextMarker: string
} {
  const names: string[] = []
  const blobRe = /<Blob>([\s\S]*?)<\/Blob>/g
  let m: RegExpExecArray | null
  while ((m = blobRe.exec(xml))) {
    const name = unescapeXml(
      (m[1].match(/<Name>([^<]+)<\/Name>/) || [])[1] || "",
    )
    if (name) names.push(name)
  }
  const nextMarker = unescapeXml(
    (xml.match(/<NextMarker>([^<]*)<\/NextMarker>/) || [])[1] || "",
  )
  return { names, nextMarker }
}

export class AzureBlobDriver implements StorageDriver {
  private addition: AzureBlobAddition
  private accountName: string
  private keyBytes: Uint8Array
  private endpoint: string
  private container: string

  constructor(addition: AzureBlobAddition) {
    this.addition = addition || {}
    this.accountName = extractAccountName(this.addition.endpoint || "")
    this.keyBytes = base64ToBytes(this.addition.access_key || "")
    this.endpoint = (this.addition.endpoint || "").replace(/\/+$/, "")
    this.container = (this.addition.container_name || "").replace(
      /^\/+|\/+$/g,
      "",
    )
  }

  async init(): Promise<void> {
    if (!/^[a-z0-9]+$/.test(this.accountName)) {
      throw new Error("[AzureBlob] invalid storage account name")
    }
    if (!this.container) {
      throw new Error("[AzureBlob] container_name is required")
    }
    if (!this.addition.access_key) {
      throw new Error("[AzureBlob] access_key is required")
    }
  }

  /** 计算 SharedKey 签名（stringToSign） */
  private async sharedKeySignature(
    method: string,
    path: string,
    query: string,
    extraHeaders: Record<string, string>,
    contentLength: string,
    contentType: string,
  ): Promise<string> {
    const canonicalHeaders = Object.keys(extraHeaders)
      .filter((k) => k.startsWith("x-ms-"))
      .sort()
      .map((k) => `${k.toLowerCase()}:${extraHeaders[k].trim()}\n`)
      .join("")
    // canonicalizedResource = /account/container[/blob] [+ 解码并按名称排序的 query]
    // 规范要求包含 container 段，且 query 的名称与值必须先 URL 解码。
    const resourceParts = [
      `/${this.accountName}/${this.container}${path ? "/" + path : ""}`,
    ]
    const queryParts = query
      .split("&")
      .filter(Boolean)
      .map((p) => {
        const eq = p.indexOf("=")
        const rawKey = eq < 0 ? p : p.slice(0, eq)
        const rawValue = eq < 0 ? "" : p.slice(eq + 1)
        return {
          key: decodeQueryComponent(rawKey).toLowerCase(),
          value: decodeQueryComponent(rawValue),
        }
      })
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    for (const { key, value } of queryParts) {
      resourceParts.push(`${key}:${value}`)
    }
    const canonicalizedResource = resourceParts.join("\n")
    const stringToSign = `${method}\n\n\n${contentLength}\n\n${contentType}\n\n\n\n\n\n\n${canonicalHeaders}${canonicalizedResource}`
    return hmacSha256Base64(stringToSign, this.keyBytes)
  }

  /** 发起带 SharedKey 认证的请求 */
  private async request(
    method: string,
    path: string,
    query: string,
    options: {
      body?: Uint8Array
      contentType?: string
      extraHeaders?: Record<string, string>
    } = {},
  ): Promise<Response> {
    const xmsDate = new Date().toUTCString()
    const contentType = options.contentType || ""
    // 规范：content length 为 0 时 Content-Length 字段必须是空串（不能签成 "0"）
    const bodyLength = options.body ? options.body.length : 0
    const contentLength = bodyLength > 0 ? String(bodyLength) : ""
    const encodedPath = encodeBlobPath(path)
    const extraHeaders = {
      "x-ms-date": xmsDate,
      "x-ms-version": "2021-08-06",
      ...(options.extraHeaders || {}),
    }
    const signature = await this.sharedKeySignature(
      method,
      encodedPath,
      query,
      extraHeaders,
      contentLength,
      contentType,
    )
    const url = `${this.endpoint}/${this.container}${encodedPath ? "/" + encodedPath : ""}${query ? "?" + query : ""}`
    const headers: Record<string, string> = {
      Authorization: `SharedKey ${this.accountName}:${signature}`,
      ...extraHeaders,
    }
    if (contentLength) headers["Content-Length"] = contentLength
    if (contentType) headers["Content-Type"] = contentType
    return fetch(url, {
      method,
      headers,
      ...(options.body ? { body: options.body as any } : {}),
    })
  }

  /** 生成 SAS 下载 URL */
  private async sasUrl(blobPath: string): Promise<string> {
    const expiry = new Date(
      Date.now() + (this.addition.sign_url_expire || 4) * 3600 * 1000,
    )
    const se = expiry.toISOString().replace(/\.\d+Z$/, "Z")
    const canonicalResource = `/blob/${this.accountName}/${this.container}/${blobPath}`
    // sv=2021-08-06（>= 2020-12-06）的 string-to-sign 共 16 个字段：
    // sp,st,se,canonicalizedResource,si,sip,spr,sv,sr,snapshotTime,
    // encryptionScope,rscc,rscd,rsce,rscl,rsct
    const stringToSign = `r\n\n${se}\n${canonicalResource}\n\n\n\n2021-08-06\nb\n\n\n\n\n\n\n`
    const sig = encodeURIComponent(
      await hmacSha256Base64(stringToSign, this.keyBytes),
    )
    return `${this.endpoint}/${this.container}/${encodeBlobPath(blobPath)}?sp=r&st=&se=${encodeURIComponent(se)}&sv=2021-08-06&sr=b&sig=${sig}`
  }

  private getKey(physicalPath: string): string {
    return String(physicalPath || "/").replace(/^\/+/, "")
  }

  async list(_v: string, physicalPath: string): Promise<FileItem[]> {
    let prefix = this.getKey(physicalPath)
    if (prefix) prefix = ensureTrailingSlash(prefix)

    // A-35：Azure List Blobs 单页最多 5000 条，必须按 NextMarker 翻页；
    // 历史实现只取第一页，第 5001 条之后静默丢失。
    const items: FileItem[] = []
    const seenMarkers = new Set<string>()
    let marker = ""
    for (let page = 0; page < 1000; page++) {
      const query =
        `restype=container&comp=list&delimiter=%2F&prefix=${encodeURIComponent(prefix)}` +
        (marker ? `&marker=${encodeURIComponent(marker)}` : "")
      const res = await this.request("GET", "", query)
      if (!res.ok) throw new Error(`[AzureBlob] list failed: HTTP ${res.status}`)
      const xml = await res.text()
      const parsed = parseListBlobsXml(xml)

      for (const p of parsed.prefixes) {
        const name = p.replace(/\/+$/, "").split("/").filter(Boolean).pop() || p
        items.push({
          name,
          size: 0,
          is_dir: true,
          modified: new Date().toISOString(),
          sign: "",
          type: 1,
          raw_url: "",
        })
      }
      for (const b of parsed.blobs) {
        const name = b.name.split("/").filter(Boolean).pop() || b.name
        items.push({
          name,
          size: b.size,
          is_dir: false,
          modified: b.modified,
          sign: b.name,
          type: calcFileType(name, false),
          raw_url: "",
        })
      }

      const next = String(parsed.nextMarker || "")
      if (!next || seenMarkers.has(next)) break
      seenMarkers.add(next)
      marker = next
    }
    return sortFileItems(items, "name", "asc")
  }

  async get(_v: string, physicalPath: string): Promise<FileItem> {
    const key = this.getKey(physicalPath)
    const name = key.split("/").filter(Boolean).pop() || key
    // A-35：用 HEAD 取真实元信息；目录 marker 与隐式目录都按目录返回，
    // 历史实现恒返回 size=0 / is_dir=false。
    let head: Response | null = null
    try {
      head = await this.request("HEAD", key, "")
    } catch {
      // 离线/测试环境：无法访问 Azure 时退化为旧行为（仅返回 SAS 直链）。
      head = null
    }
    if (head?.ok) {
      const isDir =
        head.headers.get("x-ms-meta-hdi_isfolder") === "true" ||
        key.endsWith("/")
      return {
        name,
        size: isDir ? 0 : Number(head.headers.get("content-length") || 0),
        is_dir: isDir,
        modified:
          head.headers.get("last-modified") || new Date().toISOString(),
        sign: key,
        type: isDir ? 1 : calcFileType(name, false),
        raw_url: isDir ? "" : await this.sasUrl(key),
      }
    }

    // 隐式目录（没有目录 marker，但有子 blob）：按前缀探测。
    try {
      const probe = await this.request(
        "GET",
        "",
        `restype=container&comp=list&delimiter=%2F&prefix=${encodeURIComponent(ensureTrailingSlash(key))}&maxresults=1`,
      )
      if (probe.ok) {
        const xml = await probe.text()
        const parsed = parseListBlobsXml(xml)
        if (parsed.blobs.length > 0 || parsed.prefixes.length > 0) {
          return {
            name,
            size: 0,
            is_dir: true,
            modified: new Date().toISOString(),
            sign: key,
            type: 1,
            raw_url: "",
          }
        }
      }
    } catch {
      // 同 HEAD：网络不可达时退化为文件条目
    }
    return {
      name,
      size: 0,
      is_dir: false,
      modified: new Date().toISOString(),
      sign: key,
      type: calcFileType(name, false),
      raw_url: await this.sasUrl(key),
    }
  }

  async mkdir(_v: string, physicalPath: string): Promise<void> {
    const key = ensureTrailingSlash(this.getKey(physicalPath))
    const res = await this.request("PUT", key, "", {
      body: new Uint8Array(0),
      contentType: "application/octet-stream",
      extraHeaders: {
        "x-ms-blob-type": "BlockBlob",
        "x-ms-meta-hdi_isfolder": "true",
      },
    })
    if (!res.ok) throw new Error(`[AzureBlob] mkdir failed: HTTP ${res.status}`)
  }

  async rename(
    _v: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const srcKey = this.getKey(physicalPath)
    const dstKey = joinPath(
      physicalPath.split("/").slice(0, -1).join("/"),
      newName,
    ).replace(/^\/+/, "")
    // F-451：目录必须按前缀递归复制/删除，单 blob 操作只会搬走 0 字节标记
    await this.copyEntry(srcKey, dstKey)
    await this.deleteEntry(srcKey)
  }

  async remove(
    _v: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const key = this.getKey(physicalPath)
    await this.deleteEntry(key)
  }

  async move(
    _s: string,
    _d: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 是目标项自身的物理路径（op/storage.ts moveItems 逐项调用），
    // 不得再拼 name，否则会指向 `<item>/<name>` 这种不存在的 blob。
    const srcKey = this.getKey(srcPhys)
    const dstKey = this.getKey(dstPhys)
    await this.copyEntry(srcKey, dstKey)
    await this.deleteEntry(srcKey)
  }

  async copy(
    _s: string,
    _d: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // 同 move：srcPhys/dstPhys 已是目标项自身路径，不得再拼 name。
    const srcKey = this.getKey(srcPhys)
    const dstKey = this.getKey(dstPhys)
    await this.copyEntry(srcKey, dstKey)
  }

  async put(_v: string, physicalPath: string, content: Buffer): Promise<void> {
    const key = this.getKey(physicalPath)
    const res = await this.request("PUT", key, "", {
      body: new Uint8Array(content),
      contentType: "application/octet-stream",
      extraHeaders: { "x-ms-blob-type": "BlockBlob" },
    })
    if (!res.ok) throw new Error(`[AzureBlob] put failed: HTTP ${res.status}`)
  }

  /**
   * 列出 prefix 下全部 blob 名（不带 delimiter，按 NextMarker 翻页）。
   * 用于目录的递归复制/删除（F-451）。
   */
  private async listBlobNames(prefix: string): Promise<string[]> {
    const out: string[] = []
    let marker = ""
    for (let page = 0; page < 100; page++) {
      const query =
        "restype=container&comp=list&prefix=" +
        encodeURIComponent(prefix) +
        (marker ? "&marker=" + encodeURIComponent(marker) : "")
      const res = await this.request("GET", "", query)
      if (!res.ok) {
        throw new Error(`[AzureBlob] list failed: HTTP ${res.status}`)
      }
      const { names, nextMarker } = parseBlobNamesXml(await res.text())
      out.push(...names)
      if (!nextMarker) break
      marker = nextMarker
    }
    return out
  }

  /** key 是否是虚拟目录：存在 `<key>/` 标记 blob，或该前缀下已有对象 */
  private async isDirectory(key: string): Promise<boolean> {
    const clean = key.replace(/^\/+|\/+$/g, "")
    if (!clean) return true
    const marker = clean + "/"
    const head = await this.request("HEAD", marker, "")
    if (head.ok) return true
    if (head.status !== 404) return false
    return (await this.listBlobNames(marker)).length > 0
  }

  /** 复制单个 blob；目录则递归复制其下全部 blob（F-451） */
  private async copyEntry(srcKey: string, dstKey: string): Promise<void> {
    if (!(await this.isDirectory(srcKey))) {
      await this.copyBlob(srcKey, dstKey)
      return
    }
    const srcPrefix = srcKey.replace(/^\/+|\/+$/g, "") + "/"
    const dstPrefix = dstKey.replace(/^\/+|\/+$/g, "") + "/"
    const names = await this.listBlobNames(srcPrefix)
    if (names.length === 0) {
      // 只有标记 blob 的空目录
      await this.copyBlob(srcPrefix, dstPrefix)
      return
    }
    for (const name of names) {
      const rel = name.startsWith(srcPrefix)
        ? name.slice(srcPrefix.length)
        : name
      await this.copyBlob(name, dstPrefix + rel)
    }
  }

  /** 删除单个 blob；目录则递归删除其下全部 blob（F-451） */
  private async deleteEntry(key: string): Promise<void> {
    if (!(await this.isDirectory(key))) {
      await this.deleteBlob(key)
      return
    }
    const prefix = key.replace(/^\/+|\/+$/g, "") + "/"
    const names = await this.listBlobNames(prefix)
    if (names.length === 0) {
      await this.deleteBlob(prefix)
      return
    }
    for (const name of names) {
      await this.deleteBlob(name)
    }
  }

  private async copyBlob(srcKey: string, dstKey: string): Promise<void> {
    const srcUrl = `${this.endpoint}/${this.container}/${encodeBlobPath(srcKey)}`
    const res = await this.request("PUT", dstKey, "", {
      body: new Uint8Array(0),
      contentType: "application/octet-stream",
      extraHeaders: {
        "x-ms-blob-type": "BlockBlob",
        "x-ms-copy-source": srcUrl,
      },
    })
    // 202 表示复制已接受（异步）
    if (res.status !== 201 && res.status !== 202 && !res.ok) {
      throw new Error(`[AzureBlob] copy failed: HTTP ${res.status}`)
    }
  }

  private async deleteBlob(key: string): Promise<void> {
    const res = await this.request("DELETE", key, "")
    if (res.status !== 202 && res.status !== 404 && !res.ok) {
      throw new Error(`[AzureBlob] delete failed: HTTP ${res.status}`)
    }
  }
}
