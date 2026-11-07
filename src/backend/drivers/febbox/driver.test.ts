import test from "node:test"
import assert from "node:assert/strict"
import { DriverFebBox, parentPath } from "./driver"
import { ClientFebBox } from "./util"

function makeDriver() {
  const driver = new DriverFebBox({
    client_id: "cid",
    client_secret: "secret",
    refresh_token: "refresh",
  })
  // 账号根树：0 → phys → { src → { a.txt }, dst }
  const tree: Record<string, any[]> = {
    "0": [{ fid: 1, file_name: "phys", is_dir: 1, file_size: 0 }],
    "1": [
      { fid: 2, file_name: "src", is_dir: 1, file_size: 0 },
      { fid: 3, file_name: "dst", is_dir: 1, file_size: 0 },
    ],
    "2": [{ fid: 4, file_name: "a.txt", is_dir: 0, file_size: 10 }],
    "3": [],
  }
  const calls: any[][] = []
  ;(driver as any).client = {
    getFilesList: async (id: string) => tree[id] || [],
    move: async (id: string, dst: string) => calls.push(["move", id, dst]),
    copy: async (id: string, dst: string) => calls.push(["copy", id, dst]),
  }
  return { driver, calls }
}

test("F-435: parentPath 从物理路径派生父目录", () => {
  assert.equal(parentPath("/a/b/c.txt"), "/a/b")
  assert.equal(parentPath("/a.txt"), "/")
  assert.equal(parentPath("/"), "/")
})

test("F-435: move 用物理目标父目录解析 ID（虚拟路径会解析失败）", async () => {
  const { driver, calls } = makeDriver()
  // 虚拟 dstDir="/feb/dst"（挂载前缀 feb），物理目标 /phys/dst/a.txt → 目录 ID "3"
  await driver.move("/feb/src", "/feb/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  assert.deepEqual(calls[0], ["move", "4", "3"])
})

test("F-435: copy 同样用物理目标父目录", async () => {
  const { driver, calls } = makeDriver()
  await driver.copy("/feb/src", "/feb/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  assert.deepEqual(calls[0], ["copy", "4", "3"])
})

test("F-435: 目标为账号根时解析为 \"0\"（不再落入挂载前缀目录）", async () => {
  const { driver, calls } = makeDriver()
  await driver.move("/feb/src", "/feb", ["a.txt"], "/phys/src/a.txt", "/a.txt")
  assert.deepEqual(calls[0], ["move", "4", "0"])
})

test("F-437: root_folder_id 作为 pathToId 起点与 get('/') 根 sign", async () => {
  const driver = new DriverFebBox({
    client_id: "cid",
    client_secret: "secret",
    refresh_token: "refresh",
    root_folder_id: "99",
  })
  const ids: string[] = []
  ;(driver as any).client = {
    getFilesList: async (id: string) => {
      ids.push(id)
      return [
        { fid: 5, file_name: "sub", is_dir: 1, file_size: 0 },
        { fid: 6, file_name: "a.txt", is_dir: 0, file_size: 1 },
      ]
    },
  }
  const root = await driver.get("", "/")
  assert.equal(root.sign, "99")
  assert.equal(ids.length, 0)

  const item = await driver.get("", "/sub/a.txt")
  assert.equal(item.name, "a.txt")
  assert.equal(ids[0], "99")
})

test("F-438: get() 对不存在路径抛错且 API 故障向上传播", async () => {
  const driver = new DriverFebBox({ client_id: "cid", client_secret: "secret" })
  ;(driver as any).client = {
    getFilesList: async (id: string) =>
      id === "0" ? [{ fid: 1, file_name: "dir", is_dir: 1, file_size: 0 }] : [],
  }
  await assert.rejects(
    () => driver.get("", "/missing"),
    /Directory 'missing' not found/,
  )

  ;(driver as any).client = {
    getFilesList: async () => {
      throw new Error("[FebBox] auth failed")
    },
  }
  await assert.rejects(() => driver.get("", "/dir/a.txt"), /auth failed/)
})

test("F-442: pathToId 缓存读写键一致，第二次查询命中缓存", async () => {
  const driver = new DriverFebBox({ client_id: "cid", client_secret: "secret" })
  const tree: Record<string, any[]> = {
    "0": [{ fid: 1, file_name: "a", is_dir: 1, file_size: 0 }],
    "1": [{ fid: 2, file_name: "b", is_dir: 1, file_size: 0 }],
    "2": [],
  }
  const calls: string[] = []
  ;(driver as any).client = {
    getFilesList: async (id: string) => {
      calls.push(id)
      return tree[id] || []
    },
  }
  await driver.list("", "/a/b")
  assert.deepEqual(calls, ["0", "1", "2"])

  calls.length = 0
  await driver.list("", "/a/b")
  assert.deepEqual(calls, ["2"])
})

test("F-440: -10001 只刷新重试一次，不再无限递归", async () => {
  const client = new ClientFebBox({
    client_id: "cid",
    client_secret: "secret",
    refresh_token: "refresh",
  })
  const original = globalThis.fetch
  let oauthCalls = 0
  let tokenCalls = 0
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes("/oauth/token")) {
      tokenCalls++
      return new Response(
        JSON.stringify({
          code: 1,
          data: { access_token: "new", refresh_token: "refresh2" },
        }),
        { status: 200 },
      )
    }
    oauthCalls++
    return new Response(JSON.stringify({ code: -10001, server_name: "srv" }), {
      status: 200,
    })
  }) as any
  try {
    await assert.rejects(
      () => client.getFilesList("0"),
      /rejected after refresh/,
    )
  } finally {
    globalThis.fetch = original
  }
  assert.equal(tokenCalls, 1)
  assert.equal(oauthCalls, 2)
})
