import assert from "node:assert/strict"
import { test } from "node:test"
import { S3Driver } from "./driver"
import { S3Client, parseListObjectsV1, parseListObjectsV2 } from "./util"

type Call = { method: string; url: string }

function makeClient() {
  return new S3Client({
    bucket: "bkt",
    endpoint: "https://s3.example.com",
    access_key_id: "k",
    secret_access_key: "s",
    force_path_style: true,
  })
}

function withMock<T>(
  handler: (method: string, url: URL) => Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url))
    return handler(String(init.method || "GET").toUpperCase(), url)
  }) as any
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

const xml = (contents: string, extra = "") =>
  `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}${extra}</ListBucketResult>`

test("F-149：目录 marker 在递归列举时可被收集（files 仍不含它）", () => {
  const markers: string[] = []
  const result = parseListObjectsV1(
    xml("<Contents><Key>olddir/</Key><Size>0</Size></Contents>"),
    "olddir",
    "",
    true,
    markers,
  )
  assert.deepEqual(result.files, [])
  assert.deepEqual(markers, ["olddir/"])
  assert.equal(result.lastEvaluatedKey, "olddir/")
})

test("F-149：remove() 必须删除 marker-only 目录的 'dir/' 对象", async () => {
  const calls: Call[] = []
  const deleted: string[] = []
  const listXml = xml(`<Contents><Key>olddir/</Key><Size>0</Size></Contents>`)
  const driver = new S3Driver({
    bucket: "bkt",
    endpoint: "https://s3.example.com",
    access_key_id: "k",
    secret_access_key: "s",
    force_path_style: true,
  })

  await withMock(
    (method, url) => {
      calls.push({ method, url: url.toString() })
      if (method === "HEAD") return new Response(null, { status: 404 })
      if (method === "GET") {
        return new Response(listXml, {
          status: 200,
          headers: { "content-type": "application/xml" },
        })
      }
      if (method === "DELETE") {
        deleted.push(url.pathname)
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: 200 })
    },
    () => driver.remove("/olddir", "/olddir", ["olddir"]),
  )

  assert.ok(
    deleted.includes("/bkt/olddir/"),
    `必须 DELETE 目录 marker，实际: ${deleted.join(", ") || "(none)"}`,
  )
})

test("F-149：copyDirRecursive 在目标端重建 marker", async () => {
  const puts: string[] = []
  const listXml = xml(`<Contents><Key>src/empty/</Key><Size>0</Size></Contents>`)
  const driver = new S3Driver({
    bucket: "bkt",
    endpoint: "https://s3.example.com",
    access_key_id: "k",
    secret_access_key: "s",
    force_path_style: true,
  })

  await withMock(
    (method, url) => {
      if (method === "HEAD") return new Response(null, { status: 404 })
      if (method === "GET") {
        return new Response(listXml, {
          status: 200,
          headers: { "content-type": "application/xml" },
        })
      }
      if (method === "PUT") {
        puts.push(url.pathname)
        return new Response(null, { status: 200 })
      }
      return new Response(null, { status: 200 })
    },
    () => driver.copy("/src", "/dst", ["src"], "/src", "/dst"),
  )

  assert.ok(
    puts.includes("/bkt/dst/empty/"),
    `必须在目标端重建 marker，实际 PUT: ${puts.join(", ") || "(none)"}`,
  )
})

test("F-151：分页回退 marker 用未过滤的原始末条 key（含尾斜杠）", () => {
  const page = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
    <Contents><Key>dir/a.txt</Key><Size>1</Size></Contents>
    <CommonPrefixes><Prefix>dir/zfolder/</Prefix></CommonPrefixes>
  </ListBucketResult>`
  const v1 = parseListObjectsV1(page, "dir", "", false)
  assert.equal(v1.lastEvaluatedKey, "dir/zfolder/")
  const v2 = parseListObjectsV2(page, "dir", "", false)
  assert.equal(v2.lastEvaluatedKey, "dir/zfolder/")

  // 占位符被过滤也不能影响 marker
  const filtered = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
    <Contents><Key>dir/a.txt</Key><Size>1</Size></Contents>
    <Contents><Key>dir/.openlist</Key><Size>0</Size></Contents>
  </ListBucketResult>`
  assert.equal(
    parseListObjectsV1(filtered, "dir", "", false).lastEvaluatedKey,
    "dir/.openlist",
  )
})

test("F-151：服务端忽略 marker 时不无限循环", async () => {
  const client = makeClient()
  let listCalls = 0
  const truncated = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
    <Contents><Key>dir/m/</Key><Size>0</Size></Contents>
  </ListBucketResult>`
  await withMock(
    (method, url) => {
      if (method === "GET") {
        listCalls++
        // 永远返回同一页（模拟不支持 marker 的兼容服务）
        return new Response(truncated, {
          status: 200,
          headers: { "content-type": "application/xml" },
        })
      }
      return new Response(null, { status: 200 })
    },
    () => client.listObjects("dir", "v1", true),
  )
  assert.ok(listCalls <= 2, `marker 未前进时必须终止，实际请求 ${listCalls} 次`)
})

test("F-152：key 中已有的合法百分号转义必须再编码一层", () => {
  const client = makeClient()
  assert.equal(
    new URL(client.getUrl("a%2Fb.txt")).pathname,
    "/bkt/a%252Fb.txt",
    "a%2Fb.txt 不得寻址到 a/b.txt",
  )
  assert.equal(
    new URL(client.getUrl("100%.txt")).pathname,
    "/bkt/100%25.txt",
  )
  assert.equal(
    new URL(client.getUrl("a#b c.txt")).pathname,
    "/bkt/a%23b%20c.txt",
  )
})

test("F-150：无签名 custom_host 直链必须编码 key", async () => {
  const client = makeClient()
  const link = await client.getLink(
    "a#b?c d%.txt",
    "a#b?c d%.txt",
    4,
    "https://cdn.example.com",
    false,
  )
  const url = new URL(link.url)
  assert.equal(url.host, "cdn.example.com")
  assert.equal(url.hash, "")
  assert.equal(url.search, "")
  assert.equal(url.pathname, "/bkt/a%23b%3Fc%20d%25.txt")
})

test("F-153：XML 实体单遍解码（&amp;lt; 保持为字面 &lt;）", () => {
  const result = parseListObjectsV1(
    xml(
      `<Contents><Key>a&amp;lt;b.txt</Key><Size>1</Size></Contents>
       <Contents><Key>ok&amp;done.txt</Key><Size>1</Size></Contents>`,
    ),
    "",
    "",
    false,
  )
  const names = result.files.map((f) => f.name).sort()
  assert.deepEqual(names, ["a&lt;b.txt", "ok&done.txt"])
})

test("F-154：list() 不再逐个文件预签名 raw_url", async () => {
  const calls: Call[] = []
  const driver = new S3Driver({
    bucket: "bkt",
    endpoint: "https://s3.example.com",
    access_key_id: "k",
    secret_access_key: "s",
    force_path_style: true,
  })
  const listXml = xml(
    `<Contents><Key>f1.txt</Key><Size>1</Size></Contents>
     <Contents><Key>f2.txt</Key><Size>1</Size></Contents>`,
  )
  const items = await withMock(
    (method, url) => {
      calls.push({ method, url: url.toString() })
      return new Response(listXml, {
        status: 200,
        headers: { "content-type": "application/xml" },
      })
    },
    () => driver.list("/", "/"),
  )
  assert.equal(items.length, 2)
  assert.ok(
    items.every((i) => !i.raw_url),
    "list 结果不应携带 raw_url（链接按需在 get 时签发）",
  )
  assert.ok(
    calls.every((c) => !c.url.includes("X-Amz-Signature")),
    "list 过程中不得发生 SigV4 预签名",
  )
})
