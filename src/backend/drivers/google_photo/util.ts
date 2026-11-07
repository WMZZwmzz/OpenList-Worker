// Google Photos API 客户端
import {
  DriverGooglePhotoAddition,
  GooglePhotoMediaItem,
  GooglePhotoItems,
  GooglePhotoTokenResp,
  GooglePhotoApiError,
} from "./types"

const FETCH_ALL = "all"
const FETCH_ALBUMS = "albums"
const FETCH_SHARE_ALBUMS = "share_albums"
const FETCH_ROOT = "root"

export class ClientGooglePhoto {
  private addition: DriverGooglePhotoAddition
  private accessToken = ""

  constructor(addition: DriverGooglePhotoAddition) {
    this.addition = addition
  }

  async init(): Promise<void> {
    await this.refreshToken()
  }

  async refreshToken(): Promise<void> {
    const form = new URLSearchParams({
      client_id: this.addition.client_id,
      client_secret: this.addition.client_secret,
      refresh_token: this.addition.refresh_token,
      grant_type: "refresh_token",
    })
    const resp = await fetch("https://www.googleapis.com/oauth2/v4/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    })
    const data = (await resp.json()) as GooglePhotoTokenResp
    if (!data.access_token) {
      throw new Error("[GooglePhoto] refresh token failed")
    }
    this.accessToken = data.access_token
  }

  private async request(
    url: string,
    method: string,
    query?: Record<string, string>,
    body?: unknown,
  ): Promise<Response> {
    const qs = query ? "?" + new URLSearchParams(query).toString() : ""
    const headers: Record<string, string> = {
      Authorization: "Bearer " + this.accessToken,
      "Accept-Encoding": "gzip",
    }
    const options: RequestInit = { method, headers }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json"
      options.body = JSON.stringify(body)
    }
    let resp = await fetch(`${url}${qs}`, options)
    if (resp.status === 401) {
      await this.refreshToken()
      headers.Authorization = "Bearer " + this.accessToken
      resp = await fetch(`${url}${qs}`, options)
    }
    if (resp.status >= 400) {
      const err = (await resp.json().catch(() => ({}))) as GooglePhotoApiError
      throw new Error(
        `[GooglePhoto] request failed: ${
          err.error?.message || `HTTP ${resp.status}`
        }`,
      )
    }
    return resp
  }

  async getFiles(id: string): Promise<GooglePhotoMediaItem[]> {
    switch (id) {
      case FETCH_ALL:
        return this.getAllMedias()
      case FETCH_ALBUMS:
        return this.getAlbums()
      case FETCH_SHARE_ALBUMS:
        return this.getShareAlbums()
      case FETCH_ROOT:
        return this.getFakeRoot()
      default:
        return this.getMedias(id)
    }
  }

  private getFakeRoot(): GooglePhotoMediaItem[] {
    return [
      { id: FETCH_ALL, title: FETCH_ALL },
      { id: FETCH_ALBUMS, title: FETCH_ALBUMS },
      { id: FETCH_SHARE_ALBUMS, title: FETCH_SHARE_ALBUMS },
    ]
  }

  private getAlbums(): Promise<GooglePhotoMediaItem[]> {
    return this.fetchItems(
      "https://photoslibrary.googleapis.com/v1/albums",
      {
        fields: "albums(id,title,coverPhotoBaseUrl),nextPageToken",
        pageSize: "50",
        pageToken: "first",
      },
      "GET",
    )
  }

  private getShareAlbums(): Promise<GooglePhotoMediaItem[]> {
    return this.fetchItems(
      "https://photoslibrary.googleapis.com/v1/sharedAlbums",
      {
        fields: "sharedAlbums(id,title,coverPhotoBaseUrl),nextPageToken",
        pageSize: "50",
        pageToken: "first",
      },
      "GET",
    )
  }

  private getMedias(albumId: string): Promise<GooglePhotoMediaItem[]> {
    // F-448：mediaItems:search 是 POST 接口，albumId/pageSize/pageToken 属于
    // JSON 请求体（gRPC transcoding：有请求体时字段不再从 query 映射）。
    // 以前把它们放在 query 且不带 body，服务端等价于「无过滤条件」，
    // 返回的是整个媒体库而不是该相册的内容。query 只保留 fields。
    return this.fetchItems(
      "https://photoslibrary.googleapis.com/v1/mediaItems:search",
      {
        fields:
          "mediaItems(id,baseUrl,mimeType,mediaMetadata,filename),nextPageToken",
      },
      "POST",
      (pageToken) => ({
        albumId,
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
      }),
    )
  }

  private getAllMedias(): Promise<GooglePhotoMediaItem[]> {
    return this.fetchItems(
      "https://photoslibrary.googleapis.com/v1/mediaItems",
      {
        fields:
          "mediaItems(id,baseUrl,mimeType,mediaMetadata,filename),nextPageToken",
        pageSize: "100",
        pageToken: "first",
      },
      "GET",
    )
  }

  async getMedia(id: string): Promise<GooglePhotoMediaItem> {
    const resp = await this.request(
      `https://photoslibrary.googleapis.com/v1/mediaItems/${id}`,
      "GET",
      { fields: "mediaMetadata,baseUrl,mimeType" },
    )
    return (await resp.json()) as GooglePhotoMediaItem
  }

  private async fetchItems(
    url: string,
    query: Record<string, string>,
    method: string,
    bodyBuilder?: (pageToken: string) => unknown,
  ): Promise<GooglePhotoMediaItem[]> {
    const res: GooglePhotoMediaItem[] = []
    // pageToken 初始值为占位符 "first"（首轮不带 token）；每轮必须使用上一轮
    // 返回的 nextPageToken，否则结果超过一页时会无限重复请求第一页。
    let pageToken = query.pageToken === "first" ? "" : query.pageToken || ""
    let hasMore = true
    const seenTokens = new Set<string>()
    let pageCount = 0
    while (hasMore) {
      if (pageToken && seenTokens.has(pageToken)) {
        throw new Error(`[GooglePhoto] pagination stuck on token: ${pageToken}`)
      }
      if (pageToken) seenTokens.add(pageToken)
      if (++pageCount > 1000) {
        throw new Error("[GooglePhoto] pagination exceeded 1000 pages")
      }
      const q: Record<string, string> = { ...query }
      if (!bodyBuilder) {
        if (pageToken) {
          q.pageToken = pageToken
        } else {
          delete q.pageToken
        }
      } else {
        // POST 接口的分页参数只走请求体，不能同时出现在 query 里
        delete q.pageToken
        delete q.pageSize
      }
      // POST 接口（mediaItems:search）的分页参数必须随请求体发送。
      const body = bodyBuilder ? bodyBuilder(pageToken) : undefined
      const resp = await this.request(url, method, q, body)
      const data = (await resp.json()) as GooglePhotoItems
      pageToken = data.nextPageToken || ""
      hasMore = pageToken !== ""
      if (data.mediaItems) res.push(...data.mediaItems)
      if (data.albums) res.push(...data.albums)
      if (data.sharedAlbums) res.push(...data.sharedAlbums)
    }
    return res
  }

  async link(id: string): Promise<string> {
    const media = await this.getMedia(id)
    const mime = media.mimeType || ""
    if (mime.includes("image/")) return (media.baseUrl || "") + "=d"
    if (mime.includes("video/")) return (media.baseUrl || "") + "=dv"
    return media.baseUrl || ""
  }
}
