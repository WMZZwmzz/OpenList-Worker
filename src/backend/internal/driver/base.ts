export interface FileItem {
  name: string
  size: number
  is_dir: boolean
  created?: string
  modified: string
  sign: string
  type: number // 1: FOLDER, 2: VIDEO, 3: AUDIO, 4: TEXT, 5: IMAGE, 0: UNKNOWN
  thumb?: string
  raw_url?: string
  /** Headers that must accompany the raw_url request (e.g. Cookie, Referer for cloud drives) */
  raw_url_headers?: Record<string, string>
  /** When the driver could not obtain a download link, the concrete reason (for better 404 reporting) */
  raw_url_error?: string
  /** Whole-file hash (e.g. md5) used for rapid upload */
  hash?: string
  /**
   * Whole-file hashes by algorithm, populated by drivers whose file listings
   * expose hashes (e.g. md5, sha1, sha256). Prefer this over the legacy `hash`
   * field; seed capability preflight consumes these to avoid re-downloading.
   */
  hashes?: {
    md5?: string
    sha1?: string
    sha256?: string
    /** Piece hashes when the driver exposes them (optional). */
    pieces?: {
      md5?: string[]
      sha1?: string[]
      sha256?: string[]
    }
  }
}

export function calcFileType(name: string, isDir: boolean): number {
  if (isDir) return 1 // FOLDER
  const ext = (name.split(".").pop() || "").toLowerCase()
  // F-111: "ts" 曾同时出现在 videoExts 与 textExts。video 先判，textExts 里的
  // "ts" 永远不可达，TypeScript 源码等 .ts 文本文件被分类成 VIDEO（前端进视频
  // 播放器）。上游 Go 的 VideoTypes 也不含 ts；这里按「文本优先」取舍，把它从
  // video 列表移除，MPEG-TS 片段请用 .m2ts/.mts 扩展名。
  const videoExts = [
    "mp4",
    "mkv",
    "avi",
    "mov",
    "flv",
    "wmv",
    "m2ts",
    "m4v",
    "rmvb",
    "webm",
    "3gp",
    "asf",
    "vob",
    "ogv",
    "rm",
    "f4v",
  ]
  if (videoExts.includes(ext)) return 2 // VIDEO

  const audioExts = [
    "mp3",
    "flac",
    "aac",
    "wav",
    "ogg",
    "m4a",
    "opus",
    "wma",
    "ape",
    "alac",
    "aiff",
    "mid",
    "midi",
  ]
  if (audioExts.includes(ext)) return 3 // AUDIO

  const textExts = [
    "txt",
    "md",
    "markdown",
    "json",
    "js",
    "ts",
    "jsx",
    "tsx",
    "css",
    "scss",
    "html",
    "htm",
    "xml",
    "yaml",
    "yml",
    "ini",
    "conf",
    "env",
    "log",
    "sql",
    "py",
    "java",
    "c",
    "cpp",
    "h",
    "hpp",
    "go",
    "rs",
    "sh",
    "bat",
    "cmd",
    "ps1",
    "php",
    "rb",
    "swift",
    "kt",
    "cs",
    "vue",
    "svelte",
    "json5",
    "toml",
  ]
  if (textExts.includes(ext)) return 4 // TEXT

  const imageExts = [
    "jpg",
    "jpeg",
    "png",
    "gif",
    "bmp",
    "webp",
    "svg",
    "ico",
    "tiff",
    "tif",
    "heic",
    "heif",
    "avif",
    "vvc",
    "avc",
    "psd",
    "ai",
  ]
  if (imageExts.includes(ext)) return 5 // IMAGE

  return 0 // UNKNOWN
}

export interface StorageDriver {
  init?(): Promise<void>
  list(virtualPath: string, physicalPath: string): Promise<FileItem[]>
  /**
   * 第三参 clientIp 为**可选**的请求方 IP（F-405）：CDN 防盗链签名驱动
   * （如 bunny_storage 的 cdn_token_include_ip）用它计算 token；其它驱动
   * 忽略即可，op 层在 IP 不可信（"unknown"）时不传。
   */
  get(
    virtualPath: string,
    physicalPath: string,
    clientIp?: string,
  ): Promise<FileItem>
  mkdir(virtualPath: string, physicalPath: string): Promise<void>
  rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void>
  remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void>
  /**
   * 移动条目。
   *
   * 参数契约（F-252，op 层 storage.ts 的 moveItems 是唯一调用方，所有实现
   * 必须遵守；mopan 等驱动的正确性直接依赖此语义）：
   * - `names`：srcDir 下要搬移的名字列表。op 层逐项调用（每次单元素），
   *   实现不得假设多元素，也**不得**自行用 names 拼目标路径。
   * - `srcPhys`：**源项自身**的物理路径（`${srcDir}/${name}` 经 resolvePath
   *   的解析结果），不是 srcDir 本身。
   * - `dstPhys`：**目标项自身**的完整物理路径（`${dstDir}/${name}` 的解析
   *   结果，已含文件名）——不是目标目录。需要目标父目录时按
   *   `dstPhys.split("/").slice(0, -1).join("/")` 推导（mopan 即此读法），
   *   绝不能再把 `dstDir + "/" + names[0]` 拼到 dstPhys 上，两种解读互斥。
   */
  move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void>
  /** 语义与 move 完全一致（F-252 契约见 move 注释），只是复制而非搬移。 */
  copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void>
  // 上传内容统一用 Uint8Array：ESA 边缘运行时没有全局 Buffer（Issue #169）。
  // 实现方**不得使用 Buffer 专有方法**（toString(encoding) / Buffer.from /
  // Buffer.concat 等）：Cloudflare 靠 nodejs_compat 注入 Buffer，ESA 没有，
  // 同一段代码在两边行为不同。需要文本请用 TextDecoder，需要 base64 请用 btoa。
  put(
    virtualPath: string,
    physicalPath: string,
    content: Uint8Array,
  ): Promise<void>
}
