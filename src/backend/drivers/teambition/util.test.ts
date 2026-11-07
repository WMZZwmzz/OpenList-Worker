import test from "node:test"
import assert from "node:assert/strict"
import { ClientTeambition } from "./util"

function makeClient() {
  return new ClientTeambition({
    cookie: "tb_cookie=abc",
    project_id: "proj",
  } as any)
}

function withFetch(
  handler: () => Response,
): { restore: () => void; calls: () => number } {
  const original = globalThis.fetch
  let count = 0
  globalThis.fetch = (async () => {
    count++
    return handler()
  }) as typeof fetch
  return {
    restore: () => {
      globalThis.fetch = original
    },
    calls: () => count,
  }
}

test("F-449: 非 2xx 且错误体不含 name/message 时必须抛错", async () => {
  const stub = withFetch(() => new Response(JSON.stringify({ code: 403 }), { status: 403 }))
  try {
    await assert.rejects(() => makeClient().getFiles("root"), /HTTP 403/)
  } finally {
    stub.restore()
  }
})

test("F-449: cookie 过期重定向到登录页（200 HTML）不再被当成空列表", async () => {
  const stub = withFetch(
    () => new Response("<html>login</html>", { status: 200 }),
  )
  try {
    await assert.rejects(() => makeClient().getFiles("root"), /non-JSON/)
  } finally {
    stub.restore()
  }
})

test("F-449: 服务端 name/message 错误仍优先展示", async () => {
  const stub = withFetch(
    () =>
      new Response(JSON.stringify({ name: "Forbidden", message: "no perm" }), {
        status: 403,
      }),
  )
  try {
    await assert.rejects(() => makeClient().getFiles("root"), /no perm/)
  } finally {
    stub.restore()
  }
})

test("F-449: 正常 JSON 响应不受影响", async () => {
  const stub = withFetch(
    () => new Response(JSON.stringify([{ _id: "1", title: "dir" }]), { status: 200 }),
  )
  try {
    const res = await makeClient().getFiles("root")
    assert.equal(res.folders.length, 1)
  } finally {
    stub.restore()
  }
})
