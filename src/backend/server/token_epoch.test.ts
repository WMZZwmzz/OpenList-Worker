import assert from "node:assert/strict"
import test from "node:test"
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { getDb, saveDb, __resetDbCacheForTest } from "../internal/model/db"
import { getUserFromContext } from "./middlewares"
import { bumpTokenEpoch } from "../pkg/permission"

/**
 * M-3（SECURITY-AUDIT-2026-10-20）回归测试：
 *
 * 改密 / 管理员改密 / 关闭 2FA 都不撤销已签发的 token —— 只 saveDb，无 revoke，
 * 也没有用户维度的 token 版本号。token 泄露后用户改密码，旧 token 仍可用最长
 * 7 天（disabled 与 role 是即时生效的，所以封号/降权没有这个问题）。
 *
 * 修复：用户上加 token_epoch，JWT 携带签发时的 epoch，校验不一致即拒绝。
 */

const SECRET = "m3-test-secret-0123456789abcdef"

const env = () => ({ JWT_SECRET: SECRET })

async function seed() {
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
    env(),
    { force: true },
  )
}

const appOf = () => {
  const app = new Hono()
  app.get("/api/me", async (c) => {
    const user = await getUserFromContext(c)
    return c.json({ user: user ? { id: user.id, username: user.username } : null })
  })
  return app
}

const tokenWith = (epoch?: number) =>
  sign(
    {
      id: 1,
      username: "admin",
      role: 2,
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: `m3-${epoch ?? "legacy"}-${Date.now()}`,
      ...(epoch === undefined ? {} : { epoch }),
    },
    SECRET,
  )

test("M-3: 递增 token_epoch 后旧 token 立即失效", async () => {
  __resetDbCacheForTest()
  await seed()
  const app = appOf()

  // 历史 token（无 epoch 字段）在 epoch=0 时有效
  const legacy = await tokenWith()
  const before = await app.request(
    "/api/me",
    { headers: { Authorization: `Bearer ${legacy}` } },
    env(),
  )
  assert.equal((await before.json()).user?.id, 1)

  // 改密 → 递增 token_epoch
  const db: any = await getDb(env())
  bumpTokenEpoch(db.users[0])
  assert.equal(db.users[0].token_epoch, 1)
  await saveDb(db, env())

  const after = await app.request(
    "/api/me",
    { headers: { Authorization: `Bearer ${legacy}` } },
    env(),
  )
  assert.equal((await after.json()).user, null, "改密后旧 token 必须失效")

  // 新签发的 token（携带 epoch=1）可以正常使用
  const fresh = await tokenWith(1)
  const ok = await app.request(
    "/api/me",
    { headers: { Authorization: `Bearer ${fresh}` } },
    env(),
  )
  assert.equal((await ok.json()).user?.id, 1)
})

test("M-3: 未递增 epoch 时 token 不受影响（升级不踢人）", async () => {
  __resetDbCacheForTest()
  await seed()
  const app = appOf()
  const legacy = await tokenWith()
  const res = await app.request(
    "/api/me",
    { headers: { Authorization: `Bearer ${legacy}` } },
    env(),
  )
  assert.equal((await res.json()).user?.id, 1)
})
