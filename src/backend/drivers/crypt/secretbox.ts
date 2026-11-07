// NaCl crypto_secretbox 的纯 TS 实现（XSalsa20-Poly1305）。
//
// rclone/OpenList Go 版的 crypt 后端用 golang.org/x/crypto/nacl/secretbox 加密
// 每个 64KiB 数据块（见 cipher.ts）。WebCrypto 没有 XSalsa20-Poly1305，仓库也
// 不允许为此引入新依赖，故在此按 NaCl 规范实现一份，与
// golang.org/x/crypto/nacl/secretbox、tweetnacl、libsodium 字节级一致：
//
//   subKey    = HSalsa20(key, nonce[0:16])
//   polyKey   = XSalsa20(subKey, nonce[16:24], block 0) 的前 32 字节
//   ciphertext= message XOR 同一密钥流（从第 32 字节起，即 block 0 的后半 +
//               block 1、2、…）
//   tag       = Poly1305(ciphertext, polyKey)
//   box       = tag(16) || ciphertext
//
// Poly1305 用 BigInt 实现（每 16 字节一次 130 位乘加），Salsa20 用 32 位整数实现。

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] // "expand 32-byte k"

/** secretbox 的 MAC 长度 */
export const SECRETBOX_OVERHEAD = 16

function rotl(v: number, c: number): number {
  return (v << c) | (v >>> (32 - c))
}

function le32(b: Uint8Array, off: number): number {
  return (
    (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
  )
}

function storeLe32(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff
  b[off + 1] = (v >>> 8) & 0xff
  b[off + 2] = (v >>> 16) & 0xff
  b[off + 3] = (v >>> 24) & 0xff
}

/** 20 轮 Salsa20 置换；返回 16 个 32 位字（未加初始状态） */
function salsaRounds(
  s0: number, s1: number, s2: number, s3: number, s4: number, s5: number,
  s6: number, s7: number, s8: number, s9: number, s10: number, s11: number,
  s12: number, s13: number, s14: number, s15: number,
): number[] {
  let x0 = s0, x1 = s1, x2 = s2, x3 = s3, x4 = s4, x5 = s5, x6 = s6, x7 = s7
  let x8 = s8, x9 = s9, x10 = s10, x11 = s11, x12 = s12, x13 = s13, x14 = s14, x15 = s15
  for (let i = 0; i < 10; i++) {
    let u = (x0 + x12) | 0
    x4 ^= rotl(u, 7)
    u = (x4 + x0) | 0
    x8 ^= rotl(u, 9)
    u = (x8 + x4) | 0
    x12 ^= rotl(u, 13)
    u = (x12 + x8) | 0
    x0 ^= rotl(u, 18)

    u = (x5 + x1) | 0
    x9 ^= rotl(u, 7)
    u = (x9 + x5) | 0
    x13 ^= rotl(u, 9)
    u = (x13 + x9) | 0
    x1 ^= rotl(u, 13)
    u = (x1 + x13) | 0
    x5 ^= rotl(u, 18)

    u = (x10 + x6) | 0
    x14 ^= rotl(u, 7)
    u = (x14 + x10) | 0
    x2 ^= rotl(u, 9)
    u = (x2 + x14) | 0
    x6 ^= rotl(u, 13)
    u = (x6 + x2) | 0
    x10 ^= rotl(u, 18)

    u = (x15 + x11) | 0
    x3 ^= rotl(u, 7)
    u = (x3 + x15) | 0
    x7 ^= rotl(u, 9)
    u = (x7 + x3) | 0
    x11 ^= rotl(u, 13)
    u = (x11 + x7) | 0
    x15 ^= rotl(u, 18)

    u = (x0 + x3) | 0
    x1 ^= rotl(u, 7)
    u = (x1 + x0) | 0
    x2 ^= rotl(u, 9)
    u = (x2 + x1) | 0
    x3 ^= rotl(u, 13)
    u = (x3 + x2) | 0
    x0 ^= rotl(u, 18)

    u = (x5 + x4) | 0
    x6 ^= rotl(u, 7)
    u = (x6 + x5) | 0
    x7 ^= rotl(u, 9)
    u = (x7 + x6) | 0
    x4 ^= rotl(u, 13)
    u = (x4 + x7) | 0
    x5 ^= rotl(u, 18)

    u = (x10 + x9) | 0
    x11 ^= rotl(u, 7)
    u = (x11 + x10) | 0
    x8 ^= rotl(u, 9)
    u = (x8 + x11) | 0
    x9 ^= rotl(u, 13)
    u = (x9 + x8) | 0
    x10 ^= rotl(u, 18)

    u = (x15 + x14) | 0
    x12 ^= rotl(u, 7)
    u = (x12 + x15) | 0
    x13 ^= rotl(u, 9)
    u = (x13 + x12) | 0
    x14 ^= rotl(u, 13)
    u = (x14 + x13) | 0
    x15 ^= rotl(u, 18)
  }
  return [x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15]
}

/** Salsa20 状态布局：c0, k0..k3, c1, in0..in3, c2, k4..k7, c3 */
function salsaStateWords(
  key: Uint8Array,
  inWords: [number, number, number, number],
): number[] {
  return [
    SIGMA[0], le32(key, 0), le32(key, 4), le32(key, 8), le32(key, 12), SIGMA[1],
    inWords[0], inWords[1], inWords[2], inWords[3],
    SIGMA[2], le32(key, 16), le32(key, 20), le32(key, 24), le32(key, 28), SIGMA[3],
  ]
}

/** HSalsa20：32 字节子密钥（输出 x0,x5,x10,x15,x6,x7,x8,x9） */
export function hsalsa20(key: Uint8Array, nonce16: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error("[Crypt] HSalsa20 key must be 32 bytes")
  if (nonce16.length !== 16) throw new Error("[Crypt] HSalsa20 nonce must be 16 bytes")
  const st = salsaStateWords(key, [
    le32(nonce16, 0),
    le32(nonce16, 4),
    le32(nonce16, 8),
    le32(nonce16, 12),
  ])
  const x = salsaRounds(
    st[0], st[1], st[2], st[3], st[4], st[5], st[6], st[7],
    st[8], st[9], st[10], st[11], st[12], st[13], st[14], st[15],
  )
  const out = new Uint8Array(32)
  const words = [x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]]
  for (let i = 0; i < 8; i++) storeLe32(out, i * 4, words[i])
  return out
}

/** Salsa20 块函数：64 字节密钥流（nonce 8 字节 + 64 位小端块计数器） */
function salsa20Block(
  key: Uint8Array,
  nonce8: Uint8Array,
  counter: number,
): Uint8Array {
  const hi = Math.floor(counter / 0x100000000)
  const lo = counter >>> 0
  const st = salsaStateWords(key, [
    le32(nonce8, 0),
    le32(nonce8, 4),
    lo,
    hi,
  ])
  const x = salsaRounds(
    st[0], st[1], st[2], st[3], st[4], st[5], st[6], st[7],
    st[8], st[9], st[10], st[11], st[12], st[13], st[14], st[15],
  )
  const out = new Uint8Array(64)
  for (let i = 0; i < 16; i++) storeLe32(out, i * 4, (x[i] + st[i]) | 0)
  return out
}

/** 小端 16 字节 → BigInt */
function leBigInt(b: Uint8Array): bigint {
  let n = 0n
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
  return n
}

const POLY_P = (1n << 130n) - 5n
const MASK128 = (1n << 128n) - 1n

/** Poly1305 one-time MAC（RFC 8439 §2.5，r 按规范 clamp） */
export function poly1305(msg: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error("[Crypt] Poly1305 key must be 32 bytes")
  const rb = key.slice(0, 16)
  rb[3] &= 15
  rb[7] &= 15
  rb[11] &= 15
  rb[15] &= 15
  rb[4] &= 252
  rb[8] &= 252
  rb[12] &= 252
  const r = leBigInt(rb)
  const s = leBigInt(key.subarray(16, 32))

  const view =
    msg.length >= 16 ? new DataView(msg.buffer, msg.byteOffset, msg.byteLength) : null
  let h = 0n
  for (let off = 0; off < msg.length; off += 16) {
    const n = Math.min(16, msg.length - off)
    let block: bigint
    if (n === 16 && view) {
      block = view.getBigUint64(off, true) | (view.getBigUint64(off + 8, true) << 64n)
    } else {
      block = leBigInt(msg.subarray(off, off + n))
    }
    // 末尾补 0x01 字节（即 2^(8*n)）
    block |= 1n << BigInt(n * 8)
    h = ((h + block) * r) % POLY_P
  }
  const tag = (h + s) & MASK128
  const out = new Uint8Array(16)
  let v = tag
  for (let i = 0; i < 16; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function xorInto(
  out: Uint8Array,
  outOff: number,
  input: Uint8Array,
  inOff: number,
  len: number,
  keystream: Uint8Array,
  ksOff: number,
): void {
  for (let i = 0; i < len; i++) out[outOff + i] = input[inOff + i] ^ keystream[ksOff + i]
}

/** 生成 XSalsa20 子密钥与 8 字节 nonce 尾段 */
function xsalsaSetup(nonce: Uint8Array, key: Uint8Array): {
  subKey: Uint8Array
  nonce8: Uint8Array
} {
  if (key.length !== 32) throw new Error("[Crypt] secretbox key must be 32 bytes")
  if (nonce.length !== 24) throw new Error("[Crypt] secretbox nonce must be 24 bytes")
  return {
    subKey: hsalsa20(key, nonce.subarray(0, 16)),
    nonce8: nonce.subarray(16, 24),
  }
}

function xsalsaXor(
  message: Uint8Array,
  subKey: Uint8Array,
  nonce8: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(message.length)
  if (message.length === 0) return out
  // block 0：前 32 字节留给 Poly1305 key，消息从第 32 字节起与之异或
  const block0 = salsa20Block(subKey, nonce8, 0)
  const firstLen = Math.min(32, message.length)
  xorInto(out, 0, message, 0, firstLen, block0, 32)
  let pos = firstLen
  let counter = 1
  while (pos < message.length) {
    const block = salsa20Block(subKey, nonce8, counter++)
    const n = Math.min(64, message.length - pos)
    xorInto(out, pos, message, pos, n, block, 0)
    pos += n
  }
  return out
}

function polyKeyOf(subKey: Uint8Array, nonce8: Uint8Array): Uint8Array {
  return salsa20Block(subKey, nonce8, 0).subarray(0, 32)
}

/** crypto_secretbox：返回 tag(16) || ciphertext */
export function secretboxSeal(
  message: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  const { subKey, nonce8 } = xsalsaSetup(nonce, key)
  const ciphertext = xsalsaXor(message, subKey, nonce8)
  const tag = poly1305(ciphertext, polyKeyOf(subKey, nonce8))
  const out = new Uint8Array(SECRETBOX_OVERHEAD + ciphertext.length)
  out.set(tag, 0)
  out.set(ciphertext, SECRETBOX_OVERHEAD)
  return out
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** crypto_secretbox_open：校验 MAC 后返回明文；校验失败抛错 */
export function secretboxOpen(
  box: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  if (box.length < SECRETBOX_OVERHEAD) {
    throw new Error("[Crypt] secretbox 密文过短（缺少 16 字节 MAC）")
  }
  const { subKey, nonce8 } = xsalsaSetup(nonce, key)
  const tag = box.subarray(0, SECRETBOX_OVERHEAD)
  const ciphertext = box.subarray(SECRETBOX_OVERHEAD)
  const expected = poly1305(ciphertext, polyKeyOf(subKey, nonce8))
  if (!timingSafeEqual(tag, expected)) {
    throw new Error("[Crypt] 密文校验失败（MAC 不匹配：密码错误或数据损坏）")
  }
  return xsalsaXor(ciphertext, subKey, nonce8)
}
