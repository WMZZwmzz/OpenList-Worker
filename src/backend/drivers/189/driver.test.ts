import assert from "node:assert/strict"
import { test } from "node:test"

import { Cloud189Driver } from "./driver"

function makeDriver() {
  const driver = new Cloud189Driver({
    username: "u",
    password: "p",
    root_folder_id: "-11",
  } as any)
  const tree: Record<string, { files: any[]; folders: any[] }> = {
    "-11": {
      files: [],
      folders: [
        { id: 111, name: "a" },
        { id: 222, name: "-11" },
      ],
    },
    "111": { files: [{ id: 333, name: "x.txt", size: 4 }], folders: [] },
    "222": { files: [], folders: [{ id: 444, name: "inner" }] },
  }
  const budgets: any[] = []
  const client: any = (driver as any).client
  client.getFiles = async (
    folderId: string,
    options?: { budget?: { used: number; limit: number } },
  ) => {
    if (options?.budget) budgets.push(options.budget)
    return tree[folderId] ?? { files: [], folders: [] }
  }
  client.mkdir = async () => {}
  client.rename = async () => {}
  client.remove = async () => {}
  client.move = async () => {}
  client.copy = async () => {}
  client.getDownloadUrl = async () => "https://down.test/x"
  client.getDownloadHeaders = () => ({})
  client.getRootId = () => "-11"
  return { driver, client, tree, budgets }
}

test("F-139: a real folder named like root_folder_id is still accessible", async () => {
  const { driver } = makeDriver()

  // 旧实现会把 /-11 当成存储根，返回根目录内容
  const items = await driver.list("", "/-11")
  assert.deepEqual(items.map((i) => i.name), ["inner"])

  const folder = await driver.get("", "/-11")
  assert.equal(folder.name, "-11")
  assert.equal(folder.is_dir, true)
  assert.equal(folder.sign, "222")
})

test("F-136: pathIdCache entries are dropped after remove and rename", async () => {
  const { driver, tree } = makeDriver()

  await driver.list("", "/a")
  assert.equal((driver as any).pathIdCache.get("/a"), "111")

  // 删除后同名重建：新 ID 必须被解析到
  await driver.remove("", "/a", ["a"])
  assert.equal((driver as any).pathIdCache.has("/a"), false)

  tree["-11"].folders = [{ id: 555, name: "a" }]
  tree["555"] = { files: [{ id: 556, name: "y.txt", size: 1 }], folders: [] }
  const items = await driver.list("", "/a")
  assert.deepEqual(items.map((i) => i.name), ["y.txt"])

  // 目录改名后旧路径的缓存必须失效
  await driver.rename("", "/a", "b")
  assert.equal((driver as any).pathIdCache.has("/a"), false)
})

test("F-137: every operation gets its own subrequest budget object", async () => {
  const { driver, budgets } = makeDriver()

  await Promise.all([driver.list("", "/"), driver.list("", "/")])

  assert.equal(budgets.length, 2)
  assert.notEqual(budgets[0], budgets[1], "budget must not be shared across calls")
  // 每个请求的预算都应从 0 开始（若共享，第二个请求会覆盖第一个的计数）
  assert.ok((driver as any).budget === undefined)
})
