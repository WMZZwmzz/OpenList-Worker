// AutoIndex driver - Nginx/静态目录索引适配器
// Ported from: OpenList-Backends/drivers/autoindex
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { AutoIndexAddition, AutoIndexNode } from "./types"
import { parseAutoIndexHTML, parseSize, parseTime } from "./util"

const DefaultItemXPath = "//pre/a"
const DefaultNameXPath = "@href"
const DefaultSizeXPath = "string(following-sibling::text()[1])"
const DefaultModifiedXPath = "string(following-sibling::text()[2])"
const FETCH_TIMEOUT_MS = 30_000
/** 单次目录列表允许的最大字节数（远端 HTML 体积不可控） */
const MAX_LISTING_BYTES = 4 * 1024 * 1024

/** 流式读取文本并在超过上限时立即中止，避免先整份进内存再判大小。 */
async function readTextLimited(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(res.headers.get("content-length") || "0")
  if (declared > maxBytes) {
    throw new Error(
      `autoindex listing too large (${declared} bytes, limit ${maxBytes})`,
    )
  }
  const reader = res.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  let total = 0
  let out = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.length) continue
    total += value.byteLength
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {}
      throw new Error(
        `autoindex listing too large (>${maxBytes} bytes, limit ${maxBytes})`,
      )
    }
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

export function normalizeAutoIndexAddition(a: any): AutoIndexAddition {
  const norm = { ...(a || {}) } as any
  norm.url = (norm.url || "").trim()
  // Go: 无 scheme 则补 https://，无尾斜杠则补 /
  if (norm.url && !/:\/\//.test(norm.url)) norm.url = "https://" + norm.url
  if (norm.url && !norm.url.endsWith("/")) norm.url += "/"
  norm.item_xpath = norm.item_xpath || DefaultItemXPath
  norm.name_xpath = norm.name_xpath || DefaultNameXPath
  norm.size_xpath = norm.size_xpath || DefaultSizeXPath
  norm.modified_xpath = norm.modified_xpath || DefaultModifiedXPath
  norm.modified_time_format = norm.modified_time_format || ""
  norm.ignore_file_names = norm.ignore_file_names || ""
  return norm as AutoIndexAddition
}

export class AutoIndexDriver implements StorageDriver {
  private addition: AutoIndexAddition
  private ignoreNames: string[] = []

  constructor(addition: any) {
    this.addition = normalizeAutoIndexAddition(addition)
    // Go 用换行分隔 ignore 列表；兼容逗号分隔
    if (this.addition.ignore_file_names) {
      this.ignoreNames = this.addition.ignore_file_names
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter((s) => s)
    }
  }

  async init(): Promise<void> {
    if (!this.addition.url) throw new Error("url is required")
  }

  private cleanRel(p: string): string {
    return (p || "").split("/").filter(Boolean).join("/")
  }

  // 目录 URL（带尾斜杠，供相对 href 正确拼接）
  private buildDirURL(physicalPath: string): string {
    const rel = this.cleanRel(physicalPath)
    return this.addition.url + rel + (rel ? "/" : "")
  }

  private nodeToFileItem(node: AutoIndexNode, baseURL: string): FileItem {
    // href 完全由远端目录页控制：只接受与挂载点同源的链接。跨源 href 可能被
    // 用来把浏览器引向内网/元数据（或任意外部地址），不能原样放进 raw_url。
    let safeRawUrl = ""
    try {
      const resolved = new URL(node.url, baseURL)
      const base = new URL(baseURL)
      if (resolved.origin === base.origin) safeRawUrl = resolved.toString()
    } catch {
      safeRawUrl = ""
    }
    const isDir = node.isDir
    return {
      name: node.name,
      size: node.size ? parseSize(node.size) : 0,
      is_dir: isDir,
      modified: node.modified
        ? parseTime(node.modified, this.addition.modified_time_format || "")
        : new Date().toISOString(),
      // sign 保留给下载签名（pkg/sign），不可塞入 URL，否则前端会拼出无效
      // ?sign=http://... 导致签名校验 401。直链走 raw_url。
      sign: "",
      type: calcFileType(node.name, isDir),
      raw_url: isDir ? "" : safeRawUrl,
    }
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const baseURL = this.buildDirURL(physicalPath)
    // 边缘运行时通常会等到平台级超时（EdgeOne 为 120 秒）才中止不可达的
    // 上游请求。显式限制单次目录读取，避免一个失联的 AutoIndex 挂载长期占用
    // 实例并拖累同一服务的其他请求。
    const res = await fetch(baseURL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`Failed to fetch ${baseURL}: HTTP ${res.status}`)
    }
    // 目录列表大小必须有上限：远端返回几百 MB 的 HTML 时，res.text() 会把整个
    // isolate 的内存吃光（超时只挡慢连接，挡不住大体积）。流式计数，超限即停。
    const listing = await readTextLimited(res, MAX_LISTING_BYTES)
    const html = listing

    const nodes = parseAutoIndexHTML(
      html,
      this.addition.item_xpath || DefaultItemXPath,
      this.addition.name_xpath || DefaultNameXPath,
      this.addition.size_xpath || DefaultSizeXPath,
      this.addition.modified_xpath || DefaultModifiedXPath,
      this.ignoreNames,
    )

    const items: FileItem[] = nodes
      .filter((n) => n.name !== ".." && n.name !== ".")
      .map((n) => this.nodeToFileItem(n, baseURL))

    return sortFileItems(items, "name", "asc")
  }

  /**
   * 探测远端 URL 的元信息（F-381）。
   *
   * 先用 HEAD（不取正文）；服务端不支持 HEAD（405/501）或返回其它非 404
   * 失败时，退化为 `Range: bytes=0-0` 的 GET 探测，随即取消正文流。
   */
  private async probe(
    url: string,
  ): Promise<{ ok: boolean; status: number; isHtml: boolean; size: number }> {
    const isHtmlType = (v: string | null) => (v || "").includes("text/html")
    const head = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (head.ok || head.status === 404) {
      return {
        ok: head.ok,
        status: head.status,
        isHtml: isHtmlType(head.headers.get("content-type")),
        size: Number(head.headers.get("content-length") || "0") || 0,
      }
    }
    const res = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    try {
      await res.body?.cancel()
    } catch {}
    const total = Number(
      (res.headers.get("content-range") || "").split("/").pop() ||
        res.headers.get("content-length") ||
        "0",
    )
    return {
      ok: res.ok,
      status: res.status,
      isHtml: isHtmlType(res.headers.get("content-type")),
      size: Number.isFinite(total) ? total : 0,
    }
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    const rel = this.cleanRel(physicalPath)
    const name = rel.split("/").filter(Boolean).pop() || "root"

    if (!rel) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    }

    // 静态服务：条目 URL 即 根 URL + 相对路径，目录另有带尾斜杠的形式。
    const fileURL = this.addition.url + rel
    const dirURL = fileURL + "/"
    const fileProbe = await this.probe(fileURL)

    // 目录：目录 URL（带尾斜杠）能取到 HTML 索引页。仅凭 text/html 不够
    // ——真正的 .html 文件也是 text/html，必须再确认带尾斜杠的形式存在。
    const isDirectoryProbe = async (ok: boolean, isHtml: boolean) => {
      if (!isHtml) return false
      const dirProbe = await this.probe(dirURL)
      return dirProbe.ok && dirProbe.isHtml
    }

    if (fileProbe.ok && (await isDirectoryProbe(true, fileProbe.isHtml))) {
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    }
    if (fileProbe.ok) {
      return {
        name,
        size: fileProbe.size,
        is_dir: false,
        modified: new Date().toISOString(),
        sign: "",
        type: calcFileType(name, false),
        raw_url: fileURL,
      }
    }

    // 裸路径 404 时再探一次带尾斜杠的目录形式（部分静态服务不做重定向）
    const dirProbe = await this.probe(dirURL)
    if (dirProbe.ok && dirProbe.isHtml) {
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    }

    if (fileProbe.status === 404 || dirProbe.status === 404) {
      throw new Error(`[AutoIndex] object not found: ${rel}`)
    }
    throw new Error(
      `[AutoIndex] failed to stat ${fileURL}: HTTP ${fileProbe.status}`,
    )
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Uint8Array,
  ): Promise<void> {
    throw new Error("AutoIndex is read-only")
  }
}
