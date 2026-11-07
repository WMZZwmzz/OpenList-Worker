// 115 (115网盘 / 115 Open API) - Bearer Token 认证
// API reference: last branch src/drive/cloud115 (Open API)

export interface Driver115Addition {
  /** Open API 访问令牌（必填） */
  access_token: string
  /** Open API 刷新令牌（必填） */
  refresh_token: string
  /** 根目录文件夹 ID，默认 "0" */
  root_folder_id?: string
  /** 排序字段 */
  order_by?: "file_name" | "file_size" | "user_utime" | "file_type"
  /** 排序方向 */
  order_direction?: "asc" | "desc"
}

// --- 115 Open API 响应类型 ---

/**
 * Open API 返回的原始文件对象：115 开放平台的 JSON 字段全部是小写
 * （fid/fn/fc/fs/pc/upt/pid，见 115-sdk-go fs.go GetFilesResp_File）。
 * 客户端负责把它归一化成下方内部的 Cloud115File（大写字段）。
 */
export interface Cloud115RawFile {
  fid?: string
  fn?: string
  /** "0" = 文件夹，"1" = 文件 */
  fc?: string | number
  fs?: number
  sha1?: string
  pc?: string
  thumb?: string
  upt?: number
  pid?: string
  [key: string]: any
}

/** 归一化后的文件对象（驱动内部统一使用大写字段） */
export interface Cloud115File {
  Fid: string
  Fn: string
  /** "0" = 文件夹 */
  Fc: string
  FS: number
  Sha1?: string
  /** PickCode（下载用） */
  Pc?: string
  Thumbnail?: string
  Upt?: number
  Pid?: string
}

export interface Cloud115ListResp {
  /** Open API 信封：{ state, code, message, data } */
  state?: boolean
  code?: number
  message?: string
  errcode?: number
  errno?: number
  error?: string
  count?: number
  offset?: number
  page_size?: number
  /** 实际响应格式：{ data: [ {fid, fn, fc, fs, ...} ] } */
  data?: Cloud115RawFile[]
  // 旧格式（files 数组）兼容
  files?: any[]
}

export interface Cloud115UserInfoResp {
  state?: boolean
  code?: number
  message?: string
  data?: {
    user_id: string | number
    user_name: string
  }
}

/** downurl 响应条目：url 是嵌套两层的 { url: { url } }（SDK fs.go DownURLResp） */
export interface Cloud115DownEntry {
  file_name?: string
  file_size?: number
  pick_code?: string
  sha1?: string
  url?: { url?: string } | string
}

export interface Cloud115DownResp {
  state?: boolean
  code?: number
  message?: string
  /** 兼容个别历史形态 */
  url?: string
  /** 真实形态：{ data: { [fid]: { url: { url } } } } */
  data?: Record<string, Cloud115DownEntry>
}
