/**
 * TOTP (RFC 6238) 双因素认证模块 + 依赖无关的二维码生成
 * 添加日期: 2026-09-05
 *
 * F-054：原实现静态 import 了 `otplib`（内部 require('crypto') 的
 * createHmac/randomBytes）与 `qrcode`（浏览器构建依赖 canvas/document）。
 * ESA 边缘构建会把裸 `crypto`/`buffer` 替换成抛错 shim，于是：
 *   - POST /api/auth/2fa/generate 抛 500（2FA 无法开启）；
 *   - 已开启 2FA 的用户登录时 verifyTotpCode 永远 false → 401，且错误被吞掉，
 *     表现为静默锁死。
 *
 * 现在：
 *   1. TOTP 数学全部自带实现（纯 JS SHA-1 + HMAC-SHA1），不依赖任何运行时
 *      Node API；随机密钥走 WebCrypto `crypto.getRandomValues`；
 *      async 的 verifyTotpCode 优先用 WebCrypto `crypto.subtle` 做 HMAC-SHA1，
 *      不可用时自动回退到纯 JS 实现（两条路径在单测里交叉验证一致）。
 *   2. 二维码用内置的极简 QR 编码器（byte 模式、纠错级别 L、版本 1–10）直接
 *      输出 PNG data URL（1-bit 灰度，自带 CRC32/Adler-32/deflate stored 块），
 *      不再依赖 qrcode / canvas / document / pngjs。
 *   3. 无法编码时（超长 payload）返回空字符串而不是抛错——显式的降级行为，
 *      前端仍可通过 otpauth_url / secret 手动录入。
 *
 * 兼容性：所有历史导出函数签名保持不变；密钥仍是 Base32（RFC 4648），
 * 已用 Google Authenticator 等 App 绑定的用户不受影响。
 */

// ─── Base32 (RFC 4648, 无填充依赖) ──────────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

function base32Encode(bytes: Uint8Array): string {
  let out = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  }
  return out
}

/** 解码 Base32；忽略大小写、空格、连字符与尾部 '='。非法字符返回 null。 */
function base32Decode(input: string): Uint8Array | null {
  const clean = String(input ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/=+$/, "")
  if (!clean) return null
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx < 0) return null
    buffer = (buffer << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return out.length > 0 ? new Uint8Array(out) : null
}

// ─── SHA-1 / HMAC-SHA1（纯 JS，任何运行时可用） ────────────────────────────

function sha1(bytes: Uint8Array): Uint8Array {
  const bitLen = bytes.length * 8
  const paddedLen = (((bytes.length + 8) >>> 6) + 1) * 64
  const padded = new Uint8Array(paddedLen)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(paddedLen - 4, bitLen >>> 0, false)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = (x << 1) | (x >>> 31)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = t
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  const out = new Uint8Array(20)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0, false)
  outView.setUint32(4, h1, false)
  outView.setUint32(8, h2, false)
  outView.setUint32(12, h3, false)
  outView.setUint32(16, h4, false)
  return out
}

function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockKey = key.length > 64 ? sha1(key) : key
  const ipad = new Uint8Array(64).fill(0x36)
  const opad = new Uint8Array(64).fill(0x5c)
  for (let i = 0; i < blockKey.length; i++) {
    ipad[i] ^= blockKey[i]
    opad[i] ^= blockKey[i]
  }
  const inner = new Uint8Array(64 + message.length)
  inner.set(ipad)
  inner.set(message, 64)
  const innerHash = sha1(inner)
  const outer = new Uint8Array(64 + innerHash.length)
  outer.set(opad)
  outer.set(innerHash, 64)
  return sha1(outer)
}

// ─── HOTP / TOTP ────────────────────────────────────────────────────────────

const TOTP_PERIOD_SEC = 30
const TOTP_DIGITS = 6
/** 容错窗口：允许前后各 1 个时间步（与历史 otplib `window: 1` 一致）。 */
const TOTP_WINDOW = 1

function counterBytes(counter: number): Uint8Array {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setUint32(0, Math.floor(counter / 0x100000000), false)
  view.setUint32(4, counter >>> 0, false)
  return out
}

/** RFC 4226 动态截断 → 6 位十进制码。 */
function truncateToCode(hmac: Uint8Array): string {
  const offset = hmac[19] & 0x0f
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3]
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0")
}

function hotp(secretBytes: Uint8Array, counter: number): string {
  return truncateToCode(hmacSha1(secretBytes, counterBytes(counter)))
}

function currentCounter(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC)
}

/** 定时安全比较（等长十进制串）。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function normalizeToken(token: string): string | null {
  const normalized = String(token ?? "").replace(/\s+/g, "")
  return /^\d{6}$/.test(normalized) ? normalized : null
}

/** 纯 JS 路径在 ±window 个时间步内校验。 */
function verifyHotpWindow(
  secretBytes: Uint8Array,
  token: string,
  counter: number,
): boolean {
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
    const candidate = counter + offset
    if (candidate < 0) continue
    if (timingSafeEqual(hotp(secretBytes, candidate), token)) return true
  }
  return false
}

/** WebCrypto HMAC-SHA1 路径（异步）。不可用/失败时返回 null，由调用方回退。 */
async function verifyHotpWindowWebCrypto(
  secretBytes: Uint8Array,
  token: string,
  counter: number,
): Promise<boolean | null> {
  const subtle = (globalThis as any).crypto?.subtle
  if (!subtle) return null
  try {
    const key = await subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    )
    for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
      const candidate = counter + offset
      if (candidate < 0) continue
      const sig = new Uint8Array(
        await subtle.sign("HMAC", key, counterBytes(candidate)),
      )
      if (timingSafeEqual(truncateToCode(sig), token)) return true
    }
    return false
  } catch {
    // subtle 存在但不可用（某些边缘运行时限制）：交给纯 JS 路径
    return null
  }
}

/** WebCrypto CSPRNG 生成 TOTP 密钥（160-bit / Base32 32 字符）。 */
function generateSecretBase32(byteLength = 20): string {
  const webCrypto = (globalThis as any).crypto
  if (!webCrypto || typeof webCrypto.getRandomValues !== "function") {
    throw new Error(
      "TOTP secret generation requires WebCrypto crypto.getRandomValues",
    )
  }
  const bytes = new Uint8Array(byteLength)
  webCrypto.getRandomValues(bytes)
  return base32Encode(bytes)
}

// ─── otpauth URL（与历史 otplib.keyuri 输出保持一致） ───────────────────────

function buildOtpauthUrlInternal(
  secret: string,
  username: string,
  issuer: string = "OpenList",
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`
  return (
    `otpauth://totp/${label}` +
    `?secret=${encodeURIComponent(secret)}` +
    `&period=${TOTP_PERIOD_SEC}&digits=${TOTP_DIGITS}&algorithm=SHA1` +
    `&issuer=${encodeURIComponent(issuer)}`
  )
}

// ─── QR 编码器（byte 模式，纠错级别 L，版本 1–10，输出 SVG） ───────────────

interface QrVersionSpec {
  /** 每个纠错块的纠错码字数 */
  ecPerBlock: number
  /** [块数, 每块数据码字数] */
  groups: Array<[number, number]>
  /** 对齐图案中心坐标 */
  align: number[]
}

/** 纠错级别 L 的版本参数（ISO/IEC 18004 表 9 / 表 13）。 */
const QR_SPECS: Record<number, QrVersionSpec> = {
  1: { ecPerBlock: 7, groups: [[1, 19]], align: [] },
  2: { ecPerBlock: 10, groups: [[1, 34]], align: [6, 18] },
  3: { ecPerBlock: 15, groups: [[1, 55]], align: [6, 22] },
  4: { ecPerBlock: 20, groups: [[1, 80]], align: [6, 26] },
  5: { ecPerBlock: 26, groups: [[1, 108]], align: [6, 30] },
  6: { ecPerBlock: 18, groups: [[2, 68]], align: [6, 34] },
  7: { ecPerBlock: 20, groups: [[2, 78]], align: [6, 22, 38] },
  8: { ecPerBlock: 24, groups: [[2, 97]], align: [6, 24, 42] },
  9: { ecPerBlock: 30, groups: [[2, 116]], align: [6, 26, 46] },
  10: { ecPerBlock: 18, groups: [[2, 68], [2, 69]], align: [6, 28, 50] },
}

const QR_MAX_VERSION = 10

const QR_EC_LEVEL_L_BITS = 1

// GF(256) 表，生成多项式 0x11d
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** Reed-Solomon 纠错码字（返回 ecLen 个校验码字）。 */
function rsEncode(data: number[], ecLen: number): number[] {
  // 生成多项式 g(x) = Π (x + α^i)，用升幂系数表示
  let poly = [1]
  for (let i = 0; i < ecLen; i++) {
    const root = GF_EXP[i]
    const next = new Array(poly.length + 1).fill(0)
    for (let k = 0; k < poly.length; k++) {
      next[k + 1] ^= poly[k]
      next[k] ^= gfMul(poly[k], root)
    }
    poly = next
  }
  // poly[ecLen]===1；降幂表示的非首项系数
  const gen = poly.slice(0, ecLen).reverse()
  const rem = new Array(ecLen).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.shift()
    rem.push(0)
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i], factor)
    }
  }
  return rem
}

function bchDigit(value: number): number {
  let digit = 0
  let v = value
  while (v !== 0) {
    digit++
    v >>>= 1
  }
  return digit
}

const G15 = 0x537
const G15_MASK = 0x5412
const G18 = 0x1f25

function formatInfoBits(mask: number): number {
  const data = (QR_EC_LEVEL_L_BITS << 3) | mask
  let bits = data << 10
  while (bchDigit(bits) - bchDigit(G15) >= 0) {
    bits ^= G15 << (bchDigit(bits) - bchDigit(G15))
  }
  return ((data << 10) | bits) ^ G15_MASK
}

function versionInfoBits(version: number): number {
  let bits = version << 12
  while (bchDigit(bits) - bchDigit(G18) >= 0) {
    bits ^= G18 << (bchDigit(bits) - bchDigit(G18))
  }
  return (version << 12) | bits
}

const QR_MASKS: Array<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
]

/** 选版本 + 生成数据码字（含纠错块交织）。 */
function qrCodewords(
  bytes: Uint8Array,
): { version: number; spec: QrVersionSpec; codewords: number[] } | null {
  for (let version = 1; version <= QR_MAX_VERSION; version++) {
    const spec = QR_SPECS[version]
    const totalData = spec.groups.reduce((n, [count, words]) => n + count * words, 0)
    const countBits = version < 10 ? 8 : 16
    const needBits = 4 + countBits + bytes.length * 8
    if (needBits > totalData * 8) continue

    const bits: number[] = []
    const pushBits = (value: number, len: number) => {
      for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1)
    }
    pushBits(0b0100, 4) // byte 模式
    pushBits(bytes.length, countBits)
    for (const byte of bytes) pushBits(byte, 8)
    // 终止符 + 字节对齐
    for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0)
    while (bits.length % 8 !== 0) bits.push(0)

    const codewords: number[] = []
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
      codewords.push(byte)
    }
    // 填充码字 0xEC / 0x11 交替
    let pad = 0xec
    while (codewords.length < totalData) {
      codewords.push(pad)
      pad = pad === 0xec ? 0x11 : 0xec
    }

    const blocks: number[][] = []
    let ptr = 0
    for (const [count, words] of spec.groups) {
      for (let i = 0; i < count; i++) {
        blocks.push(codewords.slice(ptr, ptr + words))
        ptr += words
      }
    }
    const ecBlocks = blocks.map((block) => rsEncode(block, spec.ecPerBlock))

    const maxWords = Math.max(...blocks.map((block) => block.length))
    const finalWords: number[] = []
    for (let i = 0; i < maxWords; i++) {
      for (const block of blocks) {
        if (i < block.length) finalWords.push(block[i])
      }
    }
    for (let i = 0; i < spec.ecPerBlock; i++) {
      for (const block of ecBlocks) finalWords.push(block[i])
    }
    return { version, spec, codewords: finalWords }
  }
  return null
}

function buildQrMatrix(
  version: number,
  spec: QrVersionSpec,
  codewords: number[],
  mask: number,
): Uint8Array {
  const size = version * 4 + 17
  const modules = new Int8Array(size * size).fill(-1)
  const set = (row: number, col: number, dark: boolean) => {
    if (row < 0 || row >= size || col < 0 || col >= size) return
    modules[row * size + col] = dark ? 1 : 0
  }
  const at = (row: number, col: number) => modules[row * size + col]

  // 定位图案 + 分隔符
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        const dark =
          inside &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4))
        set(r0 + dr, c0 + dc, dark)
      }
    }
  }

  // 定时图案
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  // 对齐图案（与定位图案重叠的中心跳过）
  for (const row of spec.align) {
    for (const col of spec.align) {
      if (at(row, col) !== -1) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark =
            Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)
          set(row + dr, col + dc, dark)
        }
      }
    }
  }

  // 版本信息（版本 >= 7）
  if (version >= 7) {
    const bits = versionInfoBits(version)
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1
      set(Math.floor(i / 3), (i % 3) + size - 11, dark)
      set((i % 3) + size - 11, Math.floor(i / 3), dark)
    }
  }

  // 格式信息（含纠错级别 + 掩码）
  const formatBits = formatInfoBits(mask)
  for (let i = 0; i < 15; i++) {
    const dark = ((formatBits >> i) & 1) === 1
    if (i < 6) set(i, 8, dark)
    else if (i < 8) set(i + 1, 8, dark)
    else set(size - 15 + i, 8, dark)
  }
  for (let i = 0; i < 15; i++) {
    const dark = ((formatBits >> i) & 1) === 1
    if (i < 8) set(8, size - i - 1, dark)
    else if (i < 9) set(8, 15 - i, dark)
    else set(8, 15 - i - 1, dark)
  }
  // 固定深色模块
  set(size - 8, 8, true)

  // 数据区（右下角两列一组、蛇形向上/向下）
  const totalBits = codewords.length * 8
  const bitAt = (index: number) =>
    index < totalBits ? (codewords[index >> 3] >> (7 - (index & 7))) & 1 : 0
  const maskFn = QR_MASKS[mask]
  let bitIndex = 0
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (let c = 0; c < 2; c++) {
        const cc = col - c
        if (at(row, cc) !== -1) continue
        let bit = bitAt(bitIndex++)
        if (maskFn(row, cc)) bit ^= 1
        modules[row * size + cc] = bit
      }
    }
    upward = !upward
  }

  const out = new Uint8Array(size * size)
  for (let i = 0; i < out.length; i++) out[i] = modules[i] === 1 ? 1 : 0
  return out
}

function penaltyScore(modules: Uint8Array, size: number): number {
  let score = 0

  // 规则 1：行/列上连续同色 >= 5
  for (let i = 0; i < size; i++) {
    let runRow = 1
    let runCol = 1
    for (let j = 1; j < size; j++) {
      if (modules[i * size + j] === modules[i * size + j - 1]) {
        runRow++
      } else {
        if (runRow >= 5) score += 3 + (runRow - 5)
        runRow = 1
      }
      if (modules[j * size + i] === modules[(j - 1) * size + i]) {
        runCol++
      } else {
        if (runCol >= 5) score += 3 + (runCol - 5)
        runCol = 1
      }
    }
    if (runRow >= 5) score += 3 + (runRow - 5)
    if (runCol >= 5) score += 3 + (runCol - 5)
  }

  // 规则 2：2x2 同色块
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const v = modules[row * size + col]
      if (
        v === modules[row * size + col + 1] &&
        v === modules[(row + 1) * size + col] &&
        v === modules[(row + 1) * size + col + 1]
      ) {
        score += 3
      }
    }
  }

  // 规则 3：1:1:3:1:1 定位图案相似结构（含一侧 4 个浅色）
  const patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const patternB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      let matchA = true
      let matchB = true
      let matchColA = true
      let matchColB = true
      for (let k = 0; k < 11; k++) {
        const rowBit = modules[i * size + j + k]
        const colBit = modules[(j + k) * size + i]
        if (rowBit !== patternA[k]) matchA = false
        if (rowBit !== patternB[k]) matchB = false
        if (colBit !== patternA[k]) matchColA = false
        if (colBit !== patternB[k]) matchColB = false
      }
      if (matchA) score += 40
      if (matchB) score += 40
      if (matchColA) score += 40
      if (matchColB) score += 40
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0
  for (let i = 0; i < modules.length; i++) if (modules[i]) dark++
  const ratio = Math.abs((dark * 100) / (size * size) - 50) / 5
  score += Math.floor(ratio) * 10

  return score
}

/**
 * 把文本编码成 QR 模块矩阵（1 = 深色）。返回 null 表示 payload 超过版本 10
 * 在纠错级别 L 下的容量（271 字节）。
 *
 * 导出是为了让单测可以逐掩码与参考实现对照（见 totp.test.ts）。
 */
export function buildQrModuleMatrix(
  text: string,
  maskPattern?: number,
): { size: number; data: Uint8Array; version: number; mask: number } | null {
  const bytes = new TextEncoder().encode(String(text ?? ""))
  const encoded = qrCodewords(bytes)
  if (!encoded) return null
  const { version, spec, codewords } = encoded

  if (maskPattern !== undefined) {
    const mask = ((maskPattern % 8) + 8) % 8
    const data = buildQrMatrix(version, spec, codewords, mask)
    return { size: version * 4 + 17, data, version, mask }
  }

  let bestMask = 0
  let bestData: Uint8Array | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const data = buildQrMatrix(version, spec, codewords, mask)
    const score = penaltyScore(data, version * 4 + 17)
    if (score < bestScore) {
      bestScore = score
      bestMask = mask
      bestData = data
    }
  }
  if (!bestData) return null
  return { size: version * 4 + 17, data: bestData, version, mask: bestMask }
}

function qrToSvg(modules: Uint8Array, size: number, quietZone = 4): string {
  const dim = size + quietZone * 2
  let path = ""
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules[row * size + col]) {
        path += `M${col + quietZone} ${row + quietZone}h1v1h-1z`
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`
  )
}

// ─── 最小 PNG 编码器（1-bit 灰度 + deflate stored 块，零依赖） ─────────────
//
// 为什么不用 qrcode 包：它的浏览器构建依赖 canvas/document，ESA 边缘运行时
// 直接抛错；Node 构建又需要 pngjs。这里手写一个「不压缩」的 PNG：
// zlib 流用 deflate 的 stored 块（RFC 1951 §3.2.4），CRC32/Adler-32 自带。

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concatBytes([new TextEncoder().encode(type), data])
  return concatBytes([u32be(data.length), body, u32be(crc32(body))])
}

/** zlib 容器 + deflate stored 块（不压缩，但完全合法）。 */
function zlibStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])]
  let offset = 0
  do {
    const chunk = Math.min(65535, data.length - offset)
    const isFinal = offset + chunk >= data.length ? 1 : 0
    parts.push(
      new Uint8Array([
        isFinal,
        chunk & 0xff,
        (chunk >>> 8) & 0xff,
        ~chunk & 0xff,
        (~chunk >>> 8) & 0xff,
      ]),
    )
    parts.push(data.subarray(offset, offset + chunk))
    offset += chunk
  } while (offset < data.length)
  parts.push(u32be(adler32(data)))
  return concatBytes(parts)
}

/** QR 模块矩阵 → 1-bit 灰度 PNG（0 = 黑模块，1 = 白底）。 */
function qrToPng(
  modules: Uint8Array,
  size: number,
  scale = 4,
  quietZone = 4,
): Uint8Array {
  const side = (size + quietZone * 2) * scale
  const bytesPerRow = Math.ceil(side / 8)
  const raw = new Uint8Array((bytesPerRow + 1) * side) // 每行首字节 = filter 0
  for (let y = 0; y < side; y++) {
    const rowOffset = y * (bytesPerRow + 1) + 1
    const my = Math.floor(y / scale) - quietZone
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - quietZone
      const dark =
        mx >= 0 &&
        mx < size &&
        my >= 0 &&
        my < size &&
        modules[my * size + mx] === 1
      if (!dark) raw[rowOffset + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  const ihdr = concatBytes([
    u32be(side),
    u32be(side),
    new Uint8Array([
      1, // bit depth
      0, // color type: grayscale
      0, // compression
      0, // filter
      0, // interlace
    ]),
  ])
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibStored(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ])
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function base64Encode(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += BASE64_ALPHABET[b0 >> 2]
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length
      ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]
      : "="
    out += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f] : "="
  }
  return out
}

/**
 * 生成 QR 图片 data URL（PNG）。超长 payload 返回空字符串（显式降级）：
 * 调用方仍可用 otpauth_url 手动录入，不应因此 500。
 */
export function buildQrDataUrl(text: string): string {
  const matrix = buildQrModuleMatrix(text)
  if (!matrix) {
    console.warn(
      "[TOTP] QR payload too long for the built-in encoder; skipping QR image",
    )
    return ""
  }
  const png = qrToPng(matrix.data, matrix.size)
  return "data:image/png;base64," + base64Encode(png)
}

/** 备用：SVG 形态的 QR（保留给不消费 PNG 的调用方/调试用）。 */
export function buildQrSvgDataUrl(text: string): string {
  const matrix = buildQrModuleMatrix(text)
  if (!matrix) return ""
  const svg = qrToSvg(matrix.data, matrix.size)
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)
}

// ─── 对外 API（签名保持不变） ───────────────────────────────────────────────

/**
 * 生成 TOTP 密钥和 QR 码
 * @param username 用户名
 * @param issuer 发行者名称（应用名称）
 * @returns { secret, qrcode } 密钥和 QR 码 data URL
 */
export async function generateTOTPSecret(
  username: string,
  issuer: string = "OpenList",
): Promise<{ secret: string; qrcode: string; otpauth_url: string }> {
  // 160-bit Base32 密钥（32 字符），所有主流认证器都接受
  const secret = generateSecretBase32()
  const otpauth_url = buildOtpauthUrlInternal(secret, username, issuer)
  const qrcode = buildQrDataUrl(otpauth_url)
  return {
    secret,
    qrcode,
    otpauth_url,
  }
}

/**
 * 验证 TOTP 令牌（同步：纯 JS HMAC-SHA1，任何运行时可用）
 * @param token 用户输入的 6 位数字令牌
 * @param secret 用户的 TOTP 密钥
 * @returns 是否验证成功
 */
export function verifyTOTPToken(token: string, secret: string): boolean {
  try {
    const normalized = normalizeToken(token)
    if (!normalized) return false
    const secretBytes = base32Decode(secret)
    if (!secretBytes) {
      console.error("[TOTP] Invalid Base32 secret")
      return false
    }
    return verifyHotpWindow(secretBytes, normalized, currentCounter())
  } catch (err) {
    console.error("[TOTP] Verification error:", err)
    return false
  }
}

/**
 * 生成当前 TOTP 令牌
 * @param secret TOTP 密钥
 * @returns 6 位数字令牌
 */
export function generateTOTPToken(secret: string): string {
  const secretBytes = base32Decode(secret)
  if (!secretBytes) {
    throw new Error("Invalid TOTP secret: expected Base32")
  }
  return hotp(secretBytes, currentCounter())
}

/**
 * 验证 TOTP 密钥格式
 * @param secret TOTP 密钥
 * @returns 是否有效
 */
export function isValidTOTPSecret(secret: string): boolean {
  try {
    // Base32 密钥应该只包含 A-Z 和 2-7
    const base32Regex = /^[A-Z2-7]+=*$/
    return base32Regex.test(secret) && secret.length >= 16
  } catch {
    return false
  }
}

/**
 * 批量验证备用码（用于紧急登录）
 * 备用码应该由调用方生成并加密存储
 */
export function generateBackupCodes(count: number = 10): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error("Backup code count must be an integer between 1 and 1000")
  }
  // 使用 CSPRNG 生成恢复码，避免 Math.random 可预测导致 2FA 被绕过
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 去除易混淆字符 I/O/0/1
  const bytes = new Uint8Array(count * 8)
  crypto.getRandomValues(bytes)

  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    let code = ""
    for (let j = 0; j < 8; j++) {
      // 取模会有轻微偏置，但对 32 字符集、8 字节/码的恢复码场景可忽略；
      // 如需严格无偏可改为拒绝采样。
      code += alphabet[bytes[i * 8 + j] % alphabet.length]
    }
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`)
  }
  return codes
}

/**
 * 验证备用码（调用方需要实现存储和标记已使用）
 * @param inputCode 用户输入的备用码
 * @param storedCodes 存储的备用码列表
 * @returns 是否匹配（调用方需要在匹配后标记为已使用）
 */
export function verifyBackupCode(
  inputCode: string,
  storedCodes: string[],
): boolean {
  const normalized = inputCode.trim().toUpperCase().replace(/\s/g, "")
  return storedCodes.some(
    (code) => code.toUpperCase().replace(/\s/g, "") === normalized,
  )
}

// ============ 兼容旧代码的函数别名 ============

/**
 * 生成 TOTP 密钥（兼容旧代码）
 * @returns Base32 密钥字符串
 */
export function generateTotpSecret(): string {
  return generateSecretBase32()
}

/**
 * 生成当前 TOTP 令牌（兼容旧代码）
 * @param secret TOTP 密钥
 * @returns 6 位数字令牌
 */
export function generateTotpCode(secret: string): string {
  return generateTOTPToken(secret)
}

/**
 * 验证 TOTP 令牌（兼容旧代码）
 *
 * 异步版本优先走 WebCrypto 的 HMAC-SHA1（边缘运行时通常有 subtle 且性能更好），
 * 不可用时回退到纯 JS 实现；两条路径对同一 (secret, counter) 输出一致。
 */
export async function verifyTotpCode(secret: string, code: string): Promise<boolean> {
  const normalized = normalizeToken(code)
  if (!normalized) return false
  const secretBytes = base32Decode(secret)
  if (!secretBytes) {
    console.error("[TOTP] Invalid Base32 secret")
    return false
  }
  const counter = currentCounter()
  const viaWebCrypto = await verifyHotpWindowWebCrypto(
    secretBytes,
    normalized,
    counter,
  )
  if (viaWebCrypto !== null) return viaWebCrypto
  return verifyHotpWindow(secretBytes, normalized, counter)
}

/**
 * 构建 otpauth URL（兼容旧代码）
 * @param secret TOTP 密钥
 * @param username 用户名
 * @param issuer 发行者名称
 * @returns otpauth:// URL
 */
export function buildOtpauthUrl(
  secret: string,
  username: string,
  issuer: string = "OpenList",
): string {
  return buildOtpauthUrlInternal(secret, username, issuer)
}

/**
 * 构建 QR 码图片 URL（兼容旧代码）
 * @param otpauthUrl otpauth:// URL
 * @returns Data URL 格式的 QR 码（SVG；超长时为空字符串）
 */
export async function buildQrImageUrl(otpauthUrl: string): Promise<string> {
  // 本地自建 QR 实现（纯 JS SVG Data URL，不依赖 canvas / QRCode 库）；
  // 上游 #153 的 SVG 方案与本实现目标一致，此处保持本地版本。
  return buildQrDataUrl(otpauthUrl)
}
