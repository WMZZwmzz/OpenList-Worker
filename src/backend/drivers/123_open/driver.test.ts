import test from "node:test"
import assert from "node:assert/strict"
import { Driver123Open } from "./driver"
import { File123 } from "./types"

interface Harness {
  driver: Driver123Open
  tree: Record<string, File123[]>
  ids: string[]
  moves: [number, string][]
}

function makeDriver(
  tree: Record<string, File123[]>,
  addition: Record<string, any> = {},
): Harness {
  const driver = new Driver123Open({
    access_token: "mock_token",
    ...addition,
  })
  const ids: string[] = []
  const moves: [number, string][] = []
  ;(driver as any).client = {
    getFiles: async (id: string) => {
      ids.push(id)
      return tree[id] || []
    },
    getDownloadUrl: async (fileId: number) => `https://dl/${fileId}`,
    move: async (fileId: number, dstId: string) => {
      moves.push([fileId, dstId])
    },
  }
  return { driver, tree, ids, moves }
}

const file = (id: number, name: string): File123 => ({
  filename: name,
  fileId: id,
  type: 2,
  size: 10,
  update_at: "2024-01-01 00:00:00",
})
const dir = (id: number, name: string): File123 => ({
  filename: name,
  fileId: id,
  type: 1,
  size: 0,
})

test("F-422: move 用 dstPhysical 的父目录解析目标 ID，而非虚拟 dstDir", async () => {
  const { driver, moves } = makeDriver({
    "0": [dir(7, "target"), file(8, "a.txt")],
  })
  await driver.move("/mnt", "/mnt/target", ["a.txt"], "/a.txt", "/target/a.txt")
  assert.deepEqual(moves, [[8, "7"]])
})

test("F-424: get() 对不存在路径抛 not found 而不是伪造文件", async () => {
  const { driver } = makeDriver({ "0": [] })
  await assert.rejects(
    () => driver.get("", "/missing.txt"),
    /Directory 'missing.txt' not found/,
  )
})

test("F-424: get() 不再吞掉 API/网络异常", async () => {
  const { driver } = makeDriver({})
  ;(driver as any).client.getFiles = async () => {
    throw new Error("[123Open] request failed: HTTP 500")
  }
  await assert.rejects(() => driver.get("", "/file.txt"), /HTTP 500/)
})

test("F-424: get() 对真实文件返回下载链接", async () => {
  const { driver } = makeDriver({ "0": [file(9, "file.txt")] })
  const item = await driver.get("", "/file.txt")
  assert.equal(item.is_dir, false)
  assert.equal(item.raw_url, "https://dl/9")
})

test("F-427: root_folder_id 作为路径解析起点", async () => {
  const { driver, ids } = makeDriver(
    { "99": [dir(5, "sub")], "5": [] },
    { root_folder_id: "99" },
  )
  const items = await driver.list("", "/sub")
  assert.deepEqual(items, [])
  assert.deepEqual(ids, ["99", "5"])
})
