import test from "node:test"
import assert from "node:assert/strict"
import { SMBDriver } from "./driver"
import { SMBAddition } from "./types"

test("SMBDriver instantiation and methods", async () => {
  const addition: SMBAddition = {
    address: "192.168.1.100",
    username: "admin",
    password: "password",
    share_name: "public",
  }

  const driver = new SMBDriver(addition)
  assert.ok(driver)

  await driver.init()

  // 本构建没有 SMB 客户端实现：这些方法必须显式失败，而不是返回假条目或静默
  // 成功（旧实现下 get() 会凭空造出一个 size:0 的条目、写操作全部「成功」）。
  await assert.rejects(() => driver.get("/", "/"), /not implemented/)
  await assert.rejects(() => driver.list("/", "/"), /not implemented/)
  await assert.rejects(() => driver.mkdir("/a", "/a"), /not implemented/)
  await assert.rejects(
    () => driver.put("/a.txt", "/a.txt", Buffer.from("x")),
    /not implemented/,
  )
  await assert.rejects(
    () => driver.remove("/a.txt", "/a.txt", ["a.txt"]),
    /not implemented/,
  )
  await assert.rejects(
    () => driver.rename("/a.txt", "/a.txt", "b.txt"),
    /not implemented/,
  )
  await assert.rejects(
    () => driver.move("/a", "/b", ["x"], "/a/x", "/b/x"),
    /not implemented/,
  )
  await assert.rejects(
    () => driver.copy("/a", "/b", ["x"], "/a/x", "/b/x"),
    /not implemented/,
  )
})
