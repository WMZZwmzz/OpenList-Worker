// 123 Cloud Drive (123Pan) driver
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/123
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { Pan123Addition, Pan123File, Pan123UploadResp } from "./types"
import { Pan123Client } from "./util"

/** 分片会话上传：会话令牌中携带的数据（不透明地往返于前后端） */
interface Pan123SessionData {
  bucket: string
  key: string
  uploadId: string
  fileId: number
  storageNode: string
  size: number
  partCount: number
  chunkSize: number
}

function encodeSession(s: Pan123SessionData): string {
  return Buffer.from(JSON.stringify(s), "utf8").toString("base64")
}

function decodeSession(token: string): Pan123SessionData {
  const s = JSON.parse(Buffer.from(token, "base64").toString("utf8"))
  if (!s || !s.bucket || !s.key || !s.uploadId) {
    throw new Error("[123Pan] invalid upload session")
  }
  return s as Pan123SessionData
}

function sessionToUpload(s: Pan123SessionData): Pan123UploadResp["data"] {
  return {
    AccessKeyId: "",
    SecretAccessKey: "",
    SessionToken: "",
    Bucket: s.bucket,
    Key: s.key,
    UploadId: s.uploadId,
    FileId: s.fileId,
    StorageNode: s.storageNode,
    EndPoint: "",
    Reuse: false,
  }
}

/**
 * 分片会话的**运行期观测状态**。
 *
 * 分片大小契约由调用方掌握：fs 的 /multipart/* 按前端 X-Chunk-Size
 * （缺省 10MB、上限 64MB）切片，seed 按 8MB 切片，两者都不会读取驱动返回的
 * chunkSize/partCount。因此驱动绝不能按自己的名义 16MB 去声明
 * partCount/isMultipart —— 否则 10MB<size≤16MB 会被声明为单片（实际两片），
 * 收尾 isMultipart=false 但已 PUT 两片，文件被截断/上传失败。
 *
 * 这里按**实际收到的分片**记录片号与字节数：
 *   - 单/多分片判定：partNumber>1 或 单片长度<size → 多分片；
 *   - complete 时用各片字节之和校验总大小，并据此给出 isMultipart。
 * 状态与 fs 的会话管理器同为进程内状态（分片请求必须命中同一 isolate 才能
 * 取到会话），生命周期一致。
 */
interface Pan123ObservedUpload {
  /** partNumber → 该片实际字节数（重复上传同一片时覆盖，不重复累计） */
  partBytes: Map<number, number>
}

const observedUploads = new Map<string, Pan123ObservedUpload>()
const MAX_OBSERVED_UPLOADS = 256

function observedKey(s: Pan123SessionData): string {
  return `${s.key}|${s.uploadId}`
}

function observePart(
  s: Pan123SessionData,
  partNumber: number,
  contentLength: number,
): Pan123ObservedUpload {
  const key = observedKey(s)
  let state = observedUploads.get(key)
  if (!state) {
    state = { partBytes: new Map() }
    if (observedUploads.size >= MAX_OBSERVED_UPLOADS) {
      const oldest = observedUploads.keys().next().value
      if (oldest !== undefined) observedUploads.delete(oldest)
    }
    observedUploads.set(key, state)
  }
  state.partBytes.set(partNumber, contentLength)
  return state
}

function pan123FileToFileItem(f: Pan123File): FileItem {
  const isDir = f.Type === 1
  return {
    name: f.FileName,
    size: f.Size || 0,
    is_dir: isDir,
    modified: f.UpdateAt
      ? new Date(f.UpdateAt).toISOString()
      : new Date().toISOString(),
    sign: String(f.FileId),
    type: calcFileType(f.FileName, isDir),
    thumb: "",
    raw_url: "",
  }
}

/** 单次调用允许的子请求预算（Cloudflare 免费版硬上限 50，留 5 次余量） */
const SUBREQUEST_LIMIT = 45

/**
 * F-193：子请求预算必须是**调用局部**对象。
 *
 * 驱动实例被 op 层按 storageId+modified 跨请求缓存复用，把 `{used,limit}`
 * 挂在实例上会让并发请求互相 reset/累加——后到者的 reset 清掉先到者已消耗的
 * 计数（击穿 50 次上限），或双方共用同一计数被提前截断（目录列表静默缺失
 * 且被写入文件树缓存）。因此每个入口方法各自创建一个预算对象并向下传递。
 */
interface SubrequestBudget {
  used: number
  limit: number
}

function newBudget(): SubrequestBudget {
  return { used: 0, limit: SUBREQUEST_LIMIT }
}

export class Pan123Driver implements StorageDriver {
  readonly rapidHashAlgos = ["md5"]
  readonly rapidHashNeedsPieces = false

  private client: Pan123Client
  private addition: Pan123Addition
  /** cache: physical path → folder FileId (string) */
  private pathIdCache = new Map<string, string>()

  constructor(
    addition: Pan123Addition,
    onTokenUpdate?: (token: string) => void,
  ) {
    // 官方驱动方式：必填 123 网盘手机号 + 密码登录（无默认令牌）。
    // access_token 为登录后自动持久化的会话令牌（可选，用户无需手动填写）。
    this.addition = addition
    this.client = new Pan123Client(addition, onTokenUpdate)
  }

  async init(): Promise<void> {
    await this.client.login()
  }

  /**
   * Resolve a physical path ("0/a/b") to the FileId of its last folder.
   * Walks the tree from the root id, listing each level to find the
   * folder by name, caching results. Each level consumes at most one
   * page of subrequests (findName early-termination).
   */
  private async resolveFolderId(
    physicalPath: string,
    budget: SubrequestBudget,
  ): Promise<string> {
    const rootId = this.client.getRootId()
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    // F-199：物理路径是相对 root_id 的，不带 rootId 段。只有 "/" 是根；
    // 把 "/<rootId>" 也当根会让顶层同名目录永远打不开。
    if (clean === "/") {
      return rootId
    }

    // Find the longest cached prefix
    const segs = clean.split("/").filter(Boolean)
    let cachedLen = 0
    let parentId = rootId
    let prefix = ""
    for (let i = 0; i < segs.length; i++) {
      const p = "/" + segs.slice(0, i + 1).join("/")
      const id = this.pathIdCache.get(p)
      if (id !== undefined) {
        parentId = id
        cachedLen = i + 1
        prefix = p
      } else {
        break
      }
    }

    for (let i = cachedLen; i < segs.length; i++) {
      const rawName = segs[i]
      const decodedName = (() => {
        try {
          return decodeURIComponent(rawName)
        } catch {
          return rawName
        }
      })()

      const files = await this.client.getFiles(parentId, {
        findName: decodedName,
        findIsDir: true,
        budget,
      })
      const folder = files.find(
        (f) =>
          f.Type === 1 &&
          (f.FileName === rawName ||
            f.FileName === decodedName ||
            String(f.FileId) === rawName ||
            String(f.FileId) === decodedName),
      )
      if (!folder) {
        throw new Error(`folder not found: ${rawName}`)
      }
      parentId = String(folder.FileId)
      prefix = "/" + segs.slice(0, i + 1).join("/")
      this.pathIdCache.set(prefix, parentId)
    }
    return parentId
  }

  /**
   * 上传场景：确保目录存在，缺失的层级自动递归创建。
   * 与 resolveFolderId 的区别是——目录不存在时不抛 "folder not found"，
   * 而是调用 mkdir 创建。用于上传文件夹 / 上传到尚不存在的子目录。
   */
  private async ensureFolderId(
    physicalPath: string,
    budget: SubrequestBudget,
  ): Promise<string> {
    const rootId = this.client.getRootId()
    const clean =
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    // F-199：物理路径是相对 root_id 的，不带 rootId 段。只有 "/" 是根；
    // 把 "/<rootId>" 也当根会让顶层同名目录永远打不开。
    if (clean === "/") {
      return rootId
    }

    const segs = clean.split("/").filter(Boolean)
    let parentId = rootId
    let prefix = ""
    for (let i = 0; i < segs.length; i++) {
      const rawName = segs[i]
      const decodedName = (() => {
        try {
          return decodeURIComponent(rawName)
        } catch {
          return rawName
        }
      })()
      prefix = "/" + segs.slice(0, i + 1).join("/")

      let id = this.pathIdCache.get(prefix)
      if (id === undefined) {
        let files = await this.client.getFiles(parentId, {
          findName: decodedName,
          findIsDir: true,
          budget,
        })
        let folder = files.find(
          (f) =>
            f.Type === 1 &&
            (f.FileName === rawName || f.FileName === decodedName),
        )
        if (folder) {
          id = String(folder.FileId)
        } else {
          // 目录不存在：创建。并发上传多个文件时可能被别的请求抢先创建，
          // mkdir 报"已存在"则忽略，随后重新查询拿到 FileId。
          try {
            const createdId = await this.client.mkdir(parentId, decodedName)
            if (createdId) {
              id = createdId
            }
          } catch {
            // ignore: directory may already exist
          }
          if (id === undefined) {
            files = await this.client.getFiles(parentId, {
              findName: decodedName,
              findIsDir: true,
              budget,
            })
            folder = files.find(
              (f) => f.Type === 1 && f.FileName === decodedName,
            )
            if (!folder) {
              throw new Error(`[123Pan] 自动创建目录失败: ${rawName}`)
            }
            id = String(folder.FileId)
          }
        }
        this.pathIdCache.set(prefix, id)
      }
      parentId = id
    }
    return parentId
  }

  /**
   * Resolve a physical path to a file: parent folder id + matching file.
   * physicalPath segments: rootId/name1/name2/.../targetName
   */
  private async resolveFile(
    physicalPath: string,
    budget: SubrequestBudget,
  ): Promise<{
    file: Pan123File
    parentId: string
    name: string
  }> {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    if (segs.length === 0) throw new Error("invalid path")
    const rawName = segs[segs.length - 1]
    const decodedName = (() => {
      try {
        return decodeURIComponent(rawName)
      } catch {
        return rawName
      }
    })()
    const parentPath = "/" + segs.slice(0, segs.length - 1).join("/")
    const parentId = await this.resolveFolderId(parentPath, budget)
    const files = await this.client.getFiles(parentId, {
      findName: decodedName,
      budget,
    })
    const file = files.find(
      (f) =>
        String(f.FileId) === rawName ||
        String(f.FileId) === decodedName ||
        f.FileName === rawName ||
        f.FileName === decodedName,
    )
    if (!file) throw new Error(`file not found: ${rawName}`)
    return { file, parentId, name: rawName }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    // F-193：预算为调用局部对象，绝不共享实例状态
    const budget = newBudget()
    const folderId = await this.resolveFolderId(physicalPath, budget)
    const files = await this.client.getFiles(folderId, { budget })
    const items = files.map(pan123FileToFileItem)
    return sortFileItems(
      items,
      this.addition.order_by || "file_name",
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const budget = newBudget()
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    // Storage root → folder。
    // F-199：只有「路径为空」才是根。此前用「最后一段 == rootId」判定，会把
    // 顶层名为 "0"（默认 root_id）的条目误判成根目录——该条目既拿不到元信息
    // 也无法下载。
    if (segs.length === 0) {
      const rootId = this.client.getRootId()
      return {
        name: rootId,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: rootId,
        type: 1,
        raw_url: "",
      }
    }

    const { file } = await this.resolveFile(physicalPath, budget)
    const item = pan123FileToFileItem(file)
    if (file.Type !== 1) {
      try {
        item.raw_url = await this.client.getDownloadLink(file)
        if (!item.raw_url) {
          item.raw_url_error =
            "123 网盘未返回下载链接（DownloadUrl 为空）。常见原因：access_token/cookie 失效，或该文件已删除/被限制下载。请到管理后台更新 access_token 后重试。"
        }
      } catch (e: any) {
        item.raw_url_error =
          `123 网盘获取下载链接失败：${e?.message || String(e)}。` +
          (String(e?.message || "").includes("登录失败")
            ? "当前部署出口 IP 可能被 123 风控，请配置有效的 access_token（浏览器登录 123 网盘后复制 Bearer 令牌）。"
            : "请检查 access_token/cookie 是否有效，或在 123 网盘网页端确认该文件可下载。")
        console.warn(
          `[123Pan] getDownloadLink warning for ${file.FileName}:`,
          e.message,
        )
      }
    } else {
      item.raw_url_error = "该条目是文件夹，不可作为文件下载。"
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const budget = newBudget()
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    const dirName = segs.pop() || "新文件夹"
    const parentPath = "/" + segs.join("/")
    const parentId = await this.resolveFolderId(parentPath, budget)
    await this.client.mkdir(parentId, dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const budget = newBudget()
    const { file } = await this.resolveFile(physicalPath, budget)
    await this.client.rename(String(file.FileId), newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const budget = newBudget()
    const { file } = await this.resolveFile(physicalPath, budget)
    await this.client.remove(String(file.FileId), file)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const budget = newBudget()
    const { file } = await this.resolveFile(srcPhysical, budget)
    const dstParts = String(dstDir).split("/").filter(Boolean)
    const targetParentId = await this.resolveFolderId("/" + dstParts.join("/"), budget)
    await this.client.move([String(file.FileId)], targetParentId)
  }

  async copy(): Promise<void> {
    throw new Error("[123Pan] Copy is not supported by 123 Cloud Drive API")
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const budget = newBudget()
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    if (segs.length === 0) throw new Error("invalid upload path")
    const rawName = segs[segs.length - 1]
    const decodedName = (() => {
      try {
        return decodeURIComponent(rawName)
      } catch {
        return rawName
      }
    })()
    const parentPath = "/" + segs.slice(0, segs.length - 1).join("/")
    const parentId = await this.ensureFolderId(parentPath, budget)
    await this.client.uploadFile(parentId, decodedName, content)
  }

  // ---- 分片会话上传（解决大文件整体缓冲导致的内存/请求体超限卡死）----

  /**
   * 创建分片上传会话。前端逐片上传，每片独立 HTTP 请求：
   * Worker 内存占用恒定（单片大小），不受 CF 请求体/内存上限约束，
   * 且浏览器端能看到每片的真实上传进度。
   * @param physicalDir 目标目录的物理路径（不含文件名）
   * @param fileName 文件名
   * @param size 文件总字节数
   * @param md5 文件 MD5（启用秒传时由前端计算；可为空）
   */
  async createUploadSession(
    _virtualDir: string,
    physicalDir: string,
    fileName: string,
    size: number,
    md5: string,
  ): Promise<{
    reuse: boolean
    partCount: number
    chunkSize: number
    session: string
  }> {
    const budget = newBudget()
    const parentId = await this.ensureFolderId(physicalDir || "/", budget)
    const upload = await this.client.createUpload(
      fileName,
      parentId,
      size,
      md5 || "",
    )
    // 名义分片大小仅用于会话令牌的兜底 partCount：调用方（fs / seed）按
    // 自己的分片大小切片且不读取该值，真正的单/多分片判定在 uploadPart /
    // completeUploadSession 中按实际收到的分片完成（见 Pan123ObservedUpload）。
    const chunkSize = 16 * 1024 * 1024 // 16MB
    // 秒传命中或未分配 Key：文件已存在，无需实际上传
    if (upload.Reuse || upload.Key === "") {
      return { reuse: true, partCount: 0, chunkSize, session: "" }
    }
    const partCount = Math.max(1, Math.ceil(size / chunkSize))
    const session = encodeSession({
      bucket: upload.Bucket,
      key: upload.Key,
      uploadId: upload.UploadId,
      fileId: upload.FileId,
      storageNode: upload.StorageNode,
      size,
      partCount,
      chunkSize,
    })
    return { reuse: false, partCount, chunkSize, session }
  }

  /**
   * 上传单个分片：获取该片的预签名 URL 并把内容转发给 123pan。
   *
   * 调用方的实际分片大小可能与本驱动名义上的 16MB 不同（fs 默认 10MB、
   * seed 8MB、前端可配置到 64MB），因此这里按实际内容推断片数：
   * 只有「第 1 片且长度等于文件大小」才是单文件上传，其余一律走分片预签名
   * 接口。completeUploadSession 使用同一份观测状态判定 isMultipart。
   */
  async uploadPart(
    session: string,
    partNumber: number,
    content: Buffer,
  ): Promise<void> {
    const s = decodeSession(session)
    if (!Number.isInteger(partNumber) || partNumber < 1) {
      throw new Error(`[123Pan] 分片序号无效: ${partNumber}`)
    }
    const rawLength = content?.length ?? 0
    if (rawLength > s.size) {
      throw new Error(
        `[123Pan] 第 ${partNumber} 分片大小 ${rawLength} 超过文件大小 ${s.size}`,
      )
    }
    if (rawLength === 0 && s.size > 0) {
      throw new Error(`[123Pan] 第 ${partNumber} 分片内容为空`)
    }
    const isMultipart = partNumber > 1 || rawLength < s.size
    const url = await this.client.getPartUploadUrl(
      sessionToUpload(s),
      partNumber,
      isMultipart ? 2 : 1,
    )
    const res = await fetch(url, { method: "PUT", body: content as any })
    if (res.status !== 200) {
      const text = await res.text().catch(() => "")
      throw new Error(
        `[123Pan] 上传第 ${partNumber} 分片失败：HTTP ${res.status} ${text}`,
      )
    }
    // 仅在分片真正落盘成功后登记，失败/未重试的分片会让 complete 的字节
    // 校验失败，而不是把不完整文件登记为上传成功。
    observePart(s, partNumber, rawLength)
  }

  /**
   * 完成分片上传会话。
   *
   * isMultipart 以**实际收到的分片数**为准（而不是建会话时按 16MB 推算的
   * 名义 partCount），并在收尾前校验已收分片字节数之和等于文件大小，避免
   * 在分片缺失时把不完整文件登记为上传完成。
   */
  async completeUploadSession(session: string): Promise<void> {
    const s = decodeSession(session)
    const key = observedKey(s)
    const observed = observedUploads.get(key)
    let isMultipart = s.partCount > 1
    if (observed && observed.partBytes.size > 0) {
      const totalBytes = Array.from(observed.partBytes.values()).reduce(
        (sum, n) => sum + n,
        0,
      )
      if (totalBytes !== s.size) {
        throw new Error(
          `[123Pan] 分片不完整：已收 ${totalBytes} 字节，应为 ${s.size} 字节`,
        )
      }
      isMultipart = observed.partBytes.size > 1
    }
    await this.client.completeUpload(sessionToUpload(s), s.size, isMultipart)
    observedUploads.delete(key)
  }
}
