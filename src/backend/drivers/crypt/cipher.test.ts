import test from "node:test"
import assert from "node:assert/strict"
import {
  BLOCK_DATA_SIZE,
  BLOCK_HEADER_SIZE,
  BLOCK_SIZE,
  CryptCipher,
  DEFAULT_SALT,
  FILE_HEADER_SIZE,
  incrementNonce,
} from "./cipher"

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex")
}

function pattern(n: number, seed = 0x11): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    out[i] = x & 0xff
  }
  return out
}

const TEST_NONCE = new Uint8Array(24)
for (let i = 0; i < 24; i++) TEST_NONCE[i] = i + 1

// rclone backend/crypt/cipher_test.go 的官方已知答案向量（TestEncryptData）：
// password="" 时 rclone 使用全零密钥，cryptoRand 注入的 nonce 为 01 02 .. 18。
const RCLONE_HEADER =
  "52434c4f4e450000" + "0102030405060708090a0b0c0d0e0f101112131415161718"
const RCLONE_VECTORS: { name: string; plain: number[]; expected: string }[] = [
  { name: "empty", plain: [], expected: RCLONE_HEADER },
  {
    name: "1 byte",
    plain: [1],
    expected:
      RCLONE_HEADER + "095b446cd6237bbcb08d09fb524ce565" + "aa",
  },
  {
    name: "16 bytes",
    plain: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    expected:
      RCLONE_HEADER +
      "b9c4552a2710062918960a3e608c29b9" +
      "aa8a5e1e165b6d075de4e9bb367fd6d4",
  },
]

test("F-458: rclone crypt v1 官方已知答案向量（加密）", async () => {
  const cipher = CryptCipher.fromDataKey(new Uint8Array(32))
  for (const v of RCLONE_VECTORS) {
    const enc = await cipher.encrypt(new Uint8Array(v.plain), TEST_NONCE)
    assert.equal(hex(enc), v.expected, `vector ${v.name}`)
  }
})

test("F-458: rclone crypt v1 官方已知答案向量（解密）", async () => {
  const cipher = CryptCipher.fromDataKey(new Uint8Array(32))
  for (const v of RCLONE_VECTORS) {
    const plain = await cipher.decrypt(
      new Uint8Array(Buffer.from(v.expected, "hex")),
    )
    assert.equal(hex(plain), hex(new Uint8Array(v.plain)), `vector ${v.name}`)
  }
})

test("F-458: 文件头布局为 magic(8) + nonce(24)", async () => {
  const cipher = await CryptCipher.create("pw", "salt")
  const enc = await cipher.encrypt(new Uint8Array([1, 2, 3]), TEST_NONCE)
  assert.equal(Buffer.from(enc.slice(0, 8)).toString("latin1"), "RCLONE\u0000\u0000")
  assert.equal(hex(enc.slice(8, 32)), hex(TEST_NONCE))
  assert.equal(FILE_HEADER_SIZE, 32)
  // 3 字节明文 = 头(32) + MAC(16) + 密文(3)
  assert.equal(enc.length, 32 + 16 + 3)
})

test("F-458: 64KiB 分块 + 每块 16B MAC 的尺寸公式", () => {
  const cipher = CryptCipher.fromDataKey(new Uint8Array(32))
  assert.equal(BLOCK_DATA_SIZE, 65536)
  assert.equal(BLOCK_HEADER_SIZE, 16)
  assert.equal(BLOCK_SIZE, 65552)
  // 0 字节：只有文件头
  assert.equal(cipher.encryptedSize(0), 32)
  // 1 字节：头 + MAC + 1
  assert.equal(cipher.encryptedSize(1), 49)
  // 正好一整块：头 + (MAC + 65536)
  assert.equal(cipher.encryptedSize(65536), 32 + 65552)
  // 一块 + 1 字节：头 + 2*(MAC) + 65537
  assert.equal(cipher.encryptedSize(65537), 32 + 65537 + 2 * 16)
  for (const n of [0, 1, 1000, 65535, 65536, 65537, 200000]) {
    assert.equal(cipher.decryptedSize(cipher.encryptedSize(n)), n, `size ${n}`)
  }
  // 畸形长度（只剩 MAC）返回 0，不抛错（list 路径会用到）
  assert.equal(cipher.decryptedSize(32 + 8), 0)
  assert.equal(cipher.decryptedSize(10), 0)
})

test("F-458: 多块往返（含 64KiB 边界）", async () => {
  const cipher = await CryptCipher.create("password", "salt")
  for (const size of [0, 1, 31, 32, 33, 65535, 65536, 65537, 131072, 200000]) {
    const plain = pattern(size, size + 7)
    const enc = await cipher.encrypt(plain)
    assert.equal(enc.length, cipher.encryptedSize(size), `enc size ${size}`)
    if (size > 0) {
      // 密文不得与明文相同（分块 MAC 在前，故比较第一个数据块）
      assert.notEqual(
        hex(enc.slice(32 + 16, 32 + 16 + Math.min(16, size))),
        hex(plain.slice(0, Math.min(16, size))),
      )
    }
    const dec = await cipher.decrypt(enc)
    assert.equal(hex(dec), hex(plain), `roundtrip ${size}`)
  }
})

test("F-458: 每个块的 nonce 依次递增（小端 +1）", async () => {
  const nonce = new Uint8Array(24)
  incrementNonce(nonce)
  assert.equal(nonce[0], 1)
  nonce.fill(0)
  nonce[0] = 0xff
  nonce[1] = 0xff
  incrementNonce(nonce)
  assert.equal(nonce[0], 0)
  assert.equal(nonce[1], 0)
  assert.equal(nonce[2], 1)

  // 两块密文与「分别用 nonce、nonce+1 单块加密」逐字节一致，证明块 nonce 递增正确
  const cipher = await CryptCipher.fromDataKey(pattern(32, 5))
  const headerNonce = pattern(24, 9)
  const second = headerNonce.slice()
  incrementNonce(second)
  const oneBlock = pattern(BLOCK_DATA_SIZE, 3)
  const twoBlocks = new Uint8Array(BLOCK_DATA_SIZE * 2)
  twoBlocks.set(oneBlock, 0)
  twoBlocks.set(oneBlock, BLOCK_DATA_SIZE)
  const encTwo = await cipher.encrypt(twoBlocks, headerNonce)

  const encFirst = await cipher.encrypt(oneBlock, headerNonce)
  const encSecond = await cipher.encrypt(oneBlock, second)
  assert.equal(
    hex(encTwo.slice(32, 32 + encFirst.length - 32)),
    hex(encFirst.slice(32)),
  )
  assert.equal(
    hex(encTwo.slice(32 + encFirst.length - 32)),
    hex(encSecond.slice(32)),
  )
})

test("F-458: 错误密码 / 篡改数据 / 非 rclone 文件都显式报错", async () => {
  const a = await CryptCipher.create("password-a", "salt")
  const b = await CryptCipher.create("password-b", "salt")
  const plain = pattern(5000, 42)
  const enc = await a.encrypt(plain)

  await assert.rejects(() => b.decrypt(enc), /MAC 不匹配|校验失败/)

  const tampered = enc.slice()
  tampered[32 + 16] ^= 0xff
  await assert.rejects(() => a.decrypt(tampered), /MAC 不匹配|校验失败/)

  const badMagic = enc.slice()
  badMagic[0] = 0x00
  await assert.rejects(() => a.decrypt(badMagic), /magic/)

  await assert.rejects(() => a.decrypt(new Uint8Array(8)), /过短/)

  // 空 salt 使用 rclone 内置 defaultSalt：与显式空串不同的 salt 派生出不同密钥
  assert.equal(DEFAULT_SALT.length, 16)
  const c1 = await CryptCipher.create("pw", "")
  const c2 = await CryptCipher.create("pw", "different")
  const e2 = await c2.encrypt(plain)
  await assert.rejects(() => c1.decrypt(e2), /MAC 不匹配|校验失败/)
})
