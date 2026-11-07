import assert from "node:assert/strict"
import { test } from "node:test"
import { OpenListDB } from "./OpenListDB"

/**
 * Durable Object 回归（F-119）。
 *
 * 历史实现让 kvGet / kvPut / kvDelete / kvList / sqlQuery / sqlExecute / sqlBatch /
 * health 共 8 个 RPC 方法每次调用都先全量重放 11 条 DDL（KV 表 + 8 条列式表 +
 * 2 条 singleflight）。key 格式按 key 逐个 get，于是 N 个实体 = N 次 RPC × 11 条
 * DDL，属稳定的每请求重计算。
 *
 * 修复：实例上缓存「已建表」标志，只在首次成功后跳过；失败不置位（下次重试）。
 */

type FakeState = {
  state: any
  execCount: () => number
  ddlCount: () => number
}

function makeSqliteState(opts: { failFirstDdl?: boolean } = {}): FakeState {
  const store = new Map<string, string>() // kv 表
  let execs = 0
  let ddls = 0
  let failedOnce = false

  const isDdl = (sql: string) => /^\s*CREATE\s+(TABLE|INDEX)/i.test(sql)

  return {
    state: {
      storage: {
        sql: {
          exec(sql: string, ...params: any[]) {
            execs += 1
            if (isDdl(sql)) {
              ddls += 1
              if (opts.failFirstDdl && !failedOnce) {
                failedOnce = true
                throw new Error("DO storage not ready")
              }
            }
            return {
              toArray() {
                if (/^SELECT 1/i.test(sql.trim())) return [{ 1: 1 }]
                if (/^SELECT value FROM kv WHERE key = \?/i.test(sql.trim())) {
                  const v = store.get(String(params[0]))
                  return v === undefined ? [] : [{ value: v }]
                }
                if (/^SELECT key FROM kv/i.test(sql.trim())) {
                  const prefix = String(params[0]).replace(/%$/, "")
                  return [...store.keys()]
                    .filter((k) => k.startsWith(prefix))
                    .sort()
                    .map((key) => ({ key }))
                }
                return []
              },
            }
          },
        },
        transactionSync(fn: () => void) {
          fn()
          return true
        },
      },
    },
    execCount: () => execs,
    ddlCount: () => ddls,
  }
}

// kvPut/kvGet 需要写入真实 Map —— 用 exec 的参数拦截实现最小可用的 kv 表
function makeWritableState() {
  const store = new Map<string, string>()
  let ddls = 0
  const sql = {
    exec(sqlText: string, ...params: any[]) {
      if (/^\s*CREATE\s+(TABLE|INDEX)/i.test(sqlText)) {
        ddls += 1
        return { toArray: () => [] }
      }
      const insert = sqlText.match(/^INSERT OR REPLACE INTO kv/i)
      if (insert) {
        store.set(String(params[0]), String(params[1]))
        return { toArray: () => [] }
      }
      if (/^DELETE FROM kv/i.test(sqlText)) {
        store.delete(String(params[0]))
        return { toArray: () => [] }
      }
      if (/^SELECT value FROM kv WHERE key = \?/i.test(sqlText.trim())) {
        const v = store.get(String(params[0]))
        return { toArray: () => (v === undefined ? [] : [{ value: v }]) }
      }
      if (/^SELECT key FROM kv/i.test(sqlText.trim())) {
        const prefix = String(params[0]).replace(/%$/, "")
        return {
          toArray: () =>
            [...store.keys()]
              .filter((k) => k.startsWith(prefix))
              .sort()
              .map((key) => ({ key })),
        }
      }
      return { toArray: () => [] }
    },
  }
  return {
    store,
    state: {
      storage: {
        sql,
        transactionSync(fn: () => void) {
          fn()
          return true
        },
      },
    },
    ddlCount: () => ddls,
  }
}

test("F-119: 首次调用执行 DDL，后续 RPC 不再重放", async () => {
  const { state, ddlCount } = makeWritableState()
  const db = new OpenListDB(state)

  await db.kvPut("a", "1")
  const afterFirst = ddlCount()
  assert.ok(afterFirst > 0, "首次调用应建表")

  await db.kvGet("a")
  await db.kvGet("b")
  await db.kvPut("c", "3")
  await db.kvList("")
  await db.health()

  assert.equal(
    ddlCount(),
    afterFirst,
    "后续 RPC 不得重复执行 DDL（11 条 × 每次调用是纯浪费）",
  )
  assert.equal(await db.kvGet("a"), "1")
  assert.deepEqual(await db.kvList(""), ["a", "c"])
})

test("F-119: DDL 失败不置位，下次调用会重试", async () => {
  const fake = makeSqliteState({ failFirstDdl: true })
  const db = new OpenListDB(fake.state)

  await assert.rejects(() => db.health(), /DO storage not ready/)
  // 第二次应重试并成功（失败标志未被缓存）
  await db.health()
  assert.ok(fake.ddlCount() >= 2, "首次失败后必须重试建表")
})
