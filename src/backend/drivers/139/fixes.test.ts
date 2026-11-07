import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { Yun139Driver } from "./driver"
import { Yun139Addition } from "./types"
import {
  calSign,
  encodeURIComponentCustom,
  Yun139ApiClient,
} from "./util"

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

function authFor(token: string): string {
  return Buffer.from(`pc:13800138000:${token}`).toString("base64")
}

test("139 signature escaping keeps !'()* literal like the Go reference", () => {
  const input = "照片 (1)*ok!.txt"
  const enc = encodeURIComponentCustom(input)
  assert.ok(enc.includes("("), "parentheses must stay literal")
  assert.ok(enc.includes(")"), "parentheses must stay literal")
  assert.ok(enc.includes("*"))
  assert.ok(enc.includes("!"))
  assert.ok(!/%28|%29|%2A|%21|%27/.test(enc))
  // 冒号/空格等仍按 %XX 编码，编码串本身可逆
  assert.equal(decodeURIComponent(enc), input)
  // 签名必须对两种方向给出不同结果（防止回退到旧方向时静默通过）
  assert.notEqual(
    calSign(`{"name":"${input}"}`, "2026-01-01 00:00:00", "abcdef"),
    "",
  )
})

test("139 legacy getDisk paginates by nodeCount instead of a single 5000 window", async () => {
  const client = new Yun139ApiClient({ authorization: authFor("t|1|RCS|1|o") })
  const windows: Array<{ start: number; end: number }> = []
  const total = 250
  ;(client as any).request = async (
    _uri: string,
    body: { startNumber: number; endNumber: number },
  ) => {
    windows.push({ start: body.startNumber, end: body.endNumber })
    const start = body.startNumber - 1
    const end = Math.min(body.endNumber, total)
    const contentList = []
    for (let i = start; i < end; i++) {
      contentList.push({
        contentID: `c-${i}`,
        contentName: `f-${i}.txt`,
        contentSize: 1,
      })
    }
    return {
      data: { getDiskResult: { contentList, catalogList: [], nodeCount: total } },
    }
  }

  const disk = await client.getDisk("cat")
  assert.equal(disk.files.length, total)
  assert.deepEqual(windows, [
    { start: 1, end: 100 },
    { start: 101, end: 200 },
    { start: 201, end: 300 },
  ])
})

test("139 legacy rename sends files to updateContentInfo and folders to updateCatalogInfo", async () => {
  const client = new Yun139ApiClient({
    authorization: authFor("t|1|RCS|1|o"),
    type: "personal",
  })
  const calls: Array<{ uri: string; body: any }> = []
  ;(client as any).request = async (uri: string, body: any) => {
    calls.push({ uri, body })
    return {}
  }

  await client.rename("file-id", "b.txt", false)
  await client.rename("cat-id", "docs2", true)

  assert.match(calls[0].uri, /content\/v1\.0\/updateContentInfo/)
  assert.equal(calls[0].body.contentID, "file-id")
  assert.equal(calls[0].body.contentName, "b.txt")
  assert.match(calls[1].uri, /catalog\/v1\.0\/updateCatalogInfo/)
  assert.equal(calls[1].body.catalogID, "cat-id")
  assert.equal(calls[1].body.catalogName, "docs2")
})

test("139 coalesces concurrent token refreshes into one request", async () => {
  const expiresAt = Date.now() + 5 * 24 * 60 * 60 * 1000
  let refreshCalls = 0
  globalThis.fetch = (async (input) => {
    const url = String(input)
    if (url === "https://user-njs.yun.139.com/user/auth/refreshToken") {
      refreshCalls++
      await new Promise((r) => setTimeout(r, 20))
      return json({
        success: true,
        code: "0000",
        data: {
          token: `new|1|RCS|${Date.now() + 30 * 24 * 60 * 60 * 1000}|o`,
        },
      })
    }
    return json({ success: true, code: "0000", data: {} })
  }) as typeof fetch

  const addition: Yun139Addition = {
    authorization: authFor(`old|1|RCS|${expiresAt}|o`),
    user_domain_id: "ud",
    type: "personal",
  }
  const client = new Yun139ApiClient(addition)
  await Promise.all([
    client.request("/file/list", {}),
    client.request("/file/list", {}),
  ])
  assert.equal(refreshCalls, 1, "concurrent refreshes must be coalesced")
})

test("139 keeps using the current token when an early refresh fails but the token is still valid", async () => {
  const expiresAt = Date.now() + 5 * 24 * 60 * 60 * 1000
  globalThis.fetch = (async (input) => {
    const url = String(input)
    if (url === "https://user-njs.yun.139.com/user/auth/refreshToken") {
      return new Response("upstream 502", { status: 502 })
    }
    return json({ success: true, code: "0000", data: {} })
  }) as typeof fetch

  const client = new Yun139ApiClient({
    authorization: authFor(`old|1|RCS|${expiresAt}|o`),
    user_domain_id: "ud",
    type: "personal",
  })
  const result = await client.request("/file/list", {})
  assert.deepEqual(result, { success: true, code: "0000", data: {} })
})

test("139 link reuses the download url already obtained by get()", async () => {
  const driver = new Yun139Driver({
    authorization: authFor("t|1|RCS|1|o"),
    type: "personal_new",
  })
  let downloads = 0
  ;(driver as any).client.getDownloadUrl = async () => {
    downloads++
    return "https://cdn.example.com/file"
  }
  ;(driver as any).get = async () => ({
    name: "a.txt",
    size: 1,
    is_dir: false,
    modified: new Date().toISOString(),
    sign: "content-1",
    type: 0,
    raw_url: "https://cdn.example.com/cached",
  })

  const link = await driver.link("/a.txt", "/a.txt")
  assert.equal(link.url, "https://cdn.example.com/cached")
  assert.equal(downloads, 0, "link() must not call getDownloadUrl again")

  // raw_url 为空时才兜底请求
  ;(driver as any).get = async () => ({
    name: "a.txt",
    size: 1,
    is_dir: false,
    modified: new Date().toISOString(),
    sign: "content-1",
    type: 0,
    raw_url: "",
  })
  const fallback = await driver.link("/a.txt", "/a.txt")
  assert.equal(fallback.url, "https://cdn.example.com/file")
  assert.equal(downloads, 1)
})

test("139 keeps sign empty for entries without an id and refuses to rename them", async () => {
  const driver = new Yun139Driver({
    authorization: authFor("t|1|RCS|1|o"),
    type: "personal_new",
  })
  ;(driver as any).client.listFiles = async () => ({
    folders: [],
    files: [{ contentName: "no-id.txt", contentSize: 1 }],
  })

  const item = await driver.get("/no-id.txt", "/no-id.txt")
  assert.equal(item.sign, "", "sign must not fall back to the file name")

  let renamed = false
  ;(driver as any).client.rename = async () => {
    renamed = true
  }
  await assert.rejects(
    () => driver.rename("/no-id.txt", "/no-id.txt", "new.txt"),
    /no id/i,
  )
  assert.equal(renamed, false, "must not call the API with a bogus id")
})
