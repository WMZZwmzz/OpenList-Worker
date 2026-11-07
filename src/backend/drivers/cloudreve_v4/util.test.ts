import test from "node:test"
import assert from "node:assert/strict"
import { ClientCloudreve, unwrapEnvelope } from "./util"

function stubFetch(
  handler: (url: string, init?: RequestInit) => { status?: number; body: any },
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const { status = 200, body } = handler(String(input), init)
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

test("F-456: unwrapEnvelope 解包 {code,data,msg}", () => {
  assert.deepEqual(unwrapEnvelope({ code: 0, data: { token: "t" }, msg: "" }, 200), {
    token: "t",
  })
  assert.throws(
    () => unwrapEnvelope({ code: 40001, data: null, msg: "credential invalid" }, 200),
    /credential invalid/,
  )
  // 无信封的裸 JSON：HTTP 2xx 原样返回，>=400 抛错
  assert.deepEqual(unwrapEnvelope({ files: [] }, 200), { files: [] })
  assert.throws(() => unwrapEnvelope({ message: "boom" }, 500), /boom/)
  assert.equal(unwrapEnvelope(null, 204), null)
})

test("F-456: login 从信封 data.token 取令牌并用于后续请求", async () => {
  const seen: { url: string; auth?: string }[] = []
  const restore = stubFetch((url, init) => {
    seen.push({ url, auth: (init?.headers as any)?.Authorization })
    if (url.endsWith("/api/v4/session")) {
      return { body: { code: 0, data: { token: "tok-1", refresh_token: "ref-1" }, msg: "" } }
    }
    return {
      body: {
        code: 0,
        data: {
          files: [{ id: "1", path: "/a.txt", name: "a.txt", size: 10, type: 0 }],
          pagination: { next_token: "" },
        },
        msg: "",
      },
    }
  })
  try {
    const client = new ClientCloudreve({
      address: "https://cloud.example.com",
      username: "u",
      password: "p",
    })
    await client.init()
    const files = await client.listFiles("/")
    assert.equal(files.length, 1)
    assert.equal(files[0].name, "a.txt")
    assert.equal(seen[1].auth, "Bearer tok-1")
  } finally {
    restore()
  }
})

test("F-456: listFiles 读取信封内的 files/pagination 并翻页", async () => {
  const tokens: string[] = []
  const restore = stubFetch((url) => {
    const token = new URL(url).searchParams.get("next_page_token") || ""
    tokens.push(token)
    if (!token) {
      return {
        body: {
          code: 0,
          data: {
            files: [{ id: "1", path: "/a", name: "a", size: 1, type: 0 }],
            pagination: { next_token: "N2" },
          },
        },
      }
    }
    return {
      body: {
        code: 0,
        data: {
          files: [{ id: "2", path: "/b", name: "b", size: 2, type: 0 }],
          pagination: { next_token: "" },
        },
      },
    }
  })
  try {
    const client = new ClientCloudreve({ address: "https://cloud.example.com", access_token: "t" })
    const files = await client.listFiles("/")
    assert.deepEqual(files.map((f) => f.name), ["a", "b"])
    assert.deepEqual(tokens, ["", "N2"])
  } finally {
    restore()
  }
})

test("F-456: getDownloadUrl 读取信封内的 urls 并透出业务错误", async () => {
  let mode: "ok" | "err" = "ok"
  const restore = stubFetch(() =>
    mode === "ok"
      ? { body: { code: 0, data: { urls: [{ url: "https://dl.example/x" }] } } }
      : { body: { code: 40001, msg: "no permission", data: null } },
  )
  try {
    const client = new ClientCloudreve({ address: "https://cloud.example.com", access_token: "t" })
    assert.equal(await client.getDownloadUrl("/a.txt"), "https://dl.example/x")
    mode = "err"
    await assert.rejects(() => client.getDownloadUrl("/a.txt"), /no permission/)
  } finally {
    restore()
  }
})

test("F-456: 200 + code!=0（如 mkdir 冲突）也会抛错而不是静默成功", async () => {
  const restore = stubFetch(() => ({ status: 200, body: { code: 40004, msg: "conflict" } }))
  try {
    const client = new ClientCloudreve({ address: "https://cloud.example.com", access_token: "t" })
    await assert.rejects(() => client.mkdir("/", "x"), /conflict/)
  } finally {
    restore()
  }
})
