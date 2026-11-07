import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { Driver115 } from "./driver"

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

/** 115 Open API 的真实列表响应：data 数组里的字段全部是小写 */
const ROOT_DATA = [
  { fid: "f-docs", fn: "docs", fc: "0", fs: 0, pid: "0" },
  {
    fid: "f-a",
    fn: "a.txt",
    fc: "1",
    fs: 12,
    pc: "pick-a",
    upt: 1700000000,
    pid: "0",
  },
]

test("115 list maps lowercase Open API fields (fid/fn/fc/fs)", async () => {
  const calls: Array<{ url: string; method?: string }> = []
  globalThis.fetch = (async (input, init) => {
    const url = requestUrl(input)
    calls.push({ url, method: init?.method })
    if (url === "https://proapi.115.com/open/user/info") {
      return json({ state: true, data: { user_id: 1, user_name: "u" } })
    }
    if (url.startsWith("https://proapi.115.com/open/ufile/files")) {
      return json({ state: true, count: ROOT_DATA.length, data: ROOT_DATA })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const driver = new Driver115({
    access_token: "token",
    refresh_token: "refresh",
  })
  await driver.init()

  const items = await driver.list("/", "/")
  assert.equal(items.length, 2)
  const docs = items.find((i) => i.name === "docs")
  const file = items.find((i) => i.name === "a.txt")
  assert.ok(docs, "folder name must be read from fn")
  assert.equal(docs!.is_dir, true)
  assert.equal(docs!.sign, "")
  assert.ok(file)
  assert.equal(file!.is_dir, false)
  assert.equal(file!.size, 12)
  assert.equal(file!.modified, new Date(1700000000 * 1000).toISOString())

  // 单一 /open 前缀：API_BASE 已是 .../open，端点不得再拼 /open
  const listCall = calls.find((c) => c.url.includes("/ufile/files"))
  assert.ok(listCall, "list must hit /open/ufile/files")
  assert.equal(listCall!.method, "GET", "list must be GET + query")
  const query = new URL(listCall!.url).searchParams
  assert.equal(query.get("cid"), "0")
  assert.ok(!listCall!.url.includes("/open/open/"))
})

test("115 resolves nested paths from lowercase listings", async () => {
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files")) {
      const cid = new URL(url).searchParams.get("cid")
      if (cid === "0") {
        return json({ state: true, data: ROOT_DATA })
      }
      if (cid === "f-docs") {
        return json({
          state: true,
          data: [{ fid: "f-inner", fn: "inner.txt", fc: "1", fs: 3 }],
        })
      }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const driver = new Driver115({
    access_token: "token",
    refresh_token: "refresh",
  })
  const items = await driver.list("/docs", "/docs")
  assert.equal(items.length, 1)
  assert.equal(items[0].name, "inner.txt")
  assert.equal(items[0].is_dir, false)
})

test("115 clears pathCache after mkdir/rename/remove/move/copy", async () => {
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files")) {
      return json({ state: true, data: ROOT_DATA })
    }
    if (
      url === "https://proapi.115.com/open/folder/add" ||
      url === "https://proapi.115.com/open/ufile/update" ||
      url === "https://proapi.115.com/open/ufile/delete" ||
      url === "https://proapi.115.com/open/ufile/move" ||
      url === "https://proapi.115.com/open/ufile/copy"
    ) {
      return json({ state: true })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const driver = new Driver115({
    access_token: "token",
    refresh_token: "refresh",
  })
  const cache: Map<string, string> = (driver as any).pathCache
  assert.ok(cache instanceof Map)

  await driver.list("/", "/docs")
  assert.equal(cache.get("/docs"), "f-docs")

  // rename: 解析后必须清空缓存
  await driver.rename("/docs", "/docs", "docs2")
  assert.equal(cache.size, 0)

  // list 重新填充后 remove 清空
  await driver.list("/", "/docs")
  assert.equal(cache.get("/docs"), "f-docs")
  await driver.remove("/docs", "/docs", ["docs"])
  assert.equal(cache.size, 0)

  await driver.list("/", "/docs")
  await driver.mkdir("/new", "/new")
  assert.equal(cache.size, 0)

  await driver.list("/", "/docs")
  await driver.move("/docs", "/", ["docs"], "/docs", "/docs")
  assert.equal(cache.size, 0)

  await driver.list("/", "/docs")
  await driver.copy("/docs", "/", ["docs"], "/docs", "/docs")
  assert.equal(cache.size, 0)
})

test("115 move/copy resolve the destination folder from dstPhysical, not the virtual dstDir", async () => {
  const writes: Array<{ url: string; form: URLSearchParams }> = []
  globalThis.fetch = (async (input, init) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files")) {
      return json({ state: true, data: ROOT_DATA })
    }
    writes.push({
      url,
      form: new URLSearchParams(String(init?.body || "")),
    })
    return json({ state: true })
  }) as typeof fetch

  const driver = new Driver115({
    access_token: "token",
    refresh_token: "refresh",
  })

  // 挂载点 /mnt 下的虚拟目录 "/mnt/docs" 对 115 账号并不存在：
  // 目标父目录必须从物理路径 "/docs/a.txt" 取 dirname。
  await driver.move("/", "/mnt/docs", ["a.txt"], "/a.txt", "/docs/a.txt")
  await driver.copy("/", "/mnt/docs", ["a.txt"], "/a.txt", "/docs/a.txt")

  const moveForm = writes.find((w) => w.url.endsWith("/ufile/move"))!.form
  const copyForm = writes.find((w) => w.url.endsWith("/ufile/copy"))!.form
  assert.equal(moveForm.get("to_cid"), "f-docs")
  assert.equal(moveForm.get("file_ids"), "f-a")
  assert.equal(copyForm.get("pid"), "f-docs")
  assert.equal(copyForm.get("file_id"), "f-a")
})

test("115 refresh uses passportapi /open/refreshToken and retries the request", async () => {
  const urls: string[] = []
  let listCalls = 0
  globalThis.fetch = (async (input, init) => {
    const url = requestUrl(input)
    urls.push(url)
    if (url.startsWith("https://proapi.115.com/open/ufile/files")) {
      listCalls++
      if (listCalls === 1) {
        // Open API 信封：token 失效是 code 99 / 401xxx
        return json({ state: false, code: 40101001, message: "token expired" })
      }
      return json({ state: true, data: [] })
    }
    if (url === "https://passportapi.115.com/open/refreshToken") {
      const form = new URLSearchParams(String(init?.body || ""))
      assert.equal(form.get("refresh_token"), "refresh")
      return json({
        code: 0,
        data: { access_token: "new-token", refresh_token: "new-refresh" },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const addition = { access_token: "old", refresh_token: "refresh" }
  const driver = new Driver115(addition)
  const items = await driver.list("/", "/")
  assert.deepEqual(items, [])
  assert.ok(urls.includes("https://passportapi.115.com/open/refreshToken"))
  assert.equal(addition.access_token, "new-token")
  assert.equal(addition.refresh_token, "new-refresh")
})

test("115 write operations use Open API endpoints with form-encoded SDK parameter names", async () => {
  const writes: Array<{
    url: string
    method?: string
    contentType: string
    form: URLSearchParams
  }> = []
  globalThis.fetch = (async (input, init) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files")) {
      return json({ state: true, data: ROOT_DATA })
    }
    const headers = (init?.headers || {}) as Record<string, string>
    writes.push({
      url,
      method: init?.method,
      contentType: headers["Content-Type"] || "",
      form: new URLSearchParams(String(init?.body || "")),
    })
    if (url === "https://proapi.115.com/open/ufile/downurl") {
      return json({
        state: true,
        data: { "f-a": { url: { url: "https://cdn.115.com/a.txt" } } },
      })
    }
    return json({ state: true })
  }) as typeof fetch

  const driver = new Driver115({
    access_token: "token",
    refresh_token: "refresh",
  })

  await driver.mkdir("/x", "/x")
  await driver.rename("/a.txt", "/a.txt", "b.txt")
  await driver.move("/a.txt", "/", ["a.txt"], "/a.txt", "/a.txt")
  await driver.copy("/a.txt", "/", ["a.txt"], "/a.txt", "/a.txt")
  await driver.remove("/a.txt", "/a.txt", ["a.txt"])
  const item = await driver.get("/a.txt", "/a.txt")

  const byUrl = (u: string) => writes.find((w) => w.url === u)!
  assert.equal(byUrl("https://proapi.115.com/open/folder/add").form.get("pid"), "0")
  assert.equal(
    byUrl("https://proapi.115.com/open/folder/add").form.get("file_name"),
    "x",
  )
  assert.equal(
    byUrl("https://proapi.115.com/open/ufile/update").form.get("file_id"),
    "f-a",
  )
  assert.equal(
    byUrl("https://proapi.115.com/open/ufile/update").form.get("file_name"),
    "b.txt",
  )
  assert.equal(
    byUrl("https://proapi.115.com/open/ufile/move").form.get("file_ids"),
    "f-a",
  )
  assert.equal(
    byUrl("https://proapi.115.com/open/ufile/move").form.get("to_cid"),
    "0",
  )
  assert.equal(
    byUrl("https://proapi.115.com/open/ufile/copy").form.get("pid"),
    "0",
  )
  assert.equal(
    byUrl("https://proapi.115.com/open/ufile/copy").form.get("file_id"),
    "f-a",
  )
  assert.equal(
    byUrl("https://proapi.115.com/open/ufile/delete").form.get("file_ids"),
    "f-a",
  )
  assert.equal(
    byUrl("https://proapi.115.com/open/ufile/delete").form.get("parent_id"),
    "0",
  )
  for (const w of writes) {
    assert.equal(w.method, "POST")
    assert.match(w.contentType, /application\/x-www-form-urlencoded/)
  }
  // downurl 嵌套两层：data[fid].url.url
  assert.equal(item.raw_url, "https://cdn.115.com/a.txt")
})

test("115 paginates a directory larger than the 1000-item page size", async () => {
  const offsets: string[] = []
  const page1 = Array.from({ length: 1000 }, (_, i) => ({
    fid: `f1-${i}`,
    fn: `f1-${i}`,
    fc: "1",
    fs: 1,
  }))
  const page2 = Array.from({ length: 500 }, (_, i) => ({
    fid: `f2-${i}`,
    fn: `f2-${i}`,
    fc: "1",
    fs: 1,
  }))
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files")) {
      const params = new URL(url).searchParams
      offsets.push(params.get("offset") || "")
      return json({ state: true, count: 1500, data: params.get("offset") === "0" ? page1 : page2 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const driver = new Driver115({
    access_token: "token",
    refresh_token: "refresh",
  })
  const items = await driver.list("/", "/")
  assert.equal(items.length, 1500)
  assert.deepEqual(offsets, ["0", "1000"])
})

test("115 throws on non-JSON upstream responses instead of returning an empty success", async () => {
  globalThis.fetch = (async () =>
    new Response("<html>waf blocked</html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    })) as typeof fetch

  const driver = new Driver115({
    access_token: "token",
    refresh_token: "refresh",
  })
  await assert.rejects(
    () => driver.list("/", "/"),
    (err: Error) => /HTTP 403|无法解析/.test(err.message),
  )
})

test("115 auth retry is bounded to one refresh and coalesces concurrent refreshes", async () => {
  let refreshed = false
  let refreshCalls = 0
  let listCalls = 0
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files")) {
      listCalls++
      if (!refreshed) {
        return json({ state: false, code: 99, message: "token expired" })
      }
      return json({ state: true, data: [] })
    }
    if (url === "https://passportapi.115.com/open/refreshToken") {
      refreshCalls++
      await new Promise((r) => setTimeout(r, 20))
      refreshed = true
      return json({
        code: 0,
        data: { access_token: "new-token", refresh_token: "new-refresh" },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const driver = new Driver115({
    access_token: "old",
    refresh_token: "refresh",
  })
  await Promise.all([driver.list("/", "/"), driver.list("/", "/")])
  assert.equal(refreshCalls, 1, "concurrent auth failures must share one refresh")
  // 2 次并发首请求 + 各自一次重试
  assert.equal(listCalls, 4)
})

test("115 gives up after a single auth retry instead of recursing forever", async () => {
  let listCalls = 0
  let refreshCalls = 0
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files")) {
      listCalls++
      return json({ state: false, code: 99, message: "still expired" })
    }
    if (url === "https://passportapi.115.com/open/refreshToken") {
      refreshCalls++
      return json({
        code: 0,
        data: { access_token: "new-token", refresh_token: "new-refresh" },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const driver = new Driver115({
    access_token: "old",
    refresh_token: "refresh",
  })
  await assert.rejects(() => driver.list("/", "/"), /code 99/)
  assert.equal(refreshCalls, 1)
  assert.equal(listCalls, 2)
})

test("115 matches literal %XX names without extra decodeURIComponent", async () => {
  const data = [
    { fid: "f-space", fn: "a b", fc: "1", fs: 1, pc: "pick-space" },
    { fid: "f-literal", fn: "a%20b", fc: "1", fs: 2, pc: "pick-literal" },
  ]
  globalThis.fetch = (async (input) => {
    const url = requestUrl(input)
    if (url.startsWith("https://proapi.115.com/open/ufile/files")) {
      return json({ state: true, data })
    }
    if (url === "https://proapi.115.com/open/ufile/downurl") {
      return json({
        state: true,
        data: { "f-literal": { url: { url: "https://cdn.115.com/literal" } } },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const driver = new Driver115({
    access_token: "token",
    refresh_token: "refresh",
  })
  const item = await driver.get("/a%20b", "/a%20b")
  assert.equal(item.name, "a%20b")
  assert.equal(item.size, 2)
  assert.equal(item.raw_url, "https://cdn.115.com/literal")
})
