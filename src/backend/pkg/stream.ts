/**
 * Stream utilities for OpenList.
 * Uses Web Streams API for cross-runtime compatibility (Cloudflare Workers / Node.js).
 */

export interface RangeParams {
  start: number
  end: number
  total: number
  size: number
}

/**
 * Parse Range header
 * @param rangeHeader Range header string
 * @param total Total file size
 *
 * F-060: 之前的三处偏差全部修正为 RFC 7233 语义：
 *   - 后缀区间 `bytes=-N`（取最后 N 字节）：旧实现 parts[0]==="" → NaN → undefined；
 *   - 越界 end 按规范截断为 total-1（旧实现直接放弃，调用方只能整文件 200）；
 *   - 多区间 `bytes=0-1,5-9` 旧实现把 "1,5" parseInt 成 1、静默丢弃第二区间；
 *     现在按规范整体拒绝（返回 undefined），调用方回退整文件响应。
 */
export function parseRange(
  rangeHeader: string | undefined | null,
  total: number,
): RangeParams | undefined {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return undefined
  }
  if (!Number.isFinite(total) || total <= 0) return undefined

  const spec = rangeHeader.slice("bytes=".length).trim()
  // 多区间（含逗号）不支持：按规范整体忽略，而不是误当首区间
  if (spec.includes(",")) return undefined

  const dash = spec.indexOf("-")
  if (dash < 0) return undefined
  const first = spec.slice(0, dash).trim()
  const last = spec.slice(dash + 1).trim()

  let start: number
  let end: number

  if (first === "") {
    // 后缀区间：最后 N 字节（N 为 0 时无意义，按不可满足处理）
    const suffix = Number(last)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = Number(first)
    if (!Number.isSafeInteger(start) || start < 0 || start >= total) {
      return undefined
    }
    if (last === "") {
      end = total - 1
    } else {
      end = Number(last)
      if (!Number.isSafeInteger(end)) return undefined
      // RFC 7233 §2.1: 超界 end 截断为 total-1
      end = Math.min(end, total - 1)
    }
    if (start > end) return undefined
  }

  return {
    start,
    end,
    total,
    size: end - start + 1,
  }
}

/**
 * Convert a buffer / Uint8Array to a Web ReadableStream
 */
export function bufferToStream(
  buffer: Uint8Array | ArrayBuffer,
): ReadableStream<Uint8Array> {
  const data = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
}

/**
 * Convert a Web ReadableStream to a Uint8Array buffer
 */
export async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
