// mediafire (MediaFire 网盘) - session_token 认证
// API base: https://www.mediafire.com/api/1.5

export interface DriverMediafireAddition {
  /** 登录 Cookie（必填，用于获取 session_token） */
  cookie: string
  /** 会话 token（可选，缺省从 cookie 获取） */
  session_token?: string
  /** 每页数量 */
  chunk_size?: number
  /** 排序字段 */
  order_by?: string
  /** 排序方向 */
  order_direction?: string
}

export interface MediafireFile {
  quickkey?: string
  folderkey?: string
  filename?: string
  name?: string
  size?: string
  created?: string
  isFolder: boolean
}

export interface MediafireApiResp<T = any> {
  response?: T
}

export interface MediafireContent {
  folder_content?: {
    folders?: {
      folderkey: string
      name: string
      created?: string
      /** get_content(details=yes) 同时返回的 UTC 版本，带时区标记 */
      created_utc?: string
    }[]
    files?: {
      quickkey: string
      filename: string
      size: string
      created?: string
      created_utc?: string
    }[]
    more_chunks?: string
    chunk_size?: number
    chunk?: number
  }
  result?: string
  message?: string
  error?: string | number
}

export interface MediafireLinks {
  links?: { direct_download?: string; normal_download?: string }[]
  result?: string
}

export interface MediafireFolderCreate {
  folder_key?: string
  name?: string
  result?: string
}
