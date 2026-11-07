import assert from "node:assert/strict"
import { test } from "node:test"
import { DriverMediafire } from "./driver"
import { ClientMediafire } from "./util"

/**
 * F-410 / F-412 / F-414 / F-415 / F-417 / F-418 回归。
 */

type Call = { url: string; body: string }

async function withFetch<T>(
  impl: (url: URL, init: any) => Promise<Response>,
  calls: Call[],
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url))
    calls.push({ url: url.toString(), body: String(init.body || "") })
    return impl(url, init)
  }) as any
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

function contentResp(content: Record<string, any>, result = "Success") {
  return Response.json({ response: { result, folder_content: content } })
}

function newDriver(): any {
  return new DriverMediafire({ cookie: "c=1", session_token: "tok" })
}

test("F-417：pathCache 键统一（无前导斜杠）后能命中", async () => {
  const driver = newDriver()
  let listCalls = 0
  driver.client.list = async (id: string) => {
    listCalls++
    if (id === "") {
      return [{ id: "id-a", name: "a", size: 0, isDir: true, created: "" }]
    }
    return [{ id: "id-b", name: "b", size: 0, isDir: true, created: "" }]
  }

  assert.equal(await driver.resolveFolderId("/a/b"), "id-b")
  assert.equal(listCalls, 2)
  assert.equal(await driver.resolveFolderId("/a/b"), "id-b")
  assert.equal(listCalls, 2, "第二次应命中缓存，不再列目录")
  assert.equal(await driver.resolveFolderId("a"), "id-a")
  assert.equal(listCalls, 2)
})

test("F-412：get() 对不存在路径抛 not found，不再伪造条目", async () => {
  const driver = newDriver()
  driver.client.list = async () => [
    { id: "id-a", name: "a.txt", size: 1, isDir: false, created: "" },
  ]

  await assert.rejects(
    () => driver.get("/missing.txt", "/missing.txt"),
    /not found/,
  )

  // 列表失败（鉴权/网络）同样必须上抛
  driver.client.list = async () => {
    throw new Error("[MediaFire] HTTP 401")
  }
  await assert.rejects(() => driver.get("/a.txt", "/a.txt"), /HTTP 401/)
})

test("F-414：move()/copy() 使用物理目标路径而不是虚拟 dstDir", async () => {
  const driver = newDriver()
  const moved: string[] = []
  driver.client.list = async (id: string) => {
    if (id === "") {
      return [
        { id: "id-a", name: "a.txt", size: 1, isDir: false, created: "" },
        { id: "id-target", name: "target", size: 0, isDir: true, created: "" },
      ]
    }
    return []
  }
  driver.client.move = async (_id: string, dstKey: string) => {
    moved.push(dstKey)
  }
  driver.client.copy = async (_id: string, dstKey: string) => {
    moved.push(dstKey)
  }

  // 挂载在 /mount 时虚拟路径是 /mount/target，物理路径是 /target
  await driver.move("/", "/mount/target", ["a.txt"], "/a.txt", "/target/a.txt")
  await driver.copy("/", "/mount/target", ["a.txt"], "/a.txt", "/target/a.txt")

  assert.deepEqual(moved, ["id-target", "id-target"])
})

test("F-410：list() 校验 result，非 Success / 非 JSON 都抛错", async () => {
  const calls: Call[] = []
  const client = new ClientMediafire({ cookie: "c=1", session_token: "tok" })

  await withFetch(
    async () => contentResp({ folders: [], files: [] }, "Error"),
    calls,
    async () => {
      await assert.rejects(() => client.list(""), /API error: Error/)
    },
  )

  calls.length = 0
  await withFetch(
    async () => new Response("<html>login</html>", { status: 200 }),
    calls,
    async () => {
      await assert.rejects(() => client.list(""), /non-JSON response/)
    },
  )
})

test("F-415：session 失效时重新取 token 并重试一次", async () => {
  const calls: Call[] = []
  const client = new ClientMediafire({ cookie: "c=1", session_token: "old" })
  let contentAttempts = 0

  await withFetch(
    async (url) => {
      if (url.pathname.includes("get_session_token.php")) {
        return Response.json({ response: { session_token: "new" } })
      }
      contentAttempts++
      if (contentAttempts === 1) {
        return Response.json({
          response: {
            result: "Error",
            message: "Session token is invalid",
          },
        })
      }
      return contentResp({ folders: [], files: [] })
    },
    calls,
    async () => {
      const entries = await client.list("")
      assert.deepEqual(entries, [])
    },
  )

  assert.equal(contentAttempts, 3, "失败一次后重试，folders/files 各一次成功")
  assert.ok(
    calls.some((c) => c.url.includes("get_session_token.php")),
    "应重新获取 session token",
  )
  assert.ok(
    calls[calls.length - 1].body.includes("session_token=new"),
    "重试应使用新 token",
  )
})

test("F-418：modified 优先取 created_utc，坏时间不再抛 RangeError", async () => {
  const calls: Call[] = []
  const driver = newDriver()

  driver.client.list = async () => [
    {
      id: "f1",
      name: "a.txt",
      size: 1,
      isDir: false,
      created: "2015-05-11 12:49:02",
      createdUtc: "2015-05-11T17:49:02Z",
    },
    {
      id: "f2",
      name: "b.txt",
      size: 1,
      isDir: false,
      created: "not-a-date",
    },
  ]

  const items = await withFetch(
    async () => Response.json({}),
    calls,
    () => driver.list("/", "/"),
  )
  const list = items as any[]

  assert.equal(list[0].modified, "2015-05-11T17:49:02.000Z")
  assert.ok(!Number.isNaN(new Date(list[1].modified).getTime()))
})
