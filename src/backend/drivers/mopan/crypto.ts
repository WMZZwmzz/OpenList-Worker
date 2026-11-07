/**
 * MoPan 加密工具。
 *
 * F-251：旧实现顶层静态 `import … from "crypto"`，而 ESA 边缘构建
 * （scripts/build-edge.mjs 的 nodeShimPlugin）会把裸 "crypto"/"node:crypto"
 * 换成调用即抛错的 shim，导致 mopan 的每个请求（含登录）在 ESA 上必然
 * 失败。这里改为全平台实现：
 *   - AES-128-ECB（PKCS7，与官方 SDK AesEncrypt/AesDecrypt 一致）用仓库
 *     既有依赖 crypto-js（纯 JS）；
 *   - base64 用 atob/btoa；
 *   - 随机数用 WebCrypto `crypto.getRandomValues`；
 *   - RSA 复用 drivers/189/crypto.ts 的纯 JS PKCS#1 v1.5 实现（BigInt）。
 * 不再依赖任何 Node 内置模块。
 */
import CryptoJS from "crypto-js"
import { rsaEncode } from "../189/crypto"

function toWordArray(bytes: Uint8Array): CryptoJS.lib.WordArray {
  return CryptoJS.lib.WordArray.create(bytes as any)
}

function fromWordArray(wa: CryptoJS.lib.WordArray): Uint8Array {
  const out = new Uint8Array(wa.sigBytes)
  for (let i = 0; i < wa.sigBytes; i++) {
    out[i] = (wa.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff
  }
  return out
}

/**
 * AES-128 encryption（ECB + PKCS7）。
 *
 * F-243：官方 SDK（mopan-sdk-go helper.go 的 AesEncrypt/AesDecrypt）对请求体、
 * 响应体与 remoteInfo 全部使用 AES-ECB + PKCS7，密钥即 16 字节会话密钥；
 * 旧移植用 CBC 零 IV，服务端无法解出请求，也无法给出可解密的响应。
 */
export function aesEncrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const encrypted = CryptoJS.AES.encrypt(toWordArray(data), toWordArray(key.slice(0, 16)), {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  })
  return fromWordArray(encrypted.ciphertext)
}

/**
 * AES-128 decryption（ECB + PKCS7，见 aesEncrypt 说明）
 */
export function aesDecrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const decrypted = CryptoJS.AES.decrypt(
    CryptoJS.lib.CipherParams.create({ ciphertext: toWordArray(data) }),
    toWordArray(key.slice(0, 16)),
    {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
    },
  )
  return fromWordArray(decrypted)
}

/**
 * Generate random secret key (16 ASCII chars → 16-byte AES-128 key).
 *
 * F-243：旧实现把 randomBytes(16).toString("hex")（32 字符）截断成 16
 * 字符，实际只有 64 bit 熵。这里取 12 字节 CSPRNG 随机数的 base64（恰好
 * 16 个 ASCII 字符）作为 16 字节 UTF-8 密钥，熵约 96 bit。
 */
export function generateSecretKey(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).slice(0, 16)
}

/**
 * Base64 encode
 */
export function base64Encode(data: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  return btoa(binary)
}

/**
 * Base64 decode
 */
export function base64Decode(data: string): Uint8Array {
  const binary = atob(String(data || ""))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * 和彩云官方 RSA 公钥（PKIX/SPKI PEM，RSA-2048）。
 *
 * F-243：旧实现这里是两段逐字符相同的伪造占位符（OpenSSL 解析即失败），
 * 会话密钥只能以明文 base64 随 encrypted-key 头传输。现填入上游官方 SDK
 * （foxxorcat/mopan-sdk-go default.go）的真实公钥：版本 ≥ 1.1.202
 * （DefaultMpVersion）的请求使用 V2，更旧版本使用 V1（见其 client.go）。
 * 服务端按 encrypted-key 头做 RSA PKCS#1 v1.5 解密，取出 AES 会话密钥。
 *
 * rsaEncrypt 仍保留 fail-closed 防护：密钥被清空或无效时直接抛错，
 * 绝不把 AES 会话密钥以明文发送。
 */
export const RSAPublicKeyV1 = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzDzuXrkkYjcb0N2/oiZX
xNNaYM0PKPZE0aXeCJWo/VBSFE3+Q/1m5u1hI7y6U6OP8Kj5w6BStHU4lqs3/OOW
G8GYKqGD6pz+b8Vp6m22lk8/7lL9375w2siAz+xSWwovAIKTfbMRwUsmJWoGI2vx
rwok6jJoWacP6GcsI335cD7fNsHSOFYTb7SCjKWvAowsHhAWu7W8oP7bB3HE3Xth
6Wy/gbZl/4Hp9rJU8w44/1Hc6O+uzfw4ZNtE0E4cIsK40XifW5SSokpCQkIlPNKH
RuzjIuGQRbCjvl682M/DixSouc4whOcOB6Rf102p2XaKvrmmT1OXCA4dFkRa5rjA
pQIDAQAB
-----END PUBLIC KEY-----`

/** 见 RSAPublicKeyV1 说明（版本 ≥ 1.1.202 使用此公钥） */
export const RSAPublicKeyV2 = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAgRb5UBbJFi3DFnxMxqqWZ0waO5a+dXLih6g47tT8H0ie+uYT3L7
nte63Cm04KX7HRovmN6zHI60m/gg6gukvqYqUtf3R2tP0i8T3KtWSZFjGqcDFLF2yvj3ntZUwU0/O3wZT3CbxOz2YoA6YXz
c0MlAjc8tu/YpBxN5CsO9auiaVSODiCNiUCFqEGBiHvQiRsX08bTOfSaTPw3SEavO24tknjAUahP/++uz2JOgLTN+zY0nmh
RZD3ArrPM84dtrldByc7g2kCwxSU3OsCpYuBZ8Po/Q/09p+Xpz2YP9dBGNnFR3sHIQcNA2Fj/nyNLRNw7FnWAcRwOvQhl8h
NqC40wIDAQAB
-----END PUBLIC KEY-----`

/**
 * RSA 加密会话密钥（PKCS#1 v1.5，与官方客户端 rsa.EncryptPKCS1v15 一致）。
 *
 * F-251：改用纯 JS 实现（drivers/189/crypto.ts 的 rsaEncode），不再静态
 * 依赖 Node 的 publicEncrypt，边缘运行时同样可用。
 *
 * @throws 公钥缺失/无效时抛出明确错误（fail closed），不会退化为明文传输
 */
export function rsaEncrypt(data: string, publicKey: string): string {
  const key = String(publicKey || "").trim()
  if (!key) {
    throw new Error(
      "[MoPan] RSA 公钥缺失：无法加密 AES 会话密钥，已拒绝明文传输（需配置官方 RSAPublicKeyV2）",
    )
  }
  try {
    return rsaEncode(data, key, false)
  } catch (e: any) {
    throw new Error(
      `[MoPan] RSA 公钥无效，无法加密 AES 会话密钥: ${e?.message || e}`,
    )
  }
}

/**
 * Encrypt device info
 */
export function encryptDeviceInfo(deviceInfoJson: string, key: string): string {
  const encrypted = aesEncrypt(
    new TextEncoder().encode(deviceInfoJson),
    new TextEncoder().encode(key),
  )
  return base64Encode(encrypted)
}

/**
 * Decrypt device info
 */
export function decryptDeviceInfo(encryptedData: string, key: string): string {
  const decrypted = aesDecrypt(
    base64Decode(encryptedData),
    new TextEncoder().encode(key),
  )
  return new TextDecoder().decode(decrypted)
}
