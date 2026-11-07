import test from "node:test"
import assert from "node:assert/strict"
import { VirtualDriver } from "./driver"

function makeDriver() {
  return new VirtualDriver({
    num_file: 2,
    num_folder: 2,
    min_file_size: 1024,
    max_file_size: 4096,
  })
}

async function drain(stream: ReadableStream): Promise<number> {
  let total = 0
  for await (const chunk of stream as any) {
    total += (chunk as Uint8Array).length
  }
  return total
}

test("F-486: get() 把 folder_N 与存储根识别为目录", async () => {
  const driver = makeDriver()
  const folder = await driver.get("/v/folder_0", "/folder_0")
  assert.equal(folder.is_dir, true)
  assert.equal(folder.size, 0)
  assert.equal(folder.type, 1)

  const root = await driver.get("/v", "/")
  assert.equal(root.is_dir, true)
  assert.equal(root.size, 0)

  const file = await driver.get("/v/file_0.bin", "/file_0.bin")
  assert.equal(file.is_dir, false)
  assert.ok(file.size >= 1024 && file.size < 4096)
})

test("F-485: 无 Range 流长度与 get() 报告的 size 同源一致", async () => {
  const driver = makeDriver()
  const item = await driver.get("/v/file_0.bin", "/file_0.bin")
  const actual = await drain(await driver.createReadStream("/file_0.bin"))
  assert.equal(actual, item.size)

  // 同一路径两次 get() 的 size 必须稳定（不再每次随机）
  const again = await driver.get("/v/file_1.bin", "/file_1.bin")
  const actual1 = await drain(await driver.createReadStream("/file_1.bin"))
  assert.equal(actual1, again.size)
})

test("F-485: list() 中文件 size 与 get() 一致", async () => {
  const driver = makeDriver()
  const items = await driver.list()
  const file = items.find((i) => i.name === "file_0.bin")!
  const item = await driver.get("/v/file_0.bin", "/file_0.bin")
  assert.equal(file.size, item.size)
})

test("F-485: Range 请求仍按请求区间返回", async () => {
  const driver = makeDriver()
  const actual = await drain(
    await driver.createReadStream("/file_0.bin", { start: 0, end: 999 }),
  )
  assert.equal(actual, 1000)
})
