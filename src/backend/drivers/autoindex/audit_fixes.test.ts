import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { AutoIndexDriver } from "./driver"
import { parseSize, parseTime } from "./util"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("F-379: TB/PB 单位换算正确（不再是 32 位位移溢出值）", () => {
  assert.equal(parseSize("4T"), 4 * 1024 ** 4)
  assert.equal(parseSize("4TB"), 4 * 1024 ** 4)
  assert.equal(parseSize("4TiB"), 4 * 1024 ** 4)
  assert.equal(parseSize("1P"), 1024 ** 5)
  assert.equal(parseSize("1PB"), 1024 ** 5)
  // K/M/G 档保持原值
  assert.equal(parseSize("3G"), 3 * 1024 ** 3)
  assert.equal(parseSize("2M"), 2 * 1024 ** 2)
})

test("F-380: 配置的 Go layout 生效（nginx 默认 02-Jan-2006 15:04）", () => {
  assert.equal(
    parseTime("02-Jan-2026 15:04", "02-Jan-2006 15:04"),
    "2026-01-02T15:04:00.000Z",
  )
  assert.equal(
    parseTime("2026-01-02 10:30", "2006-01-02 15:04"),
    "2026-01-02T10:30:00.000Z",
  )
  assert.equal(
    parseTime("02/Jan/2026:15:04:05", "02/Jan/2006:15:04:05"),
    "2026-01-02T15:04:05.000Z",
  )
})

test("F-380: 无时区时间戳按 UTC 解释，不随宿主时区漂移", () => {
  assert.equal(parseTime("2026-01-02 10:30", ""), "2026-01-02T10:30:00.000Z")
  assert.equal(
    parseTime("Fri, 02 Jan 2026 10:30:00 GMT", ""),
    "2026-01-02T10:30:00.000Z",
  )
})

test("F-380: 解析失败/空输入返回空串，不再伪造成当前时间", () => {
  assert.equal(parseTime("not a timestamp", ""), "")
  assert.equal(parseTime("", ""), "")
  assert.equal(parseTime("   ", ""), "")
})

test("F-382: get() 的 sign 恒为空串（签名由 server 层统一签发）", async () => {
  globalThis.fetch = (async (_input: any, init: any) => {
    assert.equal(init?.method, "HEAD")
    return new Response("", {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": "42" },
    })
  }) as typeof fetch

  const driver = new AutoIndexDriver({ url: "https://static.example/files/" })
  const file = await driver.get("/a.mp4", "/a.mp4")
  assert.equal(file.is_dir, false)
  assert.equal(file.size, 42)
  assert.equal(file.sign, "")
  assert.equal(file.raw_url, "https://static.example/files/a.mp4")

  const root = await driver.get("/", "")
  assert.equal(root.is_dir, true)
  assert.equal(root.sign, "")
})

test("F-381: 目录路径返回 is_dir=true，且没有 raw_url", async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    // 目录：裸路径与尾斜杠路径都是 HTML 索引页
    return new Response("", {
      status: url.endsWith("/sub/") || url.endsWith("/sub") ? 200 : 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }) as typeof fetch

  const driver = new AutoIndexDriver({ url: "https://static.example/files/" })
  const item = await driver.get("/sub", "/sub")
  assert.equal(item.is_dir, true)
  assert.equal(item.raw_url, "")
  assert.equal(item.type, 1)
})

test("F-381: HTML 文件仍是文件（尾斜杠形式不存在时不当作目录）", async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.endsWith("/index.html")) {
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/html", "content-length": "12" },
      })
    }
    return new Response("", { status: 404 })
  }) as typeof fetch

  const driver = new AutoIndexDriver({ url: "https://static.example/files/" })
  const item = await driver.get("/index.html", "/index.html")
  assert.equal(item.is_dir, false)
  assert.equal(item.raw_url, "https://static.example/files/index.html")
})

test("F-381: 不存在的路径抛 not found，而不是伪造文件条目", async () => {
  globalThis.fetch = (async () =>
    new Response("", { status: 404 })) as typeof fetch

  const driver = new AutoIndexDriver({ url: "https://static.example/files/" })
  await assert.rejects(
    () => driver.get("/missing.txt", "/missing.txt"),
    /object not found/,
  )
})
