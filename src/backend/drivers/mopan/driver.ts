// MoPan (中国移动和彩云) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/mopan
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { safeRedirectUrl } from "../../pkg/http"
import {
  MoPanAddition,
  MoPanFile,
  MoPanFolder,
  TaskFileParam,
} from "./types"
import { MoPanClient } from "./util"
import {
  TaskTypeCopy,
  TaskTypeMove,
  TaskStatusCompleted,
  TaskStatusConflict,
  TaskStatusFailed,
  createDefaultDeviceInfo,
} from "./consts"
import { md5 } from "../../pkg/crypto"

/** 列表/按名查找统一使用的页大小（F-246：请求与终止判据同源） */
const PAGE_SIZE = 100
/** 分页硬上限，避免服务端忽略 pageNum 时无限循环（F-246） */
const MAX_PAGES = 1000

function parseMoPanDate(dateStr: string): string {
  if (!dateStr) return new Date().toISOString()
  try {
    const d = new Date(dateStr)
    if (!isNaN(d.getTime())) return d.toISOString()
  } catch {}
  return new Date().toISOString()
}

function mopanFolderToFileItem(folder: MoPanFolder): FileItem {
  return {
    name: folder.name,
    size: 0,
    is_dir: true,
    modified: parseMoPanDate(folder.lastOpTime),
    sign: folder.id,
    type: 1,
    thumb: "",
    raw_url: "",
  }
}

function mopanFileToFileItem(file: MoPanFile): FileItem {
  return {
    name: file.name,
    size: file.size || 0,
    is_dir: false,
    modified: parseMoPanDate(file.lastOpTime),
    sign: file.id,
    type: calcFileType(file.name, false),
    thumb: file.icon?.smallURL || file.icon?.largeURL || "",
    raw_url: "",
    hash: file.md5 || undefined,
    hashes: file.md5 ? { md5: file.md5 } : undefined,
  }
}

export function normalizeMoPanAddition(a: any): MoPanAddition {
  const norm = { ...(a || {}) } as any
  norm.phone = (norm.phone || "").trim()
  norm.password = (norm.password || "").trim()
  norm.sms_code = (norm.sms_code || "").trim()
  norm.root_folder_id = norm.root_folder_id || ""
  norm.cloud_id = (norm.cloud_id || "").trim()
  norm.order_by = norm.order_by || "filename"
  norm.order_direction = norm.order_direction || "asc"
  norm.device_info = norm.device_info || createDefaultDeviceInfo()
  norm.upload_thread = norm.upload_thread || "3"
  return norm as MoPanAddition
}

export class MoPanDriver implements StorageDriver {
  private client: MoPanClient
  private addition: MoPanAddition
  private userId: string = ""
  private uploadThread: number = 3
  /** F-244：进行中的登录 Promise，用于合并并发 401 触发的重复登录 */
  private loginInFlight: Promise<void> | null = null

  constructor(
    addition: MoPanAddition,
    onAuthUpdate?: (deviceInfo: string, token: string) => void,
  ) {
    this.addition = normalizeMoPanAddition(addition)
    // F-250：parseInt("abc") 得 NaN，NaN<1 与 NaN>32 均为 false，旧校验会被绕过
    const parsedThread = parseInt(this.addition.upload_thread || "3", 10)
    this.uploadThread = Number.isFinite(parsedThread) ? parsedThread : 3
    if (this.uploadThread < 1 || this.uploadThread > 32) {
      this.uploadThread = 3
    }

    this.client = new MoPanClient(this.addition, async () => {
      // Re-login on authorization expired
      await this.performLogin()
      if (onAuthUpdate) {
        onAuthUpdate(
          this.client.getDeviceInfoJson(),
          this.client.getAuthorization(),
        )
      }
    })
  }

  /**
   * F-244：并发 401 只触发一次重新登录（进程内 singleflight）。
   * 登录期间关闭客户端的 401 自动重登录，避免登录接口自身返回 401 时
   * 形成 performLogin → 401 → performLogin 的无界递归。
   */
  private performLogin(): Promise<void> {
    if (!this.loginInFlight) {
      this.loginInFlight = this.doPerformLogin().finally(() => {
        this.loginInFlight = null
      })
    }
    return this.loginInFlight
  }

  private async doPerformLogin(): Promise<void> {
    this.client.setAutoRelogin(false)
    try {
      // F-248：优先复用 onAuthUpdate 持久化的 token，避免每次冷构建都做
      // 完整账密/短信登录。
      const savedToken = String(this.addition.token || "").trim()
      if (savedToken && (await this.tryRestoreSession(savedToken))) return

      const smsCode = this.addition.sms_code?.trim() || ""

      if (smsCode === "send") {
        await this.client.loginBySms(this.addition.phone)
        throw new Error("[MoPan] SMS code sent, please enter the code")
      }

      let loginData
      if (smsCode && smsCode !== "send") {
        loginData = await this.client.loginBySmsStep2(
          this.addition.phone,
          smsCode,
        )
      } else {
        loginData = await this.client.login(
          this.addition.phone,
          this.addition.password,
        )
      }

      this.client.setAuthorization(loginData.token)
      const userInfo = await this.client.getUserInfo(false)
      this.userId = userInfo.userID
      this.applyLoginData(loginData)
    } finally {
      this.client.setAutoRelogin(true)
    }
  }

  /**
   * 用持久化 token 试探会话是否仍然有效（不触发自动重登录）。
   * 成功返回 true。
   */
  private async tryRestoreSession(token: string): Promise<boolean> {
    try {
      this.client.setAuthorization(token)
      const userInfo = await this.client.getUserInfo(false)
      if (!userInfo?.userID) return false
      this.userId = userInfo.userID
      return true
    } catch {
      return false
    }
  }

  private applyLoginData(loginData: {
    token: string
    userCloudStorageRelations?: Array<{ folderID: string; path: string }>
  }): void {
    // Auto-detect root folder if not set
    if (!this.addition.root_folder_id && loginData.userCloudStorageRelations) {
      for (const rel of loginData.userCloudStorageRelations) {
        if (rel.path === "/文件") {
          this.addition.root_folder_id = rel.folderID
          break
        }
      }
    }
  }

  async init(): Promise<void> {
    await this.performLogin()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFolderId(physicalPath)
    const files: FileItem[] = []

    // Paginated listing
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.client.queryFiles(
        folderId,
        page,
        this.addition.order_by || "filename",
        this.addition.order_direction === "desc",
        this.addition.cloud_id,
        PAGE_SIZE,
      )

      if (!data.fileListAO) break

      const { folderList = [], fileList = [] } = data.fileListAO

      if (folderList.length === 0 && fileList.length === 0) break

      files.push(...folderList.map(mopanFolderToFileItem))
      files.push(...fileList.map(mopanFileToFileItem))

      // Stop if we got less than a full page
      if (folderList.length + fileList.length < PAGE_SIZE) break
    }

    return sortFileItems(
      files,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    if (parts.length === 0) {
      // Root folder
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.getRootId(),
        type: 1,
        thumb: "",
        raw_url: "",
      }
    }

    const parentPath = parts.slice(0, -1).join("/")
    const name = parts[parts.length - 1]
    const parentId = await this.resolveFolderId(parentPath)

    // Search in parent folder (F-247: 逐页查找，不再只看第一页)
    const { folder, file } = await this.findInFolder(parentId, name)
    if (folder) return mopanFolderToFileItem(folder)

    if (file) {
      const item = mopanFileToFileItem(file)
      // Get download URL
      const dlResp = await this.client
        .getFileDownloadUrl(file.id, this.addition.cloud_id)
        .catch(() => null)
      if (dlResp?.downloadUrl) {
        let url = dlResp.downloadUrl.replace(/&amp;/g, "&")
        url = url.replace(/^http:/, "https:")
        // Follow redirect to get actual URL
        const redirectUrl = await this.followRedirect(url)
        item.raw_url = redirectUrl || url
      }
      return item
    }

    throw new Error(`[MoPan] File not found: ${physicalPath}`)
  }

  /**
   * 在指定目录中按名称查找子目录/文件（逐页翻找，F-247）。
   */
  private async findInFolder(
    folderId: string,
    name: string,
  ): Promise<{ folder?: MoPanFolder; file?: MoPanFile }> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.client.queryFiles(
        folderId,
        page,
        "filename",
        false,
        this.addition.cloud_id,
        PAGE_SIZE,
      )
      if (!data.fileListAO) break

      const { folderList = [], fileList = [] } = data.fileListAO

      const folder = folderList.find((f) => f.name === name)
      if (folder) return { folder }
      const file = fileList.find((f) => f.name === name)
      if (file) return { file }

      if (folderList.length + fileList.length < PAGE_SIZE) break
    }
    return {}
  }

  private async followRedirect(url: string): Promise<string | null> {
    try {
      const res = await fetch(url, { redirect: "manual" })
      if (res.status === 302 || res.status === 301) {
        const loc = res.headers.get("location")
        return loc ? safeRedirectUrl(loc, url) || url : url
      }
      return url
    } catch {
      return null
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "新文件夹"
    const parentPath = parts.join("/")
    const parentId = await this.resolveFolderId(parentPath)

    await this.client.createFolder(name, parentId, this.addition.cloud_id)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const item = await this.get("", physicalPath)
    if (item.is_dir) {
      await this.client.renameFolder(
        item.sign,
        newName,
        this.addition.cloud_id,
      )
    } else {
      await this.client.renameFile(item.sign, newName, this.addition.cloud_id)
    }
  }

  /**
   * F-252：srcPhys/dstPhys 的语义（「目标项自身的物理路径，不再拼 names」）
   * 只由驱动侧注释维系，接口层（StorageDriver）没有约束。这里用 names[0]
   * 做一次运行时自检：末段与目标名一致 → 按「项路径」取父目录；不一致 →
   * 按「目标文件夹本身」处理，避免两种解读下把文件搬到祖父目录。
   */
  private async resolveTargetFolderId(
    dstPhys: string,
    names: string[],
  ): Promise<string> {
    const segs = String(dstPhys || "").split("/").filter(Boolean)
    const name = names?.[0] || ""
    if (!name || (segs.length > 0 && segs[segs.length - 1] === name)) {
      segs.pop()
    }
    return this.resolveFolderId(segs.join("/"))
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 是源/目标项自身的物理路径（op/storage.ts moveItems 逐项调用），
    // 参数即目标项路径，不得再拼 name，否则指向 `<item>/<name>` 这种不存在的路径。
    // 目标文件夹取 dstPhys 去掉末段后的父目录。
    const srcItem = await this.get(srcDir, srcPhys)
    const dstFolderId = await this.resolveTargetFolderId(dstPhys, names)

    await this.performBatchTask(srcItem, dstFolderId, TaskTypeMove)
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // 同 move：srcPhys/dstPhys 已是目标项自身路径，参数即目标项路径，不得再拼 name。
    const srcItem = await this.get(srcDir, srcPhys)
    const dstFolderId = await this.resolveTargetFolderId(dstPhys, names)

    await this.performBatchTask(srcItem, dstFolderId, TaskTypeCopy)
  }

  private async performBatchTask(
    srcItem: FileItem,
    targetFolderId: string,
    taskType: number,
  ): Promise<void> {
    const fileParam: TaskFileParam = {
      fileID: srcItem.sign,
      isFolder: srcItem.is_dir,
      fileName: srcItem.name,
    }

    const taskParam = {
      userOrCloudID: this.userId,
      source: 1,
      taskType,
      targetSource: 1,
      targetUserOrCloudID: this.userId,
      targetType: 1,
      targetFolderID: targetFolderId,
      taskStatusDetailDTOList: [fileParam],
    }

    if (this.addition.cloud_id) {
      taskParam.userOrCloudID = this.addition.cloud_id
      taskParam.source = 2
      taskParam.targetSource = 2
      taskParam.targetUserOrCloudID = this.addition.cloud_id
    }

    const task = await this.client.addBatchTask(taskParam)

    // F-249：taskIDList 为空时 taskId 会是 undefined，请求体里字段被
    // JSON.stringify 丢弃，产生语义不明的错误。这里直接报「任务未创建」。
    const taskId = task?.taskIDList?.[0]
    if (!taskId) {
      throw new Error("[MoPan] Task was not created (empty taskIDList)")
    }

    // Poll task status
    for (let i = 0; i < 10; i++) {
      const stat = await this.client.checkBatchTask({
        taskId,
        taskType: task.taskType,
        targetType: 1,
        targetFolderID: task.targetFolderID,
        targetSource: taskParam.targetSource,
        targetUserOrCloudID: taskParam.targetUserOrCloudID,
      })

      if (stat.taskStatus === TaskStatusConflict) {
        await this.client.cancelBatchTask(stat.taskID, task.taskType)
        throw new Error("[MoPan] File name conflict")
      }

      // F-249：失败终态立即报错，不再空转 10 秒后报误导性的 timeout
      if (stat.taskStatus === TaskStatusFailed) {
        throw new Error(`[MoPan] Task ${taskId} failed`)
      }

      if (stat.taskStatus === TaskStatusCompleted) {
        return
      }

      // Wait 1 second before next check
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    throw new Error("[MoPan] Task timeout")
  }

  async remove(_virtualPath: string, physicalPath: string): Promise<void> {
    const item = await this.get("", physicalPath)
    await this.client.deleteToRecycle(
      [
        {
          fileID: item.sign,
          isFolder: item.is_dir,
          fileName: item.name,
        },
      ],
      this.addition.cloud_id,
    )
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const pathParts = physicalPath.split("/").filter(Boolean)
    const fileName = pathParts.pop() || "未命名文件"
    const parentPath = pathParts.join("/")
    const parentId = await this.resolveFolderId(parentPath)

    const fileBuffer = content
    const fileMd5 = md5(fileBuffer)
    const totalSize = content.length

    // Init multi-part upload
    const initData = await this.client.initMultiUpload(
      fileMd5,
      fileName,
      totalSize,
      parentId,
      this.addition.cloud_id,
    )

    if (!initData.fileDataExists) {
      // Upload parts
      const uploadParts = await this.client.getAllMultiUploadUrls(
        initData.uploadFileID,
        initData.partInfos,
      )

      const uploadPart = async (part: (typeof uploadParts)[number]) => {
        const start = (part.partNumber - 1) * initData.partSize
        const end =
          part.partNumber === uploadParts.length
            ? totalSize
            : start + initData.partSize
        const chunk = fileBuffer.slice(start, end)

        // F-245：分片 PUT 是上传链路唯一的数据校验点，非 2xx 必须立刻抛错，
        // 不能让失败的片子被静默吞掉后照常 commit。
        const res = await fetch(part.uploadUrl, {
          method: "PUT",
          body: chunk as unknown as BodyInit,
          headers: {
            "Content-Length": String(chunk.length),
          },
        })
        if (!res.ok) {
          const detail = await res.text().catch(() => "")
          throw new Error(
            `[MoPan] 上传分片 ${part.partNumber}/${uploadParts.length} 失败: HTTP ${res.status} ${detail.slice(0, 200)}`,
          )
        }
      }

      // F-250：按 upload_thread 做有限并发（此前配置被解析后从未使用）
      for (let i = 0; i < uploadParts.length; i += this.uploadThread) {
        await Promise.all(
          uploadParts.slice(i, i + this.uploadThread).map(uploadPart),
        )
      }
    }

    // Commit upload
    await this.client.commitMultiUploadFile(initData.uploadFileID)
  }

  private getRootId(): string {
    return this.addition.root_folder_id || ""
  }

  private async resolveFolderId(physicalPath: string): Promise<string> {
    const rootId = this.getRootId()
    const parts = physicalPath.split("/").filter(Boolean)

    if (parts.length === 0) {
      return rootId
    }

    let currentId = rootId

    for (const part of parts) {
      // F-247：逐页查找子目录，超一页的目录不再误报 Folder not found
      const { folder } = await this.findInFolder(currentId, part)
      if (!folder) {
        throw new Error(`[MoPan] Folder not found: ${part}`)
      }

      currentId = folder.id
    }

    return currentId
  }
}
