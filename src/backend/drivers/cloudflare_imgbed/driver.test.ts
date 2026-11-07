import test from "node:test"
import assert from "node:assert/strict"
import {
  encodePath,
  parseMetadataSize,
  parseMetadataTimestamp,
} from "./util"
import { CFImgBedDriver, normalizeCFImgBedAddition } from "./driver"

test("encodePath percent-encodes each segment", () => {
  assert.equal(encodePath("/a b/c.txt"), "/a%20b/c.txt")
})

test("parseMetadataSize extracts common size keys", () => {
  assert.equal(parseMetadataSize({ FileSizeBytes: "2048" }), 2048)
  assert.equal(parseMetadataSize({ size: 4096 }), 4096)
  assert.equal(parseMetadataSize({}), 0)
})

test("parseMetadataTimestamp extracts common timestamp keys", () => {
  assert.equal(parseMetadataTimestamp({ TimeStamp: 1700000000 }), 1700000000)
  assert.equal(parseMetadataTimestamp({ modified: 1700000001 }), 1700000001)
  assert.equal(parseMetadataTimestamp({}), 0)
})

test("normalizeCFImgBedAddition normalizes address and defaults", () => {
  const a = normalizeCFImgBedAddition({
    address: "https://img.example.com/",
    token: "tok",
  })
  assert.equal(a.address, "https://img.example.com")
  assert.equal(a.root_folder_path, "/")
  assert.equal(a.upload_thread, 3)
})

test("CFImgBedDriver instantiation", () => {
  const driver = new CFImgBedDriver({
    address: "https://img.example.com",
    token: "tok",
  })
  assert.ok(driver)
})

function mockListClient(pages: any[]) {
  const starts: number[] = []
  return {
    starts,
    client: {
      list: async (_dir: string, start: number) => {
        starts.push(start)
        return pages[Math.min(starts.length - 1, pages.length - 1)]
      },
    },
  }
}

function makeFiles(count: number, prefix = "f") {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}${i}.jpg`,
    metadata: { FileSizeBytes: "1" },
  }))
}

test("F-421: list() stops when files are exhausted despite >=1000 directories", async () => {
  const driver = new CFImgBedDriver({
    address: "https://img.example.com",
    token: "tok",
  })
  const directories = Array.from({ length: 1000 }, (_, i) => `/dir/sub${i}`)
  const mock = mockListClient([{ files: [], directories }])
  ;(driver as any).client = mock.client

  const items = await driver.list("/dir", "/dir")
  assert.equal(mock.starts.length, 1)
  assert.equal(items.length, 1000)
})

test("F-421: list() stops when a page adds no new entries (KV fallback ignores pagination)", async () => {
  const driver = new CFImgBedDriver({
    address: "https://img.example.com",
    token: "tok",
  })
  const page = { files: makeFiles(1000), directories: [] }
  const mock = mockListClient([page, page])
  ;(driver as any).client = mock.client

  const items = await driver.list("/dir", "/dir")
  assert.equal(mock.starts.length, 2)
  assert.equal(items.length, 1000)
})

test("F-421: list() paginates by file count", async () => {
  const driver = new CFImgBedDriver({
    address: "https://img.example.com",
    token: "tok",
  })
  const mock = mockListClient([
    { files: makeFiles(1000), directories: ["/dir/sub"] },
    { files: makeFiles(200, "g"), directories: ["/dir/sub"] },
  ])
  ;(driver as any).client = mock.client

  const items = await driver.list("/dir", "/dir")
  assert.equal(mock.starts.length, 2)
  assert.equal(items.length, 1201) // 1000 + 200 files + 1 directory
})

test("F-431: get() 对目录返回 is_dir:true 且不构造下载直链", async () => {
  const driver = new CFImgBedDriver({
    address: "https://img.example.com",
    token: "tok",
  })
  ;(driver as any).client = {
    list: async () => ({ files: [], directories: ["/dir/sub"] }),
  }
  const item = await driver.get("/dir/sub", "/dir/sub")
  assert.equal(item.is_dir, true)
  assert.equal(item.type, 1)
  assert.equal(item.raw_url, undefined)
})

test("F-428: remove() 删除虚拟目录时传 folder=true", async () => {
  const driver = new CFImgBedDriver({
    address: "https://img.example.com",
    token: "tok",
  })
  const calls: [string, boolean][] = []
  ;(driver as any).client = {
    list: async () => ({ files: [], directories: ["/dir/sub"] }),
    remove: async (path: string, folder: boolean) => {
      calls.push([path, folder])
    },
  }
  await driver.remove("", "/dir/sub", ["sub"])
  assert.deepEqual(calls, [["/dir/sub", true]])
})

test("F-428: remove() 删除文件时仍传 folder=false", async () => {
  const driver = new CFImgBedDriver({
    address: "https://img.example.com",
    token: "tok",
  })
  const calls: [string, boolean][] = []
  ;(driver as any).client = {
    list: async () => ({
      files: [{ name: "/dir/a.jpg", metadata: { FileSizeBytes: "1" } }],
      directories: [],
    }),
    remove: async (path: string, folder: boolean) => {
      calls.push([path, folder])
    },
  }
  await driver.remove("", "/dir/a.jpg", ["a.jpg"])
  assert.deepEqual(calls, [["/dir/a.jpg", false]])
})
