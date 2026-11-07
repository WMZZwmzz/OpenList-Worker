import assert from "node:assert/strict"
import { test } from "node:test"
import { publicEncrypt, constants } from "node:crypto"

import { rsaRawEncrypt, weapi, linuxapi, __internal } from "./crypto"

const PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`

test("netease raw RSA matches Node crypto", () => {
  const secretKey = new Uint8Array(16)
  for (let i = 0; i < 16; i++) secretKey[i] = i + 1

  const full = new Uint8Array(128)
  full.set(secretKey, 112)

  const actual = rsaRawEncrypt(secretKey)
  const expected = publicEncrypt(
    { key: PEM, padding: constants.RSA_NO_PADDING },
    Buffer.from(full),
  )
  assert.equal(Buffer.from(actual).toString("hex"), expected.toString("hex"))
})

test("weapi produces base64 params and 256-hex encSecKey", async () => {
  const res = await weapi({ limit: "10", offset: "0" })
  // params 是两层 AES-CBC 的 base64
  assert.match(res.params, /^[A-Za-z0-9+/]+=*$/)
  // encSecKey 是 raw RSA 结果 hex（128 字节 = 256 hex）
  assert.equal(res.encSecKey.length, 256)
  assert.match(res.encSecKey, /^[0-9a-f]+$/)
})

test("linuxapi produces uppercase hex eparams", async () => {
  const res = await linuxapi({
    url: "/api/song/enhance/player/url",
    method: "POST",
    params: { ids: "[1]", br: "999000" },
  })
  assert.match(res.eparams, /^[0-9A-F]+$/)
})

test("weapi params follow the server's double-base64 AES chain", async () => {
  const { createDecipheriv } = await import("node:crypto")
  const res = await weapi({ limit: "10", offset: "0" })
  assert.ok(Buffer.from(res.params, "base64").length > 0)
  assert.equal(res.encSecKey.length, 256)

  // 密钥改由 CSPRNG 生成（S-04），不可再通过拦截 Math.random 复现；
  // 改用 __internal 记录的实际 reversed 密钥解密第二层。
  const res2 = await weapi({ limit: "10", offset: "0" })
  const reversed = __internal.lastWeapiReversedKey
  assert.ok(reversed, "weapi should record its secret key for tests")

  const second = Buffer.from(res2.params, "base64")
  const dec2 = createDecipheriv("aes-128-cbc", Buffer.from(reversed), Buffer.from("0102030405060708"))
  const middle = Buffer.concat([dec2.update(second), dec2.final()])
  // between the layers there must be base64 ASCII (missing in the old code)
  assert.match(middle.toString("latin1"), /^[A-Za-z0-9+/]+=*$/)
  const dec1 = createDecipheriv("aes-128-cbc", Buffer.from("0CoJUm6Qyw8W8jud"), Buffer.from("0102030405060708"))
  const json = Buffer.concat([
    dec1.update(Buffer.from(middle.toString("latin1"), "base64")),
    dec1.final(),
  ]).toString("utf8")
  assert.deepEqual(JSON.parse(json), { limit: "10", offset: "0" })
})

test("aesCbcEncrypt WebCrypto path pads exactly once (F-385)", async () => {
  const { createCipheriv } = await import("node:crypto")
  const key = new TextEncoder().encode("0CoJUm6Qyw8W8jud")
  const iv = new TextEncoder().encode("0102030405060708")
  // 28 bytes: one full block + 12 bytes, must become 32 bytes (not 48).
  const src = new TextEncoder().encode("0123456789abcdefghijklmnopqr")
  assert.equal(src.length, 28)

  const nodeCipher = createCipheriv(
    "aes-128-cbc",
    Buffer.from(key),
    Buffer.from(iv),
  )
  const expected = Buffer.concat([
    nodeCipher.update(Buffer.from(src)),
    nodeCipher.final(),
  ])
  assert.equal(expected.length, 32)

  const webcrypto = await __internal.aesCbcEncryptWebCrypto(src, key, iv)
  assert.equal(webcrypto.length, 32)
  assert.equal(Buffer.from(webcrypto).toString("hex"), expected.toString("hex"))

  // Exact block multiple must gain one full padding block in both branches.
  const src32 = new TextEncoder().encode("0123456789abcdef0123456789abcdef")
  const nodeCipher2 = createCipheriv(
    "aes-128-cbc",
    Buffer.from(key),
    Buffer.from(iv),
  )
  const expected2 = Buffer.concat([
    nodeCipher2.update(Buffer.from(src32)),
    nodeCipher2.final(),
  ])
  const webcrypto2 = await __internal.aesCbcEncryptWebCrypto(src32, key, iv)
  assert.equal(expected2.length, 48)
  assert.equal(Buffer.from(webcrypto2).toString("hex"), expected2.toString("hex"))
})

test("aesEcbEncrypt WebCrypto path equals Node ECB (no RangeError)", async () => {
  const { createCipheriv } = await import("node:crypto")
  const key = new TextEncoder().encode("rFgB&h#%2?^eDg:Q")
  // 117-byte payload shaped like a getSongLink request
  const src = new TextEncoder().encode(
    JSON.stringify({
      url: "/api/song/enhance/player/url",
      method: "POST",
      params: { ids: "[1,2,3]", br: "999000" },
    }),
  )
  const nodeCipher = createCipheriv("aes-128-ecb", Buffer.from(key), null)
  const expected = Buffer.concat([nodeCipher.update(Buffer.from(src)), nodeCipher.final()])

  // The real WebCrypto branch must produce the same bytes as Node's ECB.
  const webcrypto = await __internal.aesEcbEncryptWebCrypto(src, key)
  assert.equal(Buffer.from(webcrypto).toString("hex"), expected.toString("hex"))

  // And the public function must agree on the Node path.
  const { eparams } = await linuxapi({
    url: "/api/song/enhance/player/url",
    method: "POST",
    params: { ids: "[1,2,3]", br: "999000" },
  })
  assert.equal(eparams, Buffer.from(expected).toString("hex").toUpperCase())
})
