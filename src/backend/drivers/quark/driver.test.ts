import assert from "node:assert/strict"
import { test } from "node:test"

import { QuarkDriver } from "./driver"

function stubDriver() {
  const driver = new QuarkDriver({ cookie: "c" })
  const moves: Array<{ ids: string[]; target: string }> = []
  const copies: Array<{ ids: string[]; target: string }> = []
  ;(driver as any).client.getFiles = async (parentId: string) => {
    if (parentId !== "0") return []
    return [
      { fid: "300", file_name: "photos", pdir_fid: "0" },
      { fid: "f-a", file_name: "a.txt", pdir_fid: "0", size: 5, file: true },
    ]
  }
  ;(driver as any).client.move = async (ids: string[], target: string) => {
    moves.push({ ids, target })
  }
  ;(driver as any).client.copy = async (ids: string[], target: string) => {
    copies.push({ ids, target })
  }
  return { driver, moves, copies }
}

test("Quark move resolves the target folder from dstPhysical, not the virtual dstDir", async () => {
  const { driver, moves } = stubDriver()
  // 挂载在 /quark：虚拟 dstDir=/quark/photos，物理目标项=/photos/a.txt
  await driver.move("/quark", "/quark/photos", ["a.txt"], "/a.txt", "/photos/a.txt")
  assert.deepEqual(moves, [{ ids: ["f-a"], target: "300" }])
})

test("Quark copy resolves the target folder from dstPhysical, not the virtual dstDir", async () => {
  const { driver, copies } = stubDriver()
  await driver.copy("/quark", "/quark/photos", ["a.txt"], "/a.txt", "/photos/a.txt")
  assert.deepEqual(copies, [{ ids: ["f-a"], target: "300" }])
})
