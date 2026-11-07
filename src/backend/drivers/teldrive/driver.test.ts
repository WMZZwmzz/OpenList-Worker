import test from "node:test"
import assert from "node:assert/strict"
import { DriverTeldrive, parentPath } from "./driver"

type F = { id: string; name: string; type: "folder" | "file"; size?: number }

function makeDriver(addition: Record<string, unknown> = {}) {
  const driver = new DriverTeldrive({
    url: "https://td.example.com",
    access_token: "t",
    ...addition,
  } as any)
  const calls: any[][] = []
  const lists: Record<string, F[]> = {}
  ;(driver as any).client = {
    listFiles: async (p: string) => {
      calls.push(["list", p])
      if (!(p in lists)) throw new Error(`[TelDrive] HTTP 404 ${p}`)
      return lists[p].map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        size: f.size || 0,
      }))
    },
    mkdir: async (p: string) => calls.push(["mkdir", p]),
    move: async (ids: string[], dst: string) => calls.push(["move", ids, dst]),
    remove: async (id: string) => calls.push(["remove", id]),
    downloadUrl: (id: string) => `https://td.example.com/api/files/${id}`,
    downloadHeaders: () => ({ Authorization: "Bearer t" }),
  }
  const setTree = (tree: Record<string, F[]>) => {
    for (const k of Object.keys(lists)) delete lists[k]
    Object.assign(lists, tree)
  }
  return { driver, calls, setTree }
}

const tree = (): Record<string, F[]> => ({
  "/": [
    { id: "d1", name: "docs", type: "folder" },
    { id: "d2", name: "dst", type: "folder" },
    { id: "f1", name: "a.txt", type: "file", size: 5 },
  ],
  "/docs": [{ id: "f2", name: "b.txt", type: "file", size: 7 }],
  "/dst": [],
})

test("F-477: parentPath 从物理路径派生父目录", () => {
  assert.equal(parentPath("/a/b/c.txt"), "/a/b")
  assert.equal(parentPath("/a.txt"), "/")
  assert.equal(parentPath("/"), "/")
})

test("F-477: move 的目标目录取自物理路径（虚拟 dstDir 会被忽略）", async () => {
  const { driver, calls, setTree } = makeDriver()
  setTree(tree())
  await driver.move("/mount/src", "/mount/dst", ["b.txt"], "/docs/b.txt", "/dst/b.txt")
  assert.deepEqual(calls.at(-1), ["move", ["f2"], "d2"])
})

test("F-481: root_path 会拼接到 list 的物理路径上", async () => {
  const { driver, calls, setTree } = makeDriver({ root_path: "root" })
  setTree({ "/root": [{ id: "f1", name: "a.txt", type: "file", size: 1 }] })
  const items = await driver.list("/m", "/")
  assert.deepEqual(calls[0], ["list", "/root"])
  assert.equal(items[0].name, "a.txt")
})

test("F-483: get 传播父目录列表错误，不再降级成假文件", async () => {
  const { driver, setTree } = makeDriver()
  setTree(tree())
  ;(driver as any).client.listFiles = async () => {
    throw new Error("[TelDrive] HTTP 429 rate limited")
  }
  await assert.rejects(() => driver.get("/m/a.txt", "/a.txt"), /rate limited/)
})

test("F-483: get 未命中且无法确认为目录时抛 not found", async () => {
  const { driver, setTree } = makeDriver()
  setTree(tree())
  await assert.rejects(() => driver.get("/m/nope.txt", "/nope.txt"), /not found/)
})

test("F-483: get 确认目录时返回目录条目", async () => {
  const { driver, setTree } = makeDriver()
  setTree(tree())
  const item = await driver.get("/m/docs", "/docs")
  assert.equal(item.is_dir, true)
  assert.equal(item.size, 0)
})

test("F-483: 文件命中时附带 raw_url 与 headers", async () => {
  const { driver, setTree } = makeDriver()
  setTree(tree())
  const item = await driver.get("/m/a.txt", "/a.txt")
  assert.equal(item.is_dir, false)
  assert.equal(item.raw_url, "https://td.example.com/api/files/f1")
  assert.deepEqual(item.raw_url_headers, { Authorization: "Bearer t" })
})

test("F-484: resolveFileId 命中缓存，写入操作强制重新解析", async () => {
  const { driver, calls, setTree } = makeDriver()
  setTree(tree())
  const id1 = await (driver as any).resolveFileId("/docs/b.txt")
  assert.equal(id1, "f2")
  const before = calls.length
  const id2 = await (driver as any).resolveFileId("/docs/b.txt")
  assert.equal(id2, "f2")
  assert.equal(calls.length, before, "第二次解析应命中缓存")

  // 远端把 b.txt 换成了新 id：remove 必须拿到新 id，而不是缓存里的 f2
  setTree({
    "/": tree()["/"],
    "/docs": [{ id: "f2b", name: "b.txt", type: "file", size: 7 }],
  })
  await driver.remove("/m/docs/b.txt", "/docs/b.txt", ["b.txt"])
  assert.deepEqual(calls.at(-1), ["remove", "f2b"])
})

test("F-484: mkdir 清空 pathCache", async () => {
  const { driver, calls, setTree } = makeDriver()
  setTree(tree())
  await (driver as any).resolveFileId("/docs")
  await driver.mkdir("/m/new", "/new")
  const before = calls.length
  await (driver as any).resolveFileId("/docs")
  assert.ok(calls.length > before, "mkdir 后重新解析应再次请求上游")
})
