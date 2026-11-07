import assert from "node:assert/strict"
import { test } from "node:test"
import { DriverGooglePhoto } from "./driver"
import { ClientGooglePhoto } from "./util"

/**
 * F-448 / F-453 回归。
 */

type Call = { method: string; url: string; body: any }

async function withFetch<T>(
  impl: (url: URL, init: any) => Promise<Response>,
  calls: Call[],
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url))
    calls.push({
      method: String(init.method || "GET").toUpperCase(),
      url: url.toString(),
      body: init.body,
    })
    return impl(url, init)
  }) as any
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test("F-448：mediaItems:search 的 albumId/pageSize/pageToken 放在请求体", async () => {
  const calls: Call[] = []
  const client = new ClientGooglePhoto({
    client_id: "cid",
    client_secret: "csecret",
    refresh_token: "r",
  })
  ;(client as any).accessToken = "token"

  await withFetch(
    async () =>
      Response.json({
        mediaItems: [
          { id: "m1", filename: "IMG_1.jpg", mimeType: "image/jpeg" },
        ],
      }),
    calls,
    () => client.getFiles("album-123"),
  )

  const call = calls[0]
  const url = new URL(call.url)
  assert.ok(url.pathname.endsWith("/v1/mediaItems:search"))
  assert.equal(call.method, "POST")
  assert.equal(url.searchParams.get("albumId"), null, "albumId 不应出现在 query")
  assert.equal(url.searchParams.get("pageSize"), null, "pageSize 不应出现在 query")
  const body = JSON.parse(String(call.body))
  assert.equal(body.albumId, "album-123")
  assert.equal(body.pageSize, 100)
  assert.equal(body.pageToken, undefined)
})

test("F-448：翻页时 pageToken 随请求体发送", async () => {
  const calls: Call[] = []
  const client = new ClientGooglePhoto({
    client_id: "cid",
    client_secret: "csecret",
    refresh_token: "r",
  })
  ;(client as any).accessToken = "token"

  let round = 0
  await withFetch(
    async () => {
      round++
      if (round === 1) {
        return Response.json({
          mediaItems: [{ id: "m1", filename: "a.jpg", mimeType: "image/jpeg" }],
          nextPageToken: "p2",
        })
      }
      return Response.json({
        mediaItems: [{ id: "m2", filename: "b.jpg", mimeType: "image/jpeg" }],
      })
    },
    calls,
    () => client.getFiles("album-123"),
  )

  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(String(calls[1].body)).pageToken, "p2")
  const url = new URL(calls[1].url)
  assert.equal(url.searchParams.get("pageToken"), null)
})

test("F-453：get() 未命中抛 not found，不再返回伪造目录", async () => {
  const driver: any = new DriverGooglePhoto({
    client_id: "cid",
    client_secret: "csecret",
    refresh_token: "r",
  })
  driver.client.getFiles = async (id: string) => {
    if (id === "root") {
      return [
        { id: "albums", title: "albums" },
        { id: "all", title: "all" },
      ]
    }
    return [{ id: "m1", filename: "a.jpg" }]
  }
  driver.client.link = async () => "https://photos.example/1"

  // 未命中且不是合法目录层级 → 抛 not found（pathToId 会计算，但 getFiles 抛错）
  driver.client.getFiles = async (id: string) => {
    if (id === "root") return [{ id: "albums", title: "albums" }]
    throw new Error("[GooglePhoto] request failed: HTTP 404")
  }
  await assert.rejects(
    () => driver.get("/missing.jpg", "/missing.jpg"),
    /404/,
  )

  // 真实媒体项仍然正常返回
  driver.client.getFiles = async (id: string) => {
    if (id === "root") return [{ id: "m1", filename: "a.jpg" }]
    throw new Error("unexpected")
  }
  const item = await driver.get("/a.jpg", "/a.jpg")
  assert.equal(item.is_dir, false)
  assert.equal(item.raw_url, "https://photos.example/1")
})
