import assert from "node:assert/strict"
import { test } from "node:test"
import { Onedrive } from "./driver"
import { OnedriveAPP } from "../onedrive_app/driver"

/**
 * F-310 / F-311 / F-353 / F-354 回归：
 *  - Graph copy 返回 202 Accepted + 空响应体，requestApi 不得再对它调 res.json()
 *  - 大文件分块上传必须校验每个分块 PUT 的响应，失败时抛错而不是静默成功
 */

type Call = { method: string; url: string; range?: string }

async function withFetch<T>(
  impl: (url: string, init: any) => Promise<Response>,
  calls: Call[],
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url))
    const method = String(init.method || "GET").toUpperCase()
    calls.push({
      method,
      url: url.toString(),
      range: init.headers?.["Content-Range"],
    })
    return impl(url.toString(), { ...init, method })
  }) as any
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test("F-310：OneDrive copy() 在 202 空响应体下正常返回", async () => {
  const calls: Call[] = []
  const driver = new Onedrive({
    email: "u@example.com",
    chunk_size: 5,
  } as any)

  await withFetch(
    async (url, init) => {
      if (init.method === "POST" && url.includes(":/copy")) {
        return new Response(null, {
          status: 202,
          headers: { Location: "https://graph.microsoft.com/monitor/1" },
        })
      }
      return Response.json({ id: "dst-id", parentReference: { driveId: "d1" } })
    },
    calls,
    () => driver.copy("/d", "/d/bak", ["a.txt"], "/d/a.txt", "/d/bak/a.txt"),
  )

  const post = calls.find((c) => c.method === "POST")
  assert.ok(post, "应发出 copy POST")
  assert.ok(post!.url.includes(":/copy"))
})

test("F-311：OneDrive put() 分块失败时抛错（不再静默成功）", async () => {
  const calls: Call[] = []
  const driver = new Onedrive({ chunk_size: 5 })

  await withFetch(
    async (url, init) => {
      if (url.includes("createUploadSession")) {
        return Response.json({ uploadUrl: "https://upload.example/s" })
      }
      if (init.method === "PUT") {
        return new Response("range error", { status: 416 })
      }
      return new Response("unexpected", { status: 500 })
    },
    calls,
    async () => {
      await assert.rejects(
        () => driver.put("/b", "/b/big.bin", Buffer.alloc(6 * 1024 * 1024)),
        /chunk upload failed: HTTP 416/,
      )
    },
  )

  const puts = calls.filter((c) => c.method === "PUT")
  assert.equal(puts.length, 1, "416 不可重试，应只尝试一次")
  assert.equal(puts[0].range, `bytes 0-${5 * 1024 * 1024 - 1}/${6 * 1024 * 1024}`)
})

test("F-311：OneDrive put() 对 5xx 分块做有限重试，全部失败则抛错", async () => {
  const calls: Call[] = []
  const driver = new Onedrive({ chunk_size: 5 })
  const content = Buffer.alloc(5 * 1024 * 1024 + 1)

  await withFetch(
    async (url, init) => {
      if (url.includes("createUploadSession")) {
        return Response.json({ uploadUrl: "https://upload.example/s" })
      }
      return new Response("boom", { status: 503 })
    },
    calls,
    async () => {
      await assert.rejects(
        () => driver.put("/b", "/b/big.bin", content),
        /chunk upload failed: HTTP 503/,
      )
    },
  )

  const puts = calls.filter((c) => c.method === "PUT")
  assert.equal(puts.length, 3, "503 应重试 3 次")
})

test("F-353：OneDriveAPP copy() 在 202 空响应体下正常返回", async () => {
  const calls: Call[] = []
  const driver = new OnedriveAPP({
    email: "u@example.com",
    chunk_size: 5,
  })

  await withFetch(
    async (url, init) => {
      if (init.method === "POST" && url.includes(":/copy")) {
        return new Response(null, {
          status: 202,
          headers: { Location: "https://graph.microsoft.com/monitor/1" },
        })
      }
      return Response.json({ id: "dst-id", parentReference: { driveId: "d1" } })
    },
    calls,
    () => driver.copy("/d", "/d/bak", ["a.txt"], "/d/a.txt", "/d/bak/a.txt"),
  )

  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes(":/copy")))
})

test("F-354：OneDriveAPP put() 分块失败时抛错（不再静默成功）", async () => {
  const calls: Call[] = []
  const driver = new OnedriveAPP({ chunk_size: 5 })

  await withFetch(
    async (url, init) => {
      if (url.includes("createUploadSession")) {
        return Response.json({ uploadUrl: "https://upload.example/s" })
      }
      return new Response("denied", { status: 403 })
    },
    calls,
    async () => {
      await assert.rejects(
        () => driver.put("/b", "/b/big.bin", Buffer.alloc(6 * 1024 * 1024)),
        /chunk upload failed: HTTP 403/,
      )
    },
  )

  assert.equal(
    calls.filter((c) => c.method === "PUT").length,
    1,
    "403 不可重试",
  )
})
