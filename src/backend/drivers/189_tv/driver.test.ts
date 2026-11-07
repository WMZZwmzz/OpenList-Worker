import assert from "node:assert/strict"
import { test } from "node:test"

import { Driver189TV } from "./driver"

function stubDriver() {
  const driver = new Driver189TV({ access_token: "t", type: "personal" })
  const moves: Array<{ id: string; target: string }> = []
  const copies: Array<{ id: string; target: string }> = []
  ;(driver as any).client.getFiles = async (parentId: string) => {
    if (parentId !== "-11") return []
    return [
      { id: "300", parentId: 0, name: "photos" },
      { id: "f-a", name: "a.txt", size: 5 },
    ]
  }
  ;(driver as any).client.move = async (
    id: string,
    _isFolder: boolean,
    _name: string,
    target: string,
  ) => {
    moves.push({ id, target })
  }
  ;(driver as any).client.copy = async (
    id: string,
    _isFolder: boolean,
    _name: string,
    target: string,
  ) => {
    copies.push({ id, target })
  }
  return { driver, moves, copies }
}

test("189TV move resolves the target dir from dstPhysical, not the virtual dstDir", async () => {
  const { driver, moves } = stubDriver()
  // 挂载在 /189tv：虚拟 dstDir=/189tv/photos，物理目标项=/photos/a.txt
  await driver.move("/189tv", "/189tv/photos", ["a.txt"], "/a.txt", "/photos/a.txt")
  assert.deepEqual(moves, [{ id: "f-a", target: "300" }])
})

test("189TV copy resolves the target dir from dstPhysical, not the virtual dstDir", async () => {
  const { driver, copies } = stubDriver()
  await driver.copy("/189tv", "/189tv/photos", ["a.txt"], "/a.txt", "/photos/a.txt")
  assert.deepEqual(copies, [{ id: "f-a", target: "300" }])
})

test("189TV honours root_folder_id (with Go-style family/personal defaults)", async () => {
  const personal = new Driver189TV({
    access_token: "t",
    type: "personal",
    root_folder_id: "12345",
  })
  const queried: string[] = []
  ;(personal as any).client.getFiles = async (parentId: string) => {
    queried.push(parentId)
    return [{ id: "f-a", name: "a.txt", size: 1 }]
  }
  await personal.list("/", "/")
  assert.deepEqual(queried, ["12345"], "personal root must be the configured id")

  const family = new Driver189TV({
    access_token: "t",
    type: "family",
    root_folder_id: "-11",
  })
  const familyQueried: string[] = []
  ;(family as any).client.getFiles = async (parentId: string) => {
    familyQueried.push(parentId)
    return []
  }
  await family.list("/", "/")
  assert.deepEqual(
    familyQueried,
    [""],
    'family root "-11" must be normalised to ""',
  )
})

test("189TV get propagates listing errors instead of returning a fake empty folder", async () => {
  const driver = new Driver189TV({ access_token: "t", type: "personal" })
  ;(driver as any).client.getFiles = async () => {
    throw new Error("[189TV] session expired after retry")
  }
  await assert.rejects(
    () => driver.get("/a.txt", "/a.txt"),
    /session expired/,
  )

  const missing = new Driver189TV({ access_token: "t", type: "personal" })
  ;(missing as any).client.getFiles = async () => [
    { id: "f-other", name: "other.txt", size: 1 },
  ]
  await assert.rejects(() => missing.get("/a.txt", "/a.txt"), /not found/)
})

test("189TV put hands the buffer to the client without an extra full copy", async () => {
  const driver = new Driver189TV({ access_token: "t", type: "personal" })
  let received: unknown
  ;(driver as any).client.upload = async (
    _parentId: string,
    _name: string,
    content: Uint8Array,
  ) => {
    received = content
  }
  const buf = Buffer.from("payload")
  await driver.put("/a.txt", "/a.txt", buf)
  assert.equal(received, buf, "Buffer must be passed through by reference")
})

test("189TV getFiles aborts with a readable error once the subrequest budget is exhausted", async () => {
  const originalFetch = globalThis.fetch
  // 每页都返回满 130 条，制造无限分页
  const folders = Array.from({ length: 130 }, (_, i) => ({
    id: `d-${i}`,
    parentId: 0,
    name: `d-${i}`,
  }))
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ fileListAO: { count: 130, folderList: folders } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch

  try {
    const driver = new Driver189TV({ access_token: "t", type: "personal" })
    ;(driver as any).client.tokenInfo = {
      sessionKey: "k",
      sessionSecret: "s",
    }
    await assert.rejects(() => driver.list("/", "/"), /子请求/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
