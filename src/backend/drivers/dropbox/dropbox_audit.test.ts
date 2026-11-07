import assert from "node:assert/strict"
import { test } from "node:test"
import { DropboxDriver } from "./driver"
import { DropboxApiClient } from "./util"
import { DropboxAddition } from "./types"

/**
 * F-335 / F-336 / F-338 / F-339 / F-340 回归。
 */

type Call = { method: string; url: string; headers: any; body: any }

function baseAddition(extra: Partial<DropboxAddition> = {}): DropboxAddition {
  return {
    refresh_token: "refresh-token",
    access_token: "access-token",
    ...extra,
  }
}

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
      headers: init.headers || {},
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

function decodeArg(headers: any): any {
  // 头值必须是纯 ASCII 的 JSON（非 ASCII 字符以 \uXXXX 转义），
  // 解析后仍应还原出原始路径。
  const raw = headers?.["Dropbox-API-Arg"]
  assert.ok(raw, "应使用 Dropbox-API-Arg 头")
  assert.match(String(raw), /^[\x00-\x7f]*$/, "头值必须全为 ASCII")
  return JSON.parse(String(raw))
}

test("F-335：非 Latin-1 文件名的上传参数转义为 ASCII 头", async () => {
  const calls: Call[] = []
  const driver = new DropboxDriver(baseAddition())

  await withFetch(
    async () => Response.json({}),
    calls,
    () => driver.put("/文档/测试.txt", "/文档/测试.txt", Buffer.from("hi")),
  )

  const call = calls.find((c) => c.url.includes("/2/files/upload"))
  assert.ok(call, "应发出 /2/files/upload")
  for (const value of Object.values(call!.headers) as string[]) {
    assert.ok(
      /^[\x00-\xff]*$/.test(String(value)),
      `头部值必须是 ByteString：${value}`,
    )
  }
  assert.ok(
    !String(call!.headers["Dropbox-API-Arg"]).includes("文"),
    "原始非 ASCII 字符不得直接进入头值",
  )
  assert.equal(decodeArg(call!.headers).path, "/文档/测试.txt")
})

test("F-338：超过单次上传上限的文件走 upload_session 分片", async () => {
  const calls: Call[] = []
  const client = new DropboxApiClient(baseAddition())
  ;(client as any).singleUploadLimit = 10
  ;(client as any).sessionChunkSize = 10

  const content = Buffer.from("0123456789abcdefghij0123456789abc") // 35 bytes
  await withFetch(
    async (url) => {
      if (url.pathname.endsWith("/upload_session/start")) {
        return Response.json({ session_id: "s1" })
      }
      return Response.json({})
    },
    calls,
    () => client.upload("/big.bin", content),
  )

  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    [
      "/2/files/upload_session/start",
      "/2/files/upload_session/append_v2",
      "/2/files/upload_session/append_v2",
      "/2/files/upload_session/finish",
    ],
  )
  const starts = decodeArg(calls[0].headers)
  assert.equal(starts.close, false)
  assert.equal(decodeArg(calls[1].headers).cursor.offset, 10)
  assert.equal(decodeArg(calls[2].headers).cursor.offset, 20)
  const finish = decodeArg(calls[3].headers)
  assert.equal(finish.cursor.offset, 30)
  assert.equal(finish.cursor.session_id, "s1")
  assert.equal(finish.commit.path, "/big.bin")
  assert.equal(Buffer.from(calls[3].body).toString(), "abc")
})

test("F-338：小文件仍走单次上传", async () => {
  const calls: Call[] = []
  const client = new DropboxApiClient(baseAddition())
  await withFetch(
    async () => Response.json({}),
    calls,
    () => client.upload("/small.bin", Buffer.from("abc")),
  )
  assert.equal(new URL(calls[0].url).pathname, "/2/files/upload")
})

test("F-336：目录回退为 is_dir，其它错误原样上抛", async () => {
  const driver = new DropboxDriver(baseAddition())

  // path/not_file → 目录
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          error: { ".tag": "path", path: { ".tag": "not_file" } },
          error_summary: "path/not_file/",
        }),
        { status: 409 },
      ),
    [],
    async () => {
      const item = await driver.get("/Docs", "/Docs")
      assert.equal(item.is_dir, true)
    },
  )

  // path/not_found → 抛 not found
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          error: { ".tag": "path", path: { ".tag": "not_found" } },
          error_summary: "path/not_found/",
        }),
        { status: 409 },
      ),
    [],
    async () => {
      await assert.rejects(
        () => driver.get("/missing.txt", "/missing.txt"),
        /not found/,
      )
    },
  )

  // 5xx → 原样上抛（不再伪装成目录）
  await withFetch(
    async () => new Response("boom", { status: 503 }),
    [],
    async () => {
      await assert.rejects(
        () => driver.get("/x.txt", "/x.txt"),
        /503/,
      )
    },
  )
})

test("F-339：get() 使用 get_temporary_link 响应里的 metadata", async () => {
  const driver = new DropboxDriver(baseAddition())

  const item = await withFetch(
    async (_url, init) => {
      const body = JSON.parse(String(init.body || "{}"))
      assert.equal(body.path, "/data.bin")
      return Response.json({
        link: "https://content.example/tmp",
        metadata: {
          ".tag": "file",
          id: "id-1",
          name: "data.bin",
          size: 4321,
          server_modified: "2024-02-03T04:05:06Z",
        },
      })
    },
    [],
    () => driver.get("/data.bin", "/data.bin"),
  )

  assert.equal(item.size, 4321)
  assert.equal(item.modified, "2024-02-03T04:05:06Z")
  assert.equal(item.raw_url, "https://content.example/tmp")
  assert.equal(item.is_dir, false)
})

test("F-340：api_url_address 指向内网时拒绝刷新", async () => {
  const calls: Call[] = []
  const client = new DropboxApiClient(
    baseAddition({
      use_online_api: true,
      api_url_address: "http://127.0.0.1:8080/renew",
    }),
  )

  await withFetch(
    async () => Response.json({ access_token: "a", refresh_token: "r" }),
    calls,
    async () => {
      await assert.rejects(
        () => client.refreshToken(),
        /SSRF protection/,
      )
    },
  )
  assert.equal(calls.length, 0, "不安全地址不应发出任何请求")
})
