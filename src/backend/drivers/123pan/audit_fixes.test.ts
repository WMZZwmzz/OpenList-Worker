import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { Pan123Driver } from "./driver"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("F-193: 并发调用的 subrequest 预算互不共享", async () => {
  const driver = new Pan123Driver({ username: "u", password: "p" } as any)
  const budgets: any[] = []
  ;(driver as any).resolveFolderId = async () => "0"
  ;(driver as any).client.getFiles = async (_id: string, opts: any) => {
    budgets.push(opts.budget)
    // 模拟分页请求期间的 await 交错
    await new Promise((r) => setTimeout(r, 10))
    opts.budget.used++
    return []
  }

  await Promise.all([driver.list("/", "/"), driver.list("/", "/")])

  assert.equal(budgets.length, 2)
  assert.notEqual(budgets[0], budgets[1], "每次调用必须拿到独立的预算对象")
  assert.equal(budgets[0].used, 1)
  assert.equal(budgets[1].used, 1, "并发调用不得互相 reset/累加")
})

test("F-194: 签名时间戳是纯 epoch 秒，日期串按 CST 整体滚动", async () => {
  const driver = new Pan123Driver({
    username: "u",
    password: "p",
    access_token: "t",
  } as any)
  let captured = ""
  globalThis.fetch = (async (input: any) => {
    captured = String(input)
    return jsonResponse({ code: 0, data: {} })
  }) as typeof fetch

  const before = Math.floor(Date.now() / 1000)
  await (driver as any).client.userInfo()
  const after = Math.floor(Date.now() / 1000)

  const m = captured.match(/=(\d+)-(\d+)-(\d+)$/)
  assert.ok(m, `签名参数不存在: ${captured}`)
  const ts = Number(m![1])
  // 旧实现是 epoch + 8h（28800 秒），这里必须落在当前时间附近
  assert.ok(
    ts >= before - 2 && ts <= after + 2,
    `timestamp 应是 epoch 秒，实际 ${ts}（now≈${before}）`,
  )
})

test("F-198: 非 JSON 的 5xx 抛出带状态码的错误，而不是裸 SyntaxError", async () => {
  const driver = new Pan123Driver({ username: "u", password: "p" } as any)
  globalThis.fetch = (async () =>
    new Response("<html>bad gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })) as typeof fetch

  await assert.rejects(
    () => (driver as any).client.userInfo(),
    (e: any) => e?.status === 502 && /HTTP 502/.test(e.message),
  )
})

test("F-198: HTTP 层 401（正文非 JSON）会触发一次重登录并重试", async () => {
  const driver = new Pan123Driver({ username: "u", password: "p" } as any)
  const calls: string[] = []
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    calls.push(url)
    if (calls.length === 1) {
      return new Response("<html>401</html>", { status: 401 })
    }
    if (url.includes("sign_in")) {
      return jsonResponse({ code: 200, data: { token: "fresh-token" } })
    }
    return jsonResponse({ code: 0, data: { id: 1 } })
  }) as typeof fetch

  const info = await (driver as any).client.userInfo()
  assert.equal(calls.length, 3, "401 → 登录 → 重试 共 3 次请求")
  assert.deepEqual(info, { id: 1 })
})

test("F-199: 顶层名为 rootId 的条目不再被当成存储根", async () => {
  const driver = new Pan123Driver({ username: "u", password: "p" } as any)
  ;(driver as any).client.getFiles = async (parentId: string) => {
    assert.equal(parentId, "0")
    return [
      {
        FileId: 99,
        FileName: "0",
        Type: 0,
        Size: 3,
        Etag: "e",
        S3KeyFlag: "k",
        UpdateAt: "2026-01-01T00:00:00Z",
      },
    ]
  }
  ;(driver as any).client.getDownloadLink = async () => "https://dl.example/x"

  const item = await driver.get("/0", "/0")
  assert.equal(item.name, "0")
  assert.equal(item.is_dir, false)
  assert.equal(item.sign, "99")
  assert.equal(item.raw_url, "https://dl.example/x")
})

test("F-199: 空物理路径仍是存储根", async () => {
  const driver = new Pan123Driver({ username: "u", password: "p" } as any)
  const item = await driver.get("/", "")
  assert.equal(item.is_dir, true)
  assert.equal(item.name, "0")
})
