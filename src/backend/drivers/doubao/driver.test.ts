import test from "node:test"
import assert from "node:assert/strict"
import { DriverDoubao } from "./driver"

interface Tree {
  [id: string]: any[]
}

function makeDriver(tree: Tree) {
  const driver = new DriverDoubao({ cookie: "mock_cookie" })
  const calls: any[][] = []
  ;(driver as any).client = {
    getFiles: async (id: string) => tree[id] || [],
    rename: async (id: string, name: string) => calls.push(["rename", id, name]),
    remove: async (id: string) => calls.push(["remove", id]),
    move: async (id: string, fromPid: string, toPid: string) =>
      calls.push(["move", id, fromPid, toPid]),
    getDownloadUrl: async (f: any) => `https://dl/${f.id}`,
    downloadHeaders: () => ({ "User-Agent": "ua" }),
  }
  return { driver, calls }
}

const dir = (id: string, name: string) => ({
  id,
  name,
  node_type: 1,
  size: 0,
  parent_id: "0",
})
const file = (id: string, name: string) => ({
  id,
  name,
  node_type: 2,
  size: 10,
  parent_id: "0",
})

test("F-447: rename/remove 可作用于文件（resolveEntry 同时匹配目录与文件）", async () => {
  const tree: Tree = {
    "0": [file("f1", "file.txt"), dir("d1", "dir")],
  }
  const { driver, calls } = makeDriver(tree)

  await driver.rename("", "/file.txt", "renamed.txt")
  await driver.remove("", "/file.txt", ["file.txt"])
  await driver.rename("", "/dir", "newdir")
  await driver.remove("", "/dir", ["dir"])

  assert.deepEqual(calls, [
    ["rename", "f1", "renamed.txt"],
    ["remove", "f1"],
    ["rename", "d1", "newdir"],
    ["remove", "d1"],
  ])
})

test("F-452: get() 对不存在路径抛 not found 而不是合成假文件", async () => {
  const { driver } = makeDriver({ "0": [] })
  await assert.rejects(
    () => driver.get("", "/missing.txt"),
    /Directory 'missing.txt' not found/,
  )
})

test("F-467 同类: move 目标父目录取自物理 dstPhysical（虚拟 dstDir 被忽略）", async () => {
  // mount_path=/kb 时虚拟目录 /kb/dst 的物理路径为 /dst
  const tree: Tree = {
    "0": [file("f1", "a.txt"), dir("d2", "dst")],
  }
  const { driver, calls } = makeDriver(tree)
  await driver.move("/kb", "/kb/dst", ["a.txt"], "/a.txt", "/dst/a.txt")
  assert.deepEqual(calls, [["move", "f1", "0", "d2"]])
})

test("F-452: get() 不再吞掉 API/鉴权异常", async () => {
  const { driver } = makeDriver({})
  ;(driver as any).client.getFiles = async () => {
    throw new Error("[Doubao] cookie expired")
  }
  await assert.rejects(() => driver.get("", "/file.txt"), /cookie expired/)
})

test("F-452: get() 对真实文件返回下载链接", async () => {
  const { driver } = makeDriver({ "0": [file("f9", "file.txt")] })
  const item = await driver.get("", "/file.txt")
  assert.equal(item.is_dir, false)
  assert.equal(item.raw_url, "https://dl/f9")
})
