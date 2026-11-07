import assert from "node:assert/strict"
import test from "node:test"
import { Hono } from "hono"
import { __resetDbCacheForTest, saveDb } from "../internal/model/db"
import { mcpRouter } from "./mcp"

const env = () => ({
  JWT_SECRET: "mcp-test-secret-0123456789abcdef",
  // api_token 必须 >= 16 字符，否则会被 isStaticApiToken 拒绝（短 token 防护）
  API_TOKEN: "mcp-token-0123456789abcdef",
})
const auth = { Authorization: "Bearer mcp-token-0123456789abcdef" }

async function seededEnv() {
  __resetDbCacheForTest()
  const e: any = env()
  await saveDb(
    {
      settings: [],
      users: [
        {
          id: 1,
          username: "admin",
          password: "deadbeef",
          role: 2,
          permission: 0,
          base_path: "/",
          disabled: false,
        },
      ],
      storages: [],
      shares: [],
      metas: [],
    },
    e,
    { force: true },
  )
  return e
}

const appOf = () => {
  const app = new Hono()
  app.route("/mcp", mcpRouter)
  return app
}

test("F-049: /sse 必须返回 Content-Type: text/event-stream", async () => {
  const e = await seededEnv()
  const res = await appOf().request("/mcp/sse", { headers: auth }, e)
  assert.equal(res.status, 200)
  assert.equal(
    res.headers.get("content-type"),
    "text/event-stream",
    "c.text() 会用默认 text/plain 覆盖先前 c.header 设置的值",
  )
  assert.equal(res.headers.get("cache-control"), "no-cache")
  assert.match(String(await res.text()), /^event: endpoint\ndata: /)
})

test("F-118: JSON-RPC 协议错误以 HTTP 200 返回，语义在 body 的 error 对象里", async () => {
  const e = await seededEnv()
  const res = await appOf().request(
    "/mcp/messages",
    {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "does/not/exist" }),
    },
    e,
  )
  assert.equal(
    res.status,
    200,
    "HTTP 404 在 MCP 传输层专指会话失效，不能用来表达 -32601",
  )
  const json: any = await res.json()
  assert.equal(json.jsonrpc, "2.0")
  assert.equal(json.id, 7)
  assert.equal(json.error?.code, -32601)
})

test("F-118: 非法 JSON-RPC 请求（HTTP 层问题）仍回 400", async () => {
  const e = await seededEnv()
  const res = await appOf().request(
    "/mcp/messages",
    {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1 }),
    },
    e,
  )
  assert.equal(res.status, 400)
  const json: any = await res.json()
  assert.equal(json.error?.code, -32600)
})
