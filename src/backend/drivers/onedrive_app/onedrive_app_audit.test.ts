import assert from "node:assert/strict"
import { test } from "node:test"
import { OnedriveAPP } from "./driver"

/**
 * F-355（字符串布尔强转）与 F-313（分块大小对齐 320 KiB）在 onedrive_app
 * 上的同类回归。
 */

type Call = { method: string; url: string; headers: any }

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
      headers: init.headers,
    })
    return impl(url, init)
  }) as any
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test("F-355：字符串布尔配置不再被 !! 反转", () => {
  const driver = new OnedriveAPP({
    disable_disk_usage: "false" as any,
    enable_direct_upload: "false" as any,
    chunk_size: "20" as any,
  })
  assert.equal(driver.disable_disk_usage, false)
  assert.equal(driver.enable_direct_upload, false)
  assert.equal(driver.chunk_size, 20)

  const truthy = new OnedriveAPP({
    disable_disk_usage: "true" as any,
    enable_direct_upload: "1" as any,
  })
  assert.equal(truthy.disable_disk_usage, true)
  assert.equal(truthy.enable_direct_upload, true)
})

test("F-313：onedrive_app 分块同样对齐 320 KiB", async () => {
  const UNIT = 327680
  const calls: Call[] = []
  const driver = new OnedriveAPP({ chunk_size: 1 })
  driver.accessToken = "token"

  await withFetch(
    async (url, init) => {
      if (url.pathname.includes("createUploadSession")) {
        return Response.json({ uploadUrl: "https://upload.example/s" })
      }
      if (init.method === "PUT") return new Response(null, { status: 202 })
      return new Response("unexpected", { status: 500 })
    },
    calls,
    () => driver.put("/b", "/b/big.bin", Buffer.alloc(5 * 1024 * 1024)),
  )

  const puts = calls.filter((c) => c.method === "PUT")
  assert.ok(puts.length > 1)
  for (const put of puts) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      String(put.headers?.["Content-Range"] || ""),
    )
    assert.ok(m, "Content-Range 格式错误")
    const size = Number(m![2]) - Number(m![1]) + 1
    if (Number(m![2]) + 1 < Number(m![3])) {
      assert.equal(size % UNIT, 0, `非末块必须是 320KiB 倍数，实际 ${size}`)
    }
  }
})
