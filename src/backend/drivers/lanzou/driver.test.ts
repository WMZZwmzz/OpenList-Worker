import assert from "node:assert/strict"
import { test } from "node:test"

import { LanzouDriver } from "./driver"

function makeDriver() {
  const driver = new LanzouDriver({
    type: "cookie",
    cookie: "session=1",
    root_folder_id: "-1",
  } as any)
  const tree: Record<string, Array<any>> = {
    "-1": [
      { name: "a", fol_id: "f-a", is_folder: true },
      { name: "dest", fol_id: "f-dest", is_folder: true },
    ],
    "f-a": [{ name: "x.txt", id: "file-x" }],
    "f-dest": [],
  }
  const removed: Array<{ id: string; isDir: boolean }> = []
  const moves: Array<[string, string]> = []
  const client: any = (driver as any).client
  client.getFolders = async (id: string) => tree[id] ?? []
  client.getAllFiles = async (id: string) => tree[id] ?? []
  client.remove = async (id: string, isDir: boolean) => {
    removed.push({ id, isDir })
    delete tree[id]
  }
  client.move = async (fileId: string, targetFolderId: string) => {
    moves.push([fileId, targetFolderId])
  }
  return { driver, tree, client, removed, moves }
}

test("F-156: pathIdCache is invalidated after remove and mkdir", async () => {
  const { driver, tree, removed } = makeDriver()

  // 先访问 /a 让 resolveFolderId 写入缓存
  const items = await driver.list("", "/a")
  assert.deepEqual(items.map((i) => i.name), ["x.txt"])
  assert.equal((driver as any).pathIdCache.get("/a"), "f-a")

  await driver.remove("", "/a", ["a"])
  assert.deepEqual(removed, [{ id: "f-a", isDir: true }])
  assert.equal(
    (driver as any).pathIdCache.has("/a"),
    false,
    "stale fol_id must not survive a delete",
  )

  // 同名重建：新的 fol_id 必须生效（旧实现会命中已删除的 f-a）
  tree["-1"] = [{ name: "a", fol_id: "f-a2", is_folder: true }]
  const recreated = await driver.get("", "/a")
  assert.equal(recreated.sign, "f-a2")
})

test("F-157: move() resolves the target parent from dstPhysical, not dstDir", async () => {
  const { driver, moves } = makeDriver()

  // 虚拟路径含挂载前缀 /mount，物理路径不含；旧实现会去找名为 "mount" 的网盘文件夹
  await driver.move("", "/mount/dest", ["x.txt"], "/a/x.txt", "/dest/x.txt")

  assert.deepEqual(moves, [["file-x", "f-dest"]])
})

test("F-158: an unsafe share domain falls back instead of being fetched", async () => {
  const { client } = makeDriver()
  const requested: string[] = []
  client.request = async (url: string) => {
    requested.push(url)
    return '<iframe src="/fn?abc">x</iframe>'
  }

  // 元数据地址绝不能成为请求目标
  await assert.rejects(() =>
    client.getFilesByShareUrl(
      "abc123",
      "",
      '<iframe src="/fn?abc"></iframe>',
      "http://169.254.169.254",
    ),
  )
  assert.ok(requested.length > 0)
  for (const url of requested) {
    assert.ok(
      url.startsWith("https://pan.lanzoui.com"),
      `unsafe target requested: ${url}`,
    )
  }
})

test("F-159: doupload re-login is bounded to one retry", async () => {
  const { driver, client } = makeDriver()
  ;(driver as any).addition.type = "account"
  let logins = 0
  client.request = async () => '{"zt":9}'
  client.login = async () => {
    logins++
  }
  client.initVeiAndUid = async () => {}

  await assert.rejects(
    () => client.doupload({ task: "2" }),
    /已自动重新登录 1 次仍返回 zt=9/,
  )
  assert.equal(logins, 1, "must not re-login more than once")
})
