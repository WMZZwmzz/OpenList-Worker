/**
 * 上传体积限制（M-5：防止超大请求体被整体读入内存导致 Worker OOM）。
 *
 * 独立成模块是为了让 /fs/*、/dav/*（WebDAV PUT）、/s3/*（PutObject）三套写入口
 * 共用同一份上限判定；此前只有 /fs/* 检查，另两个端点完全不受限。
 *
 * 单次整体上传（/put、/form、PUT /dav、PUT /s3）与分片单片（/upload/part、
 * /multipart/chunk）分开设限，均可通过环境变量 MAX_UPLOAD / MAX_UPPART 覆盖。
 */

const DEFAULT_MAX_UPLOAD = 25 * 1024 * 1024 // 25MB
const DEFAULT_MAX_UPPART = 16 * 1024 * 1024 // 16MB

export function getUploadSizeLimit(c: any, part = false): number {
  const env = c.env || {}
  const key = part ? "MAX_UPPART" : "MAX_UPLOAD"
  const raw =
    env[key] || (typeof process !== "undefined" ? process.env?.[key] : "")
  if (raw) {
    const n = parseInt(String(raw), 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return part ? DEFAULT_MAX_UPPART : DEFAULT_MAX_UPLOAD
}

/** 返回超限时的上限字节数；未超限或无法预判（无 Content-Length）返回 null */
export function exceedsUploadLimit(c: any, part = false): number | null {
  const contentLength = parseInt(c.req.header("Content-Length") || "0", 10)
  if (!contentLength) return null
  const max = getUploadSizeLimit(c, part)
  return contentLength > max ? max : null
}

/**
 * 按**实际读到的字节数**判限并生成 413 响应。Content-Length 缺失（分块传输）时
 * exceedsUploadLimit 无从预判，旧实现因此完全跳过限制；这里在写入存储之前用真实
 * 长度兜住。未超限返回 null。
 */
export function overLimitResponse(c: any, bytes: number, part = false): any {
  const max = getUploadSizeLimit(c, part)
  if (bytes <= max) return null
  return c.json(
    {
      code: 413,
      message: `${part ? "Part" : "File"} too large (max ${max} bytes)`,
      data: null,
    },
    413,
  )
}

/**
 * 读取请求体并在**读取过程中**累计字节数，超过上限立即取消流。
 *
 * `c.req.arrayBuffer()` 会先把整个 body 读进内存，之后再判大小已经晚了：
 * chunked 传输（无 Content-Length）可以把 isolate 直接打爆。所有整体上传
 * 入口都应改用本函数。
 */
export async function readBodyBytesLimited(
  c: any,
  part = false,
): Promise<{ bytes: Uint8Array; tooLarge: number | null }> {
  const max = getUploadSizeLimit(c, part)
  const declared = parseInt(c.req.header("Content-Length") || "0", 10)
  if (declared > max) {
    return { bytes: new Uint8Array(0), tooLarge: max }
  }
  const body = c.req.raw?.body
  if (!body) return { bytes: new Uint8Array(0), tooLarge: null }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.length) continue
    total += value.byteLength
    if (total > max) {
      try {
        await reader.cancel()
      } catch {}
      return { bytes: new Uint8Array(0), tooLarge: max }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, tooLarge: null }
}

/**
 * 有上限的 multipart 解析：先把 body 有界读入，再交给标准 FormData 解析。
 * 上限与普通上传一致（MAX_UPLOAD）。
 */
export async function readFormDataLimited(
  c: any,
): Promise<{ form: FormData | null; tooLarge: number | null }> {
  const { bytes, tooLarge } = await readBodyBytesLimited(c, false)
  if (tooLarge !== null) return { form: null, tooLarge }
  const contentType = c.req.header("content-type") || ""
  const form = await new Response(bytes.buffer as ArrayBuffer, {
    headers: contentType ? { "Content-Type": contentType } : undefined,
  }).formData()
  return { form, tooLarge: null }
}
