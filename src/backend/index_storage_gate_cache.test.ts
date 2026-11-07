import assert from "node:assert/strict"
import { test } from "node:test"
import app, { __resetStorageGateCacheForTest } from "./index"

/**
 * F-112 回归：全局 503 拦截中间件不得逐请求执行 driver.health()。
 *
 * KV 绑定模式下一次 health 会消耗 1 次 `kv.get` + 1 次最稀缺的 `kv.list`
 *（免费版 1000 次/天）。旧实现每个非豁免请求都走 health，正常流量即可耗
 * 尽配额，之后中间件把仍然可用的存储判成不健康 → 全站 API 503（自伤回路）。
 *
 * 这里用带计数的假 KV binding 观察 health 的实际调用次数：多次请求只应触发
 * 一次 health（30s 短 TTL 缓存），清空缓存后才会重新探测。
 */

function fakeKv(counter: { get: number; list: number }) {
  return {
    async get(key: string) {
      if (key === "__health_check__") counter.get++
      return null
    },
    async put() {},
    async delete() {},
    async list(opts: any) {
      if (String(opts?.prefix || "").includes("__health_check__")) {
        counter.list++
      }
      return { keys: [], list_complete: true, cursor: "" }
    },
  }
}

test("F-112: 存储健康判定按短 TTL 缓存，不逐请求消耗 KV 配额", async () => {
  __resetStorageGateCacheForTest()
  const counter = { get: 0, list: 0 }
  const env: any = {
    DB_DRIVER: "kv",
    DB_FORMAT: "map",
    JWT_SECRET: "0123456789abcdef0123456789abcdef",
    KV: fakeKv(counter),
  }

  // 非豁免路径（无扩展名、非诊断端点）会经过存储配置拦截中间件
  const hit = () =>
    app.request(
      "/api/definitely-not-a-route",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      env,
    )

  for (let i = 0; i < 3; i++) {
    const res = await hit()
    assert.equal(res.status, 404, await res.clone().text())
  }
  assert.equal(counter.list, 1, "3 次请求只应探测一次 kv.list")
  assert.equal(counter.get, 1, "3 次请求只应探测一次 kv.get")

  // 清空缓存（等价于 TTL 到期）后重新探测
  __resetStorageGateCacheForTest()
  const after = await hit()
  assert.equal(after.status, 404, await after.clone().text())
  assert.equal(counter.list, 2)
})
