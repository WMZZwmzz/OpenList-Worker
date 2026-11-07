// 纯 JS 哈希实现（hashers.ts），不使用 hash-wasm。
//
// 为什么不能用 hash-wasm：它在运行时通过 WebAssembly.compile() 编译内置
// WASM，而 Cloudflare Workers / Vercel Edge / EdgeOne 等边缘运行环境可能
// 禁止 Wasm 代码生成（"Wasm code generation disallowed by embedder"），
// 导致 seed 功能在这些受支持的目标上整体不可用。hashers.ts 提供同名、
// 同接口的纯 JS 实现，本文件与 codec.ts 必须从它导入。
import { createMD5, createSHA1, createSHA256, md5 } from "./hashers"
import type { IHasher } from "./hashers"
import { SeedHashes } from "./types"

interface HashSet {
  md5: IHasher
  sha1: IHasher
  sha256: IHasher
}

async function createHashSet(): Promise<HashSet> {
  const [md5Hasher, sha1Hasher, sha256Hasher] = await Promise.all([
    createMD5(),
    createSHA1(),
    createSHA256(),
  ])
  return {
    md5: md5Hasher.init(),
    sha1: sha1Hasher.init(),
    sha256: sha256Hasher.init(),
  }
}

function updateSet(set: HashSet, chunk: Uint8Array): void {
  set.md5.update(chunk)
  set.sha1.update(chunk)
  set.sha256.update(chunk)
}

function digestSet(set: HashSet): { md5: string; sha1: string; sha256: string } {
  return {
    md5: set.md5.digest("hex").toLowerCase(),
    sha1: set.sha1.digest("hex").toLowerCase(),
    sha256: set.sha256.digest("hex").toLowerCase(),
  }
}

function resetSet(set: HashSet): void {
  set.md5.init()
  set.sha1.init()
  set.sha256.init()
}

export class TorrentPieceHasher {
  private hasher: IHasher
  private written = 0
  private readonly hashes: string[] = []

  private constructor(hasher: IHasher, private readonly pieceSize: number) {
    this.hasher = hasher.init()
  }

  static async create(pieceSize: number): Promise<TorrentPieceHasher> {
    return new TorrentPieceHasher(await createSHA1(), pieceSize)
  }

  update(chunk: Uint8Array): void {
    let offset = 0
    while (offset < chunk.length) {
      const length = Math.min(this.pieceSize - this.written, chunk.length - offset)
      this.hasher.update(chunk.subarray(offset, offset + length))
      this.written += length
      offset += length
      if (this.written === this.pieceSize) this.finishPiece()
    }
  }

  digest(): string[] {
    if (this.written > 0) this.finishPiece()
    return [...this.hashes]
  }

  private finishPiece(): void {
    this.hashes.push(this.hasher.digest("hex").toLowerCase())
    this.hasher.init()
    this.written = 0
  }
}

export async function hashReadableStream(
  stream: ReadableStream<Uint8Array>,
  pieceSize: number,
  expectedSize: number,
  maxBytes: number,
  torrentHasher?: TorrentPieceHasher,
): Promise<{ size: number; hashes: SeedHashes }> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxBytes) {
    // F-102：这里还没 getReader()，但流同样会保持未消费状态（fetch 响应体/
    // 连接不释放），主动 cancel 掉上游。
    void cancelStream(stream)
    throw new Error(`File exceeds the hashing limit of ${maxBytes} bytes`)
  }
  const whole = await createHashSet()
  const piece = await createHashSet()
  const pieces = { md5: [] as string[], sha1: [] as string[], sha256: [] as string[] }
  const reader = stream.getReader()
  let size = 0
  let pieceWritten = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.length) continue
      if (size + value.length > maxBytes || size + value.length > expectedSize) {
        throw new Error("Downloaded file size exceeds the declared or configured limit")
      }
      size += value.length
      torrentHasher?.update(value)
      updateSet(whole, value)
      let offset = 0
      while (offset < value.length) {
        const length = Math.min(pieceSize - pieceWritten, value.length - offset)
        updateSet(piece, value.subarray(offset, offset + length))
        pieceWritten += length
        offset += length
        if (pieceWritten === pieceSize) {
          const digest = digestSet(piece)
          pieces.md5.push(digest.md5)
          pieces.sha1.push(digest.sha1)
          pieces.sha256.push(digest.sha256)
          resetSet(piece)
          pieceWritten = 0
        }
      }
    }
  } catch (error) {
    // F-102：出错时流通常只读了一部分（尺寸超限、读取异常），仅 releaseLock
    // 不会终止上游（典型为 fetch 的响应体/下载连接），必须 cancel。
    await cancelReader(reader)
    throw error
  } finally {
    reader.releaseLock()
  }
  if (size !== expectedSize) throw new Error(`Downloaded file size mismatch: expected ${expectedSize}, received ${size}`)
  if (pieceWritten > 0) {
    const digest = digestSet(piece)
    pieces.md5.push(digest.md5)
    pieces.sha1.push(digest.sha1)
    pieces.sha256.push(digest.sha256)
  }
  return { size, hashes: { ...digestSet(whole), pieces } }
}

async function cancelStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  try {
    await stream.cancel()
  } catch {
    // 上游可能已关闭/已取消；取消失败不影响向调用方抛出的原始错误。
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // 同上：cancel 只是尽力而为的资源回收。
  }
}

export async function calculateCasSliceMd5(hashes: string[], fileMd5: string): Promise<string> {
  return hashes.length > 1 ? (await md5(hashes.map((hash) => hash.toUpperCase()).join("\n"))).toUpperCase() : fileMd5
}
