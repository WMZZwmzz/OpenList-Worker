import test from "node:test"
import assert from "node:assert/strict"
import { DriverLenovoNasShare } from "./driver"

function makeDriver() {
  const driver = new DriverLenovoNasShare({
    host: "https://siot-share.lenovo.com.cn",
    share_id: "share-1",
    share_pwd: "pwd",
  })
  const lists: Record<string, any[]> = {
    "/": [{ name: "a.txt", path: "/a.txt", type: "file", size: 3, chtime: 1 }],
    "/dir": [],
  }
  ;(driver as any).client = {
    list: async (p: string) => {
      const clean = p.startsWith("/") ? p : "/" + p
      if (!(clean in lists)) throw new Error(`[Lenovo NAS Share] not found ${clean}`)
      return lists[clean]
    },
    getDownloadUrl: async () => "https://dl.example.com/a.txt",
    downloadHeaders: () => ({ Referer: "https://siot-share.lenovo.com.cn" }),
  }
  return { driver }
}

test("F-483: 文件命中时换链失败直接抛出真实错误", async () => {
  const { driver } = makeDriver()
  ;(driver as any).client.getDownloadUrl = async () => {
    throw new Error("[Lenovo NAS Share] limited")
  }
  await assert.rejects(() => driver.get("/m/a.txt", "/a.txt"), /limited/)
})

test("F-483: 父目录列表失败向上抛，不降级为假文件", async () => {
  const { driver } = makeDriver()
  ;(driver as any).client.list = async () => {
    throw new Error("[Lenovo NAS Share] timeout")
  }
  await assert.rejects(() => driver.get("/m/a.txt", "/a.txt"), /timeout/)
})

test("F-483: 文件命中时返回 raw_url 与 headers", async () => {
  const { driver } = makeDriver()
  const item = await driver.get("/m/a.txt", "/a.txt")
  assert.equal(item.is_dir, false)
  assert.equal(item.raw_url, "https://dl.example.com/a.txt")
  assert.deepEqual(item.raw_url_headers, {
    Referer: "https://siot-share.lenovo.com.cn",
  })
})

test("F-483: 未命中但可列为目录时返回目录条目", async () => {
  const { driver } = makeDriver()
  const item = await driver.get("/m/dir", "/dir")
  assert.equal(item.is_dir, true)
  assert.equal(item.size, 0)
})

test("F-483: 未命中且不是目录时抛 not found", async () => {
  const { driver } = makeDriver()
  await assert.rejects(() => driver.get("/m/nope", "/nope"), /not found/)
})
