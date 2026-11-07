import {
  calcFileType,
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { hmacSha1Base64 } from "../../pkg/crypto"
import {
  PikPakAboutResp,
  PikPakAddition,
  PikPakFile,
  PikPakFileListResp,
} from "./types"
import { calcGcid, PikPakApiClient } from "./util"

export class PikPakDriver implements StorageDriver {
  private addition: PikPakAddition
  private client: PikPakApiClient
  private rootId: string = ""
  // Map of physical path to file ID
  private idCache: Map<string, string> = new Map()

  constructor(
    addition: PikPakAddition,
    onTokenRefreshed?: (tokens: {
      accessToken: string
      refreshToken: string
      captchaToken?: string
    }) => Promise<void>,
  ) {
    this.addition = addition
    this.rootId = addition.root_folder_id || ""
    this.client = new PikPakApiClient(addition, onTokenRefreshed)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private cleanPath(p: string): string {
    const s = "/" + (p || "").split("/").filter(Boolean).join("/")
    return s === "/" ? "" : s
  }

  /**
   * F-258：把 oldClean 及其全部子路径的缓存键迁移到 newClean 前缀。
   * rename/move 后 PikPak 文件 ID 不变，因此只需重写路径键；
   * 不迁移会让旧子路径继续命中缓存、新子路径则每次重新遍历。
   */
  private rekeyCache(oldClean: string, newClean: string): void {
    if (!oldClean || oldClean === newClean) return
    const entries: Array<{ oldKey: string; newKey: string; id: string }> = []
    for (const [key, id] of this.idCache) {
      if (key === oldClean || key.startsWith(oldClean + "/")) {
        entries.push({
          oldKey: key,
          newKey: newClean + key.slice(oldClean.length),
          id,
        })
      }
    }
    for (const e of entries) this.idCache.delete(e.oldKey)
    for (const e of entries) this.idCache.set(e.newKey, e.id)
  }

  /** F-258：删除某个路径及其全部子路径的缓存（remove 使用）。 */
  private invalidateCache(clean: string): void {
    if (!clean) {
      this.idCache.clear()
      return
    }
    for (const key of this.idCache.keys()) {
      if (key === clean || key.startsWith(clean + "/")) {
        this.idCache.delete(key)
      }
    }
  }

  private async resolveParentId(physicalPath: string): Promise<string> {
    const clean = this.cleanPath(physicalPath)
    if (!clean) return this.rootId

    if (this.idCache.has(clean)) {
      return this.idCache.get(clean)!
    }

    // Traverse from root to find id
    const parts = clean.split("/").filter(Boolean)
    let currentId = this.rootId
    let currentPath = ""

    for (const part of parts) {
      currentPath += "/" + part
      if (this.idCache.has(currentPath)) {
        currentId = this.idCache.get(currentPath)!
        continue
      }

      const files = await this.getFiles(currentId)
      const found = files.find((f) => f.name === part)
      if (!found) {
        throw new Error(`Path not found: ${currentPath}`)
      }
      currentId = found.id
      this.idCache.set(currentPath, currentId)
    }

    return currentId
  }

  private async getFiles(parentId: string): Promise<PikPakFile[]> {
    const allFiles: PikPakFile[] = []
    let pageToken = ""

    while (true) {
      const params: Record<string, string> = {
        parent_id: parentId,
        thumbnail_size: "SIZE_LARGE",
        with_audit: "true",
        limit: "100",
        filters: JSON.stringify({
          phase: { eq: "PHASE_TYPE_COMPLETE" },
          trashed: { eq: false },
        }),
      }
      if (pageToken) {
        params.page_token = pageToken
      }

      const data: PikPakFileListResp = await this.client.request(
        "https://api-drive.mypikpak.net/drive/v1/files",
        {
          method: "GET",
          params,
        },
      )

      if (data.files && data.files.length > 0) {
        allFiles.push(...data.files)
      }

      if (!data.next_page_token || data.next_page_token === pageToken) {
        break
      }
      pageToken = data.next_page_token
    }

    return allFiles
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentId = await this.resolveParentId(physicalPath)
    const files = await this.getFiles(parentId)
    const cleanParent = this.cleanPath(physicalPath)

    const items: FileItem[] = files.map((f) => {
      const isDir = f.kind === "drive#folder"
      const filePath = cleanParent ? `${cleanParent}/${f.name}` : `/${f.name}`
      this.idCache.set(filePath, f.id)

      let rawUrl = f.web_content_link || ""
      if (
        !this.addition.disable_media_link &&
        f.medias &&
        f.medias.length > 0 &&
        f.medias[0].link?.url
      ) {
        rawUrl = f.medias[0].link.url
      }

      return {
        name: f.name,
        size: parseInt(f.size || "0", 10) || 0,
        is_dir: isDir,
        created: f.created_time,
        modified: f.modified_time || new Date().toISOString(),
        sign: f.id,
        type: calcFileType(f.name, isDir),
        thumb: f.thumbnail_link,
        raw_url: rawUrl,
      }
    })

    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    const clean = this.cleanPath(physicalPath)
    const name = clean.split("/").pop() || "root"

    if (!clean) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.rootId,
        type: 1,
        raw_url: "",
      }
    }

    const fileId = await this.resolveParentId(physicalPath)
    const queryParams: Record<string, string> = {
      _magic: "2021",
      usage: this.addition.disable_media_link ? "FETCH" : "CACHE",
      thumbnail_size: "SIZE_LARGE",
    }

    const f: PikPakFile = await this.client.request(
      `https://api-drive.mypikpak.net/drive/v1/files/${encodeURIComponent(fileId)}`,
      {
        method: "GET",
        params: queryParams,
      },
    )

    const isDir = f.kind === "drive#folder"
    let rawUrl = f.web_content_link || ""
    if (
      !this.addition.disable_media_link &&
      f.medias &&
      f.medias.length > 0 &&
      f.medias[0].link?.url
    ) {
      rawUrl = f.medias[0].link.url
    }

    return {
      name: f.name || name,
      size: parseInt(f.size || "0", 10) || 0,
      is_dir: isDir,
      created: f.created_time,
      modified: f.modified_time || new Date().toISOString(),
      sign: f.id,
      type: calcFileType(f.name || name, isDir),
      thumb: f.thumbnail_link,
      raw_url: rawUrl,
    }
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    const parentPath = clean.split("/").slice(0, -1).join("/")
    const dirName = clean.split("/").pop() || ""
    const parentId = await this.resolveParentId(parentPath)

    const resp = await this.client.request(
      "https://api-drive.mypikpak.net/drive/v1/files",
      {
        method: "POST",
        body: {
          kind: "drive#folder",
          parent_id: parentId,
          name: dirName,
        },
      },
    )

    if (resp?.file?.id) {
      this.idCache.set(clean, resp.file.id)
    }
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const fileId = await this.resolveParentId(physicalPath)
    await this.client.request(
      `https://api-drive.mypikpak.net/drive/v1/files/${encodeURIComponent(fileId)}`,
      {
        method: "PATCH",
        body: {
          name: newName,
        },
      },
    )

    const clean = this.cleanPath(physicalPath)
    const parentPath = clean.split("/").slice(0, -1).join("/")
    const newClean = (parentPath ? parentPath + "/" : "/") + newName
    this.rekeyCache(clean, newClean)
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    // physicalPath 是目标项自身的物理路径（参数即目标项路径，不得再拼 name，
    // 否则指向 <item>/<name>）；父目录取 physicalPath 去掉末段后的部分，
    // 目标名取其末段，在父目录子项中按名查找对应 id。
    const clean = this.cleanPath(physicalPath)
    const targetName = clean.split("/").pop() || ""
    const parentPath = clean.split("/").slice(0, -1).join("/")
    const parentId = await this.resolveParentId(parentPath)
    const files = await this.getFiles(parentId)
    const match = files.find((f) => f.name === targetName)
    // F-256：找不到目标项必须报错，不能让调用方/用户看到「成功」。
    if (!match) {
      throw new Error(`PikPak remove: object not found: ${targetName}`)
    }

    await this.client.request(
      "https://api-drive.mypikpak.net/drive/v1/files:batchTrash",
      {
        method: "POST",
        body: {
          ids: [match.id],
        },
      },
    )

    this.invalidateCache(clean)
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 是源/目标项自身的物理路径（参数即目标项路径，不得再拼 name）：
    // 直接当父目录解析会指到项本身——源侧会去 <srcItem> 的子项里找 name（永远落空），
    // 目标侧解析一个尚不存在的目标项必然报错。
    // 故两侧父目录均去掉末段，源名取 srcPhys 末段，在源父目录子项中按名查 id。
    const srcClean = this.cleanPath(srcPhys)
    const dstClean = this.cleanPath(dstPhys)
    const srcName = srcClean.split("/").pop() || ""
    const srcParentPath = srcClean.split("/").slice(0, -1).join("/")
    const dstParentPath = dstClean.split("/").slice(0, -1).join("/")

    const srcParentId = await this.resolveParentId(srcParentPath)
    const dstParentId = await this.resolveParentId(dstParentPath)
    const srcFiles = await this.getFiles(srcParentId)
    const match = srcFiles.find((f) => f.name === srcName)
    // F-256：找不到源项必须报错（静默 return 会让 MOVE 假成功）。
    if (!match) {
      throw new Error(`PikPak move: object not found: ${srcName}`)
    }

    await this.client.request(
      "https://api-drive.mypikpak.net/drive/v1/files:batchMove",
      {
        method: "POST",
        body: {
          ids: [match.id],
          to: {
            parent_id: dstParentId,
          },
        },
      },
    )

    // F-258：把源路径（含子项）的缓存键迁移到目标路径，并为目标项本身建立键。
    this.rekeyCache(srcClean, dstClean)
    this.idCache.set(dstClean, match.id)
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // 与 move 同理：参数是源/目标项自身路径，不得再拼 name；
    // 两侧父目录均去掉末段，源名取 srcPhys 末段，在源父目录子项中按名查 id。
    const srcClean = this.cleanPath(srcPhys)
    const dstClean = this.cleanPath(dstPhys)
    const srcName = srcClean.split("/").pop() || ""
    const srcParentPath = srcClean.split("/").slice(0, -1).join("/")
    const dstParentPath = dstClean.split("/").slice(0, -1).join("/")

    const srcParentId = await this.resolveParentId(srcParentPath)
    const dstParentId = await this.resolveParentId(dstParentPath)
    const srcFiles = await this.getFiles(srcParentId)
    const match = srcFiles.find((f) => f.name === srcName)
    // F-256：找不到源项必须报错（静默 return 会让 COPY 假成功）。
    if (!match) {
      throw new Error(`PikPak copy: object not found: ${srcName}`)
    }

    await this.client.request(
      "https://api-drive.mypikpak.net/drive/v1/files:batchCopy",
      {
        method: "POST",
        body: {
          ids: [match.id],
          to: {
            parent_id: dstParentId,
          },
        },
      },
    )
  }

  readonly rapidHashAlgos = ["sha1"]
  readonly rapidHashNeedsPieces = false

  async rapidUpload(
    _virtualPath: string,
    physicalPath: string,
    metadata: {
      size: number
      sha1?: string
      hashes?: { gcid?: string; sha1?: string }
    },
  ): Promise<boolean> {
    // F-254：PikPak 秒传按 GCID（分块双重 SHA-1）匹配，普通整文件 SHA-1
    // 永远不可能命中。只有 seed 里带了真实 GCID 时才尝试秒传；缺 GCID
    // 时返回 false 走真实上传，不能拿裸 SHA-1 冒充。
    const gcid = String(metadata.hashes?.gcid || "").toUpperCase()
    if (!/^[0-9A-F]{40}$/.test(gcid)) return false
    const clean = this.cleanPath(physicalPath)
    const parentPath = clean.split("/").slice(0, -1).join("/")
    const fileName = clean.split("/").pop() || "upload"
    const parentId = await this.resolveParentId(parentPath)
    const taskResp: any = await this.client.request(
      "https://api-drive.mypikpak.net/drive/v1/files",
      {
        method: "POST",
        body: {
          kind: "drive#file",
          name: fileName,
          size: String(metadata.size),
          hash: gcid,
          upload_type: "UPLOAD_TYPE_RESUMABLE",
          objProvider: { provider: "UPLOAD_TYPE_UNKNOWN" },
          parent_id: parentId,
          folder_type: "NORMAL",
        },
      },
    )
    // A successful rapid upload returns the file without a resumable session.
    return !taskResp?.resumable
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    const parentPath = clean.split("/").slice(0, -1).join("/")
    const fileName = clean.split("/").pop() || "upload"
    const parentId = await this.resolveParentId(parentPath)

    // F-254：hash 必须是 GCID（分块双重 SHA-1），裸 SHA-1 永远不会命中
    const gcid = await calcGcid(new Uint8Array(content))

    const taskResp: any = await this.client.request(
      "https://api-drive.mypikpak.net/drive/v1/files",
      {
        method: "POST",
        body: {
          kind: "drive#file",
          name: fileName,
          size: String(content.length),
          hash: gcid,
          upload_type: "UPLOAD_TYPE_RESUMABLE",
          objProvider: { provider: "UPLOAD_TYPE_UNKNOWN" },
          parent_id: parentId,
          folder_type: "NORMAL",
        },
      },
    )

    // Rapid upload / already complete
    if (!taskResp.resumable) {
      return
    }

    const params = taskResp.resumable.params || {}
    let endpoint = String(params.endpoint || "")
    if (this.addition.platform === "android") {
      endpoint = "mypikpak.net"
    }
    const bucket = String(params.bucket || "")
    const objectKey = String(params.key || "").replace(/^\/+/, "")
    const accessKeyId = String(params.access_key_id || "")
    const accessKeySecret = String(params.access_key_secret || "")
    const securityToken = String(params.security_token || "")

    // F-253：OSS 写入必须用 AK/SK 生成 Authorization 签名，
    // x-oss-security-token 只是签名之外的补充，单独携带必然 403。
    if (!bucket || !objectKey || !accessKeyId || !accessKeySecret) {
      throw new Error(
        "[PikPak] OSS upload params incomplete (missing bucket/key/access_key_id/access_key_secret)",
      )
    }

    let endpointHost = endpoint
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")
    if (endpointHost.startsWith(bucket + ".")) {
      endpointHost = endpointHost.slice(bucket.length + 1)
    }
    // F-257：object key 逐段 URL 编码后再拼请求路径（保留 "/" 分隔符）；
    // 签名仍使用 OSS 规范要求的原始（未编码）路径。
    const encodedObjectKey = objectKey
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/")
    const uploadUrl = `https://${bucket}.${endpointHost}/${encodedObjectKey}`

    // 阿里云 OSS V1 签名：VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders + CanonicalizedResource
    const contentType = "application/octet-stream"
    const dateStr = new Date().toUTCString()
    const canonicalizedOSSHeaders = securityToken
      ? `x-oss-security-token:${securityToken}\n`
      : ""
    const canonicalizedResource = `/${bucket}/${objectKey}`
    const stringToSign =
      `PUT\n\n${contentType}\n${dateStr}\n` +
      `${canonicalizedOSSHeaders}${canonicalizedResource}`
    const signature = await hmacSha1Base64(stringToSign, accessKeySecret)

    const headers: Record<string, string> = {
      "Content-Length": String(content.length),
      "Content-Type": contentType,
      Date: dateStr,
      Authorization: `OSS ${accessKeyId}:${signature}`,
    }
    if (securityToken) headers["x-oss-security-token"] = securityToken

    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers,
      body: new Uint8Array(content),
    })

    if (!uploadRes.ok) {
      const detail = await uploadRes.text().catch(() => "")
      throw new Error(
        `PikPak OSS upload failed: ${uploadRes.status} ${uploadRes.statusText} ${detail.slice(0, 200)}`,
      )
    }
  }

  async getDetails(): Promise<{
    totalSpace: number
    usedSpace: number
  }> {
    const about: PikPakAboutResp = await this.client.request(
      "https://api-drive.mypikpak.net/drive/v1/about",
      {
        method: "GET",
      },
    )
    return {
      totalSpace: parseInt(about.quota.limit || "0", 10) || 0,
      usedSpace: parseInt(about.quota.usage || "0", 10) || 0,
    }
  }
}
