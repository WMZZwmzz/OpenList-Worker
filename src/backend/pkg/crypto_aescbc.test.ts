import test from "node:test"
import assert from "node:assert/strict"
import { createCipheriv } from "node:crypto"
import { aesCbcEncryptBase64 } from "./crypto"

// chaoxing 登录用的 key/IV（见 drivers/chaoxing/util.ts:16）
const LOGIN_KEY = "u2oh6Vu^HWe4_AES"

/** Node 官方 AES-CBC：默认自动加单层 PKCS#7（与 W3C WebCrypto 规范一致）。 */
function nodeSinglePad(plain: string): string {
  const cipher = createCipheriv(
    "aes-128-cbc",
    Buffer.from(LOGIN_KEY),
    Buffer.from(LOGIN_KEY),
  )
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString(
    "base64",
  )
}

test("F-053: aesCbcEncryptBase64 applies exactly one PKCS#7 padding layer", async () => {
  for (const plain of ["testuser", "admin", "密码123", "a".repeat(17), ""]) {
    const actual = await aesCbcEncryptBase64(plain, LOGIN_KEY)
    assert.equal(actual, nodeSinglePad(plain), `plain=${JSON.stringify(plain)}`)

    // 密文长度必须是单层填充后的块数（10 字节明文 -> 16 字节，而不是 32）
    const blockAligned = Math.ceil((Buffer.byteLength(plain) + 1) / 16) * 16
    assert.equal(
      Buffer.from(actual, "base64").length,
      blockAligned,
      `length for ${JSON.stringify(plain)}`,
    )
  }
})

test("F-053: block-aligned plaintext gets a full padding block (not two)", async () => {
  const plain = "0123456789abcdef" // 16 bytes
  const actual = await aesCbcEncryptBase64(plain, LOGIN_KEY)
  const bytes = Buffer.from(actual, "base64")
  assert.equal(bytes.length, 32)
  // Node 单层填充解密回去仍是原文
  const { createDecipheriv } = await import("node:crypto")
  const decipher = createDecipheriv(
    "aes-128-cbc",
    Buffer.from(LOGIN_KEY),
    Buffer.from(LOGIN_KEY),
  )
  const decrypted = Buffer.concat([
    decipher.update(bytes),
    decipher.final(),
  ]).toString("utf8")
  assert.equal(decrypted, plain)
})

test("F-053: custom IV is honoured", async () => {
  const iv = "1234567890abcdef"
  const actual = await aesCbcEncryptBase64("payload", LOGIN_KEY, iv)
  const cipher = createCipheriv(
    "aes-128-cbc",
    Buffer.from(LOGIN_KEY),
    Buffer.from(iv),
  )
  const expected = Buffer.concat([
    cipher.update("payload", "utf8"),
    cipher.final(),
  ]).toString("base64")
  assert.equal(actual, expected)
})
