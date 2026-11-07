/**
 * 轻量 ZIP 解析器（无外部依赖，兼容 Cloudflare Workers）。
 * 仅支持 ZIP 格式（Deflate/Store）；rar/7z 等格式由上层明确返回「不支持」。
 *
 * 参考：插件 zip 包的解析逻辑（src/utils/zip_plugin.ts 的 extractZipNative）。
 */

export interface ZipEntry {
  /** 归档内路径（目录以 / 结尾） */
  name: string
  isDir: boolean
  /** 解压后大小 */
  size: number
  /** 压缩后大小 */
  compressedSize: number
  /** 压缩方式：0=Store, 8=Deflate */
  compressionMethod: number
  /** 数据在 buffer 中的偏移 */
  dataOffset: number
  /** 修改时间 */
  modified: string
}

export interface ZipArchive {
  entries: ZipEntry[]
}

/** 条目数量上限：中央目录完全由归档作者控制，避免海量条目拖垮解析/解压。 */
export const MAX_ZIP_ENTRIES = 10_000
/** 单条目解压上限（默认 64 MiB，可被调用方收紧）。 */
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024

/** 解析 ZIP 的中央目录，返回条目列表（不包含目录条目，只返回文件） */
export function parseZip(
  buffer: ArrayBuffer,
  maxEntries: number = MAX_ZIP_ENTRIES,
): ZipArchive {
  const view = new DataView(buffer)
  const length = buffer.byteLength

  // 1. 定位 End of Central Directory (EOCD)
  let eocdOffset = -1
  const minOffset = Math.max(0, length - 22 - 65557)
  for (let i = length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset === -1) {
    throw new Error("Invalid ZIP: End of Central Directory not found")
  }

  const cdCount = view.getUint16(eocdOffset + 10, true)
  const cdOffset = view.getUint32(eocdOffset + 16, true)

  const entries: ZipEntry[] = []
  let currentCdOffset = cdOffset
  for (let i = 0; i < cdCount; i++) {
    if (entries.length >= maxEntries) {
      throw new Error(`ZIP has too many entries (limit ${maxEntries})`)
    }
    if (view.getUint32(currentCdOffset, true) !== 0x02014b50) break

    const compressionMethod = view.getUint16(currentCdOffset + 10, true)
    const compressedSize = view.getUint32(currentCdOffset + 20, true)
    const uncompressedSize = view.getUint32(currentCdOffset + 24, true)
    const fileNameLength = view.getUint16(currentCdOffset + 28, true)
    const extraFieldLength = view.getUint16(currentCdOffset + 30, true)
    const fileCommentLength = view.getUint16(currentCdOffset + 32, true)
    const localHeaderOffset = view.getUint32(currentCdOffset + 42, true)

    // modified: DOS date/time at offset +12
    const modTime = view.getUint16(currentCdOffset + 12, true)
    const modDate = view.getUint16(currentCdOffset + 14, true)
    const modified = dosDateTimeToIso(modDate, modTime)

    const fileNameBytes = new Uint8Array(
      buffer,
      currentCdOffset + 46,
      fileNameLength,
    )
    const fileName = new TextDecoder("utf-8").decode(fileNameBytes)

    currentCdOffset +=
      46 + fileNameLength + extraFieldLength + fileCommentLength

    // 跳过目录条目
    if (fileName.endsWith("/")) continue

    // 读 local header 获取数据偏移
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) continue
    const localFileNameLen = view.getUint16(localHeaderOffset + 26, true)
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true)
    const dataOffset = localHeaderOffset + 30 + localFileNameLen + localExtraLen

    entries.push({
      name: fileName.replace(/\\/g, "/"),
      isDir: false,
      size: uncompressedSize,
      compressedSize,
      compressionMethod,
      dataOffset,
      modified,
    })
  }

  return { entries }
}

/** 解压单个条目，返回其内容；超过 maxBytes 时中止，避免 zip bomb 撑爆内存。 */
export async function extractZipEntry(
  buffer: ArrayBuffer,
  entry: ZipEntry,
  maxBytes: number = MAX_ZIP_ENTRY_BYTES,
): Promise<Uint8Array> {
  const compressed = new Uint8Array(
    buffer,
    entry.dataOffset,
    entry.compressedSize,
  )

  if (entry.compressionMethod === 0) {
    // Store（未压缩）
    if (compressed.byteLength > maxBytes) {
      throw new Error(
        `ZIP entry exceeds the ${maxBytes}-byte extraction limit: ${entry.name}`,
      )
    }
    return new Uint8Array(compressed)
  }

  if (entry.compressionMethod === 8) {
    // Deflate
    if (typeof DecompressionStream === "undefined") {
      throw new Error("DecompressionStream is not supported in this runtime")
    }
    const ds = new DecompressionStream("deflate-raw")
    const writer = ds.writable.getWriter()

    /**
     * F-113：写侧必须自己吞掉拒绝。
     *
     * 旧实现 `writer.write(compressed)` / `writer.close()` 既不 await 也不挂
     * catch。zip-bomb 中止路径上 `reader.cancel()` 会按 Streams 规范 error 掉
     * 可写侧，挂起的 write/close 以 AbortError 拒绝且无人处理 —— Node 15+
     * 默认把 unhandled rejection 当未捕获异常，进程直接退出（一个请求打挂
     * 整个服务）。这里把 write→close 串成一个 Promise 并立即挂 catch：
     * 无论成功、被 cancel/abort、还是畸形 deflate 导致失败，都不会逃逸成
     * unhandled rejection；调用方通过 reader.read() / 抛出的限额错误感知失败。
     *
     * 不能先 await 这个 Promise 再读：readable 侧不排空时，write 会因内部
     * 队列反压永久挂起（死锁），所以必须并发读、最后统一 await。
     */
    const writerDone = (async () => {
      try {
        await writer.write(compressed)
        await writer.close()
      } catch {
        // 预期内的失败（超限 cancel / malformed deflate）：已由读侧报告
      }
    })()
    const reader = ds.readable.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let completed = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        total += value.byteLength
        if (total > maxBytes) {
          // 确定性释放：先中止读侧，再 abort 写侧，最后等写侧落定。
          try {
            await reader.cancel()
          } catch {}
          try {
            await writer.abort()
          } catch {}
          await writerDone
          throw new Error(
            `ZIP entry exceeds the ${maxBytes}-byte extraction limit: ${entry.name}`,
          )
        }
        chunks.push(value)
      }
      completed = true
    } finally {
      try {
        reader.releaseLock()
      } catch {}
      if (!completed) {
        // 读侧异常退出（畸形 deflate 等）：确保写侧也被 abort，否则挂起的
        // write 永远不落定，finally 里的 await 会挂死。
        try {
          await writer.abort()
        } catch {}
      }
      // 成功路径上写侧应已 close；失败路径上 write/close 的拒绝已被
      // writerDone 内部吞掉，这里只等待其落定，保证资源确定性释放。
      await writerDone
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }

  throw new Error(
    `Unsupported ZIP compression method: ${entry.compressionMethod}`,
  )
}

function dosDateTimeToIso(dosDate: number, dosTime: number): string {
  const year = 1980 + ((dosDate >> 9) & 0x7f)
  const month = (dosDate >> 5) & 0x0f
  const day = dosDate & 0x1f
  const hour = (dosTime >> 11) & 0x1f
  const minute = (dosTime >> 5) & 0x3f
  const second = (dosTime & 0x1f) * 2
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}Z`
}
