// 189PC encryption utilities
//
// F-346：旧实现静态 `import … from "crypto"`（createCipheriv/randomBytes/
// publicEncrypt）。ESA 边缘构建（scripts/build-edge.mjs 的 nodeShimPlugin）
// 会把裸 "crypto"/"node:crypto" 换成调用即抛错的 shim，导致登录、签名、
// 哈希全部运行时抛错。这里改用仓库内的跨平台实现：
//   - RSA 复用 drivers/189/crypto.ts 的纯 JS PKCS#1 v1.5（BigInt）；
//   - AES/随机数用 crypto-js + WebCrypto（Workers/Node18+/ESA 均可用）。
import CryptoJS from "crypto-js"
import { rsaEncode } from "../189/crypto"

export function encryptPassword(password: string, publicKey: string): string {
  // RSA 加密密码（PKCS#1 v1.5，输出小写 hex）
  const pemKey = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`
  return rsaEncode(password, pemKey, true)
}

export function generateDeviceId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
}

export function encryptAES(data: string, key: string): string {
  const ivBytes = new Uint8Array(16)
  crypto.getRandomValues(ivBytes)
  const iv = CryptoJS.lib.WordArray.create(ivBytes as any)
  const encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(data),
    CryptoJS.enc.Utf8.parse(key.slice(0, 16)),
    {
      iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  )
  return iv.toString(CryptoJS.enc.Hex) + encrypted.ciphertext.toString(CryptoJS.enc.Hex)
}
