import assert from "node:assert/strict"
import { test } from "node:test"

import { DriverQuarkOpen } from "./driver"
import { ClientQuarkOpen } from "./util"
import { md5 } from "../../pkg/crypto"

function stubTree() {
  const driver = new DriverQuarkOpen({ refresh_token: "r" } as any)
  const client = (driver as any).client as ClientQuarkOpen
  ;(client as any).getFiles = async (parentId: string) => {
    if (parentId === "0") {
      return [{ fid: "d1", filename: "docs", file_type: "0" }]
    }
    if (parentId === "d1") {
      return [
        { fid: "f1", filename: "report.pdf", file_type: "1", size: 7 },
        { fid: "d2", filename: "sub", file_type: "0" },
      ]
    }
    return []
  }
  const ops: Array<{ op: string; args: any[] }> = []
  ;(client as any).rename = async (...args: any[]) => {
    ops.push({ op: "rename", args })
  }
  ;(client as any).remove = async (...args: any[]) => {
    ops.push({ op: "remove", args })
  }
  ;(client as any).move = async (...args: any[]) => {
    ops.push({ op: "move", args })
  }
  return { driver, ops }
}

test("F-397: 文件的 rename/remove/move 按任意条目类型解析（不再报 Directory not found）", async () => {
  const { driver, ops } = stubTree()

  await driver.rename("/docs/report.pdf", "/docs/report.pdf", "r2.pdf")
  await driver.remove("/docs/report.pdf", "/docs/report.pdf", ["report.pdf"])
  await driver.move(
    "/docs",
    "/docs",
    ["report.pdf"],
    "/docs/report.pdf",
    "/docs/report.pdf",
  )

  assert.deepEqual(
    ops.map((o) => [o.op, o.args[0]]),
    [
      ["rename", "f1"],
      ["remove", "f1"],
      ["move", "f1"],
    ],
  )
  // 目标目录解析为 /docs 的 fid
  assert.equal(ops[2].args[1], "d1")
})

test("F-397: 目录操作仍然正常", async () => {
  const { driver, ops } = stubTree()
  await driver.rename("/docs/sub", "/docs/sub", "sub2")
  assert.deepEqual(ops[0], { op: "rename", args: ["d2", "sub2"] })
})

test("F-400: init() 取回 user_id，proof_seed1 用真实 user_id 计算", async () => {
  const client = new ClientQuarkOpen({ refresh_token: "r" } as any)
  const bodies: any[] = []
  ;(client as any).request = async (pathname: string, _m: string, body: any) => {
    if (pathname === "/open/v1/user/info") {
      return { status: 200, errno: 0, data: { user_id: "u-42" } }
    }
    bodies.push(body)
    return { status: 200, errno: 0, data: { finish: true } }
  }
  ;(client as any).generateSign = async () => ({
    tm: "1",
    token: "tok",
    reqId: "rid",
  })

  await client.init()

  const ok = await client.rapidUpload({
    parentId: "d1",
    fileName: "a.bin",
    size: 100,
    md5: "0".repeat(32),
    sha1: "0".repeat(40),
    readRange: async () => new Uint8Array(8),
  })

  assert.equal(ok, true)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].proof_seed1, md5("u-42tok"))
  assert.notEqual(bodies[0].proof_seed1, md5("tok"), "不能再是空 user_id")
})

test("F-400: 拿不到 user_id 时 init() 失败，而不是生成必然无效的 proof", async () => {
  const client = new ClientQuarkOpen({ refresh_token: "r" } as any)
  ;(client as any).request = async () => ({
    status: 200,
    errno: 0,
    data: { user_id: "" },
  })
  await assert.rejects(() => client.init(), /failed to get user ID/)
})
