import assert from "node:assert/strict"
import { test } from "node:test"
import { WebdavDriver } from "./driver"

/**
 * F-236：MOVE/COPY 收到持续 409 时原先会 `return this.move(...)` 无界递归——
 * 服务器一直回 409、MKCOL 正常时，每轮 2 个请求无限循环（实测 3000+ 请求），
 * 打爆 Workers 子请求配额 / 挂死 Node 请求。修复后只补建一次父目录，
 * 第二次仍是 409 直接抛错。
 */

type Call = { method: string; url: string }

function withMockFetch(
  calls: Call[],
  handler: (method: string, url: string) => Response,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input.url)
    const method = String(init.method || "GET").toUpperCase()
    calls.push({ method, url })
    return handler(method, url)
  }) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

function makeDriver() {
  // 构造不联网；不调用 init()
  return new WebdavDriver({
    address: "https://dav.example.com",
    username: "u",
    password: "p",
  })
}

test("F-236：持续 409 的 MOVE 只重试一次，不形成请求风暴", async () => {
  const calls: Call[] = []
  await withMockFetch(
    calls,
    (method) => new Response(null, { status: method === "MKCOL" ? 201 : 409 }),
    async () => {
      await assert.rejects(
        () => makeDriver().move("/d", "/d/dst", ["a.txt"], "/a.txt", "/d/dst/b.txt"),
        /WebDAV MOVE failed with status 409/,
        "持续 409 时必须抛错，而不是无限递归",
      )
    },
  )

  const moves = calls.filter((c) => c.method === "MOVE").length
  const mkcols = calls.filter((c) => c.method === "MKCOL").length
  assert.equal(moves, 2, `MOVE 至多重试一次（共 2 次），实际 ${moves}`)
  assert.equal(
    calls.length,
    3,
    `总请求数必须有界（2×MOVE + 1×MKCOL），实际 ${JSON.stringify(calls)}`,
  )
  assert.equal(mkcols, 1, "mkdired 父目录只补建一次")
})

test("F-236：持续 409 的 COPY 同样有界", async () => {
  const calls: Call[] = []
  await withMockFetch(
    calls,
    (method) => new Response(null, { status: method === "MKCOL" ? 201 : 409 }),
    async () => {
      await assert.rejects(
        () => makeDriver().copy("/d", "/d/dst", ["a.txt"], "/a.txt", "/d/dst/b.txt"),
        /WebDAV COPY failed with status 409/,
      )
    },
  )

  assert.equal(
    calls.filter((c) => c.method === "COPY").length,
    2,
    "COPY 至多重试一次",
  )
  assert.ok(
    calls.length <= 4,
    `请求数必须有界，实际 ${calls.length}：${JSON.stringify(calls)}`,
  )
})

test("F-236：409 → 补建父目录后成功（正常路径不受影响）", async () => {
  const calls: Call[] = []
  let moveCount = 0
  await withMockFetch(
    calls,
    (method) => {
      if (method === "MKCOL") return new Response(null, { status: 201 })
      if (method === "MOVE") {
        moveCount++
        return new Response(null, { status: moveCount === 1 ? 409 : 201 })
      }
      return new Response(null, { status: 200 })
    },
    async () => {
      await makeDriver().move(
        "/d",
        "/d/dst",
        ["a.txt"],
        "/a.txt",
        "/d/dst/b.txt",
      )
    },
  )

  assert.equal(
    calls.filter((c) => c.method === "MOVE").length,
    2,
    "首次 409 + 重试成功 = 2 次 MOVE",
  )
  assert.equal(calls.filter((c) => c.method === "MKCOL").length, 1)
})
