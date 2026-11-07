import test from "node:test"
import assert from "node:assert/strict"
import { DriverMisskey, parentPath } from "./driver"

function makeDriver() {
  const driver = new DriverMisskey({
    endpoint: "https://mk.example.com",
    access_token: "token",
  })
  const calls: any[][] = []
  const foldersByParent: Record<string, any[]> = {
    "": [
      { id: "f-src", name: "src", createdAt: "2026-01-01T00:00:00Z" },
      { id: "f-dst", name: "dst", createdAt: "2026-01-01T00:00:00Z" },
    ],
    "f-src": [],
    "f-dst": [],
  }
  const filesByParent: Record<string, any[]> = {
    "f-src": [{ id: "file-1", name: "a.txt", size: 10, url: "https://mk.example/a" }],
    "f-dst": [],
  }
  ;(driver as any).client = {
    getFolders: async (parentId?: string) => foldersByParent[parentId || ""] || [],
    getFiles: async (folderId?: string) => filesByParent[folderId || ""] || [],
    updateFile: async (id: string, data: any) => calls.push(["updateFile", id, data]),
    updateFolder: async (id: string, data: any) => calls.push(["updateFolder", id, data]),
    showFile: async (id: string) => ({ id, name: "a.txt", size: 10, url: "https://mk.example/a" }),
    uploadFromUrl: async (url: string, folderId?: string) =>
      calls.push(["uploadFromUrl", url, folderId]),
  }
  return { driver, calls }
}

test("F-467: parentPath 从物理路径派生父目录", () => {
  assert.equal(parentPath("/a/b/c.txt"), "/a/b")
  assert.equal(parentPath("/a.txt"), "/")
})

test("F-467: move 用物理目标目录解析文件夹 ID（虚拟路径会找不到目录）", async () => {
  const { driver, calls } = makeDriver()
  await driver.move("/mk/src", "/mk/dst", ["a.txt"], "/src/a.txt", "/dst/a.txt")
  assert.deepEqual(calls[0], ["updateFile", "file-1", { folderId: "f-dst" }])
})

test("F-467: copy 用物理目标目录解析文件夹 ID", async () => {
  const { driver, calls } = makeDriver()
  await driver.copy("/mk/src", "/mk/dst", ["a.txt"], "/src/a.txt", "/dst/a.txt")
  assert.deepEqual(calls[0], ["uploadFromUrl", "https://mk.example/a", "f-dst"])
})

test("F-474: pathCache 写入键与读取键一致，第二次解析命中缓存", async () => {
  const driver = new DriverMisskey({
    endpoint: "https://mk.example.com",
    access_token: "token",
  })
  const foldersByParent: Record<string, any[]> = {
    "": [{ id: "a", name: "a" }],
    a: [{ id: "b", name: "b" }],
    b: [],
  }
  let calls = 0
  ;(driver as any).client = {
    getFolders: async (parentId?: string) => {
      calls++
      return foldersByParent[parentId || ""] || []
    },
  }
  const first = await (driver as any).resolveFolderId("/a/b")
  assert.equal(first, "b")
  const afterFirst = calls
  const second = await (driver as any).resolveFolderId("/a/b")
  assert.equal(second, "b")
  assert.equal(calls, afterFirst, "第二次应命中缓存，不再请求上游")
})
