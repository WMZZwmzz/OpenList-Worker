import assert from "node:assert/strict"
import { test } from "node:test"
import { DriverDegoo } from "./driver"
import { ClientDegoo } from "./util"

/**
 * F-411 / F-413 / F-416 / F-417 / F-419 回归。
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

function dir(id: string, name: string, parent = "root") {
  return { ID: id, ParentID: parent, Name: name, Category: 1, Size: 0 }
}

function file(id: string, name: string, parent = "root") {
  return {
    ID: id,
    ParentID: parent,
    Name: name,
    Category: 0,
    Size: 10,
    LastModificationTime: 1700000000000,
  }
}

function newDriver(): any {
  const driver: any = new DriverDegoo({ access_token: "t" })
  driver.client.getRootId = () => "root"
  return driver
}

test("F-411：get() 未命中抛 not found，不再伪造目录", async () => {
  const driver = newDriver()
  driver.client.getFileChildren5 = async () => [file("f1", "a.txt")]

  await assert.rejects(() => driver.get("/missing", "/missing"), /not found/)

  // 根路径仍然返回目录条目
  const root = await driver.get("/", "/")
  assert.equal(root.is_dir, true)

  // 查询/鉴权失败必须上抛
  driver.client.getFileChildren5 = async () => {
    throw new Error("[Degoo] GraphQL error: Unauthorized")
  }
  await assert.rejects(() => driver.get("/a.txt", "/a.txt"), /Unauthorized/)
})

test("F-413：move() 用 dstPhysical 的父目录解析目标 ID", async () => {
  const driver = newDriver()
  const moved: string[] = []
  driver.client.getFileChildren5 = async (id: string) => {
    if (id === "root") {
      return [file("f1", "a.txt"), dir("d-target", "target")]
    }
    return []
  }
  driver.client.move = async (_id: string, dstId: string) => {
    moved.push(dstId)
  }

  // 虚拟路径带挂载前缀 /mount，物理路径没有
  await driver.move("/", "/mount/target", ["a.txt"], "/a.txt", "/target/a.txt")
  assert.deepEqual(moved, ["d-target"])
})

test("F-417：pathToId 缓存键与查找键一致后能命中", async () => {
  const driver = newDriver()
  let calls = 0
  driver.client.getFileChildren5 = async () => {
    calls++
    return [dir("d-a", "a")]
  }

  assert.equal(await driver.pathToId("/a"), "d-a")
  assert.equal(calls, 1)
  assert.equal(await driver.pathToId("/a"), "d-a")
  assert.equal(calls, 1, "第二次应命中缓存")
})

test("F-416：Unauthorized 重试有上限，且无凭据时不调用 login", async () => {
  const calls: Call[] = []

  // 无 username/password：直接抛原始错误
  const clientNoCreds = new ClientDegoo({ access_token: "t" })
  ;(clientNoCreds as any).isTokenExpired = () => false
  await withFetch(
    async () =>
      Response.json({
        errors: [{ errorType: "Unauthorized", message: "denied" }],
      }),
    calls,
    async () => {
      await assert.rejects(
        () => (clientNoCreds as any).apiCall("Op", "query {}", {}),
        /GraphQL error: denied/,
      )
    },
  )
  assert.equal(calls.length, 1, "无凭据时不应尝试 login")

  // 有 username/password：login 后只重试一次
  calls.length = 0
  const client = new ClientDegoo({
    access_token: "t",
    username: "u",
    password: "p",
  })
  ;(client as any).isTokenExpired = () => false
  await withFetch(
    async (url) => {
      if (url.hostname === "rest-api.degoo.com") {
        return Response.json({ Token: "t2" })
      }
      return Response.json({
        errors: [{ errorType: "Unauthorized", message: "still denied" }],
      })
    },
    calls,
    async () => {
      await assert.rejects(
        () => (client as any).apiCall("Op", "query {}", {}),
        /GraphQL error: still denied/,
      )
    },
  )
  assert.equal(calls.length, 3, "graphql → login → graphql，共 3 次请求后抛错")
})

test("F-419：JWT payload 无有效 exp 时视为已过期", () => {
  const client = new ClientDegoo({ access_token: "" })
  const makeToken = (payload: Record<string, unknown>) => {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url")
    return `${b64({ alg: "none" })}.${b64(payload)}.sig`
  }

  ;(client as any).accessToken = makeToken({ sub: "u" })
  assert.equal((client as any).isTokenExpired(), true, "缺 exp 应视为过期")

  ;(client as any).accessToken = makeToken({ exp: "abc" })
  assert.equal((client as any).isTokenExpired(), true, "非法 exp 应视为过期")

  ;(client as any).accessToken = makeToken({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  assert.equal((client as any).isTokenExpired(), false, "有效 exp 不过期")

  ;(client as any).accessToken = makeToken({
    exp: Math.floor(Date.now() / 1000) - 3600,
  })
  assert.equal((client as any).isTokenExpired(), true, "过期 exp 视为过期")
})
