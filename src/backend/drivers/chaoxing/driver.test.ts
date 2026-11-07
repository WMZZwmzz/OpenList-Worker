import test from "node:test"
import assert from "node:assert/strict"
import { DriverChaoXing } from "./driver"
import { ClientChaoXing } from "./util"
import { ChaoXingFile } from "./types"

function makeDriver(tree: Record<string, ChaoXingFile[]>) {
  const driver = new DriverChaoXing({
    user_name: "u",
    password: "p",
    bbsid: "b",
  })
  const ids: string[] = []
  const moves: [string, string, boolean][] = []
  ;(driver as any).client = {
    getFiles: async (id: string) => {
      ids.push(id)
      return tree[id] || []
    },
    move: async (id: string, dstId: string, isDir: boolean) => {
      moves.push([id, dstId, isDir])
    },
    link: async (fileId: string) => ({ download: `https://dl/${fileId}` }),
    downloadHeaders: () => ({}),
  }
  return { driver, ids, moves }
}

const dir = (id: number, name: string): ChaoXingFile => ({
  id,
  content: { folderName: name },
})
const file = (id: number, name: string, fileId: string): ChaoXingFile => ({
  id,
  content: { name, fileId },
})

test("F-365: move 用 dstPhysical 的父目录解析目标 ID，而非虚拟 dstDir", async () => {
  const { driver, moves } = makeDriver({
    "-1": [dir(2, "target"), file(11, "a.txt", "f1")],
    "2": [],
  })
  await driver.move("/cx", "/cx/target", ["a.txt"], "/a.txt", "/target/a.txt")
  assert.deepEqual(moves, [["11", "2", false]])
})

test("F-367: get() 对不存在路径抛 not found 而不是伪造文件", async () => {
  const { driver } = makeDriver({ "-1": [] })
  await assert.rejects(
    () => driver.get("", "/missing.txt"),
    /Directory 'missing.txt' not found/,
  )
})

test("F-367: get() 不再吞掉上游 API 异常", async () => {
  const { driver } = makeDriver({})
  ;(driver as any).client.getFiles = async () => {
    throw new Error("[ChaoXing] request failed: HTTP 503")
  }
  await assert.rejects(() => driver.get("", "/file.txt"), /HTTP 503/)
})

test("F-367: get() 对真实文件返回下载链接", async () => {
  const { driver } = makeDriver({ "-1": [file(5, "a.txt", "fid1")] })
  const item = await driver.get("", "/a.txt")
  assert.equal(item.is_dir, false)
  assert.equal(item.raw_url, "https://dl/fid1")
})

test("F-370: getFiles 对 recType=2 响应检查 result", async () => {
  const client = new ClientChaoXing({
    user_name: "u",
    password: "p",
    bbsid: "b",
    cookie: "uid=1",
  })
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes("recType=2")) {
      return new Response(JSON.stringify({ result: 0, msg: "err" }), {
        status: 200,
      })
    }
    return new Response(JSON.stringify({ result: 1, list: [] }), { status: 200 })
  }) as any
  try {
    await assert.rejects(() => client.getFiles("-1"), /list files failed/)
  } finally {
    globalThis.fetch = original
  }
})

test("F-368: 鉴权失败（401）后重登一次并持久化新 cookie", async () => {
  let persisted = ""
  const client = new ClientChaoXing(
    { user_name: "u", password: "p", bbsid: "b", cookie: "old=1" },
    (cookie) => {
      persisted = cookie
    },
  )
  const original = globalThis.fetch
  let apiCalls = 0
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes("passport2.chaoxing.com")) {
      return new Response("", {
        status: 200,
        headers: { "set-cookie": "uid=1; Path=/; HttpOnly" },
      })
    }
    apiCalls++
    if (apiCalls === 1) return new Response("", { status: 401 })
    return new Response(JSON.stringify({ result: 1, list: [] }), { status: 200 })
  }) as any
  try {
    const files = await client.getFiles("-1")
    assert.deepEqual(files, [])
  } finally {
    globalThis.fetch = original
  }
  assert.equal(persisted, "uid=1")
  assert.equal(apiCalls, 3)
})

test("F-372: pathCache 读写键一致，第二次路径解析命中缓存", async () => {
  const { driver, ids } = makeDriver({
    "-1": [dir(1, "a")],
    "1": [dir(2, "b")],
    "2": [],
  })
  await driver.list("", "/a/b")
  assert.deepEqual(ids, ["-1", "1", "2"])

  ids.length = 0
  await driver.list("", "/a/b")
  assert.deepEqual(ids, ["2"])
})

test("F-374: root_folder_id 作为 pathToId 根 ID", async () => {
  const driver = new DriverChaoXing({
    user_name: "u",
    password: "p",
    bbsid: "b",
    root_folder_id: "77",
  })
  const ids: string[] = []
  ;(driver as any).client = {
    getFiles: async (id: string) => {
      ids.push(id)
      return []
    },
  }
  await driver.list("", "/")
  assert.deepEqual(ids, ["77"])
})
