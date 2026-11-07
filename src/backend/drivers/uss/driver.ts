// USS (又拍云) driver — 通过 UPYUN REST API 访问又拍云对象存储
// 移植自 OpenList Go 版 drivers/uss。
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { md5 } from "../../pkg/crypto"
import { UssAddition } from "./types"

function joinPath(a: string, b: string): string {
  const left = String(a || "").replace(/\/+$/, "")
  const right = String(b || "").replace(/^\/+/, "")
  if (!left) return right
  if (!right) return left
  return left + "/" + right
}

/**
 * F-479：key 未经编码直接拼进 URL 路径时，`#` 之后会被当 fragment、`?` 之后
 * 被当 query（`new URL(".../dir#1/").pathname === ".../dir"`），列目录/下载/
 * 建目录/删除/上传/移动全部错位。按要求逐段 encodeURIComponent。
 */
function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
}

/** 又拍云列目录迭代终止标记（最后一页的 x-upyun-list-iter 值） */
const LIST_ITER_END = "g2gCZAAEbmV4dGQAA2VvZg"

/** HEAD 响应头里的类型判定（x-upyun-file-type: file | folder） */
function isFolderType(res: Response): boolean {
  const type = (res.headers.get("x-upyun-file-type") || "").toLowerCase()
  return type === "folder" || type === "dir" || type === "d"
}

export class UssDriver implements StorageDriver {
  private addition: UssAddition
  private authHeader: string
  private apiBase: string

  constructor(addition: UssAddition) {
    this.addition = addition || {}
    const operator = this.addition.operator_name || ""
    const password = this.addition.operator_password || ""
    this.authHeader = `Basic ${btoa(`${operator}:${password}`)}`
    this.apiBase = `https://v0.api.upyun.com/${this.addition.bucket || ""}`
  }

  async init(): Promise<void> {
    if (
      !this.addition.bucket ||
      !this.addition.operator_name ||
      !this.addition.operator_password
    ) {
      throw new Error(
        "[USS] bucket / operator_name / operator_password are required",
      )
    }
  }

  private getKey(physicalPath: string, isDir = false): string {
    let key = String(physicalPath || "/").replace(/^\/+/, "")
    if (isDir && key && !key.endsWith("/")) key += "/"
    return key
  }

  private getDownloadHost(): string {
    let host = this.addition.endpoint || ""
    if (!/^https?:\/\//.test(host)) host = "https://" + host
    return host.replace(/\/+$/, "")
  }

  async list(_v: string, physicalPath: string): Promise<FileItem[]> {
    const prefix = this.getKey(physicalPath, true)
    const items: FileItem[] = []
    // F-478：又拍云列表默认只返回 100 条（x-list-limit 最大 10000），后续页
    // 必须把响应头 x-upyun-list-iter 回传为请求头 x-list-iter，直到值为
    // LIST_ITER_END（或空）。原实现只发一次请求，超过 100 条的目录被静默截断。
    let iter = ""
    const seenIters = new Set<string>()
    for (;;) {
      const headers: Record<string, string> = {
        Authorization: this.authHeader,
        Accept: "application/json",
        "x-list-limit": "10000",
      }
      if (iter) headers["x-list-iter"] = iter
      const url = `${this.apiBase}/${encodeKeyPath(prefix)}`
      const res = await fetch(url, { method: "GET", headers })
      if (!res.ok) throw new Error(`[USS] list failed: HTTP ${res.status}`)
      const text = await res.text()
      const page = this.parseListPage(text)
      items.push(...page.items)
      if (!page.parsed) return sortFileItems(items, "name", "asc")
      const nextIter =
        page.iter || res.headers.get("x-upyun-list-iter") || ""
      if (!nextIter || nextIter === LIST_ITER_END || seenIters.has(nextIter)) {
        break
      }
      seenIters.add(nextIter)
      iter = nextIter
    }
    return sortFileItems(items, "name", "asc")
  }

  /**
   * 解析一页列表响应：JSON（{"files":[...],"iter":"..."}）或文本行格式。
   * `parsed` 为 false 表示 JSON 结构不符（调用方应立即停止翻页，不可退化成
   * 按行解析整段 JSON）。
   */
  private parseListPage(text: string): {
    items: FileItem[]
    iter: string
    parsed: boolean
  } {
    const items: FileItem[] = []
    // F-475：Accept: application/json 时又拍云返回对象
    // {"files":[{"type":"folder"|MIME,"length":N,"name":"...","last_modified":ts}],"iter":"..."}，
    // files 是对象字段而非顶层数组；目录的 type 是 "folder"。
    const trimmed = text.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: any = JSON.parse(trimmed)
        const arr: any[] | null = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.files)
            ? parsed.files
            : null
        if (arr) {
          for (const f of arr) {
            const rawName = String(f?.name ?? f?.file_name ?? "")
            const name = rawName.replace(/\/+$/, "")
            if (!name) continue
            const isDir =
              f?.type === "folder" || f?.type === "F" || f?.is_dir === true
            items.push({
              name,
              size: Number(f?.length ?? f?.size ?? 0) || 0,
              is_dir: isDir,
              modified: f?.last_modified
                ? new Date(Number(f.last_modified) * 1000).toISOString()
                : new Date().toISOString(),
              sign: "",
              type: calcFileType(name, isDir),
              raw_url: "",
            })
          }
          return {
            items,
            iter: typeof parsed?.iter === "string" ? parsed.iter : "",
            parsed: true,
          }
        }
        // 结构不符的 JSON：不要退回按行解析（会把整段 JSON 当成一个条目）
        return { items, iter: "", parsed: false }
      } catch {
        // 非 JSON：继续按文本行解析
      }
    }
    // 文本行解析：name<TAB>type<TAB>size<TAB>time
    for (const line of text.split("\n")) {
      const l = line.trim()
      if (!l) continue
      const parts = l.split("\t")
      const name = (parts[0] || "").trim()
      const type = (parts[1] || "").trim()
      const isDir = type === "F" || name.endsWith("/")
      items.push({
        name: name.replace(/\/+$/, ""),
        size: parseInt(parts[2] || "0", 10) || 0,
        is_dir: isDir,
        modified: parts[3]
          ? new Date(parseInt(parts[3], 10) * 1000).toISOString()
          : new Date().toISOString(),
        sign: "",
        type: calcFileType(name, isDir),
        raw_url: "",
      })
    }
    return { items, iter: "", parsed: true }
  }

  /** 上游 HEAD：区分目录/文件并确认存在（F-480） */
  private async headObject(key: string): Promise<{
    is_dir: boolean
    size: number
    modified: string
  }> {
    const attempt = (k: string) =>
      fetch(`${this.apiBase}/${encodeKeyPath(k)}`, {
        method: "HEAD",
        headers: { Authorization: this.authHeader },
      })
    let res = await attempt(key)
    // 部分实现对目录只认带尾斜杠的 key：补一次探测，避免把目录判成 404
    if (res.status === 404 && !key.endsWith("/")) {
      const dirRes = await attempt(key + "/")
      if (dirRes.ok && isFolderType(dirRes)) res = dirRes
    }
    if (res.status === 404) {
      throw new Error(`[USS] object not found: ${key}`)
    }
    if (!res.ok) {
      throw new Error(`[USS] head failed: HTTP ${res.status}`)
    }
    const isDir = isFolderType(res)
    const size = parseInt(res.headers.get("x-upyun-file-size") || "0", 10) || 0
    const dateHeader = parseInt(
      res.headers.get("x-upyun-file-date") || "",
      10,
    )
    return {
      is_dir: isDir,
      size: isDir ? 0 : size,
      modified: Number.isFinite(dateHeader)
        ? new Date(dateHeader * 1000).toISOString()
        : new Date().toISOString(),
    }
  }

  async get(_v: string, physicalPath: string): Promise<FileItem> {
    const key = this.getKey(physicalPath)
    if (!key) {
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
    // F-480：必须与上游确认存在性与类型。原实现恒返回 is_dir:false/size:0 的
    // 伪造条目：目录被上报成文件、不存在的路径也返回 200（要到下载时才 404）。
    const meta = await this.headObject(key)
    const name = key.split("/").filter(Boolean).pop() || key
    let rawUrl = ""
    if (!meta.is_dir) {
      // 又拍云 Token 防盗链：_upt = MD5(token&expire&/key)[12:20] + expire
      const expireAt =
        Math.floor(Date.now() / 1000) +
        (this.addition.sign_url_expire || 4) * 3600
      const token =
        this.addition.anti_theft_chain_token ||
        this.addition.operator_password
      const signStr = `${token}&${expireAt}&/${key}`
      const upt = md5(signStr).slice(12, 20) + expireAt
      const upd = encodeURIComponent(name)
      rawUrl = `${this.getDownloadHost()}/${encodeKeyPath(key)}?_upd=${upd}&_upt=${upt}`
    }
    return {
      name,
      size: meta.size,
      is_dir: meta.is_dir,
      modified: meta.modified,
      sign: key,
      type: calcFileType(name, meta.is_dir),
      raw_url: rawUrl,
    }
  }

  async mkdir(_v: string, physicalPath: string): Promise<void> {
    const key = this.getKey(physicalPath, true)
    const res = await fetch(`${this.apiBase}/${encodeKeyPath(key)}`, {
      method: "POST",
      headers: { Authorization: this.authHeader, Folder: "true" },
    })
    if (!res.ok) throw new Error(`[USS] mkdir failed: HTTP ${res.status}`)
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
    await this.moveOrCopy(srcKey, dstKey, "move")
  }

  async remove(
    _v: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const key = this.getKey(physicalPath)
    const res = await fetch(`${this.apiBase}/${encodeKeyPath(key)}`, {
      method: "DELETE",
      headers: { Authorization: this.authHeader },
    })
    if (!res.ok) throw new Error(`[USS] remove failed: HTTP ${res.status}`)
  }

  async move(
    _s: string,
    _d: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 是目标项自身的物理路径（op/storage.ts moveItems 逐项调用），
    // 参数即项路径，不得再拼 name，否则会指向 <item>/<name> 导致移动失败。
    await this.moveOrCopy(this.getKey(srcPhys), this.getKey(dstPhys), "move")
  }

  async copy(
    _s: string,
    _d: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // 同 move：srcPhys/dstPhys 已是目标项自身路径，参数即项路径，不得再拼 name。
    await this.moveOrCopy(this.getKey(srcPhys), this.getKey(dstPhys), "copy")
  }

  async put(_v: string, physicalPath: string, content: Buffer): Promise<void> {
    const key = this.getKey(physicalPath)
    const res = await fetch(`${this.apiBase}/${encodeKeyPath(key)}`, {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/octet-stream",
      },
      body: content as any,
    })
    if (!res.ok) throw new Error(`[USS] put failed: HTTP ${res.status}`)
  }

  private async moveOrCopy(
    srcKey: string,
    dstKey: string,
    op: "move" | "copy",
  ): Promise<void> {
    const header = op === "move" ? "X-Upyun-Move-Source" : "X-Upyun-Copy-Source"
    // F-476：官方格式为 "/<bucket>/<source_to_file>"（如 /upyun/foo/source.jpg），
    // srcKey 不含 bucket 段，必须显式拼上，否则服务端解析不到源文件。
    const source = `/${this.addition.bucket}/${srcKey}`
    const res = await fetch(`${this.apiBase}/${encodeKeyPath(dstKey)}`, {
      method: "PUT",
      headers: { Authorization: this.authHeader, [header]: source },
    })
    if (!res.ok) throw new Error(`[USS] ${op} failed: HTTP ${res.status}`)
  }
}
