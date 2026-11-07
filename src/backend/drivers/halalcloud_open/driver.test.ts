import test from "node:test"
import assert from "node:assert/strict"
import { DriverHalalCloudOpen } from "./driver"

interface OpCall {
  op: "move" | "copy"
  src: string
  dst: string
}

function makeDriver(rootFolderId: string) {
  const driver = new DriverHalalCloudOpen({
    client_id: "id",
    client_secret: "secret",
    refresh_token: "rt",
    root_folder_id: rootFolderId,
  })
  const calls: OpCall[] = []
  ;(driver as any).client = {
    listFiles: async (path: string) => {
      const name = "a.txt"
      if (path === "/" || path === "/media") {
        return [
          { name, path: `${path === "/" ? "" : path}/${name}`, identity: "id-a", dir: false },
        ]
      }
      return []
    },
    move: async (src: string, dst: string) => {
      calls.push({ op: "move", src, dst })
    },
    copy: async (src: string, dst: string) => {
      calls.push({ op: "copy", src, dst })
    },
  }
  return { driver, calls }
}

test("F-334: move uses physical dstPhysical, not virtual dstDir", async () => {
  // mount_path=/d 时虚拟 /d/dst 的物理路径为 /dst
  const { driver, calls } = makeDriver("/")
  await driver.move("/d", "/d/dst", ["a.txt"], "/a.txt", "/dst/a.txt")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].dst, "/dst/a.txt")
  assert.equal(calls[0].src, "/a.txt")
})

test("F-334: move with root_folder_id does not duplicate root or mount prefix", async () => {
  const { driver, calls } = makeDriver("/media")
  await driver.move("/d", "/d/dst", ["a.txt"], "/a.txt", "/dst/a.txt")
  assert.equal(calls[0].src, "/media/a.txt")
  assert.equal(calls[0].dst, "/media/dst/a.txt")
})

test("F-334: copy uses physical dstPhysical as well", async () => {
  const { driver, calls } = makeDriver("/media")
  await driver.copy("/d", "/d/dst", ["a.txt"], "/a.txt", "/dst/a.txt")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].op, "copy")
  assert.equal(calls[0].dst, "/media/dst/a.txt")
})

function makeGetDriver(listFiles: (path: string) => Promise<any[]>) {
  const driver = new DriverHalalCloudOpen({
    client_id: "id",
    client_secret: "secret",
    refresh_token: "rt",
  } as any)
  ;(driver as any).client = {
    listFiles,
    getDownloadUrl: async () => "https://dl.example.com/a.txt",
  }
  return driver
}

test("F-337: get 传播父目录列表错误（限流/刷新失败不再被当成目录）", async () => {
  const driver = makeGetDriver(async () => {
    throw new Error("[HalalCloud] HTTP 429 rate limited")
  })
  await assert.rejects(() => driver.get("/m/a.txt", "/a.txt"), /429/)
})

test("F-337: get 未命中且无法确认目录时抛 not found", async () => {
  const driver = makeGetDriver(async (p) => {
    if (p === "/") return []
    throw new Error("dir not found")
  })
  await assert.rejects(() => driver.get("/m/nope.txt", "/nope.txt"), /not found/)
})

test("F-337: get 未命中但可列为目录时返回占位目录", async () => {
  const driver = makeGetDriver(async (p) => {
    if (p === "/") return []
    return []
  })
  const item = await driver.get("/m/sub", "/sub")
  assert.equal(item.is_dir, true)
  assert.equal(item.size, 0)
})
