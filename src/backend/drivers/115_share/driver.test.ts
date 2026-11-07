import test from "node:test"
import assert from "node:assert/strict"
import { Pan115ShareDriver } from "./driver"
import { Pan115ShareAddition } from "./types"

test("Pan115ShareDriver instantiation and methods", async () => {
  const addition: Pan115ShareAddition = {
    share_code: "share_test_code",
    receive_code: "1234",
  }

  const driver = new Pan115ShareDriver(addition)
  assert.ok(driver)

  // Mock getFiles
  ;(driver as any).client.getFiles = async (cid: string) => {
    return [
      {
        category_id: "cid_1",
        file_name: "Folder1",
        is_file: 0,
        user_utime: 1700000000,
      },
      {
        file_id: "fid_1",
        file_name: "video.mp4",
        file_size: 10240,
        is_file: 1,
        user_utime: 1700000000,
      },
    ]
  }

  const items = await driver.list("/", "/")
  assert.equal(items.length, 2)
  assert.equal(items[0].name, "Folder1")
  assert.equal(items[0].is_dir, true)
  assert.equal(items[1].name, "video.mp4")
  assert.equal(items[1].is_dir, false)
  assert.equal(items[1].size, 10240)

  // Mock getDownloadUrl
  ;(driver as any).client.getDownloadUrl = async (fileId: string) =>
    "https://cdn115.example.com/video.mp4"

  const link = await driver.link("/video.mp4", "/video.mp4")
  assert.equal(link.url, "https://cdn115.example.com/video.mp4")
})

test("Pan115ShareDriver fails loudly for a path whose directory segment is missing", async () => {
  const driver = new Pan115ShareDriver({
    share_code: "share_test_code",
    receive_code: "1234",
  })
  const queried: string[] = []
  ;(driver as any).client.getFiles = async (cid: string) => {
    queried.push(cid)
    if (cid === "0") {
      return [{ category_id: "cid_A", file_name: "A", is_file: 0 }]
    }
    if (cid === "cid_A") {
      return [{ file_id: "fid_inner", file_name: "inner.txt", is_file: 1 }]
    }
    return []
  }

  // 不存在的目录：不能静默返回祖先（根）内容
  await assert.rejects(() => driver.list("/ghost", "/ghost"), /path not found/)
  await assert.rejects(
    () => driver.list("/ghost/deep", "/ghost/deep"),
    /path not found/,
  )
  // 中间段拼错时也不能从错误父级里取到同名文件
  await assert.rejects(
    () => driver.get("/ghost/inner.txt", "/ghost/inner.txt"),
    /path not found/,
  )

  // 真实存在的目录仍可正常列出
  const items = await driver.list("/A", "/A")
  assert.deepEqual(
    items.map((i) => i.name),
    ["inner.txt"],
  )
  assert.ok(queried.includes("cid_A"))
})
