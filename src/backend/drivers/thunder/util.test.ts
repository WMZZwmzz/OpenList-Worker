import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { afterEach, test } from "node:test"

import { calcGcid, ThunderClient, ThunderClientOptions } from "./util"
import { ThunderDriver, ThunderExpertDriver } from "./driver"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeClient(overrides: Partial<ThunderClientOptions> = {}) {
  return new ThunderClient({
    deviceId: "d".repeat(32),
    clientId: "cid",
    clientSecret: "secret",
    clientVersion: "8.31.0.9726",
    packageName: "com.xunlei.downloadprovider",
    userAgent: "ua",
    downloadUserAgent: "dua",
    ...overrides,
  })
}

function referenceGcid(data: Uint8Array): string {
  const size = data.length
  let psize = 0x40000
  while (size / psize > 0x200 && psize < 0x200000) psize = psize << 1
  const parts: Buffer[] = []
  for (let off = 0; off < size; off += psize) {
    parts.push(
      createHash("sha1")
        .update(data.subarray(off, Math.min(off + psize, size)))
        .digest(),
    )
  }
  return createHash("sha1").update(Buffer.concat(parts)).digest("hex")
}

test("F-287: calcGcid matches the reference SHA-1 construction", async () => {
  for (const size of [0, 1, 300 * 1024, 1024 * 1024 + 7]) {
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = (i * 31) % 251
    assert.equal(await calcGcid(data), referenceGcid(data), `size=${size}`)
  }
})

test("F-283: non-2xx JSON bodies are no longer treated as success", async () => {
  const client = makeClient()
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "rate limited" }), {
      status: 502,
      statusText: "Bad Gateway",
    })) as typeof fetch
  await assert.rejects(
    () => client.rawRequest("https://api.test/x"),
    /502 Bad Gateway.*rate limited/s,
  )

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch
  assert.deepEqual(await client.rawRequest("https://api.test/x"), { ok: true })
})

test("F-281: a failed refresh does not poison the shared token", async () => {
  const client = makeClient()
  const good = {
    access_token: "old-access",
    refresh_token: "old-refresh",
    token_type: "Bearer",
    expires_in: 3600,
  }
  client.tokenResp = { ...good }
  client.rawRequest = (async () => ({ error: "invalid_grant" })) as any

  await assert.rejects(() => client.refreshToken("old-refresh"), /Refresh token failed/)
  assert.deepEqual(client.tokenResp, good)
})

test("F-281: concurrent refreshes share one in-flight request", async () => {
  const client = makeClient()
  let calls = 0
  client.rawRequest = (async () => {
    calls++
    await new Promise((r) => setTimeout(r, 10))
    return { access_token: "new", refresh_token: "new-r", token_type: "Bearer" }
  }) as any

  await Promise.all([
    client.refreshToken("r1"),
    client.refreshToken("r1"),
    client.refreshToken("r1"),
  ])
  assert.equal(calls, 1)
  assert.equal(client.tokenResp?.access_token, "new")
})

test("F-282: authRequest retries a token error at most once", async () => {
  const client = makeClient()
  client.tokenResp = {
    access_token: "a",
    refresh_token: "r",
    token_type: "Bearer",
    expires_in: 3600,
    user_id: "u",
  }
  let rawCalls = 0
  client.rawRequest = (async () => {
    rawCalls++
    return { error_code: 10 }
  }) as any
  let refreshCalls = 0
  client.refreshToken = (async () => {
    refreshCalls++
    return { access_token: "a2", refresh_token: "r2", token_type: "Bearer" }
  }) as any

  await assert.rejects(
    () => client.authRequest("https://api.test/files"),
    /still failing after token refresh/,
  )
  assert.equal(refreshCalls, 1, "must refresh only once")
  assert.equal(rawCalls, 2, "initial request + one retry")
})

test("F-284: coreLogin rejects responses without sessionID", async () => {
  const client = makeClient()
  client.rawRequest = (async () => ({
    error_code: 4001,
    error_description: "wrong password",
  })) as any
  await assert.rejects(
    () => client.coreLogin("u", "p"),
    /Login failed:.*wrong password/s,
  )
})

test("F-284: signin failures surface the upstream error", async () => {
  const client = makeClient()
  client.rawRequest = (async (url: string) => {
    if (url.includes("core.login")) return { sessionID: "sid" }
    if (url.includes("shield/captcha/init")) return { captcha_token: "cap" }
    if (url.includes("auth/signin/token")) {
      return { error: "invalid_grant", error_description: "bad password" }
    }
    throw new Error(`unexpected url ${url}`)
  }) as any

  await assert.rejects(
    () => client.login("u", "p"),
    /Signin failed:.*bad password/s,
  )
  assert.equal(client.tokenResp, null, "must not store a broken token response")
})

test("F-280: init() reuses the persisted refresh_token", async () => {
  const driver = new ThunderDriver({
    username: "u",
    password: "p",
    refresh_token: "persisted-refresh",
  } as any)
  const client: any = (driver as any).client
  let logins = 0
  let refreshes = 0
  client.isLogin = async () => false
  client.refreshToken = async () => {
    refreshes++
    return { access_token: "a", refresh_token: "persisted-refresh" }
  }
  client.login = async () => {
    logins++
  }

  await driver.init()
  assert.equal(refreshes, 1)
  assert.equal(logins, 0)

  // refresh 失败时回落到账号密码登录
  const driver2 = new ThunderDriver({
    username: "u",
    password: "p",
    refresh_token: "broken",
  } as any)
  const client2: any = (driver2 as any).client
  let logins2 = 0
  client2.isLogin = async () => false
  client2.refreshToken = async () => {
    throw new Error("invalid_grant")
  }
  client2.login = async () => {
    logins2++
  }
  await driver2.init()
  assert.equal(logins2, 1)
})

test("F-285: expert init without usable credentials fails loudly", async () => {
  const driver = new ThunderExpertDriver({ login_type: "user" } as any)
  const client: any = (driver as any).client
  client.isLogin = async () => false
  await assert.rejects(() => driver.init(), /用户名或密码为空/)

  const driver2 = new ThunderExpertDriver({ login_type: "refresh_token" } as any)
  const client2: any = (driver2 as any).client
  client2.isLogin = async () => false
  await assert.rejects(() => driver2.init(), /未配置 refresh_token/)
})
