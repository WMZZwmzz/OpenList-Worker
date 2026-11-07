import test from "node:test"
import assert from "node:assert/strict"
import { CtFileDriver, ctfileDateToIso } from "./driver"

test("move() resolves the target folder from dstPhysical (F-229)", async () => {
  const driver = new CtFileDriver({ session: "sess" })
  const anyDriver = driver as any
  anyDriver.resolveEntry = async () => ({
    isDir: false,
    key: "file-key",
  })
  const resolved: string[] = []
  anyDriver.resolveFolderKey = async (p: string) => {
    resolved.push(p)
    return "dst-folder-key"
  }
  let moved: { keys: string[]; dst: string } | null = null
  anyDriver.client.move = async (keys: string[], dst: string) => {
    moved = { keys, dst }
  }

  await driver.move(
    "/ct-mount/docs",
    "/ct-mount/target",
    ["a.txt"],
    "/docs/a.txt",
    "/target/a.txt",
  )

  assert.deepEqual(resolved, ["/target"])
  assert.deepEqual(moved, { keys: ["file-key"], dst: "dst-folder-key" })
})

test("move() to the root resolves '/' rather than the virtual dstDir", async () => {
  const driver = new CtFileDriver({ session: "sess" })
  const anyDriver = driver as any
  anyDriver.resolveEntry = async () => ({ isDir: false, key: "file-key" })
  const resolved: string[] = []
  anyDriver.resolveFolderKey = async (p: string) => {
    resolved.push(p)
    return "root-key"
  }
  anyDriver.client.move = async () => {}
  await driver.move("/ct-mount/a", "/ct-mount", ["a.txt"], "/a.txt", "/a.txt")
  assert.deepEqual(resolved, ["/"])
})

test("get() 直链失败时设置 raw_url_error 并返回条目，而不是抛 500 (F-230)", async () => {
  const driver = new CtFileDriver({ session: "sess" })
  const anyDriver = driver as any
  anyDriver.resolveEntry = async () => ({
    item: { key: "f1", name: "a.txt", size: 3, date: 0 },
    isDir: false,
    key: "f1",
  })
  anyDriver.client.fetchDownloadUrl = async () => {
    throw new Error("HTTP 429 rate limited")
  }
  const item = await driver.get("/a.txt", "/a.txt")
  assert.equal(item.name, "a.txt")
  assert.equal(item.raw_url, "")
  assert.match(String(item.raw_url_error), /429 rate limited/)
})

test("无时区的城通墙钟时间按 UTC+8 解析 (F-235)", () => {
  assert.equal(
    ctfileDateToIso("2026-11-06 12:00:00"),
    "2026-11-06T04:00:00.000Z",
  )
  // 已带时区的字符串不被重复追加偏移
  assert.equal(
    ctfileDateToIso("2026-11-06T12:00:00Z"),
    "2026-11-06T12:00:00.000Z",
  )
  // unix 秒分支不受影响
  assert.equal(ctfileDateToIso(1700000000), "2023-11-14T22:13:20.000Z")
})
