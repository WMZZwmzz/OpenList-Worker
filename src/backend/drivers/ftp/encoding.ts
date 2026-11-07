// FTP Encoding Utility supporting UTF-8, GBK, GB2312, etc.

let iconvModule: any = null
let iconvLoadError: Error | null = null

/**
 * F-264：用动态 import() 加载 iconv-lite（项目是 ESM，裸 `require()` 在
 * ESM/打包产物里不存在，异常又被 catch 静默吞掉 → 非 UTF-8 编码悄悄退化成
 * UTF-8，文件名乱码、上传/MKD 的字节序列与服务器期望不符）。
 *
 * 加载是异步的，因此调用方必须先 `await ensureEncodingReady(encoding)`；
 * 未加载时 encode/decode 会显式抛错，而不是静默回退 UTF-8。
 */
async function getIconv(): Promise<any> {
  if (iconvModule) return iconvModule
  try {
    const modName = "iconv-lite"
    const mod: any = await import(/* @vite-ignore */ modName)
    iconvModule = mod?.default ?? mod
  } catch (e: any) {
    iconvLoadError = new Error(
      `[FTP] encoding requires "iconv-lite" but it could not be loaded: ${e?.message || e}`,
    )
  }
  return iconvModule
}

/** 预加载非 UTF-8 编码所需的 iconv-lite（FTPClient 建连时调用并缓存） */
export async function ensureEncodingReady(encoding?: string): Promise<void> {
  const enc = normalizeEncoding(encoding)
  if (enc === "utf-8") return
  const iconv = await getIconv()
  if (!iconv) {
    throw iconvLoadError || new Error("[FTP] iconv-lite is not available")
  }
  if (
    typeof iconv.encodingExists === "function" &&
    !iconv.encodingExists(enc)
  ) {
    throw new Error(`[FTP] Unsupported encoding: ${enc}`)
  }
}

export function normalizeEncoding(enc?: string): string {
  const clean = (enc || "").trim().toLowerCase()
  if (!clean || clean === "utf8" || clean === "utf-8") {
    return "utf-8"
  }
  return clean
}

function requireIconv(enc: string): any {
  if (!iconvModule) {
    throw new Error(
      `[FTP] encoding "${enc}" is not available: iconv-lite has not been loaded ` +
        `(await ensureEncodingReady("${enc}") before encoding/decoding)`,
    )
  }
  return iconvModule
}

export function encodeFtpString(str: string, encoding: string): Buffer {
  const enc = normalizeEncoding(encoding)
  if (enc === "utf-8") {
    return Buffer.from(str, "utf-8")
  }
  const iconv = requireIconv(enc)
  return iconv.encode(str, enc)
}

export function decodeFtpBuffer(
  buf: Buffer | Uint8Array,
  encoding: string,
): string {
  const enc = normalizeEncoding(encoding)
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (enc === "utf-8") {
    return buffer.toString("utf-8")
  }
  const iconv = requireIconv(enc)
  return iconv.decode(buffer, enc)
}
