import assert from "node:assert/strict"
import { test } from "node:test"
import { blobDriver } from "./blob"

/**
 * Blob 驱动回归（F-085 / F-089）。
 *
 * F-085：ESA health 曾用 head("__health_check__") 探测一个全仓库从未写入过的键，
 * 且不处理 not-found —— 读取不存在的键抛错就报 available:false（ESA 默认主存储
 * 因此全站 503）；若平台静默返回 null，这条探测又什么都没验证。
 * F-089：ESA list 分页是裸 do/while(cursor)，没有游标推进/重复页/迭代上限防护
 * （kv.ts 因 issue #125 修过的同类缺陷）。
 */

/** 构造 ESA Blob binding 桩 */
function makeEsaBlob(opts: {
  get?: (key: string) => Promise<any>
  list?: (arg: { prefix: string; cursor?: string }) => Promise<any>
}) {
  return {
    get: opts.get ?? (async () => null),
    put: async () => {},
    delete: async () => {},
    head: async () => {
      throw new Error("head should not be used by health()")
    },
    list: opts.list ?? (async () => ({ keys: [], cursor: undefined })),
  }
}

test("F-085: ESA health 用 get 探测，not-found 视为健康（不再 503）", async () => {
  const env = {
    ESA_BLOB: makeEsaBlob({
      get: async () => {
        const err: any = new Error("NoSuchKey: not found")
        err.code = "NoSuchKey"
        throw err
      },
    }),
  }
  const health = await blobDriver.health(env)
  assert.equal(health.available, true, "读不到探测键 = 绑定可用，不得报不可用")
})

test("F-085: ESA health 的读取故障仍报不可用", async () => {
  const env = {
    ESA_BLOB: makeEsaBlob({
      get: async () => {
        throw new Error("403 Forbidden")
      },
    }),
  }
  const health = await blobDriver.health(env)
  assert.equal(health.available, false)
  assert.match(String(health.error), /403/)
})

test("F-089: list 游标不推进时立即终止（不得同页空转）", async () => {
  let calls = 0
  const env = {
    ESA_BLOB: makeEsaBlob({
      list: async ({ prefix, cursor }) => {
        calls += 1
        return {
          keys: [{ name: `${prefix}a.txt` }, { name: `${prefix}b.txt` }],
          cursor: "same-cursor",
        }
      },
    }),
  }

  const keys = await blobDriver.list("d/", env)
  assert.deepEqual(keys.sort(), ["d/a.txt", "d/b.txt"])
  assert.ok(calls <= 2, `游标不推进必须终止（实际调用 ${calls} 次）`)
})

test("F-089: 正常分页会被完整聚合且去重", async () => {
  const pages: Record<string, any> = {
    "": { keys: [{ name: "a" }, { name: "b" }], cursor: "c2" },
    c2: { keys: [{ name: "b" }, { name: "c" }], cursor: undefined },
  }
  const env = {
    ESA_BLOB: makeEsaBlob({
      list: async ({ cursor }) => pages[String(cursor ?? "")],
    }),
  }

  const keys = await blobDriver.list("", env)
  assert.deepEqual(keys.sort(), ["a", "b", "c"], "跨页聚合且去重")
})

test("F-089: 非字符串 name 被过滤（与 kv.ts 的类型防御一致）", async () => {
  const env = {
    ESA_BLOB: makeEsaBlob({
      list: async () => ({ keys: [{ name: "ok" }, { name: 42 }, {}], cursor: undefined }),
    }),
  }
  const keys = await blobDriver.list("", env)
  assert.deepEqual(keys, ["ok"])
})
