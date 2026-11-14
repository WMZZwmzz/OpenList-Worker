import assert from "node:assert/strict"
import test from "node:test"
import { Hono } from "hono"
import { __resetDbCacheForTest, getDb } from "../internal/model/db"
import { setupRouter } from "./router"

/** 可用的 Web KV 形态替身（与 init_setup_guard.test.ts 同款） */
function fakeKv() {
  const store = new Map<string, string>()
  return {
    __store: store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, String(value))
      return true
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async () => ({ keys: [...store.keys()] }),
  }
}

const kvEnv = (over: any = {}) => ({
  DB_DRIVER: "kv",
  DB_FORMAT: "map",
  JWT_SECRET: "0123456789abcdef0123456789abcdef",
  KV: fakeKv(),
  ...over,
})

const buildApp = () => {
  const api = new Hono()
  setupRouter(api)
  const app = new Hono()
  app.route("/api", api)
  return app
}

const setupRequest = (body: Record<string, any>) =>
  ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any

test("F-040: setup 拒绝保留用户名 guest（否则匿名访客会继承管理员身份）", async () => {
  __resetDbCacheForTest()
  const env: any = kvEnv()
  const res = await buildApp().request(
    "/api/public/init/setup",
    setupRequest({ username: "guest", password: "admin1234" }),
    env,
  )
  assert.equal(res.status, 400)
  const json: any = await res.json()
  assert.match(String(json.message), /reserved/i)

  // 大小写变体同样拒绝
  __resetDbCacheForTest()
  const env2: any = kvEnv()
  const res2 = await buildApp().request(
    "/api/public/init/setup",
    setupRequest({ username: "GUEST", password: "admin1234" }),
    env2,
  )
  assert.equal(res2.status, 400)
  // 审计日志是失败请求的正常留痕（A-44 改为同步落盘后必然出现），
  // 这里校验的是「不得写入任何配置数据」。
  assert.equal(
    [...env2.KV.__store.keys()].filter(
      (k) => k !== "openlist_audit_logs",
    ).length,
    0,
    "被拒绝的初始化不得写配置库",
  )
})

test("F-039: 并发 setup 只能产生一个管理员（同一 isolate 加互斥 + 锁内复核）", async () => {
  __resetDbCacheForTest()
  const env: any = kvEnv()
  const app = buildApp()

  const bodies = Array.from({ length: 6 }, (_, i) => ({
    username: `admin${i}`,
    password: "admin1234",
  }))
  const results = await Promise.all(
    bodies.map((b) => app.request("/api/public/init/setup", setupRequest(b), env)),
  )
  const ok = results.filter((r) => r.status === 200)
  assert.equal(ok.length, 1, `只允许一个初始化请求成功，实际 ${ok.length}`)

  // 从持久化重读，确认落盘只有一个 role=2 管理员
  __resetDbCacheForTest()
  const db = await getDb(env)
  const admins = (db.users || []).filter(
    (u: any) => u.role === 2 && String(u.password || "").trim() !== "",
  )
  assert.equal(
    admins.length,
    1,
    `落盘的管理员必须唯一，实际 ${admins.map((u: any) => u.username).join(",")}`,
  )
})
