import test from "node:test"
import assert from "node:assert/strict"
import { AliyundriveShareDriver } from "./driver"
import { AliyundriveShareAddition } from "./types"

test("AliyundriveShareDriver instantiation and methods", async () => {
  const addition: AliyundriveShareAddition = {
    share_id: "ali_share_id_123",
    share_pwd: "pwd",
  }

  const driver = new AliyundriveShareDriver(addition)
  assert.ok(driver)

  // Mock getFiles
  ;(driver as any).client.getFiles = async (parentId: string) => {
    return [
      {
        file_id: "fid_101",
        name: "MyMovies",
        type: "folder",
        updated_at: "2026-08-24T12:00:00Z",
      },
      {
        file_id: "fid_102",
        name: "movie.mp4",
        type: "file",
        size: 524288000,
        updated_at: "2026-08-24T12:00:00Z",
      },
    ]
  }

  const items = await driver.list("/", "/")
  assert.equal(items.length, 2)
  assert.equal(items[0].name, "MyMovies")
  assert.equal(items[0].is_dir, true)
  assert.equal(items[1].name, "movie.mp4")
  assert.equal(items[1].is_dir, false)
  assert.equal(items[1].size, 524288000)

  // Mock getDownloadUrl
  ;(driver as any).client.getDownloadUrl = async (fileId: string) =>
    "https://cn-beijing-data.alicloud.com/movie.mp4"

  const link = await driver.link("/movie.mp4", "/movie.mp4")
  assert.equal(link.url, "https://cn-beijing-data.alicloud.com/movie.mp4")
})

// ---- F-423: 路径段不存在必须报错 ----
test("resolveFileId 对不存在的路径段抛错而不是返回上级目录（F-423）", async () => {
  const driver = new AliyundriveShareDriver({ share_id: "s1" })
  ;(driver as any).client.getFiles = async (parentId: string) => {
    if (parentId === "root") {
      return [{ file_id: "dir-a", name: "a", type: "folder" }]
    }
    return [{ file_id: "f1", name: "x.txt", type: "file", size: 1 }]
  }
  await assert.rejects(
    () => driver.list("/a/missing", "/a/missing"),
    /Directory 'missing' not found/,
  )
  await assert.rejects(
    () => driver.get("/a/missing/x.txt", "/a/missing/x.txt"),
    /Directory 'missing' not found/,
  )
})

// ---- F-426: get() 必须返回 raw_url_headers ----
test("get() 为直链附带 Referer/User-Agent 头（F-426）", async () => {
  const driver = new AliyundriveShareDriver({ share_id: "s1" })
  ;(driver as any).client.getFiles = async () => [
    { file_id: "f1", name: "movie.mp4", type: "file", size: 10 },
  ]
  ;(driver as any).client.getDownloadUrl = async () =>
    "https://cdn.example.com/movie.mp4"

  const item = await driver.get("/movie.mp4", "/movie.mp4")
  assert.equal(item.raw_url, "https://cdn.example.com/movie.mp4")
  assert.equal(item.raw_url_headers?.Referer, "https://www.aliyundrive.com/")
  assert.match(item.raw_url_headers?.["User-Agent"] || "", /Mozilla/)
})

// ---- F-429: token 失效只重试一次 ----
test("getFiles 在刷新后仍被拒时只重试一次（F-429）", async () => {
  const { AliyundriveShareApiClient } = await import("./util")
  const mockCalls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    mockCalls.push(url)
    if (url.includes("get_share_token")) {
      return new Response(JSON.stringify({ share_token: "t2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ code: "ShareLinkTokenInvalid" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as any
  try {
    const client = new AliyundriveShareApiClient({ share_id: "s1" })
    ;(client as any).shareToken = "t1"
    await assert.rejects(
      () => client.getFiles("root"),
      /did not help/,
    )
    assert.equal(mockCalls.length, 3, mockCalls.join(","))
  } finally {
    globalThis.fetch = original
  }
})
