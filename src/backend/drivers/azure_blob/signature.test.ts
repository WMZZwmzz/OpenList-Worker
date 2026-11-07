import assert from "node:assert/strict"
import { test } from "node:test"
import { createHmac } from "node:crypto"
import { AzureBlobDriver } from "./driver"

/**
 * F-444 / F-445 回归：SharedKey canonicalizedResource 必须包含 container 段、
 * query 先 URL 解码；零长度请求的 Content-Length 必须签为空串；
 * 服务 SAS（sv=2021-08-06）string-to-sign 必须是 16 字段布局。
 */

const ENDPOINT = "https://myaccount.blob.core.windows.net"
const ACCESS_KEY = Buffer.from("test-secret-key").toString("base64")
const DATE = "Wed, 01 Jan 2026 00:00:00 GMT"

function makeDriver(): AzureBlobDriver {
  return new AzureBlobDriver({
    endpoint: ENDPOINT,
    access_key: ACCESS_KEY,
    container_name: "mycontainer",
  })
}

function sign(stringToSign: string): string {
  return createHmac("sha256", Buffer.from(ACCESS_KEY, "base64"))
    .update(stringToSign, "utf8")
    .digest("base64")
}

function withFetch(
  calls: Array<{ url: string; headers: Record<string, string> }>,
  status = 201,
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({ url: String(input), headers: init.headers || {} })
    return new Response(null, { status })
  }) as any
  return () => {
    globalThis.fetch = original
  }
}

test("F-444：SharedKey 签名包含 container、query 已解码、零 Content-Length 为空串", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const restore = withFetch(calls)
  try {
    const driver = makeDriver()

    // 零字节 PUT（mkdir/rename/move/copy 的形态）
    await (driver as any).request("PUT", "dir/", "", {
      body: new Uint8Array(0),
      contentType: "application/octet-stream",
      extraHeaders: {
        "x-ms-blob-type": "BlockBlob",
        "x-ms-date": DATE,
      },
    })
    const put = calls[0]
    assert.equal(put.url, `${ENDPOINT}/mycontainer/dir/`)
    assert.equal(put.headers["Content-Length"], undefined)
    const expectedPut = sign(
      "PUT\n\n\n\n\napplication/octet-stream\n\n\n\n\n\n\n" +
        `x-ms-blob-type:BlockBlob\nx-ms-date:${DATE}\nx-ms-version:2021-08-06\n` +
        "/myaccount/mycontainer/dir/",
    )
    assert.equal(
      put.headers.Authorization,
      `SharedKey myaccount:${expectedPut}`,
      "Content-Length 为 0 时必须签成空串，且资源串必须含 container",
    )

    // 容器级 list：query 必须解码（delimiter=%2F → delimiter:/）
    await (driver as any).request(
      "GET",
      "",
      "restype=container&comp=list&delimiter=%2F&prefix=docs%2F",
      { extraHeaders: { "x-ms-date": DATE } },
    )
    const list = calls[1]
    assert.equal(
      list.url,
      `${ENDPOINT}/mycontainer?restype=container&comp=list&delimiter=%2F&prefix=docs%2F`,
    )
    const expectedList = sign(
      "GET\n\n\n\n\n\n\n\n\n\n\n\n" +
        `x-ms-date:${DATE}\nx-ms-version:2021-08-06\n` +
        "/myaccount/mycontainer\ncomp:list\ndelimiter:/\nprefix:docs/\nrestype:container",
    )
    assert.equal(
      list.headers.Authorization,
      `SharedKey myaccount:${expectedList}`,
    )
  } finally {
    restore()
  }
})

test("F-445：服务 SAS 使用 16 字段 string-to-sign（sv=2021-08-06）", async () => {
  const driver = makeDriver()
  const item = await driver.get("/a b.mp4", "/a b.mp4")
  const url = new URL(item.raw_url!)
  const se = url.searchParams.get("se")!
  const sig = url.searchParams.get("sig")!
  assert.equal(url.pathname, "/mycontainer/a%20b.mp4", "URL 路径需编码")

  const stringToSign =
    `r\n\n${se}\n` +
    "/blob/myaccount/mycontainer/a b.mp4\n" +
    "\n\n\n2021-08-06\n" +
    "b\n\n\n\n\n\n\n"
  assert.equal(stringToSign.split("\n").length, 16)
  assert.equal(sig, sign(stringToSign))
})
