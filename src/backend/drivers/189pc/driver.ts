// 189PC driver - China Telecom Cloud PC Protocol
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/189pc
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import {
  Cloud189PCAddition,
  Cloud189PCFile,
  Cloud189PCListResp,
  Cloud189PCLoginResp,
  Cloud189PCInitMultiUploadResp,
  Cloud189PCUploadUrlResp,
} from "./types"
import { Cloud189PCClient, calcMD5 } from "./util"
import { encryptPassword, generateDeviceId } from "./crypto"
import {
  LoginURL,
  ListFilesURL,
  CreateFolderURL,
  RenameFileURL,
  DeleteFileURL,
  GetDownloadURLURL,
  InitUploadURL,
  GetUploadURLsURL,
  CommitUploadURL,
  DefaultChunkSize,
} from "./consts"

const PAGE_SIZE = 100
/** 分页硬上限：recordCount 异常时不至于无限翻页（F-348） */
const MAX_PAGES = 1000

function parse189PCDate(dateStr: string): string {
  if (!dateStr) return new Date().toISOString()
  try {
    const d = new Date(dateStr)
    if (!isNaN(d.getTime())) return d.toISOString()
  } catch {}
  return new Date().toISOString()
}

function cloud189PCFileToFileItem(file: Cloud189PCFile): FileItem {
  return {
    name: file.name,
    size: file.size || 0,
    is_dir: file.isFolder,
    modified: parse189PCDate(file.lastOpTime || file.createDate),
    sign: file.id.toString(),
    type: calcFileType(file.name, file.isFolder),
    thumb: file.icon?.smallUrl || file.icon?.largeUrl || "",
    raw_url: file.downloadUrl || "",
    hash: file.md5 || undefined,
    hashes: file.md5 ? { md5: file.md5 } : undefined,
  }
}

export function normalizeCloud189PCAddition(a: any): Cloud189PCAddition {
  const norm = { ...(a || {}) } as any
  norm.username = (norm.username || "").trim()
  norm.password = (norm.password || "").trim()
  norm.root_folder_id = norm.root_folder_id || "-11"
  norm.captcha_mode = norm.captcha_mode || ""
  norm.device_id = norm.device_id || ""
  norm.session_key = norm.session_key || ""
  norm.session_secret = norm.session_secret || ""
  norm.login_type = norm.login_type || "1"
  return norm as Cloud189PCAddition
}

export class Cloud189PCDriver implements StorageDriver {
  private client: Cloud189PCClient
  private addition: Cloud189PCAddition
  private rootFolderId: string = "-11"
  /** 物理路径 → 天翼云盘 fileId（F-341：路径必须逐级解析，不能直接当 ID 用） */
  private pathIdCache = new Map<string, string>()
  private onTokenUpdate?: (tokens: {
    session_key: string
    session_secret: string
    device_id: string
  }) => Promise<void>

  get config() {
    return {
      name: "189PC",
      localSort: false,
      onlyLocal: false,
      onlyProxy: false,
      noCache: false,
      noUpload: false,
      defaultRoot: "-11",
    }
  }

  constructor(
    addition: any,
    onTokenUpdate?: (tokens: {
      session_key: string
      session_secret: string
      device_id: string
    }) => Promise<void>
  ) {
    this.addition = normalizeCloud189PCAddition(addition)
    this.client = new Cloud189PCClient(this.addition)
    this.rootFolderId = this.addition.root_folder_id || "-11"
    this.onTokenUpdate = onTokenUpdate
  }

  async init(): Promise<void> {
    // Check if we have valid session
    if (this.addition.session_key && this.addition.session_secret) {
      // Try to use existing session
      try {
        await this.testSession()
        return
      } catch (e) {
        // Session expired, need to login again
      }
    }

    // Generate device ID if not provided
    if (!this.client.getDeviceId()) {
      this.client.setDeviceId(generateDeviceId())
    }

    // Login
    await this.login()
  }

  private async testSession(): Promise<void> {
    // Test session by listing root folder
    await this.client.requestAPI(ListFilesURL, {
      folderId: this.rootFolderId,
      pageNum: 1,
      pageSize: 1,
    })
  }

  private async login(): Promise<void> {
    // Get RSA public key
    const params = {
      appId: "600002434",
      accountType: this.addition.login_type || "1",
      userName: this.addition.username,
      password: encryptPassword(this.addition.password, await this.getRSAPublicKey()),
      clientType: "10020",
      returnUrl: "https://m.cloud.189.cn/zhuanti/2020/loginSuccess/index.html",
      mailSuffix: "@189.cn",
    }

    const resp = await this.client.request(LoginURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    })

    if (!resp || resp.result !== 0) {
      throw new Error(`Login failed: ${resp?.msg || "Unknown error"}`)
    }

    const loginResp = resp as Cloud189PCLoginResp
    this.client.setTokens(
      loginResp.accessToken,
      loginResp.sessionKey,
      loginResp.sessionSecret
    )

    // Notify token update
    if (this.onTokenUpdate) {
      await this.onTokenUpdate({
        session_key: loginResp.sessionKey,
        session_secret: loginResp.sessionSecret,
        device_id: this.client.getDeviceId(),
      })
    }
  }

  private async getRSAPublicKey(): Promise<string> {
    // Cloud189 uses a fixed RSA public key for PC protocol
    return "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDY7mpaUysvgQkIiL9M6PxYcKGOXe0elNAk" +
           "kkh/v0fzfx6cGrJnLlh5G0H8qPUvhLHh+U4xqRMN8C7KKKHmCQ1Xq5KLJCBM6pq9W2KU2R1q" +
           "g5SrCAqHq5KXJHM7TpjD/yH0u8KpY2H5U3WwR5N9LCdTw2XP6YqOvAx8kKqM3N8mKQIDAQAB"
  }

  async drop(): Promise<void> {
    // No cleanup needed
  }

  // ---- 路径解析（F-341）：物理路径 → 天翼云盘 fileId ----

  private cleanPhysical(physicalPath: string): string {
    return (
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    )
  }

  private invalidatePathCache(physicalPath: string): void {
    const clean = this.cleanPhysical(physicalPath)
    if (clean === "/") {
      this.pathIdCache.clear()
      return
    }
    const prefix = `${clean}/`
    for (const key of Array.from(this.pathIdCache.keys())) {
      if (key === clean || key.startsWith(prefix)) {
        this.pathIdCache.delete(key)
      }
    }
  }

  /**
   * 取目录的一页。
   *
   * F-348：recordCount 是翻页的唯一退出信号，旧实现直接用
   * `allFiles.length >= undefined`（恒 false）会无限翻页。这里先做数值校验，
   * 并对空页/页数上限做兜底。
   */
  private async fetchFolderPage(
    folderId: string,
    pageNum: number,
  ): Promise<{ items: Cloud189PCFile[]; recordCount: number }> {
    const resp = (await this.client.requestAPI(ListFilesURL, {
      folderId,
      pageNum,
      pageSize: PAGE_SIZE,
    })) as Cloud189PCListResp
    const recordCount = (resp as any)?.recordCount
    if (typeof recordCount !== "number" || !Number.isFinite(recordCount)) {
      throw new Error(
        "[189PC] 列表响应缺少有效的 recordCount，已中止翻页（避免无限循环）",
      )
    }
    const items: Cloud189PCFile[] = [
      ...(resp.folderList || []),
      ...(resp.fileList || []),
    ]
    return { items, recordCount }
  }

  private async listFolder(folderId: string): Promise<Cloud189PCFile[]> {
    const all: Cloud189PCFile[] = []
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const { items, recordCount } = await this.fetchFolderPage(
        folderId,
        pageNum,
      )
      if (items.length === 0) break
      all.push(...items)
      if (all.length >= recordCount) break
    }
    return all
  }

  private async findChild(
    folderId: string,
    rawName: string,
    wantDir?: boolean,
  ): Promise<Cloud189PCFile | null> {
    let decodedName = rawName
    try {
      decodedName = decodeURIComponent(rawName)
    } catch {}
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const { items, recordCount } = await this.fetchFolderPage(
        folderId,
        pageNum,
      )
      if (items.length === 0) break
      const found = items.find(
        (f) =>
          (f.name === rawName ||
            f.name === decodedName ||
            String(f.id) === rawName ||
            String(f.id) === decodedName) &&
          (wantDir === undefined ? true : Boolean(f.isFolder) === wantDir),
      )
      if (found) return found
      if (pageNum * PAGE_SIZE >= recordCount) break
    }
    return null
  }

  private async resolveFolderId(physicalPath: string): Promise<string> {
    const clean = this.cleanPhysical(physicalPath)
    if (clean === "/") return this.rootFolderId
    const cached = this.pathIdCache.get(clean)
    if (cached) return cached

    const segs = clean.split("/").filter(Boolean)
    let parentId = this.rootFolderId
    let curPath = ""
    for (const seg of segs) {
      curPath = `${curPath}/${seg}`
      const hit = this.pathIdCache.get(curPath)
      if (hit) {
        parentId = hit
        continue
      }
      const child = await this.findChild(parentId, seg, true)
      if (!child) throw new Error(`[189PC] 目录未找到: ${seg}`)
      parentId = String(child.id)
      this.pathIdCache.set(curPath, parentId)
    }
    return parentId
  }

  private async resolveItem(
    physicalPath: string,
  ): Promise<{ file: Cloud189PCFile; isDir: boolean }> {
    const segs = this.cleanPhysical(physicalPath).split("/").filter(Boolean)
    if (segs.length === 0) {
      throw new Error("[189PC] 路径无效")
    }
    const name = segs.pop() as string
    const parentPath = "/" + segs.join("/")
    const parentId = await this.resolveFolderId(parentPath)
    const child = await this.findChild(parentId, name)
    if (!child) throw new Error(`[189PC] 文件或目录未找到: ${name}`)
    return { file: child, isDir: Boolean(child.isFolder) }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFolderId(physicalPath)
    const allFiles = (await this.listFolder(folderId)).map(
      cloud189PCFileToFileItem,
    )

    return sortFileItems(allFiles, "name", "asc")
  }

  async link(file: FileItem): Promise<{ url: string; headers?: Record<string, string> }> {
    if (file.is_dir) {
      throw new Error("Cannot get link for directory")
    }

    const resp = await this.client.requestAPI(GetDownloadURLURL, {
      fileId: file.sign,
    })

    if (!resp || !resp.fileDownloadUrl) {
      throw new Error("Failed to get download URL")
    }

    return {
      url: resp.fileDownloadUrl,
    }
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const clean = this.cleanPhysical(physicalPath)
    if (clean === "/") {
      return {
        name: this.rootFolderId,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.rootFolderId,
        type: 1,
        raw_url: "",
      }
    }
    // F-341：physicalPath 是名称路径，必须解析成 fileId 再查询
    const { file, isDir } = await this.resolveItem(clean)
    const item = cloud189PCFileToFileItem(file)
    if (!isDir && !item.raw_url) {
      try {
        const resp = await this.client.requestAPI(GetDownloadURLURL, {
          fileId: String(file.id),
        })
        if (resp?.fileDownloadUrl) item.raw_url = resp.fileDownloadUrl
      } catch {}
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = this.cleanPhysical(physicalPath).split("/").filter(Boolean)
    const dirName = parts.pop() || ""
    const parentDir = "/" + parts.join("/")
    const parentFolderId = await this.resolveFolderId(parentDir)
    const resp = await this.client.requestAPI(CreateFolderURL, {
      parentFolderId,
      folderName: dirName,
    })

    if (!resp || resp.id === undefined) {
      throw new Error("Failed to create folder")
    }
    this.invalidatePathCache(this.cleanPhysical(physicalPath))
  }

  private async copyTo(srcId: string, dstFolderId: string): Promise<void> {
    await this.client.requestAPI("/open/file/copyFile.action", {
      fileId: srcId,
      destFolderId: dstFolderId,
    })
  }

  private async deleteById(fileId: string): Promise<void> {
    await this.client.requestAPI(DeleteFileURL, {
      fileId,
    })
  }

  /**
   * 计算目标父目录的物理路径（F-341）：dstPhys 是目标条目自身的物理路径，
   * 去掉末段即目标文件夹；缺省时回退到虚拟 dstDir。
   */
  private targetParentPath(dstPhys: string, dstDir: string): string {
    const segs = this.cleanPhysical(dstPhys || dstDir)
      .split("/")
      .filter(Boolean)
    if (dstPhys) segs.pop()
    return "/" + segs.join("/")
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // 189PC doesn't have a direct move API, use copy + delete
    const { file } = await this.resolveItem(srcPhys)
    const targetParentId = await this.resolveFolderId(
      this.targetParentPath(dstPhys, dstDir),
    )
    await this.copyTo(String(file.id), targetParentId)
    await this.deleteById(String(file.id))
    this.invalidatePathCache(srcPhys)
    this.invalidatePathCache(dstPhys)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    // F-341：旧签名 (srcPath, newName) 会把物理路径当 fileId、把物理路径
    // 当新文件名发给服务端。
    const { file } = await this.resolveItem(physicalPath)
    await this.client.requestAPI(RenameFileURL, {
      fileId: String(file.id),
      fileName: newName,
    })
    this.invalidatePathCache(physicalPath)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const { file } = await this.resolveItem(srcPhys)
    const targetParentId = await this.resolveFolderId(
      this.targetParentPath(dstPhys, dstDir),
    )
    await this.copyTo(String(file.id), targetParentId)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const { file } = await this.resolveItem(physicalPath)
    await this.deleteById(String(file.id))
    this.invalidatePathCache(physicalPath)
  }

  readonly rapidHashAlgos = ["md5"]
  readonly rapidHashNeedsPieces = false

  async rapidUpload(
    _virtualPath: string,
    physicalPath: string,
    metadata: { size: number; md5?: string },
  ): Promise<boolean> {
    const md5Hash = String(metadata.md5 || "").toLowerCase()
    if (!/^[0-9a-f]{32}$/.test(md5Hash) || metadata.size < 0) return false
    const pathParts = this.cleanPhysical(physicalPath)
      .split("/")
      .filter(Boolean)
    const fileName = pathParts.pop() || "upload"
    const parentFolderId = await this.resolveFolderId(
      "/" + pathParts.join("/"),
    )
    const initResp = (await this.client.requestUploadAPI(InitUploadURL, {
      parentFolderId,
      fileName,
      fileSize: metadata.size,
      fileMd5: md5Hash,
      sliceSize: DefaultChunkSize,
      lazyCheck: 1,
    })) as Cloud189PCInitMultiUploadResp
    if (initResp.fileDataExists !== 1) return false
    // 同 put() 的秒传路径：命中后必须 commit，否则会话过期、文件不会创建
    // （对齐 189_tv F-288）。
    if (!initResp.uploadFileId) {
      throw new Error("[189PC] 秒传会话缺少 uploadFileId，无法提交")
    }
    await this.client.requestUploadAPI(CommitUploadURL, {
      uploadFileId: initResp.uploadFileId,
    })
    return true
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const pathParts = this.cleanPhysical(physicalPath)
      .split("/")
      .filter(Boolean)
    const fileName = pathParts.pop() || "upload"
    const parentFolderId = await this.resolveFolderId(
      "/" + pathParts.join("/"),
    )
    const buffer = content
    const totalSize = content.length
    const md5 = calcMD5(buffer)

    // Init upload
    const initResp = await this.client.requestUploadAPI(InitUploadURL, {
      parentFolderId,
      fileName,
      fileSize: totalSize,
      fileMd5: md5,
      sliceSize: DefaultChunkSize,
      lazyCheck: 1,
    })

    const uploadResp = initResp as Cloud189PCInitMultiUploadResp

    // Check if file already exists (quick upload)
    if (uploadResp.fileDataExists === 1) {
      // 对齐 189_tv F-288 的结论：秒传命中后必须 commitUpload——只建会话不
      // commit 的话会话最终过期，文件永远不会真正创建（UI 显示秒传成功但
      // 云端没有文件）。
      if (!uploadResp.uploadFileId) {
        throw new Error("[189PC] 秒传会话缺少 uploadFileId，无法提交")
      }
      await this.client.requestUploadAPI(CommitUploadURL, {
        uploadFileId: uploadResp.uploadFileId,
      })
      this.invalidatePathCache(physicalPath)
      return
    }

    // F-349：分片布局必须与 sliceSize 声明一致（旧实现恒声明单个分片，
    // 却声明 sliceSize=10MB，且把整包当一片上传）。
    const partCount = Math.max(1, Math.ceil(totalSize / DefaultChunkSize))
    const partInfo = JSON.stringify(
      Array.from({ length: partCount }, (_, i) => ({ partNumber: i + 1 })),
    )
    const urlResp = await this.client.requestUploadAPI(GetUploadURLsURL, {
      uploadFileId: uploadResp.uploadFileId,
      partInfo,
    })

    const uploadUrlResp = urlResp as Cloud189PCUploadUrlResp

    if (
      !uploadUrlResp.uploadUrls ||
      uploadUrlResp.uploadUrls.length < partCount
    ) {
      throw new Error("Failed to get upload URLs")
    }

    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const start = (partNumber - 1) * DefaultChunkSize
      const end = Math.min(start + DefaultChunkSize, totalSize)
      const chunk = buffer.subarray(start, end)
      const formData = new FormData()
      formData.append(
        "file",
        new Blob([chunk as unknown as BlobPart]),
        fileName,
      )
      await this.client.request(uploadUrlResp.uploadUrls[partNumber - 1], {
        method: "POST",
        body: formData,
      })
    }

    // Commit upload
    await this.client.requestUploadAPI(CommitUploadURL, {
      uploadFileId: uploadResp.uploadFileId,
    })
    this.invalidatePathCache(physicalPath)
  }

  async other(_method: string, _data: Record<string, any>): Promise<any> {
    throw new Error(`Unsupported operation: ${_method}`)
  }
}
