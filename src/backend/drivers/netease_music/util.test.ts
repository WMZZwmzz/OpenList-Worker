import test from "node:test"
import assert from "node:assert/strict"
import { ClientNeteaseMusic } from "./util"
import { DriverNeteaseMusic } from "./driver"

const COOKIE = "MUSIC_U=token123; __csrf=csrf456"

function newClient(): ClientNeteaseMusic {
  const client = new ClientNeteaseMusic({ cookie: COOKIE, song_limit: 10 })
  client.init()
  return client
}

test("request rejects non-2xx HTTP responses (F-390)", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response("bad gateway", { status: 502 })) as typeof fetch
  try {
    await assert.rejects(
      () => newClient().getSongObjs(10),
      /HTTP 502/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("request rejects Netease business error codes instead of returning [] (F-390)", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: 301, message: "need login" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch
  try {
    await assert.rejects(
      () => newClient().getSongObjs(10),
      /API error 301.*need login/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("removeSong checks the response and uses HTTPS (F-391/F-392)", async () => {
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  let payload: any = { code: 200 }
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url))
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
  try {
    const client = newClient()
    await client.removeSong("123")
    assert.equal(calls.length, 1)
    assert.ok(calls[0].startsWith("https://music.163.com/"))
    assert.ok(!calls[0].startsWith("http://"))

    payload = { code: 403, message: "forbidden" }
    await assert.rejects(() => client.removeSong("123"), /API error 403/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("driver.get throws for a missing song (F-389)", async () => {
  const driver = new DriverNeteaseMusic({ cookie: COOKIE })
  ;(driver as any).client.getSongObjs = async () => []
  await assert.rejects(
    () => driver.get("/missing.mp3", "/missing.mp3"),
    /file not found/,
  )
})
