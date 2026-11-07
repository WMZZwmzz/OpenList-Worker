import assert from "node:assert/strict"
import { test } from "node:test"

import { QuarkDriver } from "./driver"

function stubRootClient() {
  const driver = new QuarkDriver({ cookie: "c" } as any)
  const listCalls: string[] = []
  ;(driver as any).client.getFiles = async (parentId: string) => {
    listCalls.push(parentId)
    if (parentId !== "0") return []
    return [
      { fid: "f-a", file_name: "a.txt", pdir_fid: "0", size: 5, file: true },
    ]
  }
  ;(driver as any).client.getDownloadUrl = async () => ({
    url: "https://dl.example/a.txt",
    headers: {},
  })
  return { driver, listCalls }
}

test("F-320: move/copy 请求体包含 action_type 与 exclude_fids", async () => {
  const { driver } = stubRootClient()
  const bodies: any[] = []
  ;(driver as any).client.request = async (_p: string, _m: string, _q: any, body: any) => {
    bodies.push(body)
    return {}
  }

  await (driver as any).client.move(["f-a"], "0")
  await (driver as any).client.copy(["f-a"], "0")

  assert.equal(bodies.length, 2)
  for (const body of bodies) {
    assert.equal(body.action_type, 1)
    assert.deepEqual(body.exclude_fids, [])
    assert.deepEqual(body.filelist, ["f-a"])
  }
})

test("F-321: remove 之后旧路径不再命中 pathFileIdCache", async () => {
  const { driver, listCalls } = stubRootClient()
  const removed: string[][] = []
  ;(driver as any).client.remove = async (ids: string[]) => {
    removed.push(ids)
  }

  await driver.remove("/", "/a.txt", ["a.txt"])
  assert.deepEqual(removed, [["f-a"]])
  const afterRemove = listCalls.length

  // 删除后同名路径重建：必须重新列目录，而不是命中已失效的缓存
  await driver.get("/", "/a.txt")
  assert.ok(
    listCalls.length > afterRemove,
    "旧路径的缓存条目应在 remove 后失效",
  )
})

test("F-323: unescapeHtml 单遍解码，实体字面量不被二次解码", async () => {
  const driver = new QuarkDriver({ cookie: "c" } as any)
  ;(driver as any).client.request = async () => ({
    data: {
      list: [
        { fid: "1", file_name: "&amp;lt;b&amp;gt;.txt", file: true },
        { fid: "2", file_name: "a&amp;b.mp4", file: true },
      ],
    },
    metadata: { total: 2 },
  })

  const files = await (driver as any).client.getFiles("0")
  assert.equal(files[0].file_name, "&lt;b&gt;.txt")
  assert.equal(files[1].file_name, "a&b.mp4")
})

test("F-324: init() 不再吞掉 /config 验证错误", async () => {
  const driver = new QuarkDriver({ cookie: "c" } as any)
  ;(driver as any).client.request = async () => {
    throw new Error("[Quark/UC] API error [401] /config: cookie expired")
  }
  await assert.rejects(() => driver.init(), /401/)
})

test("F-324: cookie 为空时 init() 直接失败", async () => {
  const driver = new QuarkDriver({ cookie: "" } as any)
  await assert.rejects(() => driver.init(), /Cookie is empty/)
})

test("F-322: 刷新后的 cookie 可通过 consumePendingCookie 交给 op 层持久化", async () => {
  const addition = { cookie: "c=1" } as any
  const driver = new QuarkDriver(addition)
  const client = (driver as any).client
  assert.equal(driver.consumePendingCookie(), null)

  // 模拟服务端 Set-Cookie 轮换 __puus 后触发的 onCookieUpdate
  ;(client as any).onCookieUpdate?.("c=1; __puus=new")
  assert.equal(driver.consumePendingCookie(), "c=1; __puus=new")
  assert.equal(driver.consumePendingCookie(), null, "取走后应清空")
  assert.equal(addition.cookie, "c=1; __puus=new")
})
