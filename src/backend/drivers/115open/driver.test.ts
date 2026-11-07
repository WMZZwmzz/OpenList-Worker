import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { Pan115Driver } from "./driver"

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

const FILES_ROOT = [
  { fid: "f-a", fn: "a.txt", fc: "1", fs: 5, pid: "0" },
  { fid: "f-target", fn: "target", fc: "0", fs: 0, pid: "0" },
  { fid: "f-mnt", fn: "mnt", fc: "0", fs: 0, pid: "0" },
]

function mockClientFetch(mutations: Array<{ url: string; body: URLSearchParams }>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input)
    const method = init?.method || "GET"
    if (url === "https://proapi.115.com/open/folder/get_info" && method === "POST") {
      // 该账号内没有与虚拟路径同名的目录树 → 与线上一致的 430004
      return json({ state: false, code: 430004, message: "not found" })
    }
    if (url.startsWith("https://proapi.115.com/open/ufile/files?")) {
      const u = new URL(url)
      const cid = u.searchParams.get("cid")
      if (cid === "0") {
        return json({ state: true, code: 0, count: FILES_ROOT.length, data: FILES_ROOT })
      }
      return json({ state: true, code: 0, count: 0, data: [] })
    }
    if (
      (url === "https://proapi.115.com/open/ufile/move" ||
        url === "https://proapi.115.com/open/ufile/copy") &&
      method === "POST"
    ) {
      mutations.push({ url, body: new URLSearchParams(String(init?.body || "")) })
      return json({ state: true, code: 0 })
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  }) as typeof fetch
}

test("115open move resolves the target from dstPhysical, not the virtual dstDir", async () => {
  const mutations: Array<{ url: string; body: URLSearchParams }> = []
  globalThis.fetch = mockClientFetch(mutations)

  const driver = new Pan115Driver({ access_token: "t", refresh_token: "r" })
  // 挂载在 /mnt：虚拟 dstDir=/mnt/target，物理目标项=/target/a.txt
  await driver.move("/mnt", "/mnt/target", ["a.txt"], "/a.txt", "/target/a.txt")

  assert.equal(mutations.length, 1)
  assert.equal(mutations[0].body.get("to_cid"), "f-target")
  assert.equal(mutations[0].body.get("file_ids"), "f-a")
})

test("115open copy resolves the target from dstPhysical, not the virtual dstDir", async () => {
  const mutations: Array<{ url: string; body: URLSearchParams }> = []
  globalThis.fetch = mockClientFetch(mutations)

  const driver = new Pan115Driver({ access_token: "t", refresh_token: "r" })
  await driver.copy("/mnt", "/mnt/target", ["a.txt"], "/a.txt", "/target/a.txt")

  assert.equal(mutations.length, 1)
  assert.equal(mutations[0].url, "https://proapi.115.com/open/ufile/copy")
  assert.equal(mutations[0].body.get("pid"), "f-target")
  assert.equal(mutations[0].body.get("file_id"), "f-a")
})

test("115open folder quick path uses the root directory name (parentPath), not the numeric id", async () => {
  const lookups: string[] = []
  globalThis.fetch = (async (input, init) => {
    const url = requestUrl(input)
    const method = init?.method || "GET"
    if (url === "https://proapi.115.com/open/user/info") {
      return json({ state: true, data: { user_id: 1, user_name: "u" } })
    }
    if (url.startsWith("https://proapi.115.com/open/folder/get_info")) {
      if (method === "GET") {
        return json({
          state: true,
          data: {
            file_id: "2491234",
            file_name: "MyRoot",
            paths: [],
          },
        })
      }
      const form = new URLSearchParams(String(init?.body || ""))
      const path = form.get("path") || ""
      lookups.push(path)
      if (path === "/MyRoot/photos") {
        return json({ state: true, data: { file_id: "f-photos" } })
      }
      return json({ state: false, code: 430004, message: "not found" })
    }
    if (url.startsWith("https://proapi.115.com/open/ufile/files?")) {
      return json({
        state: true,
        count: 1,
        data: [{ fid: "f-x", fn: "x.txt", fc: "1", fs: 1 }],
      })
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  }) as typeof fetch

  const driver = new Pan115Driver({
    access_token: "t",
    refresh_token: "r",
    root_id: "2491234",
  })
  await driver.init()
  const items = await driver.list("/photos", "/photos")
  assert.equal(items.length, 1)
  // Go 语义 stdpath.Join(parentPath, path)：必须是 "/MyRoot/photos"
  assert.deepEqual(lookups, ["/MyRoot/photos"])
})

test("115open get surfaces the concrete downurl failure in raw_url_error", async () => {
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files?")) {
      return json({
        state: true,
        count: 1,
        data: [{ fid: "f-a", fn: "a.txt", fc: "1", fs: 5, pc: "pick-a" }],
      })
    }
    if (url === "https://proapi.115.com/open/ufile/downurl") {
      return json({ state: false, code: 406, message: "quota exceeded" })
    }
    if (url === "https://proapi.115.com/open/folder/get_info") {
      return json({ state: false, code: 430004, message: "not found" })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const driver = new Pan115Driver({ access_token: "t", refresh_token: "r" })
  const item = await driver.get("/a.txt", "/a.txt")
  assert.equal(item.raw_url, "")
  assert.match(String(item.raw_url_error), /406/)
  assert.match(String(item.raw_url_error), /配额/)
})

test("115open prunes expired link cache entries and bounds its size", async () => {
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files?")) {
      return json({ state: true, count: 0, data: [] })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const driver = new Pan115Driver({ access_token: "t", refresh_token: "r" })
  const cache: Map<string, { url: string; expire: number }> = (driver as any)
    .linkCache
  for (let i = 0; i < 600; i++) {
    cache.set(`expired-${i}`, { url: "u", expire: Date.now() - 1000 })
  }
  for (let i = 0; i < 100; i++) {
    cache.set(`live-${i}`, { url: "u", expire: Date.now() + 60_000 })
  }
  // 任意一次 list 会触发 pruneLinkCache
  await driver.list("/", "/")
  assert.ok(cache.size <= 512, `linkCache must stay bounded, got ${cache.size}`)
  assert.ok(![...cache.keys()].some((k) => k.startsWith("expired-")))
})

test("115open list fails loudly instead of returning a silently truncated directory", async () => {
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files?")) {
      const offset = Number(new URL(url).searchParams.get("offset") || "0")
      return json({
        state: true,
        count: 100,
        data: [{ fid: `f-${offset}`, fn: `f-${offset}`, fc: "1", fs: 1 }],
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const driver = new Pan115Driver({
    access_token: "t",
    refresh_token: "r",
    page_size: 1,
  })
  ;(driver as any).pageSize = 1
  ;(driver as any).budget.limit = 2
  await assert.rejects(
    () => driver.list("/", "/"),
    /子请求预算上限|截断/,
  )
})
