import assert from "node:assert/strict"
import test from "node:test"
import { Hono } from "hono"
import { __resetDbCacheForTest, readPersistedSecret, saveDb } from "../internal/model/db"
import {
  STATIC_API_TOKEN_USER_ID,
  getUserFromContext,
  isTokenRevoked,
  revokeToken,
} from "./middlewares"

const SECRET = "f011-f045-f051-test-secret-0123456789"
const envOf = (over: Record<string, any> = {}) => ({
  JWT_SECRET: SECRET,
  ...over,
})

async function seed(env: any) {
  await saveDb(
    {
      settings: [],
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
      shares: [],
      metas: [],
    },
    env,
    { force: true },
  )
}

test("F-011: 静态 API token 身份带稳定合成 id（分片会话所有权校验可通过）", async () => {
  __resetDbCacheForTest()
  const env = envOf({ API_TOKEN: "static-api-token" })
  await seed(env)

  const app = new Hono()
  app.get("/whoami", async (c) => {
    const user = await getUserFromContext(c)
    return c.json({ id: user?.id, role: user?.role, username: user?.username })
  })

  const res = await app.request(
    "/whoami",
    { headers: { Authorization: "Bearer static-api-token" } },
    env,
  )
  const json: any = await res.json()
  assert.equal(json.username, "api-token")
  assert.equal(json.role, 2)
  assert.equal(
    json.id,
    STATIC_API_TOKEN_USER_ID,
    "必须有非 undefined 的稳定 id，否则 owner_id 写 undefined 导致会话永远 404",
  )
  assert.notEqual(json.id, undefined)

  // 两次解析必须一致（findReceivingSession 依赖同一 owner id 复用会话）
  const again: any = await (
    await app.request(
      "/whoami",
      { headers: { Authorization: "Bearer static-api-token" } },
      env,
    )
  ).json()
  assert.equal(again.id, json.id)
})

test("F-045: 同实例并发注销不会互相覆盖持久化黑名单", async () => {
  __resetDbCacheForTest()
  const env = envOf()
  await seed(env)

  const exp = Math.floor(Date.now() / 1000) + 3600
  const jtis = ["f045-a", "f045-b", "f045-c", "f045-d"]
  await Promise.all(jtis.map((jti) => revokeToken(jti, exp, env)))

  const raw = await readPersistedSecret(env, "openlist_revoked_tokens")
  const arr = JSON.parse(String(raw)) as Array<{ jti: string; exp: number }>
  for (const jti of jtis) {
    assert.ok(
      arr.some((i) => i.jti === jti),
      `并发注销的 ${jti} 必须仍在持久化黑名单里（历史实现会丢更新）`,
    )
  }
})

test("F-051: 已过期的 jti 不应继续被判为已注销", async () => {
  __resetDbCacheForTest()
  const env = envOf()
  await seed(env)

  const past = Math.floor(Date.now() / 1000) - 10
  await revokeToken("f051-expired", past, env)
  assert.equal(
    await isTokenRevoked("f051-expired", env),
    false,
    "exp 已过的记录对已过期 token 没有意义，且不应留在内存里",
  )

  const future = Math.floor(Date.now() / 1000) + 600
  await revokeToken("f051-live", future, env)
  assert.equal(await isTokenRevoked("f051-live", env), true)
})
