// Bunny Storage driver
// Ported from: OpenList-Backends/drivers/bunny_storage
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { BunnyAddition, BunnyObject } from "./types"
import {
  bunnyDefaultEndpoint,
  bunnyDefaultPlaceholder,
  cleanObjectPath,
  cdnURL,
  handleBunnyError,
  normalizeBaseURL,
  signCDNURL,
  storageURL,
} from "./util"

export function normalizeBunnyAddition(a: any): BunnyAddition {
  const norm = { ...(a || {}) } as any
  norm.storage_zone_name = (norm.storage_zone_name || "").trim()
  norm.access_key = (norm.access_key || "").trim()
  norm.endpoint = (norm.endpoint || "").trim() || bunnyDefaultEndpoint
  norm.cdn_base_url = (norm.cdn_base_url || "").trim()
  norm.cdn_token_key = (norm.cdn_token_key || "").trim()
  norm.cdn_token_method = (norm.cdn_token_method || "sha256").toLowerCase()
  norm.cdn_token_include_ip = !!norm.cdn_token_include_ip
  norm.sign_url_expire = Number(norm.sign_url_expire || 4)
  norm.placeholder = (norm.placeholder || "").trim() || bunnyDefaultPlaceholder
  norm.root_folder_path = norm.root_folder_path || "/"
  return norm as BunnyAddition
}

function parseBunnyTime(v: string): string {
  if (!v) return new Date().toISOString()
  const t = new Date(v)
  return isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString()
}

export class BunnyStorageDriver implements StorageDriver {
  private addition: BunnyAddition

  constructor(addition: any) {
    this.addition = normalizeBunnyAddition(addition)
  }

  async init(): Promise<void> {
    // F-404：必须把归一化结果写回，否则「只填域名」的 cdn_base_url 会通过
    // 校验却在每次 get() 里 new URL("myzone.b-cdn.net") 抛 Invalid URL。
    this.addition.endpoint = normalizeBaseURL(
      this.addition.endpoint,
      bunnyDefaultEndpoint,
    )
    if (this.addition.cdn_base_url) {
      this.addition.cdn_base_url = normalizeBaseURL(
        this.addition.cdn_base_url,
        "",
      )
    }
  }

  /**
   * 由虚拟路径与物理路径推导存储的挂载路径（F-409）。
   *
   * 驱动接口拿不到 storage.mount_path，但 get() 同时收到含挂载前缀的
   * virtualPath 和不含前缀的 physicalPath，两者相减即挂载路径。推导不出时
   * 返回空串（不剥离任何前缀，保持原有行为）。
   */
  private mountPathFor(virtualPath: string, physicalPath: string): string {
    const v =
      "/" + String(virtualPath || "").split("/").filter(Boolean).join("/")
    const clean = cleanObjectPath(physicalPath)
    const root = cleanObjectPath(this.addition.root_folder_path || "/")
    let rel = clean
    if (root !== "/") {
      if (clean === root) rel = "/"
      else if (clean.startsWith(root + "/")) rel = clean.slice(root.length)
    }
    if (rel === "/") return v
    if (v.endsWith(rel)) return v.slice(0, v.length - rel.length) || "/"
    return ""
  }

  private toFileItem(parentPath: string, item: BunnyObject): FileItem {
    const fullPath =
      parentPath === "/"
        ? `/${item.ObjectName}`
        : `${parentPath}/${item.ObjectName}`
    return {
      name: item.ObjectName,
      size: item.IsDirectory ? 0 : item.Length || 0,
      is_dir: item.IsDirectory,
      modified: parseBunnyTime(item.LastChanged),
      sign: item.Guid || fullPath,
      type: calcFileType(item.ObjectName, item.IsDirectory),
    }
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentPath = cleanObjectPath(physicalPath)
    const url = storageURL(this.addition, parentPath, true)
    const res = await fetch(url, {
      headers: { AccessKey: this.addition.access_key },
    })
    await handleBunnyError(res)
    const items = (await res.json()) as BunnyObject[]

    const filtered = items.filter((item) => {
      if (!item.ObjectName) return false
      if (
        !item.IsDirectory &&
        item.ObjectName === this.addition.placeholder
      ) {
        return false
      }
      return true
    })

    const result = filtered.map((item) => this.toFileItem(parentPath, item))
    return sortFileItems(result, "name", "asc")
  }

  async get(
    virtualPath: string,
    physicalPath: string,
    clientIP = "",
  ): Promise<FileItem> {
    const clean = cleanObjectPath(physicalPath)
    const name = clean.split("/").filter(Boolean).pop() || "root"
    if (clean === "/") {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
      }
    }

    const parentPath = clean.split("/").slice(0, -1).join("/") || "/"
    const parentUrl = storageURL(this.addition, parentPath, true)
    const res = await fetch(parentUrl, {
      headers: { AccessKey: this.addition.access_key },
    })
    await handleBunnyError(res)
    const items = (await res.json()) as BunnyObject[]
    const found = items.find((i) => i.ObjectName === name)
    if (!found) throw new Error("object not found")

    let rawUrl = ""
    let rawHeaders: Record<string, string> = {}
    if (!found.IsDirectory) {
      if (this.addition.cdn_base_url) {
        // F-409：cdn_base_url 自带的挂载前缀先剥离，再拼对象路径
        rawUrl = cdnURL(
          this.addition,
          clean,
          this.mountPathFor(virtualPath, physicalPath),
        )
        if (this.addition.cdn_token_key) {
          // F-405：cdn_token_include_ip 开启时把客户端 IP 拼进签名串；
          // clientIP 由调用方（raw.ts / op 层）透传，缺省时退回旧行为。
          rawUrl = await signCDNURL(this.addition, rawUrl, clientIP)
        }
      } else {
        rawUrl = storageURL(this.addition, clean, false)
        rawHeaders = { AccessKey: this.addition.access_key }
      }
    }

    return {
      ...this.toFileItem(parentPath, found),
      raw_url: rawUrl,
      raw_url_headers: rawHeaders,
    }
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const clean = cleanObjectPath(physicalPath)
    const placeholderPath =
      clean === "/"
        ? `/${this.addition.placeholder}`
        : `${clean}/${this.addition.placeholder}`
    const url = storageURL(this.addition, placeholderPath, false)
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        AccessKey: this.addition.access_key,
        "Content-Type": "application/octet-stream",
        "Content-Length": "0",
      },
    })
    await handleBunnyError(res)
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    throw new Error("Bunny Storage does not support rename")
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    throw new Error("Bunny Storage does not support move")
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    throw new Error("Bunny Storage does not support copy")
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    const clean = cleanObjectPath(physicalPath)
    // Bunny 以尾斜杠区分目录语义（目录删除会递归清空内容），文件删除绝不能带尾斜杠。
    // 驱动接口拿不到 is_dir，先按「目录列表」探测：返回 JSON 数组即为目录。
    const isDir = await this.probeDirectory(clean)
    const res = await fetch(storageURL(this.addition, clean, isDir), {
      method: "DELETE",
      headers: { AccessKey: this.addition.access_key },
    })
    await handleBunnyError(res)
  }

  /** 用带尾斜杠的目录列表请求探测路径是否为目录 */
  private async probeDirectory(clean: string): Promise<boolean> {
    if (clean === "/") return true
    try {
      const res = await fetch(storageURL(this.addition, clean, true), {
        headers: { AccessKey: this.addition.access_key },
      })
      if (!res.ok) return false
      const body = await res.json()
      return Array.isArray(body)
    } catch {
      return false
    }
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const clean = cleanObjectPath(physicalPath)
    const url = storageURL(this.addition, clean, false)
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        AccessKey: this.addition.access_key,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(content.length),
      },
      body: new Uint8Array(content),
    })
    await handleBunnyError(res)
  }
}
