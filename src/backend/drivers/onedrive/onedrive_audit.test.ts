import assert from "node:assert/strict"
import { test } from "node:test"
import { Onedrive } from "./driver"
import { chunkSizeBytes, refreshToken, refreshTokenOnce } from "./util"

/**
 * F-312 / F-313 / F-314 / F-315 / F-316 / F-317 / F-318 回归。
 */

type Call = { method: string; url: string; body?: string; headers?: any }

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
      body: typeof init.body === "string" ? init.body : undefined,
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

test("F-312：getMetaUrl 与 buildUrl 一致，不再对段做 decodeURIComponent", async () => {
  const calls: Call[] = []
  const driver = new Onedrive({})

  await withFetch(
    async () => new Response("{}", { status: 200 }),
    calls,
    () => driver.rename("/d", "/d/100%.txt/b%20c", "new.txt"),
  )

  const patch = calls.find((c) => c.method === "PATCH")
  assert.ok(patch, "应发出 PATCH")
  // 字面名 b%20c 必须编码成 b%2520c（Graph 解码后得到字面 b%20c）。
  // 旧实现 decodeURIComponent 后再编码会得到 b%20c，指向另一个对象。
  assert.ok(
    patch!.url.includes("/100%25.txt/b%2520c"),
    `URL 段应为字面名编码，实际：${patch!.url}`,
  )
  assert.ok(!patch!.url.includes("/b%20c"), "不得出现被二次解码的 b%20c")
})

test("F-313：chunk_size 取整到 320 KiB 的倍数", async () => {
  const UNIT = 327680
  assert.equal(chunkSizeBytes(5) % UNIT, 0)
  assert.equal(chunkSizeBytes(1) % UNIT, 0)
  assert.equal(chunkSizeBytes(3) % UNIT, 0)
  assert.equal(chunkSizeBytes(10) % UNIT, 0)

  const calls: Call[] = []
  const driver = new Onedrive({ chunk_size: 1 })
  const content = Buffer.alloc(5 * 1024 * 1024)

  await withFetch(
    async (url, init) => {
      if (url.pathname.includes("createUploadSession")) {
        return Response.json({ uploadUrl: "https://upload.example/s" })
      }
      if (init.method === "PUT") return new Response(null, { status: 202 })
      return new Response("unexpected", { status: 500 })
    },
    calls,
    () => driver.put("/b", "/b/big.bin", content),
  )

  const puts = calls.filter((c) => c.method === "PUT")
  assert.ok(puts.length > 1, "2MiB 应按对齐后的块大小分多次上传")
  for (const put of puts) {
    const range = String(put.headers?.["Content-Range"] || "")
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
    assert.ok(m, `Content-Range 格式错误：${range}`)
    const start = Number(m![1])
    const end = Number(m![2])
    const size = end - start + 1
    if (end + 1 < Number(m![3])) {
      assert.equal(size % UNIT, 0, `非末块必须为 320KiB 倍数，实际 ${size}`)
    }
  }
})

test("F-314：字符串布尔配置不再被 !! 反转", async () => {
  const driver = new Onedrive({
    is_sharepoint: "false" as any,
    use_online_api: "false" as any,
    disable_disk_usage: "false" as any,
    enable_direct_upload: "false" as any,
  })
  assert.equal(driver.is_sharepoint, false)
  assert.equal(driver.use_online_api, false)
  assert.equal(driver.disable_disk_usage, false)
  assert.equal(driver.enable_direct_upload, false)

  const truthy = new Onedrive({
    is_sharepoint: "true" as any,
    enable_direct_upload: 1 as any,
  })
  assert.equal(truthy.is_sharepoint, true)
  assert.equal(truthy.enable_direct_upload, true)
})

test("F-315：并发 401 触发的刷新只执行一次（singleflight）", async () => {
  const calls: Call[] = []
  const target: any = {
    refresh_token: "r0",
    use_online_api: true,
    api_url_address: "https://api.oplist.org/onedrive/renewapi",
  }

  await withFetch(
    async () => {
      await new Promise((r) => setTimeout(r, 5))
      return Response.json({ access_token: "a1", refresh_token: "r1" })
    },
    calls,
    async () => {
      await Promise.all([
        refreshTokenOnce(target),
        refreshTokenOnce(target),
        refreshTokenOnce(target),
      ])
    },
  )

  assert.equal(calls.length, 1, `并发刷新应只发一次请求，实际 ${calls.length}`)
  assert.equal(target.refresh_token, "r1")
  assert.equal(target.accessToken, "a1")

  // 刷新完成后新的调用可以再次刷新
  await withFetch(
    async () => Response.json({ access_token: "a2", refresh_token: "r2" }),
    calls,
    () => refreshTokenOnce(target),
  )
  assert.equal(calls.length, 2)
  assert.equal(target.refresh_token, "r2")
})

test("F-316：refresh_token 优先走 POST 表单体，不出现在 URL 查询串", async () => {
  const calls: Call[] = []
  const target: any = {
    refresh_token: "SECRET_REFRESH",
    use_online_api: true,
    api_url_address: "https://api.oplist.org/onedrive/renewapi",
  }

  await withFetch(
    async () => Response.json({ access_token: "a1", refresh_token: "r1" }),
    calls,
    () => refreshToken(target),
  )

  assert.equal(calls.length, 1, "上游支持 POST 时不应再发 GET 回退")
  const call = calls[0]
  assert.equal(call.method, "POST")
  assert.equal(
    new URL(call.url).search,
    "",
    `URL 不得携带 refresh_token 查询串，实际：${call.url}`,
  )
  assert.ok(
    String(call.body || "").includes("refresh_ui=SECRET_REFRESH"),
    "refresh_token 应放在表单体里",
  )
})

test("F-316：上游不支持 POST 时回退到 GET（保证刷新不中断）", async () => {
  const calls: Call[] = []
  const target: any = {
    refresh_token: "SECRET_REFRESH",
    use_online_api: true,
    api_url_address: "https://api.oplist.org/onedrive/renewapi",
  }

  await withFetch(
    async (_url, init) => {
      if (String(init.method).toUpperCase() === "POST") {
        return new Response("Method Not Allowed", { status: 405 })
      }
      return Response.json({ access_token: "a1", refresh_token: "r1" })
    },
    calls,
    () => refreshToken(target),
  )

  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, "POST")
  assert.equal(calls[1].method, "GET")
  assert.equal(target.refresh_token, "r1")
})

test("F-318：本地 OAuth 刷新透出 error_description 与状态码", async () => {
  const target: any = {
    refresh_token: "r0",
    use_online_api: false,
    client_id: "cid",
    client_secret: "csecret",
    redirect_uri: "https://example/cb",
    region: "global",
  }

  await withFetch(
    async () =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: "AADSTS70000: The grant is expired",
        },
        { status: 400 },
      ),
    [],
    async () => {
      await assert.rejects(
        () => refreshToken(target),
        (e: any) =>
          /HTTP 400/.test(e.message) &&
          /invalid_grant/.test(e.message) &&
          /AADSTS70000/.test(e.message),
      )
    },
  )

  // 非 JSON（HTML 错误页）同样带出状态码
  await withFetch(
    async () => new Response("<html>nope</html>", { status: 502 }),
    [],
    async () => {
      await assert.rejects(
        () => refreshToken(target),
        (e: any) => /HTTP 502/.test(e.message),
      )
    },
  )
})

test("F-317：enable_direct_upload 时才能真正签发直传凭证", async () => {
  const disabled = new Onedrive({ enable_direct_upload: false })
  await assert.rejects(
    () => disabled.getDirectUploadInfo("/dir", "a.bin"),
    /Direct upload is not enabled/,
  )

  const calls: Call[] = []
  const enabled = new Onedrive({ enable_direct_upload: true, chunk_size: 5 })
  const info = await withFetch(
    async () => Response.json({ uploadUrl: "https://upload.example/s" }),
    calls,
    () => enabled.getDirectUploadInfo("/dir", "a.bin"),
  )

  const post = calls.find((c) => c.method === "POST")
  assert.ok(post, "应发出 createUploadSession POST")
  assert.ok(
    post!.url.includes("/root:/dir/a.bin:/createUploadSession"),
    `直传会话应指向目标文件而不是目录，实际：${post!.url}`,
  )
  assert.equal(info.UploadURL, "https://upload.example/s")
  assert.equal(info.ChunkSize % 327680, 0)
})
