import assert from "node:assert/strict"
import { test } from "node:test"
import { matchCronSecret } from "./middlewares"

/**
 * SEC-029：cron 鉴权必须使用独立的 CRON_SECRET；JWT_SECRET 只在显式
 * CRON_ALLOW_LEGACY_JWT_SECRET=1 时临时回退；query 默认禁用。
 */

function fakeCtx(opts: {
  env?: Record<string, any>
  header?: string
  query?: string
  body?: any
}): any {
  return {
    env: opts.env || {},
    req: {
      header: (name: string) =>
        name.toLowerCase() === "x-cron-secret" ? (opts.header ?? null) : null,
      query: (name: string) =>
        name === "cron_secret" ? opts.query : undefined,
      json: async () => opts.body ?? {},
    },
  }
}

test("SEC-029: 未配置 CRON_SECRET 时 JWT_SECRET 不再直接可用", async () => {
  const env = { JWT_SECRET: "jwt-secret-0123456789" }
  assert.equal(
    await matchCronSecret(fakeCtx({ env, header: env.JWT_SECRET })),
    false,
  )
  assert.equal(
    await matchCronSecret(
      fakeCtx({ env, query: env.JWT_SECRET, body: {} }),
    ),
    false,
  )
})

test("SEC-029: 显式 legacy 开关才允许回退 JWT_SECRET", async () => {
  const env = {
    JWT_SECRET: "jwt-secret-0123456789",
    CRON_ALLOW_LEGACY_JWT_SECRET: "1",
  }
  assert.equal(
    await matchCronSecret(fakeCtx({ env, header: env.JWT_SECRET })),
    true,
  )
})

test("SEC-029: CRON_SECRET 支持 header/body，query 默认禁用", async () => {
  const env = { CRON_SECRET: "cron-secret-0123456789", JWT_SECRET: "jwt" }
  assert.equal(
    await matchCronSecret(fakeCtx({ env, header: env.CRON_SECRET })),
    true,
  )
  assert.equal(
    await matchCronSecret(
      fakeCtx({ env, body: { cron_secret: env.CRON_SECRET } }),
    ),
    true,
  )
  assert.equal(
    await matchCronSecret(fakeCtx({ env, query: env.CRON_SECRET })),
    false,
  )
  assert.equal(
    await matchCronSecret(
      fakeCtx({ env: { ...env, CRON_ALLOW_QUERY_SECRET: "1" }, query: env.CRON_SECRET }),
    ),
    true,
  )
})

test("SEC-029: 错误的密钥一律拒绝", async () => {
  const env = { CRON_SECRET: "cron-secret-0123456789" }
  assert.equal(
    await matchCronSecret(fakeCtx({ env, header: "wrong" })),
    false,
  )
  assert.equal(
    await matchCronSecret(fakeCtx({ env, body: { cron_secret: "wrong" } })),
    false,
  )
})
