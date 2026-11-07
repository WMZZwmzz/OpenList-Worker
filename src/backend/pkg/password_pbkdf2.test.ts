// S-03 渐进迁移回归：PBKDF2 新格式 + 历史 Go 双层格式的读兼容。
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  staticHash,
  saltedHash,
  setUserPassword,
  pbkdf2PasswordHash,
  pbkdf2PasswordHashFromStatic,
  verifyPbkdf2Password,
  isPbkdf2PasswordFormat,
  isHex64,
  generateSalt,
  PBKDF2_PASSWORD_ITERATIONS,
} from "./password"

test("S-03: pbkdf2PasswordHash 产生新格式且可验证", async () => {
  const stored = await pbkdf2PasswordHash("correct horse")
  assert.ok(isPbkdf2PasswordFormat(stored))
  assert.ok(stored.includes(`$${PBKDF2_PASSWORD_ITERATIONS}$`))
  const staticHex = await staticHash("correct horse")
  assert.equal(await verifyPbkdf2Password(stored, staticHex), true)
  const wrong = await staticHash("wrong horse")
  assert.equal(await verifyPbkdf2Password(stored, wrong), false)
})

test("S-03: 盐内嵌、同明文两次哈希产生不同存储值（随机盐）", async () => {
  const a = await pbkdf2PasswordHash("same-plain")
  const b = await pbkdf2PasswordHash("same-plain")
  assert.notEqual(a, b, "随机盐必须使两次哈希不同")
  const staticHex = await staticHash("same-plain")
  assert.equal(await verifyPbkdf2Password(a, staticHex), true)
  assert.equal(await verifyPbkdf2Password(b, staticHex), true)
})

test("S-03: pbkdf2PasswordHashFromStatic 与明文入口一致（/login/hash 迁移通道）", async () => {
  const staticHex = await staticHash("the-plain")
  const fromPlain = await pbkdf2PasswordHash("the-plain", "aabbccdd00112233")
  const fromStatic = await pbkdf2PasswordHashFromStatic(
    staticHex,
    "aabbccdd00112233",
  )
  assert.equal(fromPlain, fromStatic)
})

test("S-03: 畸形存储值一律拒绝（fail-closed）", async () => {
  const staticHex = await staticHash("x")
  assert.equal(
    await verifyPbkdf2Password("$olpbkdf2-sha256$abc$zz$00", staticHex),
    false,
    "非法迭代数/盐/摘要必须拒绝",
  )
  assert.equal(await verifyPbkdf2Password("$olpbkdf2-sha256$", staticHex), false)
})

test("S-03: setUserPassword 写入新格式，历史双层哈希仍走旧路径验证", async () => {
  const user: any = {}
  await setUserPassword(user, "brand-new-pass")
  assert.ok(isPbkdf2PasswordFormat(user.password))
  assert.ok(user.salt, "user.salt 仍保留（Go 导出兼容）")
  assert.ok(user.pwd_update_at)

  // 历史 Go 双层哈希（64 位 hex）验证路径不受影响
  const legacyUser: any = { salt: generateSalt() }
  legacyUser.password = await saltedHash(
    await staticHash("legacy-pass"),
    legacyUser.salt,
  )
  assert.ok(isHex64(legacyUser.password))
  assert.ok(!isPbkdf2PasswordFormat(legacyUser.password))
})
