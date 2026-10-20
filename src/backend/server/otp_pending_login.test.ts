import assert from "node:assert/strict"
import test from "node:test"
import { Hono } from "hono"
import { saveDb, __resetDbCacheForTest } from "../internal/model/db"
import { authRouter, issueOtpPendingToken } from "./auth"
import { getUserFromContext } from "./middlewares"
import { generateTotpCode, generateTotpSecret } from "../pkg/totp"

/**
 * H-2（SECURITY-AUDIT-2026-10-20）回归测试：
 *
 * TOTP 原先只挂在口令登录上，SSO / WebAuthn 用 generateToken 直接签发 7 天
 * 完整 JWT，2FA 对这两条通道完全失效。修复后这两条通道只签发
 * `type: "otp_pending"` 的 5 分钟令牌，且该令牌不能当会话凭证使用，只能到
 * `POST /api/auth/otp/login` 用 TOTP / 恢复码兑换。
 */

const envOf = () => ({ JWT_SECRET: "test-only-otp-pending-secret" })

async function seedUser(env: any) {
  const secret = generateTotpSecret()
  await saveDb(
    {
      settings: [],
      users: [
        {
          id: 1,
          username: "admin",
          password: "unused",
          role: 2,
          permission: 0,
          base_path: "/",
          disabled: false,
          otp_secret: secret,
        },
      ],
      storages: [],
      shares: [],
      metas: [],
    },
    env,
    { force: true },
  )
  return secret
}

const appOf = () => {
  const app = new Hono()
  app.route("/api/auth", authRouter)
  app.get("/api/me", async (c) => {
    const user = await getUserFromContext(c)
    return c.json({ user })
  })
  return app
}

test("H-2: otp_pending 令牌不能当会话凭证使用", async () => {
  __resetDbCacheForTest()
  const env = envOf()
  await seedUser(env)

  const pending = await issueOtpPendingToken(
    { id: 1, username: "admin", role: 2 },
    { env } as any,
  )
  const res = await appOf().request(
    "/api/me",
    { headers: { Authorization: `Bearer ${pending}` } },
    env,
  )
  const body: any = await res.json()
  assert.equal(body.user, null, "待兑换令牌必须被身份解析拒绝")
})

test("H-2: 待兑换令牌 + 正确 TOTP 才能换到完整会话令牌", async () => {
  __resetDbCacheForTest()
  const env = envOf()
  const secret = await seedUser(env)
  const app = appOf()

  const pending = await issueOtpPendingToken(
    { id: 1, username: "admin", role: 2 },
    { env } as any,
  )

  // 错误验证码
  const bad = await app.request(
    "/api/auth/otp/login",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pending}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ otp_code: "000000" }),
    },
    env,
  )
  assert.equal(bad.status, 401)

  // 正确验证码 → 换发完整 token
  const good = await app.request(
    "/api/auth/otp/login",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pending}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ otp_code: generateTotpCode(secret) }),
    },
    env,
  )
  assert.equal(good.status, 200, await good.clone().text())
  const goodBody: any = await good.json()
  const token = goodBody.data?.token
  assert.ok(token, "应返回完整会话 token")

  // 新 token 可以正常解析出用户
  const me = await app.request(
    "/api/me",
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  )
  const meBody: any = await me.json()
  assert.equal(meBody.user?.username, "admin")

  // pending 令牌一次性：兑换成功后不可重放
  const replay = await app.request(
    "/api/auth/otp/login",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pending}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ otp_code: generateTotpCode(secret) }),
    },
    env,
  )
  assert.equal(replay.status, 401)
})

test("H-2: 完整会话令牌不能用于 /otp/login 兑换", async () => {
  __resetDbCacheForTest()
  const env = envOf()
  const secret = await seedUser(env)
  const app = appOf()

  const { sign } = await import("hono/jwt")
  const session = await sign(
    {
      id: 1,
      username: "admin",
      role: 2,
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: "h2-session",
    },
    env.JWT_SECRET,
  )
  const res = await app.request(
    "/api/auth/otp/login",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ otp_code: generateTotpCode(secret) }),
    },
    env,
  )
  assert.equal(res.status, 401)
})
