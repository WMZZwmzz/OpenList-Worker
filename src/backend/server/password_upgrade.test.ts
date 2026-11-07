// S-03 透明迁移回归：遗留 Go 双层 SHA256 用户在 /login、/login/hash 成功后
// 存储值升级为 PBKDF2 新格式，且 pwd_update_at 不变（不登出既有会话）。
import assert from "node:assert/strict"
import { test } from "node:test"
import app from "../index"

const JWT_SECRET = "jwt-secret-32-characters-long!!"
const ORIGIN = "http://localhost"

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    binding: {
      async get(key: string) {
        return store.has(key) ? store.get(key)! : null
      },
      async put(key: string, value: string) {
        store.set(key, value)
      },
      async delete(key: string) {
        store.delete(key)
      },
      async list(opts?: { prefix?: string }) {
        const prefix = opts?.prefix || ""
        return {
          keys: [...store.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((key) => ({ key })),
          complete: true,
        }
      },
    },
  }
}

function makeEnv(kv: any): any {
  return {
    DB_DRIVER: "kv",
    DB_FORMAT: "map",
    KV: kv.binding,
    JWT_SECRET,
    ADMIN_PASS: "legacy-pass",
    __requestOrigin: ORIGIN,
  }
}

async function seedLegacyAdmin(env: any) {
  const { getDb, saveDb } = await import("../internal/model/db")
  const { __resetDbCacheForTest } = await import("../internal/model/db")
  __resetDbCacheForTest()
  const db: any = await getDb(env)
  const admin = db.users.find((u: any) => u.username === "admin")
  assert.ok(admin, "admin must exist after init")
  // 写入 Go 双层 SHA256（历史格式）
  const { staticHash, saltedHash, generateSalt } = await import("../pkg/password")
  admin.salt = generateSalt()
  admin.password = await saltedHash(
    await staticHash("legacy-pass"),
    admin.salt,
  )
  admin.pwd_update_at = "2026-01-01T00:00:00.000Z"
  await saveDb(db, env)
  __resetDbCacheForTest()
  return "2026-01-01T00:00:00.000Z"
}

async function login(env: any, body: Record<string, any>) {
  const res = await app.request(
    "/api/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  )
  return { status: res.status, json: await res.json() }
}

async function currentStored(env: any) {
  const { getDb, __resetDbCacheForTest } = await import("../internal/model/db")
  __resetDbCacheForTest()
  const db: any = await getDb(env)
  return db.users.find((u: any) => u.username === "admin")
}

test("S-03: /login 成功后遗留双层哈希透明升级为 PBKDF2，pwd_update_at 不变", async () => {
  const env = makeEnv(makeKv())
  const prevStamp = await seedLegacyAdmin(env)

  const first = await login(env, { username: "admin", password: "legacy-pass" })
  assert.equal(first.status, 200, `login failed: ${JSON.stringify(first.json)}`)
  assert.ok(first.json?.data?.token)

  const stored: any = await currentStored(env)
  const { isPbkdf2PasswordFormat } = await import("../pkg/password")
  assert.ok(
    isPbkdf2PasswordFormat(stored.password),
    "stored hash must be upgraded to the S-03 PBKDF2 format",
  )
  assert.equal(
    stored.pwd_update_at,
    prevStamp,
    "transparent migration must not rotate pwd_update_at (would log out sessions)",
  )

  // 升级后的存储值必须仍可验证（新旧两个登录通道）
  const second = await login(env, { username: "admin", password: "legacy-pass" })
  assert.equal(second.status, 200)

  // 错误密码必须仍然拒绝
  const bad = await login(env, { username: "admin", password: "wrong" })
  assert.equal(bad.status, 401)
})
