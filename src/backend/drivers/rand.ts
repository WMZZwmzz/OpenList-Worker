/**
 * 驱动层共享 CSPRNG 随机串工具。
 *
 * 2026-10-31 深度安全审查报告 S-04 及其「同类清单」：驱动里大量
 * `Math.random()`（V8 xorshift128+，可预测、非密码学安全）被用于
 * 会话密钥、Digest cnonce、设备指纹、请求签名等场景。统一替换为
 * `crypto.getRandomValues`（Workers / Node 18+ / ESA 均可用）。
 */

/** 生成 len 个字符的随机小写十六进制串。 */
export function randomHex(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2))
  globalThis.crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out.slice(0, len)
}

/** 生成 len 个字符的随机字母数字串（无模偏差：拒绝采样）。 */
export function randomAlnum(len: number, charset: string): string {
  let out = ""
  while (out.length < len) {
    const bytes = new Uint8Array(len * 2)
    globalThis.crypto.getRandomValues(bytes)
    for (const b of bytes) {
      if (b >= 256 - (256 % charset.length)) continue
      out += charset.charAt(b % charset.length)
      if (out.length === len) break
    }
  }
  return out
}

/** 返回 [0, max) 内的随机整数（拒绝采样消除模偏差）。 */
export function randomInt(max: number): number {
  if (max <= 0) return 0
  const limit = Math.floor(0x100000000 / max) * max
  const bytes = new Uint8Array(4)
  for (;;) {
    globalThis.crypto.getRandomValues(bytes)
    const v =
      ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
    if (v < limit) return v % max
  }
}
