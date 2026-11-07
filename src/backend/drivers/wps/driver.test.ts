import test from "node:test"
import assert from "node:assert/strict"
import { WpsDriver } from "./driver"
import { WpsAddition } from "./types"

test("WpsDriver instantiation and methods", async () => {
  const addition: WpsAddition = {
    cookie: "wps_sid=test_session_id",
    mode: "Personal",
  }

  const driver = new WpsDriver(addition)
  assert.ok(driver)

  // Mock getGroups
  ;(driver as any).client.getGroups = async () => [
    { group_id: 1001, id: 1001, name: "我的文档" },
  ]

  // Mock getFiles
  ;(driver as any).client.getFiles = async (
    groupId: number,
    parentId: number,
  ) => {
    if (groupId === 1001 && parentId === 0) {
      return [
        {
          groupid: 1001,
          parentid: 0,
          fname: "work",
          fsize: 0,
          ftype: "folder",
          ctime: 1700000000,
          mtime: 1700000000,
          id: 2001,
        },
        {
          groupid: 1001,
          parentid: 0,
          fname: "doc.docx",
          fsize: 2048,
          ftype: "file",
          ctime: 1700000000,
          mtime: 1700000000,
          id: 2002,
        },
      ]
    }
    return []
  }

  // Root list returns groups
  const rootItems = await driver.list("/", "/")
  assert.equal(rootItems.length, 1)
  assert.equal(rootItems[0].name, "我的文档")
  assert.equal(rootItems[0].is_dir, true)

  // Group list returns files & folders
  const groupItems = await driver.list("/我的文档", "/我的文档")
  assert.equal(groupItems.length, 2)
  assert.equal(groupItems[0].name, "work")
  assert.equal(groupItems[0].is_dir, true)
  assert.equal(groupItems[1].name, "doc.docx")
  assert.equal(groupItems[1].is_dir, false)
  assert.equal(groupItems[1].size, 2048)

  // Mock getDownloadUrl
  ;(driver as any).client.getDownloadUrl = async () =>
    "https://ks3.kdocs.cn/download/doc.docx"

  const link = await driver.link("/我的文档/doc.docx", "/我的文档/doc.docx")
  assert.equal(link.url, "https://ks3.kdocs.cn/download/doc.docx")
})

test("F-327: put() fails explicitly instead of silently reporting success", async () => {
  const driver = new WpsDriver({
    cookie: "wps_sid=test_session_id",
    mode: "Personal",
  })

  await assert.rejects(
    () => driver.put("/我的文档", "/我的文档/new.docx", Buffer.from("data")),
    /upload is not supported/,
  )
})

function makeWpsDriver() {
  const driver = new WpsDriver({
    cookie: "wps_sid=test_session_id",
    mode: "Personal",
  })
  ;(driver as any).client.getGroups = async () => [
    { group_id: 1001, id: 1001, name: "g" },
  ]
  ;(driver as any).client.getFiles = async (
    _groupId: number,
    parentId: number,
  ) => {
    if (parentId === 0) {
      return [
        {
          groupid: 1001,
          parentid: 0,
          fname: "sub",
          fsize: 0,
          ftype: "folder",
          mtime: 1700000000,
          id: 3001,
        },
        {
          groupid: 1001,
          parentid: 0,
          fname: "doc.docx",
          fsize: 2048,
          ftype: "file",
          mtime: 1700000000,
          id: 2002,
        },
      ]
    }
    return []
  }
  ;(driver as any).client.getDownloadUrl = async () =>
    "https://ks3.kdocs.cn/download/doc.docx"
  return driver
}

test("F-332: get 为文件附带 raw_url_headers（与 link 相同的 UA/Referer）", async () => {
  const driver = makeWpsDriver()
  const item = await driver.get("/g/doc.docx", "/g/doc.docx")
  assert.equal(item.is_dir, false)
  assert.ok(item.raw_url_headers)
  const headers = item.raw_url_headers as Record<string, string>
  assert.equal(headers.Referer, "https://drive.wps.cn")
  assert.ok(headers["User-Agent"].length > 0)
})

test("F-333: move/copy 在源不存在时抛错，不再静默成功", async () => {
  const driver = makeWpsDriver()
  await assert.rejects(
    () => driver.move("/g", "/g/sub", ["missing.docx"], "/g/missing.docx", "/g/sub/missing.docx"),
    /Source not found/,
  )
  await assert.rejects(
    () => driver.copy("/g", "/g/sub", ["missing.docx"], "/g/missing.docx", "/g/sub/missing.docx"),
    /Source not found/,
  )
})

test("F-333: remove 在源不存在时抛错", async () => {
  const driver = makeWpsDriver()
  await assert.rejects(() => driver.remove("/g/missing.docx", "/g/missing.docx", ["missing.docx"]), /Source not found/)
})
