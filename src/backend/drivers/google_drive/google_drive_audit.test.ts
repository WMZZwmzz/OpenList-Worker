import assert from "node:assert/strict"
import { test } from "node:test"
import { GoogleDrive } from "./driver"

/**
 * F-360 / F-361 / F-362 回归。
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

/** 构造一个已持有 access_token 的驱动，避免测试里触发 token 刷新 */
function newDriver(addition: Record<string, any> = {}): any {
  const driver: any = new GoogleDrive({
    refresh_token: "r",
    use_online_api: false,
    ...addition,
  } as any)
  driver.client.accessToken = "token"
  driver.client.tokenExpiresAt = Date.now() + 3600_000
  return driver
}

test("F-360：chunk_size>5MB 时 5MB~chunk_size 的文件走 resumable 上传", async () => {
  const calls: Call[] = []
  const driver = newDriver({ chunk_size: 8 })
  const content = Buffer.alloc(6 * 1024 * 1024, 1)

  await withFetch(
    async (url) => {
      if (url.searchParams.get("uploadType") === "resumable") {
        return new Response(null, {
          status: 200,
          headers: { Location: "https://upload.example/session" },
        })
      }
      return Response.json({ id: "file-id" })
    },
    calls,
    () => driver.put("/a.bin", "/a.bin", content),
  )

  const upload = calls.find((c) => c.url.includes("/upload/drive/"))
  assert.ok(upload, "应发出上传请求")
  assert.equal(
    new URL(upload!.url).searchParams.get("uploadType"),
    "resumable",
    `6MB 文件在 chunk_size=8 时必须走 resumable，实际：${upload!.url}`,
  )
})

test("F-360：<=5MB 的文件仍走 multipart", async () => {
  const calls: Call[] = []
  const driver = newDriver({ chunk_size: 8 })

  await withFetch(
    async () => Response.json({ id: "file-id" }),
    calls,
    () => driver.put("/a.bin", "/a.bin", Buffer.alloc(1024, 1)),
  )

  const upload = calls.find((c) => c.url.includes("/upload/drive/"))
  assert.equal(
    new URL(upload!.url).searchParams.get("uploadType"),
    "multipart",
  )
})

test("F-361：复合 order_by 不再被本地启发式重排", async () => {
  const driver = newDriver({ order_by: "folder,name,modifiedTime desc" })
  driver.client.resolveReadId = async () => "root-id"
  // API 已按复合查询串排好序（这里刻意给出与 name 序不同的顺序，
  // 用来证明驱动没有再在本地重排）。
  driver.client.listFiles = async () => [
    { id: "3", name: "zeta.txt", mimeType: "text/plain", modifiedTime: "2024-03-03T00:00:00Z" },
    { id: "1", name: "alpha.txt", mimeType: "text/plain", modifiedTime: "2024-02-02T00:00:00Z" },
    { id: "2", name: "mid.txt", mimeType: "text/plain", modifiedTime: "2024-01-01T00:00:00Z" },
  ]

  const items = await driver.list("/", "/")
  assert.deepEqual(
    items.map((i: any) => i.name),
    ["zeta.txt", "alpha.txt", "mid.txt"],
    "复合 order_by 必须原样信任 Drive 的返回顺序",
  )
})

test("F-362：目录 get() 不再返回 raw_url 与 Authorization 头", async () => {
  const driver = newDriver()
  driver.client.resolveFileId = async () => "folder-1"
  driver.client.getFile = async () => ({
    id: "folder-1",
    name: "Docs",
    mimeType: "application/vnd.google-apps.folder",
  })

  const item = await driver.get("/Docs", "/Docs")
  assert.equal(item.is_dir, true)
  assert.equal(item.raw_url, "")
  assert.equal(item.raw_url_headers, undefined)

  driver.client.getFile = async () => ({
    id: "file-1",
    name: "a.txt",
    mimeType: "text/plain",
    size: "12",
  })
  const file = await driver.get("/a.txt", "/a.txt")
  assert.equal(file.is_dir, false)
  assert.ok(file.raw_url)
  assert.ok(file.raw_url_headers?.Authorization)
})
