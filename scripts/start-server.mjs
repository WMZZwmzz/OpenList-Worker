/**
 * 自托管 Node 启动入口。
 *
 * A-33：历史 `npm start` 直接执行 `node dist-server/api/[...route].js`，
 * 该产物只导出 handle，不会监听端口，进程启动后立即退出。这里用
 * @hono/node-server 显式监听，并复用构建产物导出的 fetch 句柄。
 */
import path from "node:path"
import { pathToFileURL } from "node:url"
import { serve } from "@hono/node-server"

const entry = pathToFileURL(
  path.resolve("dist-server/api/[...route].js"),
).href

let mod
try {
  mod = await import(entry)
} catch (err) {
  console.error(
    `[start] failed to load ${entry}. Run "pnpm build" first.`,
    err?.message || err,
  )
  process.exit(1)
}

const app = mod.default
if (!app || typeof app.fetch !== "function") {
  console.error(
    "[start] build output does not export a fetch handler; rebuild with pnpm build.",
  )
  process.exit(1)
}

const port = parseInt(process.env.PORT || "3000", 10)
const hostname = process.env.HOST || "0.0.0.0"

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[start] OpenList listening on http://${hostname}:${info.port}`)
})
