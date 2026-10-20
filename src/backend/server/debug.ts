import { Hono } from "hono"
import { getDb, getStoreStatus } from "../internal/model/db"
import { checkAdminAuth } from "../pkg/utils"
import { getSingleFlightStats } from "../pkg/singleflight"
import { adminAuthMiddleware } from "./middlewares"

export const debugRouter = new Hono()

// L-5：整个 /debug 收进管理员鉴权。此前匿名请求也能拿到存储后端指纹
// （driver / format / KV·D1·MySQL 是否生效），是一次零成本的侦察面；
// 需要匿名探活时用 /healthz。
debugRouter.use("/info", adminAuthMiddleware)

debugRouter.get("/info", async (c) => {
  const isAdmin = await checkAdminAuth(c)
  const db = await getDb(c.env)

  const storeStatus: any = await getStoreStatus(c.env)
  // 驱动 health 里的 error 文本常带 endpoint / DSN / 路径细节，匿名请求只保留
  // 连接状态本身，管理员仍能看到原文便于排障。
  const store = isAdmin
    ? storeStatus
    : {
        ...storeStatus,
        ...(typeof storeStatus?.error === "string"
          ? { error: "[redacted: admin only]" }
          : {}),
      }

  const responseData: any = {
    runtime: "Cloudflare Workers / Edge",
    timestamp: new Date().toISOString(),
    // 后端驱动信息非敏感，未登录也返回，便于确认 D1/KV/MySQL 是否生效
    store,
    // singleflight 去重统计：用于确认跨实例协调是否真的生效
    // （coalesced/shared 持续为 0 说明没有并发重复调用，或协调未生效）
    singleflight: getSingleFlightStats(),
  }

  if (isAdmin) {
    responseData.db_state = {
      storages_count: db.storages?.length || 0,
      users_count: db.users?.length || 0,
      metas_count: db.metas?.length || 0,
      settings_count: db.settings?.length || 0,
    }
  }

  return c.json({
    code: 200,
    message: "OpenList debug profile generated",
    data: responseData,
  })
})
