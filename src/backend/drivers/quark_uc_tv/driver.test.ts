import test from "node:test"
import assert from "node:assert/strict"
import { DriverQuarkUcTv } from "./driver"
import { QuarkTvFile } from "./types"

// F-424：quark_uc_tv 的 get() 与 123_open 同构 —— 以前吞掉一切异常并对
// 不存在路径伪造 {is_dir:false} 的幻影条目。这里验证修复后的行为。

function makeDriver(tree: Record<string, QuarkTvFile[]>) {
  const driver = new DriverQuarkUcTv({
    refresh_token: "mock_token",
  })
  ;(driver as any).client = {
    getFiles: async (id: string) => tree[id] || [],
    getDownloadUrl: async (fid: string) => `https://dl/${fid}`,
  }
  return driver
}

const file = (fid: string, name: string): QuarkTvFile => ({
  fid,
  filename: name,
  size: 10,
  isdir: 0,
  category: 0,
})
const dir = (fid: string, name: string): QuarkTvFile => ({
  fid,
  filename: name,
  size: 0,
  isdir: 1,
  category: 0,
})

test("F-424: get() 对不存在路径抛 not found 而不是伪造文件", async () => {
  const driver = makeDriver({ "0": [] })
  await assert.rejects(
    () => driver.get("", "/missing.txt"),
    /Directory 'missing.txt' not found/,
  )
})

test("F-424: get() 不再吞掉 API/网络异常", async () => {
  const driver = makeDriver({})
  ;(driver as any).client.getFiles = async () => {
    throw new Error("[QuarkTV] request failed: HTTP 500")
  }
  await assert.rejects(() => driver.get("", "/file.txt"), /HTTP 500/)
})

test("F-424: get() 对真实文件返回下载链接", async () => {
  const driver = makeDriver({ "0": [file("9", "file.txt")] })
  const item = await driver.get("", "/file.txt")
  assert.equal(item.is_dir, false)
  assert.equal(item.raw_url, "https://dl/9")
})

test("F-424: get() 对真实目录返回 is_dir:true", async () => {
  const driver = makeDriver({ "0": [dir("5", "sub")], "5": [] })
  const item = await driver.get("", "/sub")
  assert.equal(item.is_dir, true)
})
