// 天翼云盘 TV/家庭云 API 客户端（HMAC-SHA1 签名 + AccessToken 登录）
import {
  Driver189TVAddition,
  AppSessionResp,
  Cloud189TVFile,
  Cloud189TVFolder,
  Cloud189TVFilesResp,
  RespErr,
  CreateBatchTaskResp,
  BatchTaskStateResp,
  BatchTaskInfo,
  CreateUploadFileResp,
  DownResp,
} from "./types"
import { hmacSha1Hex, md5Hex, randomUUID189 } from "../189/crypto"

// 协议级固定签名密钥：从天翼云盘 TV/家庭云客户端逆向得到，服务端固定校验、全网共享，
// 并非可申请替换的 OAuth 凭据，删除会导致 HMAC 签名校验失败、驱动不可用。
const TVAppKey = "600100885"
const TVAppSignatureSecre = "fe5734c74c2f96a38157f420b32dc995"
const TvVersion = "6.5.5"
const AndroidTV = "FAMILY_TV"
const TvChannelId = "home02"
const ApiUrl = "https://api.cloud.189.cn"

const UA = "EcloudTV/6.5.5 (PJX110; unknown; home02) Android/35"

function clientSuffix(): Record<string, string> {
  return {
    clientType: AndroidTV,
    version: TvVersion,
    channelId: TvChannelId,
    clientSn: "unknown",
    model: "PJX110",
    osFamily: "Android",
    osVersion: "35",
    networkAccessMode: "WIFI",
    telecomsOperator: "46011",
  }
}

function urlPath(fullUrl: string): string {
  try {
    return new URL(fullUrl).pathname
  } catch {
    return fullUrl
  }
}

export function sessionKeySignatureOfHmac(
  sessionSecret: string,
  sessionKey: string,
  operate: string,
  fullUrl: string,
  dateOfGmt: string,
): string {
  const data = `SessionKey=${sessionKey}&Operate=${operate}&RequestURI=${urlPath(fullUrl)}&Date=${dateOfGmt}`
  return hmacSha1Hex(data, sessionSecret).toUpperCase()
}

export function appKeySignatureOfHmac(
  appSignatureSecret: string,
  appKey: string,
  operate: string,
  fullUrl: string,
  timestamp: number,
): string {
  const data = `AppKey=${appKey}&Operate=${operate}&RequestURI=${urlPath(fullUrl)}&Timestamp=${timestamp}`
  return hmacSha1Hex(data, appSignatureSecret).toUpperCase()
}

/**
 * 保护 JSON 中大整数 ID（int64 超 JS 安全整数）。
 * 除了 "id" 之外，上传协议里的 uploadFileId 同样是 int64（Go 侧 UploadFileId int64），
 * 精度丢失后会被写进 PUT 请求头 / 提交表单，指向不存在的上传会话。
 */
function parseJsonPreservingIds(text: string): any {
  const protectedText = text.replace(
    /("(?:id|uploadFileId)"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g,
    '$1"$2"',
  )
  return JSON.parse(protectedText)
}

function hasError(data: RespErr): boolean {
  const rc = data.res_code
  if (typeof rc === "number") return rc !== 0
  if (typeof rc === "string") return rc !== "" && rc !== "0"
  if (data.code && data.code !== "SUCCESS") return true
  if (data.errorCode) return true
  if (data.error) return true
  return false
}

function toFamilyOrderBy(o: string): string {
  switch (o) {
    case "filename":
      return "1"
    case "filesize":
      return "2"
    case "lastOpTime":
      return "3"
    default:
      return "1"
  }
}

function toDesc(o: string): string {
  return o === "desc" ? "true" : "false"
}

export class Client189TV {
  private addition: Driver189TVAddition
  private tokenInfo: AppSessionResp | null = null
  private persistAccessToken?: (accessToken: string) => void | Promise<void>
  /**
   * 单次驱动操作允许的上游子请求数。Cloudflare Workers 免费版每个 invocation 上限 50，
   * 这里留出余量；超出时抛出可读错误，而不是让平台抛 "Too many subrequests"。
   */
  private budget = { used: 0, limit: 45 }

  constructor(
    addition: Driver189TVAddition,
    persistAccessToken?: (accessToken: string) => void | Promise<void>,
  ) {
    this.addition = addition
    this.persistAccessToken = persistAccessToken
  }

  isFamily(): boolean {
    return this.addition.type === "family"
  }

  getFamilyId(): string {
    return this.addition.family_id || ""
  }

  /** 每次驱动操作开始时重置子请求预算 */
  resetBudget(): void {
    this.budget.used = 0
  }

  private reserve(): void {
    this.budget.used++
    if (this.budget.used > this.budget.limit) {
      throw new Error(
        `[189TV] 单次操作上游请求数超过 ${this.budget.limit} 次（Cloudflare Workers 子请求上限），结果不完整：请拆分为更小的目录或改用其他运行时`,
      )
    }
  }

  async init(): Promise<void> {
    if (!this.addition.access_token) {
      throw new Error(
        "[189TV] access_token 为空：请先在别处扫码登录获取 access_token 后填入配置",
      )
    }
    await this.login()
  }

  private signatureHeader(
    url: string,
    method: string,
    isFamily: boolean,
  ): Record<string, string> {
    const dateOfGmt = new Date().toUTCString()
    const sessionKey = isFamily
      ? this.tokenInfo?.familySessionKey || ""
      : this.tokenInfo?.sessionKey || ""
    const sessionSecret = isFamily
      ? this.tokenInfo?.familySessionSecret || ""
      : this.tokenInfo?.sessionSecret || ""
    return {
      Date: dateOfGmt,
      SessionKey: sessionKey,
      "X-Request-ID": randomUUID189(),
      Signature: sessionKeySignatureOfHmac(
        sessionSecret,
        sessionKey,
        method,
        url,
        dateOfGmt,
      ),
    }
  }

  private appKeySignatureHeader(
    url: string,
    method: string,
  ): Record<string, string> {
    const ts = Date.now()
    return {
      Timestamp: String(ts),
      "X-Request-ID": randomUUID189(),
      AppKey: TVAppKey,
      AppSignature: appKeySignatureOfHmac(
        TVAppSignatureSecre,
        TVAppKey,
        method,
        url,
        ts,
      ),
    }
  }

  private async request(
    url: string,
    method: string,
    options: {
      query?: Record<string, string>
      form?: Record<string, string>
      headers?: Record<string, string>
      isFamily?: boolean
      isAppKey?: boolean
      retryCount?: number
    } = {},
  ): Promise<any> {
    const { query, form, headers: extraHeaders, isFamily = false, isAppKey = false } = options
    const retryCount = options.retryCount ?? 0

    const urlObj = new URL(url)
    for (const [k, v] of Object.entries(clientSuffix())) {
      urlObj.searchParams.set(k, v)
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) urlObj.searchParams.set(k, v)
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json;charset=UTF-8",
      "User-Agent": UA,
    }
    if (isAppKey) {
      Object.assign(headers, this.appKeySignatureHeader(url, method))
    } else {
      Object.assign(headers, this.signatureHeader(url, method, isFamily))
    }
    // 调用方自定义请求头（如家庭云提交所需的 ResumePolicy/UploadFileId/FamilyId）后置覆盖
    if (extraHeaders) Object.assign(headers, extraHeaders)

    let body: string | undefined
    if (form) {
      headers["Content-Type"] =
        "application/x-www-form-urlencoded; charset=UTF-8"
      body = new URLSearchParams(form).toString()
    }

    this.reserve()
    const resp = await fetch(urlObj.toString(), { method, headers, body })
    const text = await resp.text()

    if (
      text.includes("userSessionBO is null") ||
      text.includes("InvalidSessionKey")
    ) {
      if (retryCount >= 3) {
        throw new Error("[189TV] session expired after retry")
      }
      await this.login()
      return this.request(url, method, {
        ...options,
        retryCount: retryCount + 1,
      })
    }

    let data: any
    try {
      data = parseJsonPreservingIds(text)
    } catch {
      throw new Error(`[189TV] 非预期响应: ${text.slice(0, 200)}`)
    }

    if (hasError(data as RespErr)) {
      throw new Error(
        `[189TV] API 错误: ${(data as RespErr).res_message || (data as RespErr).errorMsg || (data as RespErr).msg || text.slice(0, 200)}`,
      )
    }
    return data
  }

  private async login(): Promise<void> {
    if (!this.addition.access_token) {
      throw new Error("[189TV] access_token 为空，无法登录")
    }
    const resp = (await this.request(
      ApiUrl + "/family/manage/loginFamilyMerge.action",
      "GET",
      {
        query: { e189AccessToken: this.addition.access_token },
        isAppKey: true,
      },
    )) as AppSessionResp
    this.tokenInfo = resp
    if (resp.accessToken && resp.accessToken !== this.addition.access_token) {
      this.addition.access_token = resp.accessToken
      if (this.persistAccessToken)
        await this.persistAccessToken(resp.accessToken)
    }
  }

  async getFiles(
    folderId: string,
    isFamily: boolean,
  ): Promise<Array<Cloud189TVFile | Cloud189TVFolder>> {
    const base = isFamily ? ApiUrl + "/family/file" : ApiUrl
    const fullUrl = base + "/listFiles.action"
    const orderBy = this.addition.order_by || "lastOpTime"
    const descending = toDesc(this.addition.order_direction || "asc")
    const result: Array<Cloud189TVFile | Cloud189TVFolder> = []

    for (let pageNum = 1; ; pageNum++) {
      const query: Record<string, string> = {
        folderId,
        fileType: "0",
        mediaAttr: "0",
        iconOption: "5",
        pageNum: String(pageNum),
        pageSize: "130",
      }
      if (isFamily) {
        query.familyId = this.addition.family_id || ""
        query.orderBy = toFamilyOrderBy(orderBy)
        query.descending = descending
      } else {
        query.recursive = "0"
        query.orderBy = orderBy
        query.descending = descending
      }
      const resp = (await this.request(fullUrl, "GET", {
        query,
        isFamily,
      })) as Cloud189TVFilesResp

      const ao = resp.fileListAO
      if (!ao || Number(ao.count) === 0) break
      const folders = ao.folderList || []
      const files = ao.fileList || []
      result.push(...folders, ...files)
      if (folders.length + files.length < 130) break
    }
    return result
  }

  async getFileDownloadUrl(fileId: string, isFamily: boolean): Promise<string> {
    const base = isFamily ? ApiUrl + "/family/file" : ApiUrl
    const fullUrl = base + "/getFileDownloadUrl.action"
    const query: Record<string, string> = { fileId }
    if (isFamily) {
      query.familyId = this.addition.family_id || ""
    } else {
      query.dt = "3"
      query.flag = "1"
    }
    const resp = (await this.request(fullUrl, "GET", {
      query,
      isFamily,
    })) as DownResp

    let url = resp.fileDownloadUrl || ""
    if (!url) throw new Error("[189TV] 获取下载地址失败")
    url = url.replace(/&amp;/g, "&").replace(/^http:\/\//i, "https://")

    // 尝试解析一次 302 重定向获得直接 CDN 地址
    try {
      const probe = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": UA },
        redirect: "manual",
      })
      const loc = probe.headers.get("location")
      if (probe.status === 302 && loc) {
        url = loc.replace(/^http:\/\//i, "https://")
      }
      // CDN 直接返回 200 时响应体是完整文件流；不消费就必须取消，
      // 否则 Workers 上会一直占用上游连接/带宽（见 server/raw.ts 的同类处理）。
      try {
        await probe.body?.cancel()
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
    return url
  }

  async mkdir(
    parentId: string,
    folderName: string,
    isFamily: boolean,
  ): Promise<void> {
    const base = isFamily ? ApiUrl + "/family/file" : ApiUrl
    const fullUrl = base + "/createFolder.action"
    const query: Record<string, string> = {
      folderName,
      relativePath: "",
    }
    if (isFamily) {
      query.familyId = this.addition.family_id || ""
      query.parentId = parentId
    } else {
      query.parentFolderId = parentId
    }
    await this.request(fullUrl, "POST", { query, isFamily })
  }

  async rename(
    id: string,
    isFolder: boolean,
    newName: string,
    isFamily: boolean,
  ): Promise<void> {
    const base = isFamily ? ApiUrl + "/family/file" : ApiUrl
    const method = isFamily ? "GET" : "POST"
    const suffix = isFolder ? "/renameFolder.action" : "/renameFile.action"
    const fullUrl = base + suffix
    const query: Record<string, string> = {}
    if (isFamily) query.familyId = this.addition.family_id || ""
    if (isFolder) {
      query.folderId = id
      query.destFolderName = newName
    } else {
      query.fileId = id
      query.destFileName = newName
    }
    await this.request(fullUrl, method, { query, isFamily })
  }

  private async createBatchTask(
    aType: string,
    familyId: string,
    targetFolderId: string,
    taskInfos: BatchTaskInfo[],
  ): Promise<string> {
    const form: Record<string, string> = {
      type: aType,
      taskInfos: JSON.stringify(taskInfos),
    }
    if (targetFolderId) form.targetFolderId = targetFolderId
    if (familyId) form.familyId = familyId
    const resp = (await this.request(
      ApiUrl + "/batch/createBatchTask.action",
      "POST",
      { form, isFamily: familyId !== "" },
    )) as CreateBatchTaskResp
    if (!resp.taskId) throw new Error("[189TV] 创建批量任务失败")
    return resp.taskId
  }

  private async waitBatchTask(aType: string, taskId: string): Promise<void> {
    // 批量任务在服务端异步执行（大目录很容易超过几秒）。这里用指数退避轮询约 30 秒，
    // 截止时任务通常仍在后台继续——此时抛错会让调用方误判为失败并重试
    // （COPY 重试会在云端产生重复副本），因此记录告警后按"已受理"返回。
    const deadline = Date.now() + 30_000
    let delay = 300
    for (;;) {
      const resp = (await this.request(
        ApiUrl + "/batch/checkBatchTask.action",
        "POST",
        { form: { type: aType, taskId } },
      )) as BatchTaskStateResp
      const status = resp.taskStatus
      if (status === 4) return
      if (status === 2) throw new Error("[189TV] 目标存在同名冲突")
      if (Date.now() + delay > deadline) {
        console.warn(
          `[189TV] 批量任务 ${aType}（taskId=${taskId}）仍在后台执行，已按受理返回`,
        )
        return
      }
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(Math.round(delay * 1.5), 5_000)
    }
  }

  async move(
    id: string,
    isFolder: boolean,
    fileName: string,
    targetFolderId: string,
    isFamily: boolean,
  ): Promise<void> {
    const taskId = await this.createBatchTask(
      "MOVE",
      isFamily ? this.addition.family_id || "" : "",
      targetFolderId,
      [{ fileId: id, fileName, isFolder: isFolder ? 1 : 0 }],
    )
    await this.waitBatchTask("MOVE", taskId)
  }

  async copy(
    id: string,
    isFolder: boolean,
    fileName: string,
    targetFolderId: string,
    isFamily: boolean,
  ): Promise<void> {
    const taskId = await this.createBatchTask(
      "COPY",
      isFamily ? this.addition.family_id || "" : "",
      targetFolderId,
      [{ fileId: id, fileName, isFolder: isFolder ? 1 : 0 }],
    )
    await this.waitBatchTask("COPY", taskId)
  }

  async remove(
    id: string,
    isFolder: boolean,
    fileName: string,
    isFamily: boolean,
  ): Promise<void> {
    const taskId = await this.createBatchTask(
      "DELETE",
      isFamily ? this.addition.family_id || "" : "",
      "",
      [{ fileId: id, fileName, isFolder: isFolder ? 1 : 0 }],
    )
    await this.waitBatchTask("DELETE", taskId)
  }

  /** 仅创建上传会话，用于判断服务端是否已存在相同 MD5 的文件（秒传）。 */
  async rapidUploadCreate(
    parentId: string,
    fileName: string,
    fileSize: number,
    fileMd5: string,
    isFamily: boolean,
  ): Promise<boolean> {
    const base = isFamily ? ApiUrl + "/family/file" : ApiUrl
    const createUrl =
      base +
      (isFamily ? "/createFamilyFile.action" : "/createUploadFile.action")
    let createResp: CreateUploadFileResp
    if (isFamily) {
      createResp = (await this.request(createUrl, "POST", {
        query: {
          familyId: this.addition.family_id || "",
          parentId,
          fileMd5,
          fileName,
          fileSize: String(fileSize),
          resumePolicy: "1",
        },
        isFamily,
      })) as CreateUploadFileResp
    } else {
      createResp = (await this.request(createUrl, "POST", {
        form: {
          parentFolderId: parentId,
          fileName,
          size: String(fileSize),
          md5: fileMd5,
          opertype: "3",
          flag: "1",
          resumePolicy: "1",
          isLog: "0",
        },
        isFamily,
      })) as CreateUploadFileResp
    }
    if (createResp.fileDataExists !== 1) return false
    // 秒传命中后必须执行提交（上游 OldUploadCommit）：只建会话不 commit 的话
    // 会话最终过期，文件永远不会真正创建——UI 显示秒传成功但云端没有文件。
    const uploadFileId = createResp.uploadFileId
    const fileCommitUrl = createResp.fileCommitUrl
    if (!uploadFileId || !fileCommitUrl) {
      throw new Error("[189TV] 秒传会话缺少 uploadFileId/fileCommitUrl，无法提交")
    }
    await this.commitUpload(fileCommitUrl, String(uploadFileId), isFamily)
    return true
  }

  /** 提交上传会话（个人云 form / 家庭云请求头，与 Go 原版 OldUploadCommit 一致） */
  private async commitUpload(
    fileCommitUrl: string,
    uploadFileId: string,
    isFamily: boolean,
  ): Promise<void> {
    if (isFamily) {
      // 参考实现（Go 189_tv OldUploadCommit / 189pc）：家庭云这三个字段通过请求头传递，
      // 个人云才用 form 表单。
      await this.request(fileCommitUrl, "POST", {
        headers: {
          ResumePolicy: "1",
          UploadFileId: uploadFileId,
          FamilyId: this.addition.family_id || "",
        },
        isFamily,
      })
    } else {
      await this.request(fileCommitUrl, "POST", {
        form: {
          opertype: "3",
          resumePolicy: "1",
          uploadFileId,
          isLog: "0",
        },
        isFamily,
      })
    }
  }

  /** 单片上传（Worker 的 put 接收完整 Buffer） */
  async upload(
    parentId: string,
    fileName: string,
    content: Uint8Array,
    isFamily: boolean,
  ): Promise<void> {
    const fileMd5 = md5Hex(content)
    const fileSize = content.length

    // 1. 创建上传会话
    const base = isFamily ? ApiUrl + "/family/file" : ApiUrl
    const createUrl =
      base +
      (isFamily ? "/createFamilyFile.action" : "/createUploadFile.action")
    let createResp: CreateUploadFileResp
    if (isFamily) {
      createResp = (await this.request(createUrl, "POST", {
        query: {
          familyId: this.addition.family_id || "",
          parentId,
          fileMd5,
          fileName,
          fileSize: String(fileSize),
          resumePolicy: "1",
        },
        isFamily,
      })) as CreateUploadFileResp
    } else {
      createResp = (await this.request(createUrl, "POST", {
        form: {
          parentFolderId: parentId,
          fileName,
          size: String(fileSize),
          md5: fileMd5,
          opertype: "3",
          flag: "1",
          resumePolicy: "1",
          isLog: "0",
        },
        isFamily,
      })) as CreateUploadFileResp
    }

    const uploadFileId = createResp.uploadFileId
    const fileUploadUrl = createResp.fileUploadUrl
    const fileCommitUrl = createResp.fileCommitUrl
    if (!uploadFileId || !fileUploadUrl) {
      throw new Error("[189TV] 创建上传会话失败")
    }

    // 2. PUT 上传文件数据
    const putHeaders: Record<string, string> = {
      ResumePolicy: "1",
      Expect: "100-continue",
      "User-Agent": UA,
    }
    if (isFamily) {
      putHeaders.FamilyId = this.addition.family_id || ""
      putHeaders.UploadFileId = String(uploadFileId)
    } else {
      putHeaders["Edrive-UploadFileId"] = String(uploadFileId)
    }
    Object.assign(
      putHeaders,
      this.signatureHeader(fileUploadUrl, "PUT", isFamily),
    )

    const putResp = await fetch(fileUploadUrl, {
      method: "PUT",
      headers: putHeaders,
      // content 本身即 Uint8Array（Buffer），无需再整包拷贝一份
      body: content as unknown as BodyInit,
    })
    // 响应体不需要，及时取消以释放上游连接
    try {
      await putResp.body?.cancel()
    } catch {
      // ignore
    }
    if (putResp.status !== 200) {
      throw new Error(`[189TV] 上传失败: HTTP ${putResp.status}`)
    }

    // 3. 提交上传
    await this.commitUpload(fileCommitUrl!, String(uploadFileId), isFamily)
  }
}
