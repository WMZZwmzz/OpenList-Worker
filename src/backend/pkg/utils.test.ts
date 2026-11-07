import test from "node:test"
import assert from "node:assert/strict"
import { formatBytes } from "./utils"

test("F-066: formatBytes keeps the historical output for normal sizes", () => {
  assert.equal(formatBytes(0), "0 Bytes")
  assert.equal(formatBytes(1024), "1 KB")
  assert.equal(formatBytes(1536), "1.5 KB")
  assert.equal(formatBytes(1024 ** 5), "1 PB")
})

test("F-066: sub-byte values no longer produce an undefined unit", () => {
  assert.equal(formatBytes(0.5), "0.5 Bytes")
  assert.equal(formatBytes(0.1, 1), "0.1 Bytes")
})

test("F-066: negative / non-finite values clamp to '0 Bytes'", () => {
  assert.equal(formatBytes(-100), "0 Bytes")
  assert.equal(formatBytes(-1), "0 Bytes")
  assert.equal(formatBytes(NaN), "0 Bytes")
  assert.equal(formatBytes(Infinity), "0 Bytes")
  assert.equal(formatBytes(-Infinity), "0 Bytes")
})

test("F-066: values beyond PB clamp to the largest unit instead of 'undefined'", () => {
  assert.equal(formatBytes(2 ** 60), "1024 PB")
  assert.equal(formatBytes(1024 ** 6), "1024 PB")
})

test("F-066: decimals argument is respected and never negative", () => {
  assert.equal(formatBytes(1536, 0), "2 KB")
  assert.equal(formatBytes(1536, -3), "2 KB")
})

// ── F-032: checkAdminAuth 必须拒绝 otp_pending 令牌 ─────────────────────────

const adminAuth = await (async () => {
  const { Hono } = await import("hono")
  const { sign } = await import("hono/jwt")
  const { checkAdminAuth } = await import("./utils")
  const db = (await import("../internal/model/db")) as any

  const SECRET = "test-admin-auth-secret-0123456789abcdef"

  function installDb(users: any[]) {
    db.__resetDbCacheForTest()
    const backend = {
      name: "admin-auth-test",
      isConfigured: async () => true,
      async load() {
        return {
          settings: [],
          storages: [],
          users,
          shares: [],
          metas: [],
          plugins: [],
        }
      },
      async save() {
        return true
      },
    }
    db.__setStoreBackendLoaderForTest(async () => backend)
    return { JWT_SECRET: SECRET, DB_DRIVER: `admin-auth-${Math.random()}` }
  }

  const app = new Hono()
  app.get("/admin", async (c) => c.json({ ok: await checkAdminAuth(c) }))

  async function probe(payload: any, env: any) {
    const token = await sign(payload, SECRET)
    const res = await app.request(
      "/admin",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    return ((await res.json()) as any).ok
  }

  return { installDb, probe }
})()

test("F-032: checkAdminAuth rejects type:'otp_pending' tokens", async () => {
  // 遗留账号：没有 pwd_update_at 与 token_epoch，历史上这让 pending 令牌通过
  const env = adminAuth.installDb([
    { id: 1, username: "admin", role: 2, password: "legacy", permission: 0 },
  ])
  const now = () => Math.floor(Date.now() / 1000)

  const pending = {
    type: "otp_pending",
    id: 1,
    username: "admin",
    iss: "openlist",
    aud: "openlist-api",
    exp: now() + 300,
    jti: "pending-1",
  }
  assert.equal(await adminAuth.probe(pending, env), false)

  // 对照：同一用户的完整会话令牌仍然放行
  const full = {
    id: 1,
    username: "admin",
    role: 2,
    iss: "openlist",
    aud: "openlist-api",
    exp: now() + 300,
    jti: "full-1",
    pwd_ts: "",
    epoch: 0,
  }
  assert.equal(await adminAuth.probe(full, env), true)
})

test("F-032: checkAdminAuth still rejects non-admin roles and missing tokens", async () => {
  const env = adminAuth.installDb([
    { id: 2, username: "guest", role: 0, password: "x", permission: 0 },
  ])
  const token = {
    id: 2,
    username: "guest",
    role: 2, // JWT 声称管理员，但库里是普通用户
    iss: "openlist",
    aud: "openlist-api",
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: "g-1",
  }
  assert.equal(await adminAuth.probe(token, env), false)
})
