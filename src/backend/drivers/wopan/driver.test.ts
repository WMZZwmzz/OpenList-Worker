import test from "node:test"
import assert from "node:assert/strict"
import { WoPanDriver } from "./driver"

function makeDriver() {
  const driver = new WoPanDriver({
    access_token: "at",
    refresh_token: "",
    root_folder_id: "root-id",
  })
  const anyDriver = driver as any
  anyDriver.resolveWoPanFile = async () => ({
    type: 1,
    id: "src-id",
    name: "a.txt",
  })
  const resolved: string[] = []
  anyDriver.resolveFolderId = async (p: string) => {
    resolved.push(p)
    return "dst-folder-id"
  }
  return { driver, anyDriver, resolved }
}

test("move() resolves the target folder from dstPhysical (F-214)", async () => {
  const { driver, anyDriver, resolved } = makeDriver()
  let moveArgs: any[] | null = null
  anyDriver.client.moveFile = async (...args: any[]) => {
    moveArgs = args
  }

  await driver.move(
    "/wopan/docs",
    "/wopan/photos",
    ["a.txt"],
    "docs/a.txt",
    "photos/a.txt",
  )

  assert.deepEqual(resolved, ["photos"])
  assert.ok(moveArgs)
  assert.deepEqual(moveArgs![0], [])
  assert.deepEqual(moveArgs![1], ["src-id"])
  assert.equal(moveArgs![2], "dst-folder-id")
})

test("copy() resolves the target folder from dstPhysical (F-214)", async () => {
  const { driver, anyDriver, resolved } = makeDriver()
  let copyArgs: any[] | null = null
  anyDriver.client.copyFile = async (...args: any[]) => {
    copyArgs = args
  }

  await driver.copy(
    "/wopan/docs",
    "/wopan/photos",
    ["a.txt"],
    "docs/a.txt",
    "photos/a.txt",
  )

  assert.deepEqual(resolved, ["photos"])
  assert.ok(copyArgs)
  assert.equal(copyArgs![2], "dst-folder-id")
})

test("move() to the storage root resolves the empty parent path", async () => {
  const { driver, anyDriver, resolved } = makeDriver()
  anyDriver.client.moveFile = async () => {}
  await driver.move("/wopan/docs", "/wopan", ["a.txt"], "docs/a.txt", "a.txt")
  assert.deepEqual(resolved, [""])
})

test("normalizeWoPanAddition 对非字符串字段先 String() 归一 (F-217)", async () => {
  const { normalizeWoPanAddition } = await import("./driver")
  const norm = normalizeWoPanAddition({
    refresh_token: "abc",
    family_id: 12345,
    access_token: 67890,
    root_folder_id: 42,
  })
  assert.equal(norm.family_id, "12345")
  assert.equal(norm.access_token, "67890")
  assert.equal(norm.refresh_token, "abc")
  assert.equal(norm.root_folder_id, "42")
})

test("fetchFolderFiles 子请求预算用尽时报明确错误 (F-219)", async () => {
  const { driver, anyDriver } = makeDriver()
  let calls = 0
  anyDriver.client.queryAllFiles = async () => {
    calls++
    const files = Array.from({ length: 100 }, (_, i) => ({
      type: 1,
      id: `id-${calls}-${i}`,
      name: `f-${calls}-${i}`,
    }))
    return { files }
  }
  anyDriver.budget.limit = 2

  await assert.rejects(
    () => driver.list("", ""),
    /subrequest 预算上限/,
  )
  assert.equal(calls, 2)
})
