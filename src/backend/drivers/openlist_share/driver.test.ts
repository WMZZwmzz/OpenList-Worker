import test from "node:test"
import assert from "node:assert/strict"
import { DriverOpenlistShare } from "./driver"

function makeDriver() {
  const driver = new DriverOpenlistShare({
    url: "https://ol.example.com",
    sid: "sid1",
    pwd: "p",
  } as any)
  const lists: Record<string, any[]> = {
    "/": [{ name: "a.txt", is_dir: false, size: 3 }],
    "/dir": [],
  }
  ;(driver as any).client = {
    init: () => {},
    list: async (p: string) => {
      if (!(p in lists)) throw new Error(`[OpenListShare] not found ${p}`)
      return lists[p]
    },
    downloadUrl: (p: string) => `https://ol.example.com/sd/sid1${p}`,
  }
  return { driver }
}

test("F-482: 父目录列表失败向上抛，不返回假目录", async () => {
  const { driver } = makeDriver()
  ;(driver as any).client.list = async () => {
    throw new Error("[OpenListShare] wrong password")
  }
  await assert.rejects(() => driver.get("/m/a.txt", "/a.txt"), /wrong password/)
})

test("F-482: 未命中且不是目录时抛 not found（此前会返回 200 空目录）", async () => {
  const { driver } = makeDriver()
  await assert.rejects(() => driver.get("/m/nope.txt", "/nope.txt"), /not found/)
})

test("F-482: 未命中但可列为目录时返回目录条目", async () => {
  const { driver } = makeDriver()
  const item = await driver.get("/m/dir", "/dir")
  assert.equal(item.is_dir, true)
  assert.equal(item.size, 0)
})

test("F-482: 文件命中返回直链", async () => {
  const { driver } = makeDriver()
  const item = await driver.get("/m/a.txt", "/a.txt")
  assert.equal(item.raw_url, "https://ol.example.com/sd/sid1/a.txt")
})
