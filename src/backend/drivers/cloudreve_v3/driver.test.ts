import test from "node:test"
import assert from "node:assert/strict"
import { DriverCloudreveV3, parentUri } from "./driver"

function makeDriver() {
  const driver = new DriverCloudreveV3({
    address: "https://cr.example.com",
    cookie: "session",
  })
  const calls: any[][] = []
  ;(driver as any).client = {
    listFiles: async (uri: string) => {
      if (uri === "/phys/src" || uri === "/data/src") {
        return [
          {
            id: "obj-file",
            name: "a.txt",
            path: "/phys/src/a.txt",
            type: "file",
            size: 10,
            date: "2026-01-01T00:00:00Z",
          },
          {
            id: "obj-dir",
            name: "sub",
            path: "/phys/src/sub",
            type: "dir",
            size: 0,
            date: "2026-01-01T00:00:00Z",
          },
        ]
      }
      return []
    },
    move: async (srcDir: string, dst: string, src: any) => {
      calls.push(["move", srcDir, dst, src])
    },
    copy: async (srcDir: string, dst: string, src: any) => {
      calls.push(["copy", srcDir, dst, src])
    },
  }
  return { driver, calls }
}

test("F-434: parentUri 从物理路径派生父目录", () => {
  assert.equal(parentUri("/a/b/c.txt"), "/a/b")
  assert.equal(parentUri("/a.txt"), "/")
  assert.equal(parentUri("/"), "/")
  assert.equal(parentUri(""), "/")
})

test("F-434: move 用物理目标父目录（不是虚拟 dstDir）", async () => {
  const { driver, calls } = makeDriver()
  await driver.move("/virtual/src", "/virtual/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  assert.deepEqual(calls[0], [
    "move",
    "/phys/src",
    "/phys/dst",
    { dirs: [], items: ["obj-file"] },
  ])
})

test("F-434: copy 用物理目标父目录；目录条目走 dirs", async () => {
  const { driver, calls } = makeDriver()
  await driver.copy("/virtual/src", "/virtual/dst", ["sub"], "/phys/src/sub", "/phys/dst/sub")
  assert.deepEqual(calls[0], [
    "copy",
    "/phys/src",
    "/phys/dst",
    { dirs: ["obj-dir"], items: [] },
  ])
})

test("F-434: root_folder_path 场景——虚拟路径含挂载前缀也不会被发给 API", async () => {
  const { driver, calls } = makeDriver()
  // mount /cr + root_folder_path /data ⇒ 物理路径 /data/src/...、/data/dst/...
  await driver.move("/cr/src", "/cr/dst", ["a.txt"], "/data/src/a.txt", "/data/dst/a.txt")
  assert.equal(calls[0][1], "/data/src")
  assert.equal(calls[0][2], "/data/dst")
  assert.ok(!calls[0].includes("/cr/dst"))
})

function makeGetDriver(listFiles: (uri: string) => Promise<any[]>) {
  const driver = new DriverCloudreveV3({
    address: "https://cr.example.com",
    cookie: "session",
  })
  ;(driver as any).client = {
    listFiles,
    getDownloadUrl: async () => "https://dl.example.com/a.txt",
    downloadHeaders: () => ({ Cookie: "session" }),
  }
  return driver
}

test("F-439: get 传播父目录列表错误（不再合成空目录）", async () => {
  const driver = makeGetDriver(async () => {
    throw new Error("HTTP 500 upstream")
  })
  await assert.rejects(() => driver.get("/m/a.txt", "/a.txt"), /HTTP 500/)
})

test("F-439: get 未命中且无法确认目录时抛 not found", async () => {
  const driver = makeGetDriver(async (uri) => {
    if (uri === "/") return []
    throw new Error("dir not found")
  })
  await assert.rejects(() => driver.get("/m/nope.txt", "/nope.txt"), /not found/)
})

test("F-439: get 确认目录时返回目录条目，文件命中时带 raw_url", async () => {
  const driver = makeGetDriver(async (uri) => {
    if (uri === "/") {
      return [
        { id: "f1", name: "a.txt", path: "/a.txt", type: "file", size: 3 },
      ]
    }
    return []
  })
  const file = await driver.get("/m/a.txt", "/a.txt")
  assert.equal(file.is_dir, false)
  assert.equal(file.raw_url, "https://dl.example.com/a.txt")
  assert.deepEqual(file.raw_url_headers, { Cookie: "session" })

  const dir = await driver.get("/m/sub", "/sub")
  assert.equal(dir.is_dir, true)
})
