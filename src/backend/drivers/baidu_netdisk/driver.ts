// Baidu Netdisk driver
// Re-ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/baidu_netdisk
// (driver.go — StorageDriver interface implementation)
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { createMD5, md5 } from "../../internal/seed/hashers"
import { BaiduAddition, BaiduFile } from "./types"
import {
  BaiduClient,
  ErrUploadIDExpired,
  UPLOAD_FALLBACK_API,
  UPLOAD_RETRY_COUNT,
  UPLOAD_RETRY_MAX_WAIT_MS,
  UPLOAD_RETRY_WAIT_MS,
  normalizeBaiduAddition,
} from "./util"

export { normalizeBaiduAddition } from "./util"

export const ErrBaiduEmptyFilesNotAllowed = new Error(
  "empty files are not allowed by baidu netdisk",
)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Go fileToObj → FileItem */
function baiduFileToFileItem(f: BaiduFile): FileItem {
  const serverFilename = f.server_filename || basename(f.path)
  const serverCtime = f.server_ctime || f.ctime || 0
  const serverMtime = f.server_mtime || f.mtime || 0
  const isDir = f.isdir === 1
  return {
    name: serverFilename,
    size: f.size || 0,
    is_dir: isDir,
    created: serverCtime
      ? new Date(serverCtime * 1000).toISOString()
      : undefined,
    modified: serverMtime
      ? new Date(serverMtime * 1000).toISOString()
      : new Date().toISOString(),
    sign: String(f.fs_id),
    type: calcFileType(serverFilename, isDir),
    thumb: f.thumbs?.url3 || "",
    raw_url: "",
  }
}

function basename(p: string): string {
  const segs = String(p || "").split("/")
  return segs[segs.length - 1] || ""
}

export class BaiduDriver implements StorageDriver {
  private client: BaiduClient
  private addition: BaiduAddition
  private uploadThread = 3
  private vipType = 0

  constructor(
    addition: BaiduAddition,
    onTokenUpdate?: (tokens: {
      access_token: string
      refresh_token: string
    }) => void,
  ) {
    this.addition = normalizeBaiduAddition(addition)
    this.client = new BaiduClient(this.addition, onTokenUpdate)
  }

  async init(): Promise<void> {
    const a = this.addition
    // upload_thread clamp 1..32 (Go Init)
    // F-209：不可解析字符串会让 parseInt 得到 NaN，而 NaN 通过 <1/>32 两个
    // 比较后仍是 NaN，最终并发 worker 数为 0、所有分片被静默跳过。这里先
    // 把非有限值回退到 1（对齐 Go：Atoi 失败得 0，再被 clamp 到 1）。
    let thread = parseInt(a.upload_thread || "3", 10)
    if (!Number.isFinite(thread)) thread = 1
    if (thread < 1) thread = 1
    if (thread > 32) thread = 32
    this.uploadThread = thread

    // access_token 是必填项（对齐前端表单 required）
    if (!this.client.accessToken) {
      throw new Error(
        "百度网盘缺少访问令牌 access_token（必填）：请通过 https://api.oplist.org/ 获取后填写。",
      )
    }

    // Validate the token and cache vip type.
    // 对齐 Go 原版 Init：uinfo 失败（token 无效 / 风控）→ 挂载失败并给出明确错误，
    // 而不是静默继续导致后续 list 全部 500。若 token 已失效（errno 20016/-6/111），
    // request() 会自动用 refresh_token 换新后重试。
    this.vipType = await this.client.uinfo()
  }

  private baiduPath(physicalPath: string): string {
    const clean =
      "/" +
      String(physicalPath || "")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .replace(/\/+/g, "/")
    return clean === "/" ? "/" : clean.replace(/\/$/, "")
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const files = await this.client.getFiles(this.baiduPath(physicalPath))
    const items = files.map(baiduFileToFileItem)
    return sortFileItems(
      items,
      this.addition.order_by || "name",
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const bp = this.baiduPath(physicalPath)
    if (bp === "/") {
      return {
        name: "/",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    }
    // Find the file by listing its parent (Baidu has no path lookup API)
    const parent = dirname(bp)
    const rawName = basename(bp)
    const decodedName = (() => {
      try {
        return decodeURIComponent(rawName)
      } catch {
        return rawName
      }
    })()
    const files = await this.client.getFiles(parent)
    const file = files.find(
      (f) =>
        f.server_filename === rawName ||
        f.server_filename === decodedName ||
        f.path === bp ||
        String(f.fs_id) === rawName,
    )
    if (!file) {
      throw new Error(`file not found: ${rawName}`)
    }
    const item = baiduFileToFileItem(file)
    if (file.isdir !== 1) {
      try {
        const link = await this.getDownloadLink(file)
        item.raw_url = link.url
        item.raw_url_headers = link.headers
      } catch (e: any) {
        // F-211：把真实原因（风控 31023 / token 失效等）写入 raw_url_error，
        // 让下载端点回 404 + 原因，而不是仅留在服务端日志里。
        item.raw_url_error = e?.message || String(e)
        console.warn(
          `[baidu_netdisk] getDownloadLink warning for ${file.server_filename}:`,
          e.message,
        )
      }
    }
    return item
  }

  /** Go Link(): download_api dispatch */
  private async getDownloadLink(file: BaiduFile): Promise<{
    url: string
    headers: Record<string, string>
  }> {
    const api = this.addition.download_api || "official"
    if (api === "crack") {
      return this.client.getCrackLink(file.path)
    }
    if (api === "crack_video") {
      return this.client.getCrackVideoLink(file.path, file.fs_id)
    }
    return this.client.getOfficialLink(file.fs_id)
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    await this.client.create(this.baiduPath(physicalPath), 0, 1, "", "", 0, 0)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    await this.client.manage("rename", [
      { path: this.baiduPath(physicalPath), newname: newName },
    ])
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    await this.client.manage("delete", [this.baiduPath(physicalPath)])
  }

  async move(
    _srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const name = names[0] || basename(srcPhys)
    // F-208：dstDir 是站点虚拟路径（含挂载前缀），不能直接交给百度；
    // dstPhys 才是目标条目自身的物理路径，取其父目录作为目标目录。
    const dest = dirname(this.baiduPath(dstPhys))
    await this.client.manage("move", [
      { path: this.baiduPath(srcPhys), dest, newname: name },
    ])
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const name = names[0] || basename(srcPhys)
    // 同 move：目标目录必须由物理目标路径推导
    const dest = dirname(this.baiduPath(dstPhys))
    await this.client.manage("copy", [
      { path: this.baiduPath(srcPhys), dest, newname: name },
    ])
  }

  // ---- Upload (Go Put / PutRapid / precreate / uploadSlice) ----

  readonly rapidHashAlgos = ["md5"]
  readonly rapidHashNeedsPieces = false

  async rapidUpload(
    _virtualPath: string,
    physicalPath: string,
    metadata: { size: number; md5?: string },
  ): Promise<boolean> {
    const md5Hash = String(metadata.md5 || "").toLowerCase()
    if (!/^[0-9a-f]{32}$/.test(md5Hash) || metadata.size < 1) return false
    const path = this.baiduPath(physicalPath)
    const now = Math.floor(Date.now() / 1000)
    try {
      await this.client.create(
        path,
        metadata.size,
        0,
        "",
        JSON.stringify([md5Hash]),
        now,
        now,
      )
      return true
    } catch {
      return false
    }
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    // 百度网盘不允许上传空文件
    if (content.length < 1) {
      throw ErrBaiduEmptyFilesNotAllowed
    }

    const streamSize = content.length
    const path = this.baiduPath(physicalPath)
    const name = basename(path)
    const now = Math.floor(Date.now() / 1000)
    const mtime = now
    const ctime = now

    // --- steps 0+1: 单遍哈希 ---
    // F-213：整文件 MD5、分片 MD5 与 256KB 头部 MD5 在同一次遍历中增量计算
    // （分片边界与头部位置已知），把降级路径上对整块 Buffer 的哈希遍历从
    // 两遍降为一遍；同时全程使用流式 hasher，避免为整个文件分配 padded 拷贝。
    const sliceSize = this.client.getSliceSize(streamSize, this.vipType)
    const count = Math.max(1, Math.ceil(streamSize / sliceSize))
    const lastBlockSize = streamSize % sliceSize || sliceSize
    const contentHasher = (await createMD5()).init()
    const blockList: string[] = []
    let headMd5 = ""
    for (let i = 0; i < count; i++) {
      const byteSize = i === count - 1 ? lastBlockSize : sliceSize
      const slice = content.subarray(i * sliceSize, i * sliceSize + byteSize)
      contentHasher.update(slice)
      blockList.push(await md5(slice))
      if (i === 0) {
        // precreate 的 slice-md5 = 文件头 256KB 的 MD5（不足 256KB 则取整个文件）
        headMd5 = await md5(
          slice.subarray(0, Math.min(256 * 1024, slice.length)),
        )
      }
    }
    const contentMd5 = contentHasher.digest("hex") as string

    // --- step 2: rapid upload (秒传) ---
    const rapidBlockList = JSON.stringify([contentMd5])
    try {
      await this.client.create(
        path,
        streamSize,
        0,
        "",
        rapidBlockList,
        mtime,
        ctime,
      )
      return // rapid upload succeeded
    } catch {
      // fall through to chunked upload
    }

    const blockListStr = JSON.stringify(blockList)

    // --- step 3: precreate ---
    let pre = await this.client.precreate(
      path,
      streamSize,
      blockListStr,
      contentMd5,
      headMd5,
      ctime,
      mtime,
    )
    if (pre.return_type === 2 && pre.info) {
      // instant success (md5 matched on server)
      return
    }

    // Upload retry loop (Go: for range 2 + ErrUploadIDExpired restart)
    for (let loop = 0; loop < 2; loop++) {
      // --- step 4: resolve upload domain ---
      let uploadUrl = this.addition.upload_api || UPLOAD_FALLBACK_API
      if (this.addition.use_dynamic_upload_api && pre.uploadid) {
        try {
          uploadUrl = await this.client.requestForUploadUrl(path, pre.uploadid)
        } catch {
          uploadUrl = this.addition.upload_api || UPLOAD_FALLBACK_API
        }
      }

      // --- step 5: upload all missing slices, honoring upload_thread ---
      const parts = pre.block_list || []
      let failed = false
      // Sequential queue with limited concurrency
      let cursor = 0
      const workers = Math.max(1, Math.min(this.uploadThread, parts.length))
      const worker = async () => {
        for (;;) {
          const idx = cursor++
          if (idx >= parts.length) return
          const partseq = parts[idx]
          if (partseq < 0) continue // already uploaded
          const offset = partseq * sliceSize
          const size = partseq + 1 === count ? lastBlockSize : sliceSize
          const slice = content.subarray(offset, offset + size)
          const params: Record<string, string> = {
            method: "upload",
            access_token: this.client.accessToken,
            type: "tmpfile",
            path,
            uploadid: pre.uploadid,
            partseq: String(partseq),
          }
          // retry per-slice (Go retry.Attempts(3), backoff)
          let ok = false
          for (let attempt = 0; attempt < UPLOAD_RETRY_COUNT; attempt++) {
            try {
              await this.client.uploadSlice(
                uploadUrl,
                params,
                name,
                slice,
                (this.addition.upload_timeout || 60) * 1000,
              )
              parts[idx] = -1
              ok = true
              break
            } catch (e) {
              if (e instanceof ErrUploadIDExpired) throw e
              if (attempt < UPLOAD_RETRY_COUNT - 1) {
                await sleep(
                  Math.min(
                    UPLOAD_RETRY_WAIT_MS * Math.pow(2, attempt),
                    UPLOAD_RETRY_MAX_WAIT_MS,
                  ),
                )
              }
            }
          }
          if (!ok) {
            failed = true
            throw new Error(`upload slice ${partseq} failed`)
          }
        }
      }
      try {
        await Promise.all(Array.from({ length: workers }, () => worker()))
        if (failed) throw new Error("upload slice failed")
      } catch (e) {
        if (e instanceof ErrUploadIDExpired) {
          // uploadid expired → restart precreate from scratch (no md5s)
          const newPre = await this.client.precreate(
            path,
            streamSize,
            blockListStr,
            "",
            "",
            ctime,
            mtime,
          )
          if (newPre.return_type === 2 && newPre.info) {
            return
          }
          pre = newPre
          continue
        }
        throw e
      }

      // --- step 6: create file ---
      await this.client.create(
        path,
        streamSize,
        0,
        pre.uploadid,
        blockListStr,
        mtime,
        ctime,
      )
      return
    }
    throw new Error("upload failed after retries")
  }
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/")
  if (idx <= 0) return "/"
  return p.slice(0, idx)
}
