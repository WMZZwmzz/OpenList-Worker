// Tencent Weiyun Storage Driver
// Ported from OpenList: https://github.com/OpenListTeam/OpenList/tree/main/drivers/weiyun
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { WeiyunAddition, WeiyunFile, WeiyunFolder } from "./types"
import { WeiyunClient } from "./util"

const SUBREQUEST_LIMIT = 45
const UPLOAD_CHUNK_SIZE = 1024 * 1024 // 1MB per chunk
/**
 * 服务层 multipart 分片硬上限（internal/upload/multipart.ts: CHUNK_MAX）。
 * 驱动侧用它做单片长度校验；实际偏移必须按服务层真实分片大小计算，不能再
 * 假设 UPLOAD_CHUNK_SIZE（默认 10MB，见 F-165）。
 */
const MAX_UPLOAD_PART_SIZE = 64 * 1024 * 1024

interface WeiyunUploadSession {
  uploadKey: string
  ex: string
  parentDirKey: string
  pdirKey: string
  fileName: string
  size: number
  partCount: number
  chunkSize: number
  channels: { id: number; offset: number; len: number }[]
}

/**
 * 分片布局推断缓存（F-165）。
 *
 * 服务层每次请求只把 `chunkIndex + 1` 和该片字节交给驱动，不传自己的
 * chunk_size（fs.ts 忽略驱动的 info.chunkSize）。除最后一片外，每片长度
 * 恒等于服务层分片大小，因此可用已见分片的长度推断真实 chunkSize。
 * 该缓存只是本 isolate 内的推导辅助：multipart 会话本身也保存在进程内
 * Map 中，两者生命周期一致；即使缓存丢失，uploadPart 也有无状态回退。
 */
interface UploadLayout {
  chunkSize: number
  completed: boolean
}
const uploadLayouts = new Map<string, UploadLayout>()
const MAX_TRACKED_LAYOUTS = 128

function uploadLayoutKey(session: WeiyunUploadSession): string {
  return `${session.uploadKey}|${session.pdirKey}|${session.fileName}|${session.size}`
}

function rememberUploadLayout(key: string, layout: UploadLayout): void {
  uploadLayouts.delete(key)
  uploadLayouts.set(key, layout)
  while (uploadLayouts.size > MAX_TRACKED_LAYOUTS) {
    const oldest = uploadLayouts.keys().next().value
    if (oldest === undefined) break
    uploadLayouts.delete(oldest)
  }
}

/**
 * 计算某个分片在文件中的字节偏移。
 *
 * 服务层契约（fs.ts:1847-1857）：chunkSize 固定，除最后一片外每片长度
 * 恰好等于 chunkSize。据此：
 * - 已知 chunkSize：offset = (partNumber - 1) * chunkSize，最后一片用
 *   size - length 修正；
 * - 未知 chunkSize（冷启动/跨 isolate）：非末片的 partNumber * length
 *   必然小于文件大小，可据反推 chunkSize；末片则直接落在文件尾部。
 */
function computePartOffset(
  session: WeiyunUploadSession,
  partNumber: number,
  length: number,
): { offset: number; chunkSize: number } {
  const size = session.size
  if (size === 0) {
    // 空文件仅允许唯一一个空分片（服务端在 UploadPiece 时完成登记）
    if (partNumber !== 1 || length !== 0) {
      throw new Error(`[WeiYun] 空文件不接受非空分片: part ${partNumber}`)
    }
    return { offset: 0, chunkSize: 0 }
  }
  if (length <= 0) {
    throw new Error(`[WeiYun] 分片内容为空: part ${partNumber}`)
  }
  if (length > size) {
    throw new Error(`[WeiYun] 分片长度 ${length} 超过文件大小 ${size}`)
  }

  let chunkSize = uploadLayouts.get(uploadLayoutKey(session))?.chunkSize || 0
  let offset: number

  if (partNumber === 1) {
    offset = 0
  } else if (chunkSize > 0) {
    // 已知分片大小时可以精确校验：分片总数 = ceil(size / chunkSize)，
    // 非末片必须恰好 chunkSize 字节，末片必须落在文件尾部。
    const totalParts = Math.ceil(size / chunkSize)
    if (partNumber > totalParts) {
      throw new Error(
        `[WeiYun] 分片序号 ${partNumber} 超过总分片数 ${totalParts}`,
      )
    }
    if (partNumber < totalParts && length !== chunkSize) {
      throw new Error(
        `[WeiYun] 非末片长度 ${length} 必须等于分片大小 ${chunkSize}`,
      )
    }
    offset =
      partNumber === totalParts ? size - length : (partNumber - 1) * chunkSize
  } else if (partNumber * length >= size) {
    // 末片（可能短于 chunkSize）
    offset = size - length
    if (partNumber > 1 && (size - length) % (partNumber - 1) === 0) {
      chunkSize = (size - length) / (partNumber - 1)
    }
  } else {
    // 非末片：length 即服务层分片大小
    offset = (partNumber - 1) * length
    chunkSize = length
  }

  if (chunkSize <= 0 && length < size) chunkSize = length
  if (offset < 0 || offset + length > size) {
    throw new Error(
      `[WeiYun] 分片 ${partNumber} 越界: offset=${offset}, len=${length}, size=${size}`,
    )
  }
  return { offset, chunkSize }
}

/** 合并已上传字节区间，返回总覆盖字节数（用于上传完成校验） */
function mergeRanges(ranges: Array<[number, number]>): number {
  if (ranges.length === 0) return 0
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  let total = 0
  let [curStart, curEnd] = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]
    if (s <= curEnd) {
      curEnd = Math.max(curEnd, e)
      continue
    }
    total += curEnd - curStart
    curStart = s
    curEnd = e
  }
  total += curEnd - curStart
  return total
}

function encodeUploadSession(session: WeiyunUploadSession): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64")
}

function decodeUploadSession(token: string): WeiyunUploadSession {
  try {
    const session = JSON.parse(
      Buffer.from(token, "base64").toString("utf8"),
    ) as WeiyunUploadSession
    if (
      !session ||
      !session.uploadKey ||
      !session.ex ||
      !Number.isInteger(session.partCount) ||
      session.partCount < 1 ||
      !Number.isFinite(session.size) ||
      session.size < 0
    ) {
      throw new Error("invalid upload session")
    }
    return session
  } catch {
    throw new Error("[WeiYun] 上传会话无效或已损坏")
  }
}

function parseWeiyunDate(timeVal?: number | string): string {
  if (!timeVal) return new Date().toISOString()
  try {
    const num = typeof timeVal === "string" ? parseInt(timeVal, 10) : timeVal
    if (!isNaN(num) && num > 0) {
      // If unix seconds (10 digits) vs millis (13 digits)
      const ms = num < 10000000000 ? num * 1000 : num
      return new Date(ms).toISOString()
    }
    const d = new Date(timeVal)
    if (!isNaN(d.getTime())) return d.toISOString()
  } catch {}
  return new Date().toISOString()
}

function weiyunFolderToFileItem(folder: WeiyunFolder): FileItem {
  return {
    name: folder.dir_name,
    size: 0,
    is_dir: true,
    modified: parseWeiyunDate(folder.dir_mtime || folder.dir_ctime),
    sign: folder.dir_key,
    type: 1,
    thumb: "",
    raw_url: "",
  }
}

function weiyunFileToFileItem(file: WeiyunFile): FileItem {
  return {
    name: file.filename,
    size: file.file_size || 0,
    is_dir: false,
    modified: parseWeiyunDate(file.file_mtime || file.file_ctime),
    sign: file.file_id,
    type: calcFileType(file.filename, false),
    thumb: file.ext_info?.thumb_url || "",
    raw_url: "",
  }
}

export function normalizeWeiyunAddition(a: any): WeiyunAddition {
  const norm = { ...(a || {}) } as any
  norm.root_folder_id = (norm.root_folder_id || "").trim()
  norm.cookies = (norm.cookies || "").trim()
  norm.order_by = norm.order_by || "name"
  norm.order_direction = norm.order_direction || "asc"
  norm.upload_thread = norm.upload_thread || "4"
  return norm as WeiyunAddition
}

interface ResolvedFolderInfo {
  dirKey: string
  pdirKey: string
  dirName: string
}

export class WeiyunDriver implements StorageDriver {
  private client: WeiyunClient
  private addition: WeiyunAddition
  private rootFolderId = ""
  private rootPdirKey = ""
  private uploadThreads = 4

  /** Cache: physicalPath -> ResolvedFolderInfo */
  private pathFolderCache = new Map<string, ResolvedFolderInfo>()
  /** CF Workers subrequest budget */
  private budget = { used: 0, limit: SUBREQUEST_LIMIT }

  constructor(
    addition: WeiyunAddition,
    onCookieUpdate?: (cookie: string) => void,
  ) {
    this.addition = normalizeWeiyunAddition(addition)
    this.client = new WeiyunClient(this.addition, onCookieUpdate)
  }

  async init(): Promise<void> {
    const threadNum = parseInt(this.addition.upload_thread || "4", 10)
    this.uploadThreads = Math.min(
      32,
      Math.max(4, isNaN(threadNum) ? 4 : threadNum),
    )
    this.addition.upload_thread = String(this.uploadThreads)

    await this.client.refreshCtoken()

    if (!this.addition.root_folder_id) {
      const userInfo = await this.client.diskUserInfoGet()
      this.rootFolderId = userInfo.main_dir_key || userInfo.root_dir_key || ""
      this.addition.root_folder_id = this.rootFolderId
    } else {
      this.rootFolderId = this.addition.root_folder_id
    }

    if (!this.rootFolderId) {
      throw new Error("[WeiYun] Failed to obtain root folder ID")
    }

    const folders = await this.client.libDirPathGet(this.rootFolderId)
    if (!folders || folders.length === 0) {
      throw new Error(
        `[WeiYun] Invalid root directory ID: ${this.rootFolderId}`,
      )
    }

    const last = folders[folders.length - 1]
    this.rootPdirKey = last.pdir_key || ""
    this.rememberFolder("/", {
      dirKey: this.rootFolderId,
      pdirKey: this.rootPdirKey,
      dirName: last.dir_name || "root",
    })
  }

  consumePendingCookie(): string | null {
    return this.client.consumePendingCookie()
  }

  /** 消耗一次子请求预算；超限抛出可读错误而不是静默返回截断结果 */
  private reserve(): void {
    this.budget.used++
    if (this.budget.used > this.budget.limit) {
      throw new Error(
        `[WeiYun] 单次操作上游请求数超过 ${this.budget.limit} 次（Cloudflare Workers 子请求上限），` +
          `结果不完整：请拆分为更小的目录或改用其他运行时`,
      )
    }
  }

  /**
   * 失效物理路径对应的目录缓存（含所有子孙路径）。
   * 驱动实例被 driverCache 跨请求复用，rename/remove/move/mkdir 后若不清理，
   * 旧路径会持续解析到已不存在或已被替换的 dirKey（幽灵目录）。
   */
  private invalidatePathCache(targetPath: string): void {
    const clean =
      "/" +
      String(targetPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    if (clean === "/") {
      this.pathFolderCache.clear()
      return
    }
    for (const key of [...this.pathFolderCache.keys()]) {
      if (key === clean || key.startsWith(`${clean}/`)) {
        this.pathFolderCache.delete(key)
      }
    }
  }

  /** 写入路径缓存，并对总量设上限（长驻运行时防止无界增长） */
  private rememberFolder(path: string, info: ResolvedFolderInfo): void {
    this.pathFolderCache.set(path, info)
    const MAX_FOLDER_CACHE = 20000
    if (this.pathFolderCache.size <= MAX_FOLDER_CACHE) return
    for (const key of this.pathFolderCache.keys()) {
      if (this.pathFolderCache.size <= MAX_FOLDER_CACHE) break
      if (key === "/") continue
      this.pathFolderCache.delete(key)
    }
  }

  private async resolveFolder(
    physicalPath: string,
  ): Promise<ResolvedFolderInfo> {
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")

    if (clean === "/" || clean === `/${this.rootFolderId}`) {
      return {
        dirKey: this.rootFolderId,
        pdirKey: this.rootPdirKey,
        dirName: "root",
      }
    }

    if (this.pathFolderCache.has(clean)) {
      return this.pathFolderCache.get(clean)!
    }

    const segs = clean.split("/").filter(Boolean)
    let current = {
      dirKey: this.rootFolderId,
      pdirKey: this.rootPdirKey,
      dirName: "root",
    }
    let currentPath = ""

    for (let i = 0; i < segs.length; i++) {
      const rawPart = segs[i]
      const decodedPart = (() => {
        try {
          return decodeURIComponent(rawPart)
        } catch {
          return rawPart
        }
      })()

      currentPath = "/" + segs.slice(0, i + 1).join("/")
      if (this.pathFolderCache.has(currentPath)) {
        current = this.pathFolderCache.get(currentPath)!
        continue
      }

      // 分页查找子目录：单页 500 条会把第 500 项之后的目录全部漏掉
      let target: WeiyunFolder | undefined
      let start = 0
      for (;;) {
        this.reserve()
        const listData = await this.client.diskDirFileList(current.dirKey, {
          start,
          count: 500,
          getType: 1, // Only directories
        })

        const dirs = listData.dir_list || []
        target = dirs.find(
          (d) =>
            d.dir_name === rawPart ||
            d.dir_name === decodedPart ||
            d.dir_key === rawPart,
        )
        if (target) break
        start += dirs.length
        if (listData.finish_flag || dirs.length === 0) break
      }

      if (!target) {
        throw new Error(
          `[WeiYun] Directory '${rawPart}' not found in folder '${current.dirKey}'`,
        )
      }

      current = {
        dirKey: target.dir_key,
        pdirKey: current.dirKey,
        dirName: target.dir_name,
      }
      this.rememberFolder(currentPath, current)
    }

    return current
  }

  private async resolveFile(physicalPath: string): Promise<{
    file?: WeiyunFile
    folder?: WeiyunFolder
    parent: ResolvedFolderInfo
    isDir: boolean
  }> {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    if (segs.length === 0) throw new Error("[WeiYun] 路径无效")

    const rawName = segs[segs.length - 1]
    const decodedName = (() => {
      try {
        return decodeURIComponent(rawName)
      } catch {
        return rawName
      }
    })()

    const parentPath = "/" + segs.slice(0, segs.length - 1).join("/")
    const parent = await this.resolveFolder(parentPath)

    // 分页查找目标条目：单页 500 条会让第 500 项之后的文件/目录不可见
    let start = 0
    for (;;) {
      this.reserve()
      const listData = await this.client.diskDirFileList(parent.dirKey, {
        start,
        count: 500,
        getType: 0, // File and dir
      })

      const file = (listData.file_list || []).find(
        (f) =>
          f.filename === rawName ||
          f.filename === decodedName ||
          f.file_id === rawName,
      )
      if (file) {
        return { file, parent, isDir: false }
      }

      const folder = (listData.dir_list || []).find(
        (d) =>
          d.dir_name === rawName ||
          d.dir_name === decodedName ||
          d.dir_key === rawName,
      )
      if (folder) {
        return { folder, parent, isDir: true }
      }

      const pageCount =
        (listData.file_list || []).length + (listData.dir_list || []).length
      start += pageCount
      if (listData.finish_flag || pageCount === 0) break
    }

    throw new Error(`[WeiYun] 文件或目录未找到: ${rawName}`)
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    this.budget.used = 0
    const folderInfo = await this.resolveFolder(physicalPath)

    const allFolders: WeiyunFolder[] = []
    const allFiles: WeiyunFile[] = []

    let start = 0
    while (true) {
      // 预算耗尽必须显式失败：截断的目录列表会被上层写入文件树缓存，
      // 在 TTL 内持续当作完整结果返回（静默数据缺失）。
      this.reserve()

      const sortField =
        this.addition.order_by === "size"
          ? 3
          : this.addition.order_by === "updated_at"
            ? 2
            : 1
      const reverseOrder = this.addition.order_direction === "desc"

      const data = await this.client.diskDirFileList(folderInfo.dirKey, {
        start,
        count: 500,
        sortField,
        reverseOrder,
        getType: 0,
      })

      const dirs = data.dir_list || []
      const files = data.file_list || []

      for (const d of dirs) {
        d.pdir_key = folderInfo.dirKey
        allFolders.push(d)
      }
      for (const f of files) {
        f.pdir_key = folderInfo.dirKey
        allFiles.push(f)
      }

      start = allFolders.length + allFiles.length
      if (data.finish_flag || (dirs.length === 0 && files.length === 0)) {
        break
      }
    }

    const items: FileItem[] = [
      ...allFolders.map(weiyunFolderToFileItem),
      ...allFiles.map(weiyunFileToFileItem),
    ]

    return sortFileItems(
      items,
      this.addition.order_by === "size"
        ? "size"
        : this.addition.order_by === "updated_at"
          ? "updated_at"
          : "name",
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    this.budget.used = 0
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")

    if (clean === "/" || clean === `/${this.rootFolderId}`) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.rootFolderId,
        type: 1,
        raw_url: "",
      }
    }

    const { file, folder, parent, isDir } = await this.resolveFile(physicalPath)

    if (isDir && folder) {
      return weiyunFolderToFileItem(folder)
    }

    if (file) {
      const item = weiyunFileToFileItem(file)
      try {
        const downloadData = await this.client.diskFileDownload({
          ppdir_key: parent.pdirKey,
          pdir_key: parent.dirKey,
          file_id: file.file_id,
          filename: file.filename,
        })
        item.raw_url = downloadData.download_url
        item.raw_url_headers = {
          Cookie: `${downloadData.cookie_name}=${downloadData.cookie_value}`,
        }
      } catch (e: any) {
        console.warn(`[WeiYun] 获取 ${file.filename} 下载链接失败:`, e.message)
        item.raw_url_error = e.message
      }
      return item
    }

    throw new Error(`[WeiYun] 条目未找到: ${physicalPath}`)
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    this.budget.used = 0
    const parts = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const dirName = parts.pop() || "新建文件夹"
    const parentPath = "/" + parts.join("/")
    const parent = await this.resolveFolder(parentPath)

    await this.client.diskDirCreate({
      ppdir_key: parent.pdirKey,
      pdir_key: parent.dirKey,
      dir_name: dirName,
    })
    // 删除后重建同名目录时，陈旧条目会让新目录继续解析到旧 dirKey
    this.invalidatePathCache(physicalPath)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    this.budget.used = 0
    const { file, folder, parent, isDir } = await this.resolveFile(physicalPath)
    if (isDir && folder) {
      await this.client.diskDirAttrModify(
        {
          ppdir_key: parent.pdirKey,
          pdir_key: parent.dirKey,
          dir_key: folder.dir_key,
          dir_name: folder.dir_name,
        },
        newName,
      )
    } else if (file) {
      await this.client.diskFileRename(
        {
          ppdir_key: parent.pdirKey,
          pdir_key: parent.dirKey,
          file_id: file.file_id,
          filename: file.filename,
        },
        newName,
      )
    }
    // 旧路径与（可能的）新路径都必须失效，否则后续请求仍会命中改名前的映射
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    const parentPath = clean.substring(0, clean.lastIndexOf("/")) || "/"
    this.invalidatePathCache(clean)
    this.invalidatePathCache(`${parentPath === "/" ? "" : parentPath}/${newName}`)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    this.budget.used = 0
    const { file, folder, parent, isDir } = await this.resolveFile(physicalPath)
    if (isDir && folder) {
      await this.client.diskDirDelete({
        ppdir_key: parent.pdirKey,
        pdir_key: parent.dirKey,
        dir_key: folder.dir_key,
        dir_name: folder.dir_name,
      })
    } else if (file) {
      await this.client.diskFileDelete({
        ppdir_key: parent.pdirKey,
        pdir_key: parent.dirKey,
        file_id: file.file_id,
        filename: file.filename,
      })
    }
    // 删除后同一路径可能被重建：清掉该路径及其子孙的陈旧 dirKey
    this.invalidatePathCache(physicalPath)
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    this.budget.used = 0
    const {
      file,
      folder,
      parent: srcParent,
      isDir,
    } = await this.resolveFile(srcPhysical)
    // dstPhysical 是目标项自身的物理路径（含文件名），目标父目录取 dirname；
    // 虚拟 dstDir 含挂载点前缀，不能当作微云内的路径解析。
    const dstParent = await this.resolveFolder(
      this.parentPhysicalPath(dstPhysical),
    )

    if (isDir && folder) {
      await this.client.diskDirMove(
        {
          ppdir_key: srcParent.pdirKey,
          pdir_key: srcParent.dirKey,
          dir_key: folder.dir_key,
          dir_name: folder.dir_name,
        },
        {
          pdir_key: dstParent.pdirKey,
          dir_key: dstParent.dirKey,
        },
      )
    } else if (file) {
      await this.client.diskFileMove(
        {
          ppdir_key: srcParent.pdirKey,
          pdir_key: srcParent.dirKey,
          file_id: file.file_id,
          filename: file.filename,
        },
        {
          pdir_key: dstParent.pdirKey,
          dir_key: dstParent.dirKey,
        },
      )
    }
    // 源路径（及其子孙）已不存在；目标路径可能覆盖旧映射
    this.invalidatePathCache(srcPhysical)
    const movedName =
      String(srcPhysical || "")
        .split("/")
        .filter(Boolean)
        .pop() || ""
    const cleanDst = this.parentPhysicalPath(dstPhysical)
    this.invalidatePathCache(
      `${cleanDst === "/" ? "" : cleanDst}/${movedName}`,
    )
  }

  /** dstPhysical 是目标项自身的物理路径（含文件名），目标父目录取其 dirname */
  private parentPhysicalPath(physicalPath: string): string {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    segs.pop()
    return "/" + segs.join("/")
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    _srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    throw new Error("[WeiYun] 微云接口不支持复制操作 (Copy not supported)")
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const parts = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const fileName = parts.pop()
    if (!fileName) throw new Error("[WeiYun] 上传路径无效")

    const parentPath = "/" + parts.join("/")
    const parent = await this.resolveFolder(parentPath)

    const preData = await this.client.preUpload(
      parent.pdirKey,
      parent.dirKey,
      fileName,
      content.length,
      content,
      4,
      1,
    )

    if (preData.file_exist) {
      return // Fast upload succeeded
    }

    const auth = {
      upload_key: preData.upload_key || "",
      ex: preData.ex || "",
    }

    let channels = preData.channel_list || []
    if (channels.length === 0) {
      channels = [{ id: 0, offset: 0, len: content.length }]
    }

    // 协议（Go drivers/weiyun Put）：只有 upload_state === 1 才继续上传；
    // 2（完成）与 3（该通道无剩余分片）都是终止信号，下一片位置只采纳服务端
    // 返回的 channel。旧实现只在 state===2 时 break，state===3 时继续用自增
    // offset 硬灌数据（服务端已声明该通道无剩余分片），甚至死循环。
    const uploaded: Array<[number, number]> = []
    let finished = false
    outer: for (const ch of channels) {
      let cur = { ...ch }
      while (cur.offset < content.length) {
        const sliceLen = Math.min(
          cur.len || UPLOAD_CHUNK_SIZE,
          content.length - cur.offset,
        )
        const chunk = content.subarray(cur.offset, cur.offset + sliceLen)
        const res = await this.client.uploadPiece(cur, auth, chunk)
        if (res.upload_state === 2) {
          uploaded.push([cur.offset, cur.offset + chunk.length])
          finished = true
          break outer
        }
        if (res.upload_state !== 1) {
          // 该通道已终止（3 = 无剩余分片）；换下一个通道继续
          break
        }
        uploaded.push([cur.offset, cur.offset + chunk.length])
        if (!res.channel) {
          throw new Error("[WeiYun] 服务端未返回下一分片位置，上传中断")
        }
        if (res.channel.offset <= cur.offset) {
          throw new Error(
            `[WeiYun] 服务端返回的分片位置未前进 (${cur.offset} → ${res.channel.offset})，中止以避免死循环`,
          )
        }
        cur = res.channel
      }
    }

    // 校验上传完整性：所有通道终止后必须已覆盖整个文件，否则不能报成功
    const covered = mergeRanges(uploaded)
    if (!finished && covered < content.length) {
      throw new Error(
        `[WeiYun] 上传未完成: 已上传 ${covered}/${content.length} 字节（服务端提前终止了上传通道）`,
      )
    }
  }

  // ---- 分片会话上传接口（支持边缘与网页前端大文件直接分片上传） ----

  async createUploadSession(
    _virtualDir: string,
    physicalDir: string,
    fileName: string,
    size: number,
    _md5?: string,
  ): Promise<{
    reuse: boolean
    partCount: number
    chunkSize: number
    session: string
  }> {
    this.budget.used = 0
    const parent = await this.resolveFolder(physicalDir || "/")
    const realSize = Math.max(0, Number(size) || 0)
    // partCount 只是上限（服务层自己按 X-Chunk-Size clamp 后的 chunkSize
    // 计算 totalChunks；驱动返回值被 fs.ts 忽略）。以 1MB 估算保证
    // partNumber 校验不会误拒合法分片。
    const chunkSize = UPLOAD_CHUNK_SIZE
    const partCount = Math.max(1, Math.ceil(realSize / chunkSize))

    let preData
    if (realSize === 0) {
      // 空文件：此刻内容就是完整文件，哈希真实可算，允许正常的秒传探测。
      preData = await this.client.preUpload(
        parent.pdirKey,
        parent.dirKey,
        fileName,
        0,
        new Uint8Array(0),
        4,
        1,
      )
      if (preData.file_exist) {
        return { reuse: true, partCount: 0, chunkSize, session: "" }
      }
    } else {
      // F-166：init 阶段只有 size、没有字节，任何块哈希都只能是伪造的。
      // 改为「无哈希上传」申请会话，并关闭 file_exist 探测（没有哈希的
      // 探测结果不可信，绝不能据此返回 reuse 谎报上传成功）。
      preData = await this.client.preUpload(
        parent.pdirKey,
        parent.dirKey,
        fileName,
        realSize,
        undefined,
        4,
        0,
        { omitHash: true },
      )
    }

    const auth = {
      upload_key: preData.upload_key || "",
      ex: preData.ex || "",
    }
    if (!auth.upload_key) {
      // 没有 upload_key 的会话无法上传任何分片，直接失败而不是返回一个
      // 后续必定被 decodeUploadSession 拒绝的 token。
      throw new Error("[WeiYun] 上传会话未获得 upload_key")
    }

    let channels = preData.channel_list || []
    if (channels.length < this.uploadThreads && auth.upload_key) {
      try {
        const addCh = await this.client.addUploadChannel(
          channels.length,
          this.uploadThreads,
          auth,
        )
        if (addCh.channels) {
          channels = [...channels, ...addCh.channels]
        }
      } catch {}
    }

    return {
      reuse: false,
      partCount,
      chunkSize,
      session: encodeUploadSession({
        uploadKey: auth.upload_key,
        ex: auth.ex,
        parentDirKey: parent.pdirKey,
        pdirKey: parent.dirKey,
        fileName,
        size: realSize,
        partCount,
        chunkSize,
        channels,
      }),
    }
  }

  async uploadPart(
    sessionToken: string,
    partNumber: number,
    content: Buffer,
  ): Promise<{ partNumber: number }> {
    const session = decodeUploadSession(sessionToken)
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > session.partCount
    ) {
      throw new Error(`[WeiYun] 分片序号无效: ${partNumber}`)
    }
    if (content.length > MAX_UPLOAD_PART_SIZE) {
      throw new Error(
        `[WeiYun] 分片长度 ${content.length} 超过服务层上限 ${MAX_UPLOAD_PART_SIZE}`,
      )
    }

    const key = uploadLayoutKey(session)
    const existing = uploadLayouts.get(key)
    if (existing?.completed) {
      throw new Error(`[WeiYun] 上传会话已由服务端标记完成，拒绝继续写入`)
    }

    const { offset, chunkSize } = computePartOffset(
      session,
      partNumber,
      content.length,
    )
    if (chunkSize > 0 && content.length > chunkSize) {
      throw new Error(
        `[WeiYun] 分片 ${partNumber} 长度 ${content.length} 超过分片大小 ${chunkSize}`,
      )
    }
    if (chunkSize > 0) {
      rememberUploadLayout(key, {
        chunkSize,
        completed: existing?.completed || false,
      })
    }

    // 通道 id 必须来自 preUpload/AddChannel 实际分配的通道，按分片轮转；
    // 旧实现直接使用 partNumber-1，分片数超过通道数后 id 越界。
    const channelList = session.channels?.length
      ? session.channels
      : [{ id: 0 }]
    const channelId = channelList[(partNumber - 1) % channelList.length].id ?? 0
    const channel = {
      id: channelId,
      offset,
      len: content.length,
    }

    const auth = {
      upload_key: session.uploadKey,
      ex: session.ex,
    }

    const res = await this.client.uploadPiece(channel, auth, content)
    if (res.upload_state === 2) {
      rememberUploadLayout(key, {
        chunkSize: chunkSize || content.length,
        completed: true,
      })
    }
    return { partNumber }
  }

  async completeUploadSession(
    _sessionToken: string,
    _partTokens: any[] = [],
  ): Promise<void> {
    // Weiyun commits chunks incrementally during UploadPiece; no separate commit call required
  }
}
