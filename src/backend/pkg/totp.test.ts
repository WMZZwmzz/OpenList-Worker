import assert from "node:assert"
import { test } from "node:test"
import QRCode from "qrcode"
import {
  buildQrDataUrl,
  buildQrModuleMatrix,
  buildOtpauthUrl,
  buildQrImageUrl,
  generateBackupCodes,
  generateTOTPSecret,
  generateTOTPToken,
  generateTotpCode,
  generateTotpSecret,
  isValidTOTPSecret,
  verifyBackupCode,
  verifyTOTPToken,
  verifyTotpCode,
} from "./totp"

// RFC 6238 test secret: ASCII "12345678901234567890"
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

function atTime<T>(epochMs: number, fn: () => T): T {
  const realNow = Date.now
  Date.now = () => epochMs
  try {
    return fn()
  } finally {
    Date.now = realNow
  }
}

test("F-054: TOTP matches RFC 6238 test vectors without otplib", () => {
  // TOTP 截断取低 6 位：59s -> 94287082 -> 287082；1111111109s -> 07081804 -> 081804
  assert.equal(atTime(59_000, () => generateTOTPToken(RFC_SECRET)), "287082")
  assert.equal(
    atTime(1_111_111_109_000, () => generateTOTPToken(RFC_SECRET)),
    "081804",
  )
  assert.equal(
    atTime(1_111_111_111_000, () => generateTOTPToken(RFC_SECRET)),
    "050471",
  )
})

test("F-054: verifyTOTPToken accepts the current step and ±1 window only", () => {
  const now = 1_700_000_000_000 // fixed epoch, avoids 30s boundary flake
  const code = atTime(now, () => generateTOTPToken(RFC_SECRET))
  assert.equal(atTime(now, () => verifyTOTPToken(code, RFC_SECRET)), true)
  // 前一个时间步的码仍在 ±1 窗口内
  const prev = atTime(now - 30_000, () => generateTOTPToken(RFC_SECRET))
  assert.equal(atTime(now, () => verifyTOTPToken(prev, RFC_SECRET)), true)
  // 两个时间步之前超出窗口
  const old = atTime(now - 90_000, () => generateTOTPToken(RFC_SECRET))
  assert.equal(atTime(now, () => verifyTOTPToken(old, RFC_SECRET)), false)
  // 格式/密钥错误不抛异常
  assert.equal(verifyTOTPToken("12345", RFC_SECRET), false)
  assert.equal(verifyTOTPToken(code, "NOT-BASE32-!!"), false)
})

test("F-054: async verifyTotpCode (WebCrypto path) agrees with sync path", async () => {
  const secret = generateTotpSecret()
  assert.equal(isValidTOTPSecret(secret), true)
  const code = generateTotpCode(secret)
  assert.match(code, /^\d{6}$/)
  assert.equal(await verifyTotpCode(secret, code), true)
  assert.equal(await verifyTotpCode(secret, "000000"), false)
  assert.equal(await verifyTotpCode(secret, "not-a-code"), false)
})

test("F-054: generated secret is 160-bit Base32 and QR is a dependency-free PNG data URL", async () => {
  const { secret, qrcode, otpauth_url } = await generateTOTPSecret("alice")
  assert.equal(secret.length, 32)
  assert.equal(isValidTOTPSecret(secret), true)
  assert.equal(otpauth_url, buildOtpauthUrl(secret, "alice"))
  assert.ok(otpauth_url.startsWith("otpauth://totp/OpenList:alice?"))
  assert.ok(otpauth_url.includes("period=30&digits=6&algorithm=SHA1"))

  assert.ok(qrcode.startsWith("data:image/png;base64,"))
  const png = Buffer.from(qrcode.slice("data:image/png;base64,".length), "base64")
  // PNG 签名 + IHDR 尺寸（(33+4*2)*4 = 164px，随版本变化，这里只校验结构）
  assert.deepEqual(
    Array.from(png.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  )
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR")
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.equal(width, height)
  assert.ok(width >= 21 * 4, "quiet zone + scale must be applied")
  assert.equal(png[24], 1, "bit depth")
  assert.equal(png[25], 0, "grayscale colour type")
  // IEND 位于末尾
  assert.ok(png.subarray(png.length - 8, png.length - 4).toString("ascii") === "IEND")

  // buildQrImageUrl 是同一实现的别名
  assert.equal(await buildQrImageUrl(otpauth_url), qrcode)
})

test("F-054: fallback QR encoder matches the reference implementation per mask", () => {
  const url = buildOtpauthUrl(RFC_SECRET, "alice")
  // 内置编码器只做 byte 模式；参考实现默认会自动切分 numeric/alphanumeric
  // 段，因此这里显式指定 byte 段，确保比较的是同一 segment 布局。
  const segments = [
    { data: new TextEncoder().encode(url), mode: "byte" as const },
  ]
  for (const mask of [0, 1, 2, 3, 4, 5, 6, 7] as const) {
    const expected = QRCode.create(segments, {
      errorCorrectionLevel: "L",
      maskPattern: mask,
    })
    const actual = buildQrModuleMatrix(url, mask)
    assert.ok(actual, `mask ${mask} should encode`)
    assert.equal(actual!.size, expected.modules.size, `mask ${mask} size`)
    assert.deepEqual(
      Array.from(actual!.data),
      Array.from(expected.modules.data as Uint8Array),
      `mask ${mask} module matrix`,
    )
  }
})

test("F-054: automatic mask selection matches the reference penalty rules", () => {
  const urls = [
    buildOtpauthUrl(RFC_SECRET, "alice"),
    buildOtpauthUrl("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", "bob", "OpenList Test"),
    "https://example.com/a/very/long/path/with/query?x=1&y=2",
  ]
  for (const url of urls) {
    const expected = QRCode.create(
      [{ data: new TextEncoder().encode(url), mode: "byte" as const }],
      { errorCorrectionLevel: "L" },
    )
    const actual = buildQrModuleMatrix(url)
    assert.ok(actual)
    assert.equal(actual!.mask, expected.maskPattern, `mask for ${url}`)
    assert.deepEqual(
      Array.from(actual!.data),
      Array.from(expected.modules.data as Uint8Array),
      `matrix for ${url}`,
    )
  }
})

test("F-054: oversized QR payload degrades to empty string instead of throwing", () => {
  const huge = "x".repeat(400)
  assert.equal(buildQrModuleMatrix(huge), null)
  assert.equal(buildQrDataUrl(huge), "")
})

test("F-054: backup codes still use CSPRNG and verify case-insensitively", () => {
  const codes = generateBackupCodes(3)
  assert.equal(codes.length, 3)
  for (const code of codes) assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.equal(verifyBackupCode(codes[0].toLowerCase(), codes), true)
  assert.equal(verifyBackupCode("ABCD-EFGH", codes), false)
})

test("F-054: PNG data URL round-trips back to the QR module matrix", async () => {
  const { inflateSync } = await import("node:zlib")
  const url = buildOtpauthUrl(RFC_SECRET, "alice")
  const dataUrl = buildQrDataUrl(url)
  const png = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64")

  // 逐 chunk 解析，收集 IDAT
  let pos = 8
  let idat: Buffer = Buffer.alloc(0)
  let width = 0
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.subarray(pos + 4, pos + 8).toString("ascii")
    const data = png.subarray(pos + 8, pos + 8 + len)
    if (type === "IHDR") width = data.readUInt32BE(0)
    if (type === "IDAT") idat = Buffer.concat([idat, data])
    pos += 12 + len
  }
  assert.ok(width > 0)
  // inflate 会校验 zlib 头与 Adler-32
  const raw = inflateSync(idat)
  const bytesPerRow = Math.ceil(width / 8)
  assert.equal(raw.length, (bytesPerRow + 1) * width)

  const matrix = buildQrModuleMatrix(url)
  assert.ok(matrix)
  const scale = 4
  const quiet = 4
  for (let row = 0; row < matrix!.size; row++) {
    for (let col = 0; col < matrix!.size; col++) {
      // 取样模块中心像素：0 = 黑（深色模块），1 = 白
      const x = (col + quiet) * scale + 1
      const y = (row + quiet) * scale + 1
      const bit = (raw[y * (bytesPerRow + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1
      assert.equal(bit, matrix!.data[row * matrix!.size + col] ? 0 : 1)
    }
  }
})
