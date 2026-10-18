export interface RangeParams {
  start: number
  end: number
  chunksize: number
}

/**
 * 解析标准 Range 头。非法 / 越界 / 反向区间一律返回 null，由调用方给 416，
 * 不能再把 NaN 或负数当成长度去写 Content-Length。
 */
export function parseRangeHeader(
  rangeHeader: string,
  fileSize: number,
): RangeParams | null {
  const size = Number(fileSize)
  if (!Number.isFinite(size) || size <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (!rawStart && !rawEnd) return null
  let start: number
  let end: number
  if (!rawStart) {
    // `bytes=-N`：最后 N 字节
    const suffix = parseInt(rawEnd, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = parseInt(rawStart, 10)
    end = rawEnd ? parseInt(rawEnd, 10) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start >= size) return null
  if (end < start) return null
  if (end >= size) end = size - 1
  return { start, end, chunksize: end - start + 1 }
}
