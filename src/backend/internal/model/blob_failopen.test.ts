/**
 * 回归测试：Blob 驱动的读取失败必须是「抛错」，不能 fail-open 成 null。
 *
 * 背景（D-2）：早期实现把所有异常都吞成 null，上层 map.load 把 null 当成
 * 「库不存在」，loadDb 于是返回一个 dbTrusted=false、dbLastLoadError=null 的
 * 空壳；`/public/init/setup` 只看 loadError，于是任何人都能在存储瞬时故障时
 * 重建管理员并 force 覆盖整库配置。
 *
 * 这里只测驱动契约：not-found → null，其它失败 → throw。
 */
import test from "node:test"
import assert from "node:assert/strict"
import { blobDriver } from "./store/driver/blob"

function esaEnv(getImpl: (key: string) => Promise<any>) {
  return {
    ESA_BLOB: {
      get: getImpl,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], cursor: undefined }),
    },
  }
}

test("读取异常必须抛出，交由 loadDb 标记 dbLastLoadError", async () => {
  const env = esaEnv(async () => {
    throw new Error("quota exceeded")
  })
  await assert.rejects(
    () => blobDriver.get!("openlist_config", env),
    /blob read failed/i,
  )
})

test("对象不存在（返回 null）仍然视为空库", async () => {
  const env = esaEnv(async () => null)
  assert.equal(await blobDriver.get!("openlist_config", env), null)
})

test("明确的 404 / NotFound 异常视为不存在", async () => {
  const notFound = Object.assign(new Error("NotFound"), { status: 404 })
  const env = esaEnv(async () => {
    throw notFound
  })
  assert.equal(await blobDriver.get!("openlist_config", env), null)
})
