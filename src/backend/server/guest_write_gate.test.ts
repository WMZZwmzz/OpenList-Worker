import assert from "node:assert/strict"
import test from "node:test"
import { Hono } from "hono"
import { saveDb, __resetDbCacheForTest } from "../internal/model/db"
import { webauthnRouter } from "./webauthn"
import { seedRouter } from "./seed"

/**
 * M-1（SECURITY-AUDIT-2026-10-20）回归测试：
 *
 * `allow_guest` 默认 true 时，任何没有 Authorization 的请求都会拿到一个真实
 * 的 guest 用户对象（带 id / role / permission）。WebAuthn 的写端点与 seed 的
 * 写/计算端点此前只判 `!user || user.disabled`，于是匿名者可以给 guest 注册、
 * 删除、枚举 Passkey，也能触发离线转存/哈希等重活；若管理员把 guest 的 role
 * 调成 2，匿名请求直接成为管理员。
 *
 * 修复后这些端点要求「真实凭据」——guest 回退只留给读路径。
 */

async function seedDb(env: any) {
  await saveDb(
    {
      settings: [
        { key: "allow_guest", value: "true" },
        { key: "webauthn_login_enabled", value: "true" },
        { key: "webauthn_rp_id", value: "example.com" },
      ],
      users: [
        {
          id: 1,
          username: "guest",
          password: "xxx",
          role: 1,
          permission: 0,
          base_path: "/",
          disabled: false,
        },
      ],
      storages: [],
      shares: [],
      metas: [],
    },
    env,
    { force: true },
  )
}

test("M-1: 匿名（guest 兜底）不能调用 WebAuthn 写端点", async () => {
  __resetDbCacheForTest()
  const env: any = { JWT_SECRET: "m1-test-secret-0123456789abcdef" }
  await seedDb(env)

  const app = new Hono()
  app.route("/api/authn", webauthnRouter)

  for (const p of [
    "/api/authn/webauthn_begin_registration",
    "/api/authn/webauthn_finish_registration",
    "/api/authn/delete_authn",
  ]) {
    const res = await app.request(
      p,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      env,
    )
    assert.equal(res.status, 401, `${p} 必须拒绝匿名请求`)
  }

  const creds = await app.request("/api/authn/getcredentials", {}, env)
  assert.equal(creds.status, 401, "getcredentials 必须拒绝匿名请求")
})

test("M-1: 匿名不能调用 seed 的写/计算端点", async () => {
  __resetDbCacheForTest()
  const env: any = { JWT_SECRET: "m1-test-secret-0123456789abcdef" }
  await seedDb(env)

  const app = new Hono()
  app.route("/api/fs/seed", seedRouter)

  const res = await app.request(
    "/api/fs/seed/convert",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
    env,
  )
  assert.equal(res.status, 401, "seed 写端点必须拒绝匿名请求")

  // 读类端点仍允许 guest（保持原有游客语义）
  const caps = await app.request("/api/fs/seed/capabilities", {}, env)
  assert.notEqual(caps.status, 401, "seed 读端点不应被 401 拦掉")
})
