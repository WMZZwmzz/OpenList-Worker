import assert from "node:assert/strict"
import test from "node:test"
import { readCipher } from "./store/backend"

/**
 * M-13（SECURITY-AUDIT-2026-10-20）回归测试：
 *
 * `DB_CIPHER=des` / `3des` / `v5` / `v6` 会启用 56-bit 单 DES 或已弃用的 3DES
 * 来保护**本应用自己的数据库**（区别于驱动内复刻厂商协议的 DES/ECB）。
 *
 * 修复：读取配置时把弱算法自动升级为 `aes-256-gcm` **用于写入**；历史密文的
 * 解密由密文前缀驱动，所以旧数据仍可读，并在下次保存时自动迁移。确需保留
 * 弱算法可设 `DB_CIPHER_ALLOW_INSECURE=1`。
 */

test("M-13: 弱算法在写入侧被自动升级为 aes-256-gcm", () => {
  for (const weak of ["des", "3des", "v5", "v6", "des-cbc-hmac", "3des-cbc-hmac"]) {
    assert.equal(
      readCipher({ DB_CIPHER: weak }),
      "aes-256-gcm",
      `DB_CIPHER=${weak} 应被升级`,
    )
  }
})

test("M-13: 显式允许时保留弱算法（兼容逃生口）", () => {
  assert.equal(
    readCipher({ DB_CIPHER: "des", DB_CIPHER_ALLOW_INSECURE: "1" }),
    "des-cbc-hmac",
  )
  assert.equal(
    readCipher({ DB_CIPHER: "3des", DB_CIPHER_ALLOW_INSECURE: "true" }),
    "3des-cbc-hmac",
  )
})

test("M-13: 强算法与 none 不受影响", () => {
  assert.equal(readCipher({ DB_CIPHER: "aes-256-gcm" }), "aes-256-gcm")
  assert.equal(readCipher({ DB_CIPHER: "chacha20-poly1305" }), "chacha20-poly1305")
  assert.equal(readCipher({ DB_CIPHER: "none" }), "none")
  assert.equal(readCipher({}), "none")
})
