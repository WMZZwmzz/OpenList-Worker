import assert from "node:assert/strict"
import { test } from "node:test"
import { kvDriver } from "./kv"
import type { Driver } from "../types"

/**
 * KV 驱动读取语义回归（F-087 / F-088）。
 *
 * F-087：CF 的 get(key,"text") 对不存在的键正常返回 null（不抛错），历史实现却以
 * `value == null` 为条件重试第二种签名 —— 每次 miss 都多一次真实 KV 读，读配额翻倍。
 * F-088：签名判定用消息正则 /invalid|unexpected|argument/i 猜测，真实存储故障
 * （"Invalid argument"、"WRONGPASS invalid ..."）会被吞成「键不存在」。
 */

function makeKvBinding(impl: {
  get: (key: string, arg?: any) => Promise<any>
}) {
  const calls: any[] = []
  const env = {
    KV: {
      get: async (key: string, arg?: any) => {
        calls.push(arg)
        return impl.get(key, arg)
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true }),
    },
  }
  return { env, calls }
}

test("F-087: miss 只消耗一次 KV 读（不再为 null 结果重试第二种签名）", async () => {
  const { env, calls } = makeKvBinding({ get: async () => null })
  const value = await (kvDriver as Driver).get("missing", env)
  assert.equal(value, null)
  assert.equal(calls.length, 1, `miss 应只读一次，实际 ${calls.length} 次`)
})

test("F-087: 命中同样只读一次", async () => {
  const { env, calls } = makeKvBinding({ get: async () => "hello" })
  const value = await kvDriver.get("k", env)
  assert.equal(value, "hello")
  assert.equal(calls.length, 1)
})

test("F-088: 签名不兼容（TypeError）时才回退第二种签名", async () => {
  const { env, calls } = makeKvBinding({
    get: async (_key, arg) => {
      if (arg === "text") throw new TypeError("get() takes 1 argument")
      return "fallback-value"
    },
  })
  const value = await kvDriver.get("k", env)
  assert.equal(value, "fallback-value")
  assert.equal(calls.length, 2, "签名回退必须仍然可用")
})

for (const message of [
  "Invalid argument",
  "WRONGPASS invalid username-password pair",
  "unexpected status 502 from KV backend",
]) {
  test(`F-088: 真实故障 "${message}" 必须原样抛出，不得伪装成键不存在`, async () => {
    const { env } = makeKvBinding({
      get: async () => {
        throw new Error(message)
      },
    })
    await assert.rejects(
      () => kvDriver.get("k", env),
      new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    )
  })
}

test("F-088: 两种签名都不兼容时抛出可诊断错误（而不是返回 null）", async () => {
  const { env } = makeKvBinding({
    get: async () => {
      throw new TypeError("invalid arguments")
    },
  })
  await assert.rejects(
    () => kvDriver.get("k", env),
    /rejected both get\(\) signatures/i,
  )
})
