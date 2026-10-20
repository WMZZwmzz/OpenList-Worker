import assert from "node:assert/strict"
import test from "node:test"
import {
  getDb,
  saveDb,
  __resetDbCacheForTest,
} from "./db"

/**
 * H-4（SECURITY-AUDIT-2026-10-20）回归测试：
 *
 * 静态加密的字段清单不完整 —— `settings.api_token`（等价管理员的静态 API
 * 令牌）、`shares[].pwd`（分享提取码）、`metas[].password`（目录口令）都不在
 * seal/unseal 范围内，明文落盘。
 *
 * 验证方式：
 *  1. 用密钥 A + aes-256-gcm 写入 → 换用密钥 B 读取，值应仍是 `enc:` 密文
 *     （说明确实加密了，而不是把明文原样存下去）；
 *  2. 用密钥 A 读取 → 三者都应还原成明文（说明 unseal 也覆盖到了）。
 */

const KEY_A = "key-a-0123456789abcdef0123456789abcdef"
const KEY_B = "key-b-0123456789abcdef0123456789abcdef"

const baseDb = () => ({
  settings: [
    { key: "site_title", value: "OpenList" },
    { key: "api_token", value: "admin-api-token-value" },
  ],
  users: [
    {
      id: 1,
      username: "admin",
      password: "deadbeef",
      role: 2,
      permission: 0,
      base_path: "/",
      disabled: false,
    },
  ],
  storages: [],
  shares: [
    {
      id: "share1",
      files: ["/a.txt"],
      pwd: "share-pass-1234",
      creator_id: 1,
      disabled: false,
    },
  ],
  metas: [
    {
      id: 1,
      path: "/secret",
      password: "dir-pass-5678",
      p_sub: true,
      read_users: [],
      write_users: [],
    },
  ],
})

const envOf = (key: string) => ({
  JWT_SECRET: key,
  DB_CIPHER: "aes-256-gcm",
})

test("H-4: api_token / shares.pwd / metas.password 都会落盘加密", async () => {
  __resetDbCacheForTest()
  const envA = envOf(KEY_A)
  await saveDb(baseDb() as any, envA, { force: true })

  // 换错密钥读取：解不开 → 保持 enc: 前缀，证明存储里存的确实是密文
  __resetDbCacheForTest()
  const wrongKeyDb: any = await getDb(envOf(KEY_B))
  const wrongToken = wrongKeyDb.settings.find(
    (s: any) => s.key === "api_token",
  )?.value
  assert.match(String(wrongToken), /^enc:v\d+:/, "api_token 必须是密文")
  assert.match(
    String(wrongKeyDb.shares[0].pwd),
    /^enc:v\d+:/,
    "shares[].pwd 必须是密文",
  )
  assert.match(
    String(wrongKeyDb.metas[0].password),
    /^enc:v\d+:/,
    "metas[].password 必须是密文",
  )

  // 用正确密钥读取：三者都应还原为明文
  __resetDbCacheForTest()
  const db: any = await getDb(envOf(KEY_A))
  assert.equal(
    db.settings.find((s: any) => s.key === "api_token")?.value,
    "admin-api-token-value",
  )
  assert.equal(db.shares[0].pwd, "share-pass-1234")
  assert.equal(db.metas[0].password, "dir-pass-5678")
})

test("H-4: 未开启加密时保持原行为（明文落盘、可读）", async () => {
  __resetDbCacheForTest()
  const env: any = { JWT_SECRET: KEY_A }
  await saveDb(baseDb() as any, env, { force: true })

  __resetDbCacheForTest()
  const db: any = await getDb(env)
  assert.equal(db.shares[0].pwd, "share-pass-1234")
  assert.equal(db.metas[0].password, "dir-pass-5678")
})
