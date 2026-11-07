import assert from "node:assert/strict"
import { test } from "node:test"

/**
 * 审计日志持久化回归测试（F-072 / F-073）。
 *
 * F-072：persistAuditLogToKV 曾把任何读取/解析失败当作「首次写入」，用一条日志
 * 覆盖全部既有历史；且整组 read-modify-write 无锁，并发写互相丢失。
 * F-073：loadAuditLogsFromKV 全仓库无调用者，查询/统计只看得见当前 isolate 的
 * 内存数组，重启/换 isolate 后记录「消失」。
 *
 * 这里用 env.KV 注入一个形状合法的假 binding（get/put/set），走真实的
 * getKvBinding 探测路径。
 */

const mod = await import("./audit")
const {
  logAudit,
  queryAuditLogs,
  getAuditStats,
  loadAuditLogsFromKV,
  cleanupExpiredLogs,
  ensureAuditLogsLoaded,
  __resetAuditLogsForTest,
  __flushAuditPersistForTest,
} = mod as any

const AUDIT_KEY = "openlist_audit_logs"

function makeLog(i: number, overrides: any = {}) {
  return {
    id: `log-${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    username: "admin",
    ip: "127.0.0.1",
    action: `POST /api/test/${i}`,
    resource: `/api/test/${i}`,
    method: "POST",
    status: "success",
    status_code: 200,
    ...overrides,
  }
}

/**
 * 假 KV binding。
 *
 * @param initial 初始键值
 * @param failReads 让所有 get 抛错（模拟 401 / 网络故障）
 */
function makeEnv(
  initial: Record<string, string> = {},
  opts: { failReads?: boolean } = {},
) {
  const data = new Map<string, string>(Object.entries(initial))
  const env: any = {
    KV: {
      get: async (key: string) => {
        if (opts.failReads) throw new Error("simulated KV read failure (401)")
        return data.get(key) ?? null
      },
      put: async (key: string, value: string) => {
        data.set(key, value)
      },
      delete: async (key: string) => {
        data.delete(key)
      },
    },
  }
  return { env, data }
}

const entry = {
  username: "admin",
  ip: "127.0.0.1",
  action: "POST /api/admin/save",
  resource: "/api/admin/save",
  method: "POST",
  status: "success" as const,
  status_code: 200,
}

test("F-073: loadAuditLogsFromKV 把历史载入内存，查询/统计可见", async () => {
  __resetAuditLogsForTest()
  const { env } = makeEnv({ [AUDIT_KEY]: JSON.stringify([makeLog(1), makeLog(2)]) })

  const logs = await loadAuditLogsFromKV(env)
  assert.equal(logs.length, 2)
  assert.equal(queryAuditLogs({ limit: 10 }).length, 2, "查询必须看到 KV 历史")
  assert.equal(getAuditStats().total, 2, "统计必须看到 KV 历史")
})

test("F-072: 读取失败时中止写入，绝不覆盖既有历史", async () => {
  __resetAuditLogsForTest()
  const original = JSON.stringify([makeLog(1), makeLog(2)])
  const { env, data } = makeEnv({ [AUDIT_KEY]: original }, { failReads: true })

  await logAudit(entry, env)
  await __flushAuditPersistForTest()

  assert.equal(
    data.get(AUDIT_KEY),
    original,
    "读取失败时不得用单条日志覆盖既有审计历史",
  )
})

test("F-072: 值损坏时先转存备份键再替换", async () => {
  __resetAuditLogsForTest()
  const corrupt = "{ this is not json"
  const { env, data } = makeEnv({ [AUDIT_KEY]: corrupt })

  await logAudit(entry, env)
  await __flushAuditPersistForTest()

  const backupKeys = [...data.keys()].filter((k) =>
    k.startsWith(`${AUDIT_KEY}_corrupt_`),
  )
  assert.equal(backupKeys.length, 1, "损坏值必须转存到备份键")
  assert.equal(data.get(backupKeys[0]), corrupt)

  const written = JSON.parse(data.get(AUDIT_KEY)!)
  assert.ok(Array.isArray(written))
  assert.ok(written.length >= 1, "替换后仍应写入本次日志")
})

test("F-072: 正常追加（不覆盖既有条目）", async () => {
  __resetAuditLogsForTest()
  const { env, data } = makeEnv({
    [AUDIT_KEY]: JSON.stringify([makeLog(1), makeLog(2)]),
  })

  await logAudit(entry, env)
  await __flushAuditPersistForTest()

  const written = JSON.parse(data.get(AUDIT_KEY)!)
  assert.equal(written.length, 3, "既有两条 + 新一条")
  assert.deepEqual(
    written.map((l: any) => l.id).sort(),
    ["log-1", "log-2", written.find((l: any) => !l.id.startsWith("log-"))?.id].sort(),
  )
})

test("F-072: 并发写被串行化，互不覆盖", async () => {
  __resetAuditLogsForTest()
  const { env, data } = makeEnv({ [AUDIT_KEY]: JSON.stringify([makeLog(1)]) })

  await Promise.all([
    logAudit({ ...entry, action: "POST /a" }, env),
    logAudit({ ...entry, action: "POST /b" }, env),
    logAudit({ ...entry, action: "POST /c" }, env),
  ])
  await __flushAuditPersistForTest()

  const written = JSON.parse(data.get(AUDIT_KEY)!)
  assert.equal(written.length, 4, "三条并发日志必须全部落盘（无丢更新）")
  const actions = written.map((l: any) => l.action)
  for (const a of ["POST /a", "POST /b", "POST /c"]) {
    assert.ok(actions.includes(a), `${a} 不得被并发覆盖丢失`)
  }
})

test("F-073: cleanupExpiredLogs 同时清理持久化镜像（不会在下一次写入复活）", async () => {
  __resetAuditLogsForTest()
  const old = makeLog(1, { timestamp: "2020-01-01T00:00:00.000Z" })
  const fresh = makeLog(2, { timestamp: new Date().toISOString() })
  const { env, data } = makeEnv({ [AUDIT_KEY]: JSON.stringify([old, fresh]) })

  await ensureAuditLogsLoaded(env)
  cleanupExpiredLogs(30)
  await logAudit(entry, env)
  await __flushAuditPersistForTest()

  const written = JSON.parse(data.get(AUDIT_KEY)!)
  assert.ok(
    !written.some((l: any) => l.id === "log-1"),
    "已过期的历史不得在下一次写入时复活",
  )
})
