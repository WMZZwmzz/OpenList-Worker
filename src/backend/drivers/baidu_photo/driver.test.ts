import test from "node:test"
import assert from "node:assert/strict"
import { DriverBaiduPhoto } from "./driver"
import { BaiduPhotoAlbum } from "./types"

const BIG_TID = "3171468985035633694"

function makeAlbum(title: string, tid = BIG_TID): BaiduPhotoAlbum {
  return {
    album_id: "album-1",
    tid,
    title,
    create_time: 0,
    mtime: 0,
  }
}

function makeDriver(): any {
  return new DriverBaiduPhoto({ cookie: "c" }) as any
}

test("mkdir 用 physicalPath 最后一段作为相册名，仅拦截嵌套路径 (F-298)", async () => {
  const driver = makeDriver()
  const created: string[] = []
  driver.client.createAlbum = async (name: string) => {
    created.push(name)
    return makeAlbum(name)
  }

  await driver.mkdir("/mnt/旅行", "旅行")
  assert.deepEqual(created, ["旅行"])

  await assert.rejects(
    () => driver.mkdir("/mnt/a/b", "a/b"),
    /相册不支持创建子目录/,
  )
  // 顶层挂载点 mkdir 没有名字，应报明确错误
  await assert.rejects(() => driver.mkdir("/mnt", ""), /缺少相册名称/)
  assert.deepEqual(created, ["旅行"])
})

test("get() 对不存在的路径抛 not-found，根路径返回真实目录 (F-301)", async () => {
  const driver = makeDriver()
  driver.client.getAllAlbum = async () => []
  driver.client.getAllFile = async () => []

  const root = await driver.get("/mnt", "")
  assert.equal(root.is_dir, true)
  assert.equal(root.name, "mnt")

  await assert.rejects(() => driver.get("/mnt/missing", "missing"), /not found/)
})

test("albumCache 过期后重新拉取（F-302）", async () => {
  const driver = makeDriver()
  const stale = makeAlbum("旅行", "111111111111111111")
  const fresh = makeAlbum("旅行", "222222222222222222")
  driver.albumCache.set("旅行", { album: stale, expires: Date.now() - 1 })
  let calls = 0
  driver.client.getAllAlbum = async () => {
    calls++
    return [fresh]
  }

  const found = await driver.findAlbum("旅行")
  assert.equal(found.tid, "222222222222222222")
  assert.equal(calls, 1)

  // 未过期时直接命中缓存，不再请求
  const cached = await driver.findAlbum("旅行")
  assert.equal(cached.tid, "222222222222222222")
  assert.equal(calls, 1)
})

test("resolveEntry 生成的 sign 中 tid 保持 18 位字符串 (F-300)", async () => {
  const driver = makeDriver()
  driver.client.getAllAlbum = async () => [makeAlbum("旅行")]
  const entry = await driver.resolveEntry("旅行")
  assert.equal(entry.kind, "album")
  assert.equal(entry.tid, BIG_TID)
})
