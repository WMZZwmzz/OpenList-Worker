import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { Pan115Client } from "./util"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
}

test("115open coalesces concurrent token refreshes into one upstream call", async () => {
  let refreshed = false
  let refreshCalls = 0
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files?")) {
      if (!refreshed) {
        return json({ state: false, code: 40101001, message: "expired" })
      }
      return json({ state: true, code: 0, data: [], count: 0 })
    }
    if (url === "https://passportapi.115.com/open/refreshToken") {
      refreshCalls++
      await new Promise((r) => setTimeout(r, 20))
      refreshed = true
      return json({
        code: 0,
        data: { access_token: "a2", refresh_token: "r2" },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const client = new Pan115Client({
    access_token: "a1",
    refresh_token: "r1",
  })
  const opts = { cid: "0", limit: 10, offset: 0, asc: true }
  await Promise.all([client.getFiles(opts), client.getFiles(opts)])
  assert.equal(refreshCalls, 1, "concurrent 401s must share one refresh")
  assert.equal(client.accessToken, "a2")
})

test("115open does not replay non-idempotent writes after a network error", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    throw new Error("ECONNRESET")
  }) as typeof fetch

  const client = new Pan115Client({
    access_token: "a",
    refresh_token: "r",
  })
  await assert.rejects(() => client.mkdir("0", "newdir"))
  assert.equal(calls, 1, "mkdir must be attempted exactly once")
})

test("115open retries idempotent query requests (downurl)", async () => {
  let calls = 0
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input)
    calls++
    if (calls === 1) throw new Error("socket hang up")
    if (url === "https://proapi.115.com/open/ufile/downurl") {
      return json({
        state: true,
        code: 0,
        data: { "f-a": { url: { url: "https://cdn.115.com/a" } } },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const client = new Pan115Client({
    access_token: "a",
    refresh_token: "r",
  })
  const resp = await client.downUrl("pick-a", "ua")
  assert.equal(resp["f-a"].url.url, "https://cdn.115.com/a")
  assert.equal(calls, 2)
})
