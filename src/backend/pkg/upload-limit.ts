/**
 * 上传体积上限（M-5：防止超大请求体被整体读入内存导致 Worker OOM）。
 *
 * 覆盖范围：`/fs/put`、`/fs/form`、`/fs/multipart/chunk`（单片）以及 S3 `PutObject`。
 * 单次整体上传与分片单片分开设限，均可通过环境变量 `MAX_UPLOAD` / `MAX_UPPART` 覆盖。
 *
 * 安全不变量：体积上限必须按**实际收到的字节数**判定，不能只信 `Content-Length`——
 * 该头由客户端提供，可以省略、伪造或与真实 body 不一致。
 *
 * 历史缺陷：只做 `Content-Length` 预检，**省略该头即完全不拦截**——实测在
 * `MAX_UPLOAD=4` 时，不带 `Content-Length` 的 5 字节请求写入成功。这使上限形同
 * 虚设，超大请求体可被整体读入内存。
 *
 * 注意：`/fs/other` 签发的存储直传 URL（客户端直接写对象存储、不经过本站）不受
 * 本模块约束——数据的实际写入由下游存储自己限额。
 */

export const DEFAULT_MAX_UPLOAD = 25 * 1024 * 1024 // 25MB
export const DEFAULT_MAX_UPPART = 16 * 1024 * 1024 // 16MB

export function getUploadSizeLimit(c: any, part = false): number {
  const env = c?.env || {}
  const key = part ? "MAX_UPPART" : "MAX_UPLOAD"
  const raw =
    env[key] || (typeof process !== "undefined" ? process.env?.[key] : "")
  if (raw) {
    const n = parseInt(String(raw), 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return part ? DEFAULT_MAX_UPPART : DEFAULT_MAX_UPLOAD
}

/**
 * 只做 `Content-Length` 预检：超限时返回该上限值，否则返回 null。
 *
 * ⚠️ 本函数**不是完整保护**。`Content-Length` 可被省略或伪造，缺失时它直接
 * 返回 null（即放行）——任何**只**调用本函数的路径都会重新引入「省略该头即可
 * 绕过上限」的历史缺陷。需要完整保护时必须使用 `readBodyWithinLimit`
 * （它内部先调用本函数做预检，再按实际字节数复核）。
 *
 * 正因如此这里**刻意不导出**，避免日后被独立误用。
 */
function exceedsUploadLimit(c: any, part = false): number | null {
  const contentLength = parseInt(c.req.header("Content-Length") || "0", 10)
  if (!contentLength) return null
  const max = getUploadSizeLimit(c, part)
  return contentLength > max ? max : null
}

export const tooLargeResponse = (c: any, limit: number, label = "File") =>
  c.json(
    { code: 413, message: `${label} too large (max ${limit} bytes)`, data: null },
    413,
  )

/**
 * 读取请求体，并按**实际字节数**复核上传上限。
 *
 * 安全不变量（F-057）：上限判定必须发生在**读取过程中**，而不是把整个 body
 * 缓冲完之后。`c.req.arrayBuffer()` 会先把全部字节驻留内存再返回——chunked
 * 传输（无 Content-Length）或谎报偏小的 Content-Length 都让预检失效，
 * 攻击者可以在判定发生前就把 isolate / Node 进程打爆（本模块第 7-9 行
 * 自述的不变量正是「按实际收到的字节数判定」，但旧实现的判定来得太晚）。
 *
 * 现在改为：`Content-Length` 预检之后，用 `c.req.raw.body` 的 ReadableStream
 * 边读边累计，超过上限立即 `reader.cancel()` 并返回失败，不保留任何 chunk。
 * 返回契约保持不变（`{ ok: true, buffer } | { ok: false, limit }`），三个生产
 * 入口（/fs/put、/fs/multipart/chunk、S3 PutObject）无需改动。
 */
export async function readBodyWithinLimit(
  c: any,
  part = false,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; limit: number }> {
  const pre = exceedsUploadLimit(c, part)
  if (pre !== null) return { ok: false, limit: pre }
  const max = getUploadSizeLimit(c, part)

  const body = c?.req?.raw?.body
  if (!body || typeof body.getReader !== "function") {
    // 退化路径：上下文里没有可用的 ReadableStream（例如只提供 arrayBuffer()
    // 的轻量替身）。只能整体读取，但仍在返回前按实际字节数复核。
    const buffer = Buffer.from(await c.req.arrayBuffer())
    if (buffer.length > max) return { ok: false, limit: max }
    return { ok: true, buffer }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      total += value.byteLength
      if (total > max) {
        // 超限立即中止下载侧，避免继续把剩余字节拉进内存。
        try {
          await reader.cancel()
        } catch {}
        return { ok: false, limit: max }
      }
      chunks.push(value)
    }
  } catch (err) {
    try {
      await reader.cancel()
    } catch {}
    throw err
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }

  const buffer = Buffer.allocUnsafe(total)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, buffer }
}
