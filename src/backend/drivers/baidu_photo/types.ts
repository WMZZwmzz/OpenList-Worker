// baidu_photo (百度相册) - Cookie 认证
// API reference: Go drivers/baidu_photo

export interface DriverBaiduPhotoAddition {
  cookie: string
  show_type?: string // root | root_only_album | root_only_file
  album_id?: string
  delete_origin?: boolean
  upload_thread?: string
}

export interface BaiduPhotoPage {
  has_more?: number
  cursor?: string
}

export interface BaiduPhotoFile {
  fsid: number
  path: string
  size: number
  ctime: number
  mtime: number
  thumburl?: string[]
  md5?: string
}

export interface BaiduPhotoAlbum {
  album_id: string
  /**
   * 相册 tid 是 18 位 int64（超出 Number.MAX_SAFE_INTEGER），
   * 全链路必须以字符串承载，避免 JSON 解析/Number() 舍入（F-300）。
   */
  tid: string
  title: string
  join_time?: number
  create_time: number
  mtime: number
}

export interface BaiduPhotoAlbumFile extends BaiduPhotoFile {
  album_id: string
  /** 同上：18 位 int64，必须用字符串承载（F-300）。 */
  tid: string
  uk: number
}

export interface BaiduPhotoFileListResp extends BaiduPhotoPage {
  list: BaiduPhotoFile[]
}

export interface BaiduPhotoAlbumListResp extends BaiduPhotoPage {
  list: BaiduPhotoAlbum[]
  reset?: number
  total_count?: number
}

export interface BaiduPhotoAlbumFileListResp extends BaiduPhotoPage {
  list: BaiduPhotoAlbumFile[]
  reset?: number
  total_count?: number
}

export interface BaiduPhotoUInfo {
  youa_id?: string
}

export interface BaiduPhotoDownloadResp {
  dlink?: string
}

export interface BaiduPhotoPrecreateResp {
  return_type?: number
  data?: {
    fs_id: number
    size: number
    md5: string
    server_filename: string
    path: string
    ctime: number
    mtime: number
    isdir: number
    category: number
  }
  path?: string
  uploadid?: string
  block_list?: number[]
}
