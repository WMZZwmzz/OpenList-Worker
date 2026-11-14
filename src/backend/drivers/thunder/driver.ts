import {
  calcFileType,
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { signS3Headers } from "../s3/sigv4"
import { randomHex } from "../rand"
import {
  ThunderAddition,
  ThunderExpertAddition,
  ThunderFile,
  ThunderFileListResp,
  ThunderTokenResp,
  ThunderUploadTaskResp,
} from "./types"
import {
  calcGcid,
  FILE,
  FILE_API_URL,
  FOLDER,
  md5,
  ThunderClient,
  UPLOAD_TYPE_RESUMABLE,
} from "./util"

/**
 * A-07：从上传端点推导 SigV4 的 region。
 * 迅雷返回的 endpoint 可能是 AWS S3（s3.cn-north-1.amazonaws.com.cn）或
 * S3 兼容服务；无法识别时回退 us-east-1（S3 兼容实现的通用默认值）。
 */
function s3RegionOfEndpoint(endpoint: string): string {
  try {
    const host = new URL(endpoint).hostname
    const aws = host.match(/(?:^|\.)s3[.-]([a-z0-9-]+)\.amazonaws\./)
    if (aws) return aws[1]
    const oss = host.match(/\.oss-([a-z0-9-]+)\.aliyuncs\.com$/)
    if (oss) return oss[1]
  } catch {}
  return "us-east-1"
}

function thunderFileToFileItem(
  f: ThunderFile,
  downloadUserAgent: string,
  useVideoUrl?: boolean,
): FileItem {
  const isDir = f.kind === FOLDER
  let rawUrl = f.web_content_link || ""

  if (useVideoUrl && f.medias && f.medias.length > 0) {
    for (const m of f.medias) {
      if (m.link?.url) {
        rawUrl = m.link.url
        break
      }
    }
  }

  return {
    name: f.name,
    size: parseInt(f.size || "0", 10),
    is_dir: isDir,
    modified: f.modified_time || f.created_time || new Date().toISOString(),
    sign: "",
    type: calcFileType(f.name, isDir),
    thumb: f.thumbnail_link || f.icon_link || "",
    raw_url: rawUrl,
    raw_url_headers: {
      "User-Agent": downloadUserAgent,
    },
  }
}

export function generateThunderDeviceId(addition?: any): string {
  if (addition?.device_id && addition.device_id.trim().length === 32) {
    return addition.device_id.trim()
  }
  const seed = `${addition?.username || ""}${addition?.password || ""}`
  if (seed.trim()) {
    return md5(seed)
  }
  // S-04 同类清单：设备 id 随机段改用 CSPRNG（原 Math.random）。
  return md5(randomHex(16) + Date.now().toString(36))
}

export class ThunderDriver implements StorageDriver {
  protected client: ThunderClient
  protected addition: ThunderAddition | ThunderExpertAddition
  protected identity: string = ""
  protected onPersistCallback?: (tokens: any) => Promise<void> | void
  /** 物理路径 → 迅雷服务端生成的文件/目录 ID（按名称链解析后缓存） */
  private idCache = new Map<string, string>()

  constructor(
    addition: ThunderAddition,
    onPersistCallback?: (tokens: any) => Promise<void> | void,
  ) {
    this.addition = addition
    this.onPersistCallback = onPersistCallback

    const deviceId = generateThunderDeviceId(addition)
    addition.device_id = deviceId

    this.client = new ThunderClient({
      deviceId,
      clientId: addition.client_id || "",
      clientSecret: addition.client_secret || "",
      clientVersion: "8.31.0.9726",
      packageName: "com.xunlei.downloadprovider",
      userAgent:
        "ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/12 protocolVersion/301 platformVersion/10 sdkVersion/512000 Oauth2Client/0.9 (Linux 4_14_186-perf-gddfs8vbb238b) (JAVA 0)",
      downloadUserAgent:
        "Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)",
      algorithms: [
        "9uJNVj/wLmdwKrJaVj/omlQ",
        "Oz64Lp0GigmChHMf/6TNfxx7O9PyopcczMsnf",
        "Eb+L7Ce+Ej48u",
        "jKY0",
        "ASr0zCl6v8W4aidjPK5KHd1Lq3t+vBFf41dqv5+fnOd",
        "wQlozdg6r1qxh0eRmt3QgNXOvSZO6q/GXK",
        "gmirk+ciAvIgA/cxUUCema47jr/YToixTT+Q6O",
        "5IiCoM9B1/788ntB",
        "P07JH0h6qoM6TSUAK2aL9T5s2QBVeY9JWvalf",
        "+oK0AN",
      ],
      space: addition.space || "",
      captchaToken: addition.captcha_token || "",
      creditKey: addition.credit_key || "",
      onPersistToken: async (token: ThunderTokenResp) => {
        if (this.onPersistCallback) {
          await this.onPersistCallback({
            refresh_token: token.refresh_token,
            captcha_token: this.client.captchaToken,
            device_id: deviceId,
          })
        }
      },
      onPersistCaptchaToken: async (cToken: string) => {
        if (this.onPersistCallback) {
          await this.onPersistCallback({
            captcha_token: cToken,
          })
        }
      },
    })
  }

  protected get downloadUserAgent(): string {
    return (
      (this.addition as ThunderExpertAddition).download_user_agent ||
      "Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)"
    )
  }

  protected get useVideoUrl(): boolean {
    return !!(this.addition as ThunderExpertAddition).use_video_url
  }

  async init(): Promise<void> {
    const username = this.addition.username || ""
    const password = this.addition.password || ""
    // F-280：identity 纳入持久化的 refresh_token，token 变化时才会重新初始化
    const savedRefreshToken = (this.addition.refresh_token || "").trim()
    const identity = md5(`${username}${password}${savedRefreshToken}`)

    if (this.identity !== identity || !(await this.client.isLogin())) {
      this.identity = identity
      // F-280：优先复用 onPersistToken 持久化的 refresh_token（1 个请求），
      // 失败再回落到完整的用户名/密码登录（3 个请求 + 风控暴露）。
      if (savedRefreshToken) {
        try {
          await this.client.refreshToken(savedRefreshToken)
          return
        } catch {
          // refresh_token 失效/被轮换：继续走账密登录
        }
      }
      await this.client.login(username, password)
    }
  }

  private cleanPhysical(physicalPath: string): string {
    return (
      "/" +
      String(physicalPath || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    )
  }

  private get rootFolderId(): string {
    return this.addition.root_folder_id || ""
  }

  /** 拉取某目录的全部分页子项（迅雷列表按 page_token 分页） */
  private async listChildren(folderId: string): Promise<ThunderFile[]> {
    const files: ThunderFile[] = []
    let pageToken = ""

    while (true) {
      const url = new URL(FILE_API_URL)
      url.searchParams.set("space", this.addition.space || "")
      url.searchParams.set("__type", "drive")
      url.searchParams.set("refresh", "true")
      url.searchParams.set("__sync", "true")
      url.searchParams.set("parent_id", folderId)
      url.searchParams.set("page_token", pageToken)
      url.searchParams.set("with_audit", "true")
      url.searchParams.set("limit", "100")
      url.searchParams.set(
        "filters",
        JSON.stringify({
          phase: { eq: "PHASE_TYPE_COMPLETE" },
          trashed: { eq: false },
        }),
      )

      const res = await this.client.authRequest<ThunderFileListResp>(
        url.toString(),
        { method: "GET" },
      )
      if (res.files && res.files.length > 0) files.push(...res.files)
      if (!res.next_page_token) break
      pageToken = res.next_page_token
    }
    return files
  }

  private async findChild(
    parentId: string,
    rawName: string,
    wantDir: boolean,
  ): Promise<ThunderFile | null> {
    let decodedName = rawName
    try {
      decodedName = decodeURIComponent(rawName)
    } catch {}
    const children = await this.listChildren(parentId)
    const found = children.find(
      (f) =>
        (f.name === rawName || f.name === decodedName || f.id === rawName) &&
        (wantDir ? f.kind === FOLDER : true),
    )
    return found || null
  }

  /**
   * 物理路径 → 迅雷真实目录 ID（F-279）。
   *
   * physical 是「root_folder_path + 用户相对路径」的名称链（thunder 无
   * root_folder_path，故就是相对路径），末段是名称而不是服务端 ID。
   * 旧实现直接返回末段当 ID，导致除挂载根外所有操作把名称发给迅雷而失败。
   * 这里从 root_folder_id 出发逐级按名称匹配换取真实 ID 并缓存。
   */
  protected async resolveFolderId(physicalPath: string): Promise<string> {
    const clean = this.cleanPhysical(physicalPath)
    if (clean === "/") return this.rootFolderId
    const cached = this.idCache.get(clean)
    if (cached) return cached

    const segs = clean.split("/").filter(Boolean)
    let parentId = this.rootFolderId
    let curPath = ""
    for (const seg of segs) {
      curPath = `${curPath}/${seg}`
      const hit = this.idCache.get(curPath)
      if (hit) {
        parentId = hit
        continue
      }
      const child = await this.findChild(parentId, seg, true)
      if (!child) throw new Error(`[Thunder] Directory not found: ${seg}`)
      parentId = child.id
      this.idCache.set(curPath, parentId)
    }
    return parentId
  }

  /** 解析任意条目（文件或目录）的真实 ID */
  protected async resolveItemId(physicalPath: string): Promise<string> {
    const clean = this.cleanPhysical(physicalPath)
    if (clean === "/") return this.rootFolderId
    const cached = this.idCache.get(clean)
    if (cached) return cached

    const segs = clean.split("/").filter(Boolean)
    const name = segs[segs.length - 1]
    const parentPath = "/" + segs.slice(0, -1).join("/")
    const parentId = await this.resolveFolderId(parentPath)
    const child = await this.findChild(parentId, name, false)
    if (!child) throw new Error(`[Thunder] Item not found: ${name}`)
    this.idCache.set(clean, child.id)
    return child.id
  }

  private invalidateIdCache(): void {
    this.idCache.clear()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFolderId(physicalPath)
    const children = await this.listChildren(folderId)
    const clean = this.cleanPhysical(physicalPath)
    const items = children.map((f) => {
      this.idCache.set(
        clean === "/" ? `/${f.name}` : `${clean}/${f.name}`,
        f.id,
      )
      return thunderFileToFileItem(f, this.downloadUserAgent, this.useVideoUrl)
    })

    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const fileId = await this.resolveItemId(physicalPath)
    const url = new URL(`${FILE_API_URL}/${fileId}`)
    url.searchParams.set("space", this.addition.space || "")

    const res = await this.client.authRequest<ThunderFile>(url.toString(), {
      method: "GET",
    })
    return thunderFileToFileItem(res, this.downloadUserAgent, this.useVideoUrl)
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const dirName = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveFolderId(parentPath)

    await this.client.authRequest(FILE_API_URL, {
      method: "POST",
      body: {
        kind: FOLDER,
        name: dirName,
        parent_id: parentId,
        space: this.addition.space || "",
      },
    })
    this.invalidateIdCache()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const fileId = await this.resolveItemId(physicalPath)
    await this.client.authRequest(`${FILE_API_URL}/${fileId}`, {
      method: "PATCH",
      body: {
        name: newName,
        space: this.addition.space || "",
      },
    })
    this.invalidateIdCache()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const fileId = await this.resolveItemId(physicalPath)
    const url = new URL(`${FILE_API_URL}/${fileId}/trash`)
    url.searchParams.set("space", this.addition.space || "")

    await this.client.authRequest(url.toString(), {
      method: "PATCH",
      body: {},
    })
    this.invalidateIdCache()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const srcFileId = await this.resolveItemId(srcPhys)
    // dstDir 是站点虚拟路径；dstPhys 是目标条目自身的物理路径，取父目录
    const dstParent =
      "/" +
      this.cleanPhysical(dstPhys)
        .split("/")
        .filter(Boolean)
        .slice(0, -1)
        .join("/")
    const dstDirId = await this.resolveFolderId(dstParent)

    await this.client.authRequest(`${FILE_API_URL}:batchMove`, {
      method: "POST",
      body: {
        to: { parent_id: dstDirId },
        ids: [srcFileId],
        space: this.addition.space || "",
      },
    })
    this.invalidateIdCache()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const srcFileId = await this.resolveItemId(srcPhys)
    const dstParent =
      "/" +
      this.cleanPhysical(dstPhys)
        .split("/")
        .filter(Boolean)
        .slice(0, -1)
        .join("/")
    const dstDirId = await this.resolveFolderId(dstParent)

    await this.client.authRequest(`${FILE_API_URL}:batchCopy`, {
      method: "POST",
      body: {
        to: { parent_id: dstDirId },
        ids: [srcFileId],
        space: this.addition.space || "",
      },
    })
    this.invalidateIdCache()
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const fileName = parts.pop() || "file"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveFolderId(parentPath)
    const gcid = await calcGcid(content)

    const resp = await this.client.authRequest<ThunderUploadTaskResp>(
      FILE_API_URL,
      {
        method: "POST",
        body: {
          kind: FILE,
          parent_id: parentId,
          name: fileName,
          size: content.length.toString(),
          hash: gcid,
          upload_type: UPLOAD_TYPE_RESUMABLE,
          space: this.addition.space || "",
        },
      },
    )

    if (resp.upload_type === UPLOAD_TYPE_RESUMABLE && resp.resumable?.params) {
      const params = resp.resumable.params
      let endpoint = params.endpoint
      if (endpoint.startsWith(params.bucket + ".")) {
        endpoint = endpoint.slice(params.bucket.length + 1)
      }
      if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
        endpoint = `https://${endpoint}`
      }

      const uploadUrl = `${endpoint.replace(/\/$/, "")}/${params.bucket}/${params.key}`
      // A-07：上传必须使用 params 里的 access_key_id/access_key_secret 做
      // AWS SigV4 签名。历史实现只带 x-amz-security-token，S3/OSS 对 PUT
      // 一律 403，迅雷上传 100% 失败。
      const signed = await signS3Headers({
        method: "PUT",
        url: uploadUrl,
        region: s3RegionOfEndpoint(uploadUrl),
        accessKeyId: params.access_key_id,
        secretAccessKey: params.access_key_secret,
        sessionToken: params.security_token,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(content.length),
        },
        body: content,
      })

      const uploadRes = await fetch(signed.url, {
        method: "PUT",
        headers: signed.headers,
        body: content as any,
      })

      if (!uploadRes.ok) {
        throw new Error(
          `S3 Upload failed: ${uploadRes.status} ${uploadRes.statusText}`,
        )
      }
    }
    this.invalidateIdCache()
  }
}

export class ThunderExpertDriver extends ThunderDriver {
  constructor(
    addition: ThunderExpertAddition,
    onPersistCallback?: (tokens: any) => Promise<void> | void,
  ) {
    super(addition, onPersistCallback)

    const deviceId = generateThunderDeviceId(addition)
    addition.device_id = deviceId

    const algorithms =
      addition.sign_type === "captcha_sign"
        ? undefined
        : (addition.algorithms || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)

    this.client = new ThunderClient({
      deviceId,
      clientId: addition.client_id || "",
      clientSecret: addition.client_secret || "",
      clientVersion: addition.client_version || "8.31.0.9726",
      packageName: addition.package_name || "com.xunlei.downloadprovider",
      userAgent:
        addition.user_agent ||
        "ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/12 protocolVersion/301 platformVersion/10 sdkVersion/512000 Oauth2Client/0.9 (Linux 4_14_186-perf-gddfs8vbb238b) (JAVA 0)",
      downloadUserAgent:
        addition.download_user_agent ||
        "Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)",
      algorithms: algorithms && algorithms.length > 0 ? algorithms : undefined,
      timestamp: addition.timestamp,
      captchaSign: addition.captcha_sign,
      useVideoUrl: addition.use_video_url,
      space: addition.space || "",
      captchaToken: addition.captcha_token || "",
      creditKey: addition.credit_key || "",
      onPersistToken: async (token: ThunderTokenResp) => {
        if (this.onPersistCallback) {
          await this.onPersistCallback({
            refresh_token: token.refresh_token,
            captcha_token: this.client.captchaToken,
            device_id: deviceId,
          })
        }
      },
      onPersistCaptchaToken: async (cToken: string) => {
        if (this.onPersistCallback) {
          await this.onPersistCallback({
            captcha_token: cToken,
          })
        }
      },
    })
  }

  async init(): Promise<void> {
    const expAddition = this.addition as ThunderExpertAddition
    let identity = ""
    if (expAddition.login_type === "refresh_token") {
      identity = md5(expAddition.refresh_token || "")
    } else {
      identity = md5(
        `${expAddition.username || ""}${expAddition.password || ""}`,
      )
    }

    if (this.identity !== identity || !(await this.client.isLogin())) {
      this.identity = identity

      if (
        expAddition.login_type === "refresh_token" &&
        expAddition.refresh_token
      ) {
        await this.client.refreshToken(expAddition.refresh_token)
      } else if (expAddition.username && expAddition.password) {
        await this.client.login(expAddition.username, expAddition.password)
      } else {
        // F-285：凭据不满足所选 login_type 时必须显式报配置错误，
        // 否则 init() 静默成功、失败被延迟到首次请求的 "empty token"。
        throw new Error(
          expAddition.login_type === "refresh_token"
            ? "[Thunder] 登录方式为 refresh_token，但未配置 refresh_token（且缺少可回退的用户名/密码）"
            : "[Thunder] 登录方式为账号密码，但用户名或密码为空",
        )
      }
    }
  }
}
