import { Hono } from "hono"
import { handleMcpJsonRpc } from "../internal/mcp/mcp"
import { adminAuthMiddleware } from "./middlewares"

export const mcpRouter = new Hono()

// MCP 端点要求管理员鉴权（当前为占位实现，仅暴露工具 schema；
// 加鉴权防止未授权探测 / 未来接入真实能力时的越权访问）
mcpRouter.use("*", adminAuthMiddleware)

mcpRouter.get("/sse", (c) => {
  // F-049：不能先 c.header("Content-Type", "text/event-stream") 再 c.text()——
  // Hono 的 c.text() 会带默认 Content-Type: text/plain 并覆盖已设置的头，
  // 导致响应体是 SSE 文本而头声明为 text/plain，按 content-type 校验事件流的
  // MCP 客户端会拒绝连接。用 c.body() 显式给出完整的客户端可见头。
  return c.body(`event: endpoint\ndata: /api/mcp/messages\n\n`, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
})

mcpRouter.post("/messages", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { method, id, params } = body

  if (!method) {
    // HTTP 层问题（body 不是合法 JSON-RPC 请求）才回 4xx
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request" },
        id: id || null,
      },
      400,
    )
  }

  const responseRpc = await handleMcpJsonRpc(method, id, params, c.env)
  // F-118：JSON-RPC 协议级错误（-32601 / -32602 等）必须以 HTTP 200 返回，
  // 由 body 内的 error 对象表达语义。历史实现把任何 error 映射成 404，但 404 在
  // MCP 传输层有专指语义（会话失效→重新 initialize），会让客户端把协议错误当成
  // 传输层失败。
  return c.json(responseRpc, 200)
})
