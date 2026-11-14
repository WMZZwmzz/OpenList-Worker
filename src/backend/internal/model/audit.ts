/**
 * 审计日志系统 (Audit Log System)
 * 添加日期: 2026-09-05
 * 
 * 记录所有敏感操作，用于安全审计、合规要求和故障排查。
 * 采用内存 + KV 持久化的混合策略，适配 Cloudflare Workers 环境。
 */

export interface AuditLog {
  id?: string
  timestamp: string
  user_id?: number
  username: string
  ip: string
  action: string
  resource: string
  method: string
  status: "success" | "failure"
  status_code: number
  details?: string
  user_agent?: string
  duration_ms?: number
}

// 内存缓存（进程内，最多保留 1000 条）
let auditLogs: AuditLog[] = []
const MAX_MEMORY_LOGS = 1000
/** KV 中持久化的历史上限（与旧实现一致：最多保留最近 10000 条） */
const MAX_PERSISTED_LOGS = 10000
const AUDIT_LOG_KV_KEY = "openlist_audit_logs"

/**
 * KV 历史的进程内镜像（F-073）。
 *
 * 历史缺陷：`loadAuditLogsFromKV` 全仓库没有调用者，查询/统计/清理接口只看得到
 * 当前 isolate 的模块级数组 —— 重启、冷启动或换 isolate 后审计记录「消失」，
 * /audit/cleanup 也只清理内存、对 KV 无效。
 *
 * 现在该镜像在首次使用时从 KV 载入（并合并进 auditLogs 供查询），写入时以它为
 * 基础追加，从而让「写」与「读」使用同一份数据。
 *  - `null`  = 尚未成功载入（需要先读 KV）；
 *  - 数组    = 已载入的持久化历史。
 */
let kvLogMirror: AuditLog[] | null = null
/** 镜像最近一次载入失败的标记（失败后不覆盖 KV，见 persist） */
let kvMirrorLoadFailed = false
/** 镜像最近一次载入时间（用于跨 isolate 收敛的周期性回读） */
let kvMirrorLoadedAt = 0
const KV_MIRROR_TTL_MS = 30_000
/** 载入去重（并发请求共享一次 KV 读） */
let kvMirrorInflight: Promise<boolean> | null = null
/** 串行化写入，避免同 isolate 并发 read-modify-write 互相覆盖（F-072） */
let persistChain: Promise<void> = Promise.resolve()

/**
 * 供测试使用：复位模块级状态（内存日志 / KV 镜像 / 写入队列）。
 *
 * 审计模块的状态是 isolate 级的（与线上多请求共享），用例之间必须显式复位，
 * 否则断言会依赖执行顺序。
 */
export function __resetAuditLogsForTest(): void {
  auditLogs = []
  kvLogMirror = null
  kvMirrorLoadFailed = false
  kvMirrorLoadedAt = 0
  kvMirrorInflight = null
  persistChain = Promise.resolve()
}

/** 当前内存中的日志条数（含已从 KV 载入的历史）。 */
export function getAuditLogCount(): number {
  return auditLogs.length
}

/**
 * 供测试使用：等待当前排队的持久化任务全部结束。
 *
 * 生产路径上 logAudit 是 fire-and-forget（不阻塞业务请求），测试需要能确定性地
 * 观察到落盘结果。
 */
export async function __flushAuditPersistForTest(): Promise<void> {
  await persistChain.catch(() => {})
}

/**
 * 记录审计日志
 */
export async function logAudit(
  entry: Omit<AuditLog, "id" | "timestamp">,
  env?: any,
): Promise<void> {
  const log: AuditLog = {
    id: generateLogId(),
    timestamp: new Date().toISOString(),
    ...entry,
  }

  // 添加到内存缓存
  auditLogs.push(log)

  // 防止内存溢出，保留最近 N 条
  if (auditLogs.length > MAX_MEMORY_LOGS) {
    auditLogs = auditLogs.slice(-MAX_MEMORY_LOGS)
  }

  // A-44：必须 await。历史实现既不 await 也没挂 waitUntil，Workers/EdgeOne
  // 在响应返回后可能直接取消该 Promise，审计记录随机丢失。
  if (env) {
    try {
      await persistAuditLogToKV(log, env)
    } catch (err) {
      console.warn("[Audit] Failed to persist log to KV:", err)
    }
  }
  // 控制台输出（开发环境）
  if (isDevelopment(env)) {
    console.log(
      `[AUDIT] ${log.username} ${log.method} ${log.resource} - ${log.status} (${log.status_code})`,
    )
  }
}

/**
 * 查询审计日志（内存缓存）
 */
export function queryAuditLogs(filters?: {
  username?: string
  action?: string
  method?: string
  status?: "success" | "failure"
  startDate?: string
  endDate?: string
  limit?: number
}): AuditLog[] {
  let results = [...auditLogs]

  if (filters?.username) {
    results = results.filter((log) => log.username === filters.username)
  }

  if (filters?.action) {
    results = results.filter((log) => log.action.includes(filters.action!))
  }

  if (filters?.method) {
    results = results.filter(
      (log) => log.method.toUpperCase() === filters.method!.toUpperCase(),
    )
  }

  if (filters?.status) {
    results = results.filter((log) => log.status === filters.status)
  }

  if (filters?.startDate) {
    results = results.filter((log) => log.timestamp >= filters.startDate!)
  }

  if (filters?.endDate) {
    results = results.filter((log) => log.timestamp <= filters.endDate!)
  }

  const limit = filters?.limit || 100
  return results.slice(-limit).reverse() // 最新的在前
}

/**
 * 审计日志的 KV 访问适配器。
 *
 * 必须自己实现而不是假定 binding 形态，原因是历史缺陷的两种表现（F-072）：
 *   1. `mode === "api"`（cf_rest）的 binding 只有凭据字段、没有 get/put，
 *      旧实现把 undefined 当函数调用抛 TypeError，又被内层 catch 吞掉 —— 持久化
 *      静默什么都不做；
 *   2. `get(key, "text")` 不是所有平台都支持，读取异常被当成「首次写入」，
 *      随后整组写回就把既有历史全部覆盖。
 * 因此这里把「读取失败」与「键不存在」严格区分：读取失败一律抛出，由调用方
 * 中止本次写；只有确证 404 / null 才算不存在。
 */
type AuditKvTarget = {
  read(): Promise<string | null>
  write(payload: string): Promise<void>
  /** 转存损坏值用的备份写入 */
  backup(key: string, payload: string): Promise<void>
}

async function getAuditKvTarget(env: any): Promise<AuditKvTarget | null> {
  const { getKvBinding } = await import("./db")
  const kvInfo = await getKvBinding(env)
  if (kvInfo.mode === "none" || !kvInfo.binding) return null

  const { binding, mode } = kvInfo

  // cf_rest：直接用 REST API（与 store/json.ts 的 readFromKv/saveToKv 同一协议）。
  if (mode === "api" && binding?.type === "cf_rest") {
    const url = (key: string) =>
      `https://api.cloudflare.com/client/v4/accounts/${binding.accountId}/storage/kv/namespaces/${binding.namespaceId}/values/${key}`
    return {
      async read() {
        const res = await fetch(url(AUDIT_LOG_KV_KEY), {
          headers: { Authorization: `Bearer ${binding.token}` },
        })
        if (res.status === 404) return null
        if (!res.ok) throw new Error(`audit KV read failed: HTTP ${res.status}`)
        return await res.text()
      },
      async write(payload: string) {
        const res = await fetch(url(AUDIT_LOG_KV_KEY), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${binding.token}`,
            "Content-Type": "text/plain",
          },
          body: payload,
        })
        if (!res.ok) throw new Error(`audit KV write failed: HTTP ${res.status}`)
      },
      async backup(key: string, payload: string) {
        await fetch(url(key), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${binding.token}`,
            "Content-Type": "text/plain",
          },
          body: payload,
        })
      },
    }
  }

  return {
    async read() {
      let val: any
      if (mode === "blob") {
        // Blob SDK 可能直接返回结构化对象（数组），优先按 json 取。
        try {
          val = await binding.get(AUDIT_LOG_KV_KEY, { type: "json" })
        } catch {
          val = await binding.get(AUDIT_LOG_KV_KEY)
        }
      } else {
        try {
          val = await binding.get(AUDIT_LOG_KV_KEY, "text")
        } catch (err) {
          // 与 store 层一致：Cloudflare KV 支持 (key,"text")，EdgeOne KV 只支持
          // (key)。只有「签名不兼容」才回退，其它读取故障必须抛出 —— 否则一次
          // 读取失败会被当成「首次写入」并整组覆盖既有历史（F-072）。
          const msg = String((err as any)?.message || "")
          const isSignatureError =
            err instanceof TypeError || /not a function/i.test(msg)
          if (!isSignatureError) throw err
          val = await binding.get(AUDIT_LOG_KV_KEY)
        }
      }
      if (val && typeof val.text === "function") val = await val.text()
      if (val === undefined || val === null) return null
      if (typeof val === "string") return val
      // 绑定返回已解析对象（Blob json / 代理）时序列化回字符串，保持统一契约。
      return JSON.stringify(val)
    },
    async write(payload: string) {
      if (typeof binding.put === "function") {
        await binding.put(AUDIT_LOG_KV_KEY, payload)
        return
      }
      if (typeof binding.set === "function") {
        await binding.set(AUDIT_LOG_KV_KEY, payload)
        return
      }
      throw new Error(`KV mode "${mode}" provides neither put() nor set()`)
    },
    async backup(key: string, payload: string) {
      if (typeof binding.put === "function") await binding.put(key, payload)
      else if (typeof binding.set === "function") await binding.set(key, payload)
      else throw new Error(`KV mode "${mode}" cannot write backup`)
    },
  }
}

/** 按 id 去重（缺 id 时退化为时间戳 + 用户名 + action） */
function auditIdOf(log: AuditLog, index = 0): string {
  return String(
    log?.id ||
      `${log?.timestamp || ""}|${log?.username || ""}|${log?.action || ""}|${index}`,
  )
}

/** 合并两组日志（按 id 去重），按时间升序返回。 */
function mergeAuditLogs(base: AuditLog[], extra: AuditLog[]): AuditLog[] {
  const byId = new Map<string, AuditLog>()
  base.forEach((log, i) => byId.set(auditIdOf(log, i), log))
  extra.forEach((log, i) => {
    const id = auditIdOf(log, i)
    if (!byId.has(id)) byId.set(id, log)
  })
  return [...byId.values()].sort((a, b) =>
    String(a?.timestamp || "").localeCompare(String(b?.timestamp || "")),
  )
}

/** 把持久化历史合并进内存数组（查询/统计立即能看到 KV 中的记录）。 */
function mergeIntoMemory(logs: AuditLog[]): void {
  if (logs.length === 0) return
  auditLogs = mergeAuditLogs(logs, auditLogs).slice(-MAX_MEMORY_LOGS)
}

/**
 * 确保 KV 历史已载入内存镜像（F-073 的核心）。
 *
 * 返回 false 表示「读取失败，镜像不可用」—— 此时写入必须中止，绝不能拿一份
 * 空数组去覆盖真实历史（F-072）。
 */
export async function ensureAuditLogsLoaded(env: any): Promise<boolean> {
  if (kvLogMirror && Date.now() - kvMirrorLoadedAt < KV_MIRROR_TTL_MS) return true
  if (kvMirrorInflight) return kvMirrorInflight

  kvMirrorInflight = (async () => {
    try {
      const target = await getAuditKvTarget(env)
      if (!target) {
        // 没有 KV 类后端：没有可载入的历史，写入也不应假装成功。
        kvLogMirror = kvLogMirror ?? []
        kvMirrorLoadFailed = false
        kvMirrorLoadedAt = Date.now()
        return true
      }

      const raw = await target.read()
      if (raw === null) {
        // 确证不存在（首次写入）：镜像从空开始，允许写入。
        kvLogMirror = mergeAuditLogs(kvLogMirror ?? [], auditLogs)
        kvMirrorLoadFailed = false
        kvMirrorLoadedAt = Date.now()
        return true
      }

      let parsed: any
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        // 值损坏：先转存备份键，绝不静默用单条日志覆盖整段历史（F-072）。
        const backupKey = `${AUDIT_LOG_KV_KEY}_corrupt_${Date.now()}`
        try {
          await target.backup(backupKey, raw)
          console.error(
            `[Audit] audit log value is corrupt; original saved to "${backupKey}" before replacement`,
            err,
          )
        } catch (backupErr) {
          console.error(
            "[Audit] audit log value is corrupt and backup failed:",
            backupErr,
          )
          kvMirrorLoadFailed = true
          return false
        }
        parsed = []
      }

      if (!Array.isArray(parsed)) parsed = []
      const kvLogs = parsed.filter(
        (l: any) => l && typeof l === "object",
      ) as AuditLog[]

      // 合并：以 KV 为基础，保留本实例内存中尚未落盘的条目（按 id 去重）
      kvLogMirror = mergeAuditLogs(kvLogs, [
        ...(kvLogMirror ?? []),
        ...auditLogs,
      ]).slice(-MAX_PERSISTED_LOGS)
      mergeIntoMemory(kvLogMirror)
      kvMirrorLoadFailed = false
      kvMirrorLoadedAt = Date.now()
      return true
    } catch (err) {
      // 读取失败：镜像不可用，本次写入必须中止（不得覆盖既有历史）。
      console.warn("[Audit] Failed to load logs from KV:", err)
      kvMirrorLoadFailed = true
      return false
    } finally {
      kvMirrorInflight = null
    }
  })()

  return kvMirrorInflight
}

/**
 * 从 KV 加载历史日志（并合并进内存，供查询/统计使用）。
 *
 * 历史缺陷：本函数全仓库没有调用者，写与读各用一份数据 —— 重启/换 isolate 后
 * 审计记录「消失」（F-073）。现在它是载入链路的一部分。
 */
export async function loadAuditLogsFromKV(env: any): Promise<AuditLog[]> {
  await ensureAuditLogsLoaded(env)
  return kvLogMirror ? [...kvLogMirror] : []
}

/**
 * 持久化单条日志到 KV（追加模式）。
 *
 * 与历史实现的区别（F-072）：
 *  - 读取失败一律中止本次写，绝不把「读不到」当成「首次写入」；
 *  - 解析失败先备份原始值再替换；
 *  - 同一 isolate 内的并发写串行化（singleflight 队列），避免读-改-写互相覆盖；
 *  - 以内存镜像（含从 KV 载入的历史）为基础追加，而不是每次重新读取。
 */
async function persistAuditLogToKV(log: AuditLog, env: any): Promise<void> {
  const task = persistChain.then(async () => {
    try {
      const loaded = await ensureAuditLogsLoaded(env)
      if (!loaded || kvMirrorLoadFailed) {
        console.warn(
          "[Audit] KV history could not be read; skipping this persist to avoid " +
            "overwriting existing audit history (log kept in memory only)",
        )
        return
      }

      const target = await getAuditKvTarget(env)
      if (!target) return

      const mirror = kvLogMirror ? [...kvLogMirror] : []
      if (!mirror.some((l) => l && l.id && l.id === log.id)) mirror.push(log)
      kvLogMirror = mergeAuditLogs(mirror, []).slice(-MAX_PERSISTED_LOGS)

      await target.write(JSON.stringify(kvLogMirror))
      kvMirrorLoadedAt = Date.now()
    } catch (err) {
      // 持久化失败不影响业务流程
      console.warn("[Audit] Persist to KV failed:", err)
    }
  })
  // 队列本身不能被单次失败打断
  persistChain = task.catch(() => {})
  await task
}

/**
 * 生成日志 ID
 */
function generateLogId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 9)
  return `${timestamp}-${random}`
}

/**
 * 检测是否为开发环境
 */
function isDevelopment(env?: any): boolean {
  const e = env || (typeof process !== "undefined" ? process.env : {})
  return e?.ENVIRONMENT === "development" || e?.NODE_ENV === "development"
}

/**
 * 清理过期日志（保留最近 30 天）
 */
export function cleanupExpiredLogs(retentionDays: number = 30): void {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  const cutoffISO = cutoffDate.toISOString()

  auditLogs = auditLogs.filter((log) => log.timestamp >= cutoffISO)
  // F-073：清理必须同时作用于持久化镜像，否则下一次 persist 会把刚清掉的记录
  // 原样写回 KV（清理接口对 KV 无效的历史缺陷）。
  if (kvLogMirror) {
    kvLogMirror = kvLogMirror.filter((log) => log.timestamp >= cutoffISO)
  }
}

/**
 * 获取审计日志统计
 */
export function getAuditStats(): {
  total: number
  success: number
  failure: number
  uniqueUsers: number
  recentActions: Array<{ action: string; count: number }>
} {
  const total = auditLogs.length
  const success = auditLogs.filter((log) => log.status === "success").length
  const failure = auditLogs.filter((log) => log.status === "failure").length

  const uniqueUsers = new Set(auditLogs.map((log) => log.username)).size

  // 统计最常见的操作
  const actionCounts = new Map<string, number>()
  auditLogs.forEach((log) => {
    const count = actionCounts.get(log.action) || 0
    actionCounts.set(log.action, count + 1)
  })

  const recentActions = Array.from(actionCounts.entries())
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return {
    total,
    success,
    failure,
    uniqueUsers,
    recentActions,
  }
}
