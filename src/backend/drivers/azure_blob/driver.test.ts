import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { AzureBlobDriver } from "./driver"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function blobXml(names: string[]): string {
  const blobs = names
    .map(
      (n) =>
        `<Blob><Name>${n}</Name><Content-Length>1</Content-Length><Last-Modified>Fri, 02 Jan 2026 10:30:00 GMT</Last-Modified></Blob>`,
    )
    .join("")
  return `<?xml version="1.0"?><EnumerationResults><Blobs>${blobs}</Blobs><NextMarker /></EnumerationResults>`
}

type Call = { method: string; url: URL; headers: Record<string, string> }

function installFetch(handler?: (call: Call) => Response | null) {
  const calls: Call[] = []
  globalThis.fetch = (async (input: any, init: any) => {
    const url = new URL(String(input))
    const call: Call = {
      method: (init?.method || "GET").toUpperCase(),
      url,
      headers: (init?.headers || {}) as Record<string, string>,
    }
    calls.push(call)
    const custom = handler?.(call)
    if (custom) return custom
    if (call.method === "HEAD") return new Response("", { status: 200 })
    if (call.method === "GET" && url.searchParams.get("comp") === "list") {
      const prefix = url.searchParams.get("prefix") || ""
      if (prefix === "dir/") {
        return new Response(
          blobXml(["dir/", "dir/a.txt", "dir/sub/", "dir/sub/b.txt"]),
          { status: 200 },
        )
      }
      return new Response(blobXml(["dir/"]), { status: 200 })
    }
    if (call.method === "PUT") return new Response("", { status: 201 })
    if (call.method === "DELETE") return new Response("", { status: 202 })
    return new Response("", { status: 200 })
  }) as typeof fetch
  return calls
}

function makeDriver() {
  return new AzureBlobDriver({
    endpoint: "https://acct.blob.core.windows.net",
    container_name: "cont",
    access_key: Buffer.from("secret-key").toString("base64"),
  } as any)
}

test("F-454: 列表对 blob 名做 XML 实体反转义", async () => {
  installFetch(
    () =>
      new Response(
        `<?xml version="1.0"?><EnumerationResults><Blobs>` +
          `<Blob><Name>A&amp;B&amp;lt;.mp4</Name><Content-Length>9</Content-Length></Blob>` +
          `</Blobs><BlobPrefix><Name>dir&amp;x/</Name></BlobPrefix></EnumerationResults>`,
        { status: 200 },
      ),
  )

  const items = await makeDriver().list("/", "/")
  const file = items.find((i) => !i.is_dir)
  const dir = items.find((i) => i.is_dir)
  assert.equal(file?.name, "A&B&lt;.mp4")
  assert.equal(file?.sign, "A&B&lt;.mp4")
  assert.equal(dir?.name, "dir&x")
})

test("F-455: blob 名含 ? / # 时 SAS URL 做百分号编码", async () => {
  installFetch()
  const driver = makeDriver()

  const q = await driver.get("/a?b.txt", "/a?b.txt")
  assert.match(String(q.raw_url), /\/a%3Fb\.txt\?sp=r&/)
  const h = await driver.get("/a#b.txt", "/a#b.txt")
  assert.match(String(h.raw_url), /\/a%23b\.txt\?sp=r&/)
})

test("F-451: 目录 remove 递归删除全部子 blob（不是只删标记 blob）", async () => {
  const calls = installFetch()
  const driver = makeDriver()

  await driver.remove("/", "/dir", ["dir"])

  const deleted = calls
    .filter((c) => c.method === "DELETE")
    .map((c) => decodeURIComponent(c.url.pathname).replace("/cont/", ""))
  assert.deepEqual(deleted.sort(), [
    "dir/",
    "dir/a.txt",
    "dir/sub/",
    "dir/sub/b.txt",
  ])
})

test("F-451: 目录 move 递归复制到新前缀后再递归删除源", async () => {
  const calls = installFetch()
  const driver = makeDriver()

  await driver.move("/", "/", ["dir"], "/dir", "/new")

  const copied = calls
    .filter((c) => c.method === "PUT")
    .map((c) => decodeURIComponent(c.url.pathname).replace("/cont/", ""))
  assert.deepEqual(copied.sort(), [
    "new/",
    "new/a.txt",
    "new/sub/",
    "new/sub/b.txt",
  ])
  const deleted = calls
    .filter((c) => c.method === "DELETE")
    .map((c) => decodeURIComponent(c.url.pathname).replace("/cont/", ""))
  assert.equal(deleted.length, 4)
})

test("F-451: 普通文件的 remove 仍然只删该 blob", async () => {
  const calls = installFetch((call) =>
    call.method === "HEAD" ? new Response("", { status: 404 }) : null,
  )
  // 文件没有 <key>/ 标记，也没有子对象
  const driver = makeDriver()
  const originalList = (driver as any).listBlobNames.bind(driver)
  ;(driver as any).listBlobNames = async (prefix: string) =>
    prefix ? [] : originalList(prefix)

  await driver.remove("/", "/one.txt", ["one.txt"])

  const deleted = calls
    .filter((c) => c.method === "DELETE")
    .map((c) => decodeURIComponent(c.url.pathname).replace("/cont/", ""))
  assert.deepEqual(deleted, ["one.txt"])
})
