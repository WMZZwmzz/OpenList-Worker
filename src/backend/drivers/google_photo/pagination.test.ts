import assert from "node:assert/strict"
import { test } from "node:test"
import { ClientGooglePhoto } from "./util"

/**
 * F-446 回归：fetchItems 必须把上一轮返回的 nextPageToken 用于下一轮请求，
 * 且不能每轮都从原始 query 重置 pageToken（否则永远重复请求第一页）。
 */

type Call = { url: string; pageToken: string | null; method: string }

function installFetch(
  calls: Call[],
  pages: Record<string, { items: any[]; nextPageToken?: string }>,
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url))
    // mediaItems:search 是 POST：pageToken 在 JSON body 中；其它接口在 query 中。
    let pageToken: string | null = url.searchParams.get("pageToken")
    if (init?.body) {
      try {
        const body = JSON.parse(String(init.body))
        if (typeof body?.pageToken === "string") pageToken = body.pageToken
      } catch {
        /* ignore non-JSON body */
      }
    }
    calls.push({
      url: url.toString(),
      pageToken,
      method: String(init.method || "GET").toUpperCase(),
    })
    const page = pages[pageToken ?? ""]
    if (!page) {
      return Response.json({
        error: { message: `unexpected pageToken: ${JSON.stringify(pageToken)}` },
      })
    }
    const isAlbums = /\/v1\/(shared)?[aA]lbums$/.test(url.pathname)
    return Response.json({
      ...(isAlbums ? { albums: page.items } : { mediaItems: page.items }),
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
    })
  }) as any
  return () => {
    globalThis.fetch = original
  }
}

function makeClient(): ClientGooglePhoto {
  const client = new ClientGooglePhoto({
    client_id: "id",
    client_secret: "secret",
    refresh_token: "refresh",
  })
  ;(client as any).accessToken = "token"
  return client
}

test("F-446：相册分页携带 nextPageToken，只请求两页后结束", async () => {
  const calls: Call[] = []
  const restore = installFetch(calls, {
    "": { items: [{ id: "a1", title: "A1" }], nextPageToken: "TOKEN2" },
    TOKEN2: { items: [{ id: "a2", title: "A2" }] },
  })
  try {
    const items = await makeClient().getFiles("albums")
    assert.deepEqual(
      items.map((i) => i.id),
      ["a1", "a2"],
    )
    assert.deepEqual(
      calls.map((c) => c.pageToken),
      [null, "TOKEN2"],
      "首轮不带 token，第二轮必须带上一轮的 nextPageToken",
    )
  } finally {
    restore()
  }
})

test("F-446：mediaItems 分页同样推进 pageToken（且不会无限循环）", async () => {
  const calls: Call[] = []
  const restore = installFetch(calls, {
    "": { items: [{ id: "m1", filename: "1.jpg" }], nextPageToken: "P2" },
    P2: { items: [{ id: "m2", filename: "2.jpg" }], nextPageToken: "P3" },
    P3: { items: [{ id: "m3", filename: "3.jpg" }] },
  })
  try {
    const items = await makeClient().getFiles("some-album-id")
    assert.deepEqual(
      items.map((i) => i.id),
      ["m1", "m2", "m3"],
    )
    assert.deepEqual(calls.map((c) => c.pageToken), [null, "P2", "P3"])
    assert.ok(
      calls.every((c) => c.method === "POST"),
      "相册内媒体搜索应为 POST",
    )
  } finally {
    restore()
  }
})
