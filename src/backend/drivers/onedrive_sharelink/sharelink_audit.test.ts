import assert from "node:assert/strict"
import { test } from "node:test"
import { OnedriveSharelinkDriver } from "./driver"
import { OnedriveSharelinkApiClient } from "./util"

/**
 * F-459 / F-460 / F-461 回归。
 */

type Call = { url: string; body: any }

async function withFetch<T>(
  impl: (url: URL, init: any) => Promise<Response>,
  calls: Call[],
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url))
    calls.push({
      url: url.toString(),
      body: typeof init.body === "string" ? init.body : undefined,
    })
    return impl(url, init)
  }) as any
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

function row(name: string, isFolder = false) {
  return {
    FSObjType: isFolder ? "1" : "0",
    FileLeafRef: name,
    File_x0020_Size: isFolder ? "0" : "42",
    UniqueId: `id-${name}`,
    "Modified.": "2024-01-01T00:00:00Z",
    "@content.downloadUrl": `https://share.example/${name}`,
  }
}

function client(): OnedriveSharelinkApiClient {
  const c = new OnedriveSharelinkApiClient({
    url: "https://my-sharepoint.com/:f:/g/personal/user/test_link",
  })
  ;(c as any).finalUrl =
    "https://my-sharepoint.com/:f:/g/personal/user/test_link"
  return c
}

test("F-459：getFiles(folderPath) 把子目录传给 FolderServerRelativeUrl", async () => {
  const calls: Call[] = []
  const c = client()

  const items = await withFetch(
    async () => Response.json({ ListData: { Row: [row("a.txt")] } }),
    calls,
    () => c.getFiles("/Docs/Sub"),
  )

  assert.equal(items.length, 1)
  const body = JSON.parse(String(calls[0].body))
  assert.equal(
    body.parameters.FolderServerRelativeUrl,
    "/:f:/g/personal/user/test_link/Docs/Sub",
    `子目录必须拼进 FolderServerRelativeUrl，实际：${JSON.stringify(body)}`,
  )

  // 根目录不带该参数（保持分享根行为）
  calls.length = 0
  await withFetch(
    async () => Response.json({ ListData: { Row: [row("a.txt")] } }),
    calls,
    () => c.getFiles("/"),
  )
  const rootBody = JSON.parse(String(calls[0].body))
  assert.equal(rootBody.parameters.FolderServerRelativeUrl, undefined)
})

test("F-461：跟随 NextHref 聚合所有分页", async () => {
  const calls: Call[] = []
  const c = client()
  let round = 0

  const items = await withFetch(
    async () => {
      round++
      if (round === 1) {
        return Response.json({
          ListData: {
            Row: [row("p1.txt"), row("p2.txt")],
            NextHref: "next-page-2",
          },
        })
      }
      return Response.json({ ListData: { Row: [row("p3.txt")] } })
    },
    calls,
    () => c.getFiles("/"),
  )

  assert.equal(calls.length, 2, "应请求第二页")
  assert.equal(items.length, 3, `应聚合所有分页，实际 ${items.length}`)
  assert.deepEqual(
    items.map((i) => i.name),
    ["p1.txt", "p2.txt", "p3.txt"],
  )
  const second = JSON.parse(String(calls[1].body))
  assert.equal(second.parameters.NextHref, "next-page-2")
})

test("F-461：NextHref 重复时不会无限循环", async () => {
  let hits = 0
  const c = client()

  await withFetch(
    async () => {
      hits++
      return Response.json({
        ListData: { Row: [row("x.txt")], NextHref: "same-href" },
      })
    },
    [],
    () => c.getFiles("/"),
  )

  assert.ok(hits <= 100, `翻页次数应有上限，实际 ${hits}`)
})

test("F-460：get() 列出父目录再匹配，嵌套路径不再命中根目录同名文件", async () => {
  const driver: any = new OnedriveSharelinkDriver({
    url: "https://my-sharepoint.com/:f:/g/personal/user/test_link",
  })
  const listed: string[] = []
  ;(driver as any).client.finalUrl =
    "https://my-sharepoint.com/:f:/g/personal/user/test_link"
  driver.client.getFiles = async (folderPath: string) => {
    listed.push(folderPath)
    if (folderPath === "/Docs") {
      return [
        {
          id: "nested",
          name: "data.xlsx",
          size: 10,
          is_folder: false,
          modified: "2024-01-01T00:00:00Z",
          download_url: "https://share.example/nested",
        },
      ]
    }
    if (folderPath === "/") {
      return [
        {
          id: "root-same-name",
          name: "data.xlsx",
          size: 999,
          is_folder: false,
          modified: "2024-01-01T00:00:00Z",
          download_url: "https://share.example/root",
        },
      ]
    }
    return []
  }

  const item = await driver.get("/Docs/data.xlsx", "/Docs/data.xlsx")
  assert.deepEqual(listed, ["/Docs"], "应列出父目录而不是根目录")
  assert.equal(item.size, 10, "不得返回根目录同名文件的元数据")
  assert.equal(item.raw_url, "https://share.example/nested")
})
