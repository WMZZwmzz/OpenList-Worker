import test from "node:test"
import assert from "node:assert/strict"
import { PikPakShareDriver } from "./driver"
import { PikPakShareAddition } from "./types"

test("PikPakShareDriver instantiation and methods", async () => {
  const addition: PikPakShareAddition = {
    share_id: "pikpak_share_123",
    share_pwd: "pwd",
  }

  const driver = new PikPakShareDriver(addition)
  assert.ok(driver)

  // Mock getFiles
  ;(driver as any).client.getFiles = async (parentId: string) => {
    return [
      {
        id: "folder_1",
        share_id: "pikpak_share_123",
        kind: "drive#folder",
        name: "Anime",
        modified_time: "2026-08-24T12:00:00Z",
      },
      {
        id: "file_2",
        share_id: "pikpak_share_123",
        kind: "drive#file",
        name: "ep01.mkv",
        size: 500000000,
        modified_time: "2026-08-24T12:00:00Z",
        web_content_link: "https://dl.pikpak.example.com/ep01.mkv",
      },
    ]
  }

  const items = await driver.list("/", "/")
  assert.equal(items.length, 2)
  assert.equal(items[0].name, "Anime")
  assert.equal(items[0].is_dir, true)
  assert.equal(items[1].name, "ep01.mkv")
  assert.equal(items[1].is_dir, false)
  assert.equal(items[1].size, 500000000)

  const link = await driver.link("/ep01.mkv", "/ep01.mkv")
  assert.equal(link.url, "https://dl.pikpak.example.com/ep01.mkv")
})

// ---- F-450: 路径段不存在必须报错 ----
test("resolveParentId 对不存在的目录段抛错（F-450）", async () => {
  const driver = new PikPakShareDriver({ share_id: "pikpak_share_123" })
  ;(driver as any).client.getFiles = async () => [
    {
      id: "folder_1",
      share_id: "pikpak_share_123",
      kind: "drive#folder",
      name: "Anime",
      modified_time: "2026-08-24T12:00:00Z",
    },
  ]
  await assert.rejects(
    () => driver.list("/missing", "/missing"),
    /Directory 'missing' not found/,
  )
  await assert.rejects(
    () => driver.get("/missing/ep01.mkv", "/missing/ep01.mkv"),
    /Directory 'missing' not found/,
  )
})
