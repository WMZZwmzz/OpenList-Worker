import test from "node:test"
import assert from "node:assert/strict"
import { AliasDriver } from "./driver"

test("Alias driver initialization with path mappings", async () => {
  const driver = new AliasDriver({
    paths: "/local\nsub1:/storage1\nsub2:/storage2",
    read_conflict_policy: "first",
    write_conflict_policy: "disabled",
  })
  await driver.init()
  assert.ok(driver)
})

test("F-462: 多段 aliasSub 的中间目录被合成为可导航目录", async () => {
  const driver = new AliasDriver({
    paths: "/a/b:/target",
    read_conflict_policy: "first",
    write_conflict_policy: "disabled",
  })
  await driver.init()
  assert.deepEqual((driver as any).syntheticChildren("/"), ["a"])
  assert.deepEqual((driver as any).syntheticChildren("/a"), ["b"])
  // 中间目录的 get() 必须是目录，而不是 0 字节文件
  const item = await driver.get("/alias/a", "/a")
  assert.equal(item.is_dir, true)
  assert.equal(item.size, 0)
})

test("F-462: 唯一具名根的根目录也有合成项", async () => {
  const driver = new AliasDriver({
    paths: "sub1:/storage1",
    read_conflict_policy: "first",
    write_conflict_policy: "disabled",
  })
  await driver.init()
  assert.deepEqual((driver as any).syntheticChildren("/"), ["sub1"])
  const root = await driver.get("/alias", "/")
  assert.equal(root.is_dir, true)
})

test("F-463: 无法映射的路径抛 not found，不再返回伪造的 0 字节文件", async () => {
  const driver = new AliasDriver({
    paths: "/a/b:/target",
    read_conflict_policy: "first",
    write_conflict_policy: "disabled",
  })
  await driver.init()
  await assert.rejects(() => driver.get("/alias/nope", "/nope"), /not found/)
})
