import { describe, it } from "node:test"
import assert from "node:assert"
import { createCipheriv } from "crypto"
import {
  aesDecrypt,
  aesEncrypt,
  base64Decode,
  base64Encode,
  generateSecretKey,
  rsaEncrypt,
  RSAPublicKeyV1,
  RSAPublicKeyV2,
} from "./crypto"

describe("MoPan crypto (F-243)", () => {
  it("fails closed on a missing or invalid key instead of sending plaintext", () => {
    assert.throws(() => rsaEncrypt("0123456789abcdef", ""), /RSA 公钥缺失/)
    assert.throws(
      () => rsaEncrypt("0123456789abcdef", "not-a-key"),
      /RSA 公钥无效/,
    )
  })

  it("embeds the two distinct official public keys (upstream SDK)", () => {
    // 旧缺陷：两段“公钥”逐字符相同且为伪造占位符
    assert.notStrictEqual(RSAPublicKeyV1, RSAPublicKeyV2)
    assert.ok(RSAPublicKeyV1.includes("BEGIN PUBLIC KEY"))
    assert.ok(RSAPublicKeyV2.includes("BEGIN PUBLIC KEY"))
  })

  it("RSA-encrypts the session key into a 2048-bit ciphertext", () => {
    const secret = generateSecretKey()
    const encrypted = rsaEncrypt(secret, RSAPublicKeyV2)
    // 密文不是明文 base64（明文只有 16 字节）
    assert.notStrictEqual(
      encrypted,
      Buffer.from(secret, "utf-8").toString("base64"),
    )
    assert.strictEqual(base64Decode(encrypted).length, 256)
  })

  it("generates a 16-byte AES key with per-call randomness", () => {
    const a = generateSecretKey()
    const b = generateSecretKey()
    assert.strictEqual(a.length, 16)
    assert.strictEqual(Buffer.byteLength(a, "utf-8"), 16)
    assert.notStrictEqual(a, b)
  })

  it("AES-128-ECB round-trips device info", () => {
    const key = new TextEncoder().encode(generateSecretKey())
    const payload = JSON.stringify({ deviceId: "abc", platform: "android" })
    const encrypted = aesEncrypt(new TextEncoder().encode(payload), key)
    assert.strictEqual(
      new TextDecoder().decode(aesDecrypt(encrypted, key)),
      payload,
    )
  })

  it("is edge-safe: no Node-only modules in the crypto module (F-251)", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(new URL("./crypto.ts", import.meta.url), "utf-8")
    assert.ok(!/^\s*import[^;\n]*from\s+["'](node:)?crypto["']/m.test(src))
    // AES 输出必须与官方 SDK 的 aes-128-ecb/PKCS7 完全一致（F-243）
    const keyStr = "0123456789abcdef"
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(keyStr), null)
    const expected = Buffer.concat([
      cipher.update(Buffer.from("hello mopan", "utf-8")),
      cipher.final(),
    ]).toString("base64")
    assert.strictEqual(
      base64Encode(aesEncrypt(new TextEncoder().encode("hello mopan"), new TextEncoder().encode(keyStr))),
      expected,
    )
  })
})

describe("MoPan client sends an RSA-encrypted session key (F-243)", () => {
  it("encrypted-key header carries RSA ciphertext, not the plaintext key", async () => {
    const { MoPanClient } = await import("./util")
    const client = new MoPanClient({} as any)
    let captured: any = null
    const orig = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      captured = init
      return new Response(JSON.stringify({ code: 500, message: "stub" }), {
        status: 200,
      })
    }) as any
    try {
      await assert.rejects(() => client.login("13800138000", "password"))
      // encrypted-key 必须是 RSA-2048 密文（256 字节）；明文 base64 只有 16 字节
      const encKey = captured?.headers?.["encrypted-key"]
      assert.ok(encKey, "encrypted-key header must be sent")
      assert.strictEqual(base64Decode(encKey).length, 256)
      assert.ok(captured?.headers?.remoteInfo)
      assert.ok(captured?.body)
    } finally {
      globalThis.fetch = orig
    }
  })
})
