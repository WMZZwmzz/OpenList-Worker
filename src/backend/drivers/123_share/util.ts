import { randomInt } from "../rand"
import {
  Pan123ShareAddition,
  Pan123ShareFileInfo,
  Pan123ShareFilesResp,
  Pan123ShareDownloadInfoResp,
} from "./types"

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c
  }
  return table
})()

export function crc32(str: string | Uint8Array): number {
  const bytes = typeof str === "string" ? new TextEncoder().encode(str) : str
  let crc = 0 ^ -1
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

/** 按北京时间（UTC+8，上游钉死 CST）格式化 yyyyMMddHHmm，与宿主时区无关 */
export function formatCstTime(now: Date): string {
  const cst = new Date(now.getTime() + 8 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${cst.getUTCFullYear()}${pad(cst.getUTCMonth() + 1)}${pad(cst.getUTCDate())}${pad(cst.getUTCHours())}${pad(cst.getUTCMinutes())}`
}

export function signPath(
  path: string,
  os = "web",
  version = "3",
): [string, string] {
  const table = [
    "a",
    "d",
    "e",
    "f",
    "g",
    "h",
    "l",
    "m",
    "y",
    "i",
    "j",
    "n",
    "o",
    "p",
    "k",
    "q",
    "r",
    "s",
    "t",
    "u",
    "b",
    "c",
    "v",
    "w",
    "s",
    "z",
  ]
  // S-04 同类清单：sign 随机数改用 CSPRNG（原 Math.random）。
  const random = String(randomInt(1e7))
  const now = new Date()
  const timestamp = String(Math.floor(now.getTime() / 1000))

  const nowStr = formatCstTime(now)

  const mappedChars: string[] = []
  for (let i = 0; i < nowStr.length; i++) {
    const code = nowStr.charCodeAt(i) - 48
    mappedChars.push(table[code] || "a")
  }
  const timeSign = String(crc32(mappedChars.join("")))
  const data = [timestamp, random, path, os, version, timeSign].join("|")
  const dataSign = String(crc32(data))

  return [timeSign, [timestamp, random, dataSign].join("-")]
}

export function getSignedApiUrl(rawUrl: string): string {
  const u = new URL(rawUrl)
  const [k, v] = signPath(u.pathname, "web", "3")
  u.searchParams.set(k, v)
  return u.toString()
}

export class Pan123ShareApiClient {
  private addition: Pan123ShareAddition
  private mainApi = "https://yun.123pan.com/b/api"

  constructor(addition: Pan123ShareAddition) {
    this.addition = addition
  }

  async init(): Promise<void> {
    if (!this.addition.sharekey) {
      throw new Error("123Pan Share: sharekey is required")
    }
  }

  async request<T = any>(
    url: string,
    options: {
      method?: string
      params?: Record<string, string>
      body?: any
    } = {},
  ): Promise<T> {
    const targetUrl = new URL(url)
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        targetUrl.searchParams.set(k, v)
      }
    }

    const signedUrl = getSignedApiUrl(targetUrl.toString())
    const headers: Record<string, string> = {
      Origin: "https://yun.123pan.com",
      Referer: "https://yun.123pan.com/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) openlist-client",
      Platform: "web",
      "App-Version": "3",
    }

    if (this.addition.accesstoken) {
      headers["Authorization"] = `Bearer ${this.addition.accesstoken}`
    }

    let requestBody: string | undefined = undefined
    if (options.body) {
      headers["Content-Type"] = "application/json"
      requestBody = JSON.stringify(options.body)
    }

    const res = await fetch(signedUrl, {
      method: options.method || "GET",
      headers,
      body: requestBody,
    })

    if (!res.ok) {
      throw new Error(`123Pan Share API error: HTTP ${res.status}`)
    }

    const json = (await res.json()) as any
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.message || `123Pan Share API error (${json.code})`)
    }

    return json as T
  }

  async getFiles(parentId = "0"): Promise<Pan123ShareFileInfo[]> {
    const files: Pan123ShareFileInfo[] = []
    let page = 1

    // A-55：页数硬上限，避免异常服务端导致无限翻页。
    while (page <= 1000) {
      const res = await this.request<Pan123ShareFilesResp>(
        `${this.mainApi}/share/get`,
        {
          method: "GET",
          params: {
            limit: "100",
            next: "0",
            orderBy: "file_id",
            orderDirection: "desc",
            parentFileId: parentId || "0",
            Page: String(page),
            shareKey: this.addition.sharekey,
            SharePwd: this.addition.sharepassword || "",
          },
        },
      )

      const list = res.data?.InfoList || []
      files.push(...list)
      page++

      if (
        list.length === 0 ||
        res.data?.Next === "-1" ||
        res.data?.Next === -1
      ) {
        break
      }
    }

    return files
  }

  async getDownloadUrl(file: Pan123ShareFileInfo): Promise<string> {
    const res = await this.request<Pan123ShareDownloadInfoResp>(
      `${this.mainApi}/share/download/info`,
      {
        method: "POST",
        body: {
          shareKey: this.addition.sharekey,
          SharePwd: this.addition.sharepassword || "",
          etag: file.Etag || "",
          fileId: file.FileId,
          s3keyFlag: file.S3KeyFlag || "",
          size: file.Size,
        },
      },
    )

    let downloadUrl = res.data?.DownloadURL || ""
    if (!downloadUrl) {
      throw new Error("Failed to obtain download URL from 123Pan Share")
    }

    try {
      const ou = new URL(downloadUrl)
      const nu = ou.searchParams.get("params")
      if (nu) {
        const decoded = atob(nu)
        downloadUrl = decoded
      }
    } catch {
      // Keep original URL
    }

    return downloadUrl
  }
}
