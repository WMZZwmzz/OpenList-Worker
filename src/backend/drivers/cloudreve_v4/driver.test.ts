import test from "node:test"
import assert from "node:assert/strict"
import { DriverCloudreve, parentUri } from "./driver"

function makeDriver() {
  const driver = new DriverCloudreve({
    address: "https://cloud.example.com",
    access_token: "tok",
  })
  const calls: any[][] = []
  ;(driver as any).client = {
    move: async (uris: string[], dst: string, copy: boolean) => calls.push([uris, dst, copy]),
  }
  return { driver, calls }
}

test("parentUri 从物理路径派生父目录", () => {
  assert.equal(parentUri("/a/b/c.txt"), "/a/b")
  assert.equal(parentUri("/a.txt"), "/")
})

test("move/copy 的 dst 用物理父目录（与 list/mkdir/rename 的物理坐标系一致）", async () => {
  const { driver, calls } = makeDriver()
  await driver.move("/virt/src", "/virt/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  await driver.copy("/virt/src", "/virt/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  assert.deepEqual(calls[0], [["/phys/src/a.txt"], "/phys/dst", false])
  assert.deepEqual(calls[1], [["/phys/src/a.txt"], "/phys/dst", true])
})

function makeGetDriver(listFiles: (uri: string) => Promise<any[]>) {
  const driver = new DriverCloudreve({
    address: "https://cloud.example.com",
    access_token: "tok",
  })
  ;(driver as any).client = {
    listFiles,
    getDownloadUrl: async () => "https://dl.example.com/a.txt",
  }
  return driver
}

test("F-464: get 传播父目录列表错误（不再伪装成 0 字节文件）", async () => {
  const driver = makeGetDriver(async () => {
    throw new Error("HTTP 401 unauthorized")
  })
  await assert.rejects(() => driver.get("/m/a.txt", "/a.txt"), /401/)
})

test("F-464: get 未命中且无法确认目录时抛 not found", async () => {
  const driver = makeGetDriver(async (uri) => {
    if (uri === "/") return []
    throw new Error("dir not found")
  })
  await assert.rejects(() => driver.get("/m/nope.txt", "/nope.txt"), /not found/)
})

test("F-464: get 确认目录时返回目录条目，文件命中时带 raw_url", async () => {
  const driver = makeGetDriver(async (uri) => {
    if (uri === "/") {
      return [{ id: "f1", name: "a.txt", type: 0, size: 3, path: "/a.txt" }]
    }
    return []
  })
  const file = await driver.get("/m/a.txt", "/a.txt")
  assert.equal(file.is_dir, false)
  assert.equal(file.raw_url, "https://dl.example.com/a.txt")

  const dir = await driver.get("/m/sub", "/sub")
  assert.equal(dir.is_dir, true)
})
