import CryptoJS from "crypto-js"
import {
  ThunderCaptchaTokenRequest,
  ThunderCaptchaTokenResponse,
  ThunderCoreLoginResp,
  ThunderErrResp,
  ThunderLoginReviewResp,
  ThunderReviewData,
  ThunderTokenResp,
} from "./types"

export const API_URL = "https://api-pan.xunlei.com/drive/v1"
export const FILE_API_URL = `${API_URL}/files`
export const TASK_API_URL = `${API_URL}/tasks`
export const XLUSER_API_BASE_URL = "https://xluser-ssl.xunlei.com"
export const XLUSER_API_URL = `${XLUSER_API_BASE_URL}/v1`

export const FOLDER = "drive#folder"
export const FILE = "drive#file"
export const RESUMABLE = "drive#resumable"

export const UPLOAD_TYPE_RESUMABLE = "UPLOAD_TYPE_RESUMABLE"
export const UPLOAD_TYPE_URL = "UPLOAD_TYPE_URL"

export const SignProvider = "access_end_point_token"
// 协议级固定签名密钥：从迅雷官方客户端逆向得到，服务端固定校验、全网共享，
// 并非可申请替换的 OAuth 凭据，删除会导致设备签名校验失败、驱动不可用。
export const APPID = "40"
export const APPKey = "34a062aaa22f906fca4fefe9fb3a3021"

export function md5(input: string): string {
  return CryptoJS.MD5(input).toString(CryptoJS.enc.Hex)
}

export function sha1(input: string | CryptoJS.lib.WordArray): string {
  return CryptoJS.SHA1(input).toString(CryptoJS.enc.Hex)
}

export function getAction(method: string, url: string): string {
  const m = url.match(/:\/\/[^/]+((\/[^/\s?#]+)*)/)
  const path = m ? m[1] : url
  return `${method}:${path}`
}

export function generateDeviceSign(
  deviceID: string,
  packageName: string,
): string {
  const signatureBase = `${deviceID}${packageName}${APPID}${APPKey}`
  const sha1Result = CryptoJS.SHA1(signatureBase).toString(CryptoJS.enc.Hex)
  const md5Result = CryptoJS.MD5(sha1Result).toString(CryptoJS.enc.Hex)
  return `div101.${deviceID}${md5Result}`
}

export async function calcGcid(data: Buffer | Uint8Array): Promise<string> {
  const size = data.length
  let psize = 0x40000 // 256KB
  while (size / psize > 0x200 && psize < 0x200000) {
    psize = psize << 1
  }

  // F-287：改用 WebCrypto 的原生 SHA-1（Workers/Node18+/ESA 均可用）。
  // 旧的 CryptoJS.SHA1 是纯 JS 实现，吞吐仅几 MB/s，大文件上传会直接
  // 打爆 Workers 的 CPU 限额。
  const chunkDigests: Uint8Array[] = []
  for (let offset = 0; offset < size; offset += psize) {
    const chunk = data.subarray(offset, Math.min(offset + psize, size))
    // 传副本：subtle.digest 需要独立的 ArrayBuffer/TypedArray
    const digest = await crypto.subtle.digest("SHA-1", chunk.slice() as any)
    chunkDigests.push(new Uint8Array(digest))
  }

  const combined = new Uint8Array(chunkDigests.length * 20)
  chunkDigests.forEach((digest, i) => combined.set(digest, i * 20))

  const finalDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-1", combined as any),
  )
  return Array.from(finalDigest)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export interface ThunderClientOptions {
  algorithms?: string[]
  timestamp?: string
  captchaSign?: string
  deviceId: string
  clientId: string
  clientSecret: string
  clientVersion: string
  packageName: string
  userAgent: string
  downloadUserAgent: string
  useVideoUrl?: boolean
  space?: string
  captchaToken?: string
  creditKey?: string
  onPersistToken?: (token: ThunderTokenResp) => Promise<void> | void
  onPersistCaptchaToken?: (token: string) => Promise<void> | void
}

export class ThunderClient {
  public options: ThunderClientOptions
  public tokenResp: ThunderTokenResp | null = null
  public coreLoginResp: ThunderCoreLoginResp | null = null
  public captchaToken: string = ""
  public creditKey: string = ""
  /** F-281：进行中的刷新 Promise（singleflight） */
  private refreshInFlight: Promise<ThunderTokenResp> | null = null

  constructor(options: ThunderClientOptions) {
    this.options = options
    this.captchaToken = options.captchaToken || ""
    this.creditKey = options.creditKey || ""
  }

  getCaptchaSign(): { timestamp: string; sign: string } {
    if (!this.options.algorithms || this.options.algorithms.length === 0) {
      return {
        timestamp: this.options.timestamp || "",
        sign: this.options.captchaSign || "",
      }
    }
    const timestamp = Date.now().toString()
    let str = `${this.options.clientId}${this.options.clientVersion}${this.options.packageName}${this.options.deviceId}${timestamp}`
    for (const algorithm of this.options.algorithms) {
      str = md5(str + algorithm)
    }
    return {
      timestamp,
      sign: `1.${str}`,
    }
  }

  async refreshCaptchaToken(
    action: string,
    metas: Record<string, string>,
  ): Promise<void> {
    const param: ThunderCaptchaTokenRequest = {
      action,
      captcha_token: this.captchaToken,
      client_id: this.options.clientId,
      device_id: this.options.deviceId,
      meta: metas,
      redirect_uri: "xlaccsdk01://xunlei.com/callback?state=harbor",
    }

    const res = await this.rawRequest<
      ThunderCaptchaTokenResponse & ThunderErrResp
    >(`${XLUSER_API_URL}/shield/captcha/init`, {
      method: "POST",
      body: param,
    })

    if (res.error_code || (res.error && res.error !== "success")) {
      throw new Error(
        `Captcha error: ${res.error_code} ${res.error} ${res.error_description || ""}`,
      )
    }

    if (res.url) {
      throw new Error(
        `need verify: <a target="_blank" href="${res.url}">Click Here</a>`,
      )
    }

    if (!res.captcha_token) {
      throw new Error("empty captchaToken")
    }

    this.captchaToken = res.captcha_token
    if (this.options.onPersistCaptchaToken) {
      await this.options.onPersistCaptchaToken(res.captcha_token)
    }
  }

  async refreshCaptchaTokenAtLogin(
    action: string,
    userId: string,
  ): Promise<void> {
    const { timestamp, sign } = this.getCaptchaSign()
    const metas: Record<string, string> = {
      client_version: this.options.clientVersion,
      package_name: this.options.packageName,
      user_id: userId,
      timestamp,
      captcha_sign: sign,
    }
    await this.refreshCaptchaToken(action, metas)
  }

  async refreshCaptchaTokenInLogin(
    action: string,
    username: string,
  ): Promise<void> {
    const metas: Record<string, string> = {}
    if (/\w+([-+.]\w+)*@\w+([-.]\w+)*\.\w+([-.]\w+)*/.test(username)) {
      metas.email = username
    } else if (username.length >= 11 && username.length <= 18) {
      metas.phone_number = username
    } else {
      metas.username = username
    }
    await this.refreshCaptchaToken(action, metas)
  }

  private formatReviewData(reviewResp: ThunderLoginReviewResp): Error {
    const deviceSign = generateDeviceSign(
      this.options.deviceId,
      this.options.packageName,
    )
    const reviewData: ThunderReviewData = {
      creditkey: reviewResp.creditkey,
      reviewurl: `${reviewResp.reviewurl}&deviceid=${deviceSign}`,
      deviceid: deviceSign,
      devicesign: deviceSign,
    }
    const jsonStr = JSON.stringify(reviewData, null, 2)
    const html = `
<div style="font-family: Arial, sans-serif; padding: 15px; border-radius: 5px; border: 1px solid #e0e0e0;">
    <h3 style="color: #d9534f; margin-top: 0;">
        <span style="font-size: 16px;">🔒 本次登录需要验证</span><br>
        <span style="font-size: 14px; font-weight: normal; color: #666;">This login requires verification</span>
    </h3>
    <p style="font-size: 14px; margin-bottom: 15px;">下面是验证所需要的数据，具体使用方法请参照对应的驱动文档<br>
    <span style="color: #666; font-size: 13px;">Below are the relevant verification data. For specific usage methods, please refer to the corresponding driver documentation.</span></p>
    <div style="border: 1px solid #ddd; border-radius: 4px; padding: 10px; overflow-x: auto; font-family: 'Courier New', monospace; font-size: 13px;">
        <pre style="margin: 0; white-space: pre-wrap;"><code>${jsonStr}</code></pre>
    </div>
</div>`
    return new Error(html)
  }

  async rawRequest<T>(
    url: string,
    options: {
      method?: string
      body?: any
      headers?: Record<string, string>
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "user-agent": this.options.userAgent,
      accept: "application/json;charset=UTF-8",
      "x-device-id": this.options.deviceId,
      "x-client-id": this.options.clientId,
      "x-client-version": this.options.clientVersion,
      ...(options.headers || {}),
    }

    let bodyStr: string | undefined = undefined
    if (options.body !== undefined) {
      if (typeof options.body === "string") {
        bodyStr = options.body
      } else {
        bodyStr = JSON.stringify(options.body)
        if (!headers["content-type"]) {
          headers["content-type"] = "application/json;charset=UTF-8"
        }
      }
    }

    const res = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: bodyStr,
    })

    const text = await res.text()
    let data: any = {}
    try {
      data = JSON.parse(text)
    } catch {
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${text}`)
      }
      return text as unknown as T
    }

    if (data.error === "review_panel") {
      throw this.formatReviewData(data as ThunderLoginReviewResp)
    }

    // F-283：JSON 分支同样要检查 HTTP 状态码。网关/限流组件常返回
    // 502/429 + JSON 错误体（如 {"message":"rate limited"}），这类响应没有
    // error_code 字段，若当作成功数据返回会被静默处理（list 变空目录）。
    // 例外：带非 0 error_code 的响应交给 authRequest 处理（4122/10/16 需刷新令牌）。
    if (!res.ok) {
      const errCode = data?.error_code
      const handledByAuth = typeof errCode === "number" && errCode !== 0
      if (!handledByAuth) {
        const reason =
          data?.error_description ||
          data?.error ||
          data?.message ||
          text
        throw new Error(
          `${res.status} ${res.statusText}: ${String(reason).slice(0, 300)}`,
        )
      }
    }

    return data as T
  }

  async authRequest<T>(
    url: string,
    options: {
      method?: string
      body?: any
      headers?: Record<string, string>
    } = {},
    retry: number = 0,
  ): Promise<T> {
    if (!this.tokenResp?.access_token) {
      throw new Error("empty token")
    }

    const authHeaders: Record<string, string> = {
      Authorization: `${this.tokenResp.token_type} ${this.tokenResp.access_token}`,
      "X-Captcha-Token": this.captchaToken,
      ...(options.headers || {}),
    }

    const data = await this.rawRequest<any>(url, {
      ...options,
      headers: authHeaders,
    })

    const errCode = data?.error_code || 0
    if (
      errCode === 4122 ||
      errCode === 4121 ||
      errCode === 10 ||
      errCode === 16
    ) {
      // Access token expired, try to refresh.
      // F-282：只自动刷新/重试一次，避免上游持续返回同一错误码时无界递归。
      if (retry >= 1) {
        throw new Error(
          `Token expired error ${errCode} (still failing after token refresh)`,
        )
      }
      if (this.tokenResp?.refresh_token) {
        // F-281：refreshToken 内部已完成校验 + 持久化（且已 singleflight）
        this.tokenResp = await this.refreshToken(this.tokenResp.refresh_token)
        return this.authRequest<T>(url, options, retry + 1)
      }
      throw new Error(`Token expired error ${errCode}`)
    } else if (errCode === 9) {
      // Captcha token expired
      // F-282：captcha 刷新同样只重试一次
      if (retry >= 1) {
        throw new Error("Captcha error 9 (still failing after captcha refresh)")
      }
      const action = getAction(options.method || "GET", url)
      await this.refreshCaptchaTokenAtLogin(
        action,
        this.tokenResp.user_id || "",
      )
      return this.authRequest<T>(url, options, retry + 1)
    } else if (errCode !== 0 || (data.error && data.error !== "success")) {
      throw new Error(
        `ErrorCode: ${data.error_code || 0}, Error: ${data.error || ""}, ErrorDescription: ${data.error_description || ""}`,
      )
    }

    return data as T
  }

  async coreLogin(
    username: string,
    password: string,
  ): Promise<ThunderCoreLoginResp> {
    const url = `${XLUSER_API_BASE_URL}/xluser.core.login/v3/login`
    const body = {
      protocolVersion: "301",
      sequenceNo: "1000012",
      platformVersion: "10",
      isCompressed: "0",
      appid: APPID,
      clientVersion: this.options.clientVersion,
      peerID: "00000000000000000000000000000000",
      appName: "ANDROID-com.xunlei.downloadprovider",
      sdkVersion: "512000",
      devicesign: generateDeviceSign(
        this.options.deviceId,
        this.options.packageName,
      ),
      netWorkType: "WIFI",
      providerName: "NONE",
      deviceModel: "M2004J7AC",
      deviceName: "Xiaomi_M2004j7ac",
      OSVersion: "12",
      creditkey: this.creditKey,
      hl: "zh-CN",
      userName: username,
      passWord: password,
      verifyKey: "",
      verifyCode: "",
      isMd5Pwd: "0",
    }

    const res = await this.rawRequest<ThunderCoreLoginResp>(url, {
      method: "POST",
      body,
      headers: {
        "user-agent": "android-ok-http-client/xl-acc-sdk/version-5.0.12.512000",
      },
    })
    // F-284：登录响应必须校验，否则密码错误/需要验证时 sessionID 为
    // undefined，会把 undefined 的 signin_token 发出去并被 JSON.stringify 丢弃。
    const anyRes = res as any
    if (!res?.sessionID) {
      throw new Error(
        `Login failed: error_code=${anyRes?.error_code ?? ""}, error=${anyRes?.error ?? ""}, error_description=${anyRes?.error_description ?? ""}`,
      )
    }
    this.coreLoginResp = res
    return res
  }

  async login(username: string, password: string): Promise<ThunderTokenResp> {
    const coreResp = await this.coreLogin(username, password)
    const sessionId = coreResp.sessionID

    const signinUrl = `${XLUSER_API_URL}/auth/signin/token`
    await this.refreshCaptchaTokenInLogin(
      getAction("POST", signinUrl),
      username,
    )

    const resp = await this.rawRequest<ThunderTokenResp & ThunderErrResp>(
      signinUrl,
      {
        method: "POST",
        body: {
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          provider: SignProvider,
          signin_token: sessionId,
        },
      },
    )

    // F-284：signin 失败时校验并抛出上游真实原因，而不是把垃圾对象
    // 赋给 tokenResp 后在首次 authRequest 才报误导性的 "empty token"。
    if (!resp?.access_token) {
      throw new Error(
        `Signin failed: error_code=${resp?.error_code ?? ""}, error=${resp?.error ?? ""}, error_description=${resp?.error_description ?? ""}`,
      )
    }

    this.tokenResp = resp
    this.creditKey = "" // reset credit key upon successful login
    if (this.options.onPersistToken) {
      await this.options.onPersistToken(resp)
    }
    return resp
  }

  /**
   * 刷新 access token。
   *
   * F-281：
   *  - OAuth 错误响应（如 {"error":"invalid_grant"}）不得覆盖 tokenResp，
   *    必须校验 access_token 存在，否则共享驱动实例会被整体毒化；
   *  - 并发刷新复用同一个 in-flight Promise（singleflight），避免旧
   *    refresh_token 被并发消费导致互相失效；
   *  - 持久化只在真正刷新成功后执行一次。
   */
  async refreshToken(refreshToken: string): Promise<ThunderTokenResp> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefreshToken(refreshToken).finally(() => {
        this.refreshInFlight = null
      })
    }
    return this.refreshInFlight
  }

  private async doRefreshToken(
    refreshToken: string,
  ): Promise<ThunderTokenResp> {
    const url = `${XLUSER_API_URL}/auth/token`
    const resp = await this.rawRequest<ThunderTokenResp & ThunderErrResp>(url, {
      method: "POST",
      body: {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      },
    })
    if (!resp?.access_token) {
      throw new Error(
        `Refresh token failed: error_code=${resp?.error_code ?? ""}, error=${resp?.error ?? ""}, error_description=${resp?.error_description ?? ""}`,
      )
    }
    // 服务端未轮换 refresh_token 时沿用旧值，避免下一次刷新丢凭据
    if (!resp.refresh_token) resp.refresh_token = refreshToken
    this.tokenResp = resp
    if (this.options.onPersistToken) {
      await this.options.onPersistToken(resp)
    }
    return resp
  }

  async isLogin(): Promise<boolean> {
    if (!this.tokenResp?.access_token) return false
    try {
      await this.authRequest(`${XLUSER_API_URL}/user/me`, { method: "GET" })
      return true
    } catch {
      return false
    }
  }
}
