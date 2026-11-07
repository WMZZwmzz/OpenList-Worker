/**
 * 内存驱动（模块级 Map，不持久化）。
 *
 * 作为 auto 检测失败时的最终回退，保证无任何存储绑定的环境下（本地开发、
 * 容器、CI）仍能正常读写配置（仅在单实例内存中生效，进程重启后丢失）。
 * 与旧版 json 后端的「无绑定 → 内存回退」行为一致。
 *
 * F-107：历史实现是裸 Map —— 无容量上限、无过期淘汰。配合缓存层「只有再次
 * 读到过期条目才删除」的惰性清理，显式配置 `CACHE_DRIVER=memory` 时，每个被
 * 浏览过的目录（完整 FileItem[] JSON，可达数百 KB）都会在 Node 长驻进程里
 * 永久驻留，只访问一次的路径构成纯粹的累积泄漏。
 *
 * 现在加入两条护栏（都是「有界」语义，不改变读写契约）：
 *   1. LRU：读命中时把键移到队尾；写入超过条目/字节上限时按队首淘汰。
 *   2. 过期清扫：写入时顺带扫掉**缓存信封**（形如 `{v,ts,exp}`）中已过期的条目。
 *
 * 淘汰只针对「缓存信封」形态的值：同一个 Map 也可能承载业务数据（DB_DRIVER=
 * memory 时的 openlist_config / 各表键），业务键绝不能被容量策略悄悄删掉。
 */
import type { Driver } from "../types"

/** 条目数上限（按不同目录/路径计，超出即淘汰最久未使用的缓存条目） */
const MAX_ENTRIES = 5000
/** 总字节上限（约 32MB，避免大目录把长驻进程的堆打满） */
const MAX_BYTES = 32 * 1024 * 1024

const store = new Map<string, string>()
let totalBytes = 0

function entryBytes(key: string, value: string): number {
  return key.length + value.length
}

/**
 * 是否是缓存层写入的信封（`{ v, ts, exp }`）。
 *
 * 只对这类值做容量淘汰/过期清扫；业务数据（整库 JSON、单表记录）永不淘汰。
 */
function parseEnvelope(value: string): { exp: number; ts: number } | null {
  if (!value || value.charCodeAt(0) !== 123 /* { */) return null
  try {
    const parsed = JSON.parse(value)
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.exp === "number" &&
      typeof parsed.ts === "number"
    ) {
      return { exp: parsed.exp, ts: parsed.ts }
    }
  } catch {
    // 非 JSON：业务数据或损坏值，按不可淘汰处理
  }
  return null
}

function deleteKey(key: string): void {
  const value = store.get(key)
  if (value === undefined) return
  store.delete(key)
  totalBytes -= entryBytes(key, value)
  if (totalBytes < 0) totalBytes = 0
}

/** 顺序即 LRU：Map 的迭代顺序是插入顺序，读命中时重新插入即移到队尾。 */
function touch(key: string): void {
  const value = store.get(key)
  if (value === undefined) return
  store.delete(key)
  store.set(key, value)
}

/** 写入计数：每 N 次顺带做一次过期清扫（把 O(n) 扫描摊薄） */
let putCount = 0
const SWEEP_EVERY = 64

/** 清扫已过期的缓存信封。 */
function sweepExpired(now = Date.now()): void {
  for (const [key, value] of store) {
    const env = parseEnvelope(value)
    if (env && env.exp <= now) deleteKey(key)
  }
}

/** 维护容量与过期约束。 */
function enforceLimits(): void {
  putCount += 1

  // 未超限：只做摊薄后的过期清扫（摊销 O(n/64)），不做全量淘汰扫描
  if (store.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) {
    if (putCount % SWEEP_EVERY === 0) sweepExpired()
    return
  }

  // 1) 先清扫已过期的缓存信封（Map 允许在迭代中删除当前项）
  sweepExpired()

  if (store.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) return

  // 2) 再按 LRU 淘汰缓存信封（跳过业务数据键）
  for (const [key, value] of store) {
    if (store.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) break
    if (!parseEnvelope(value)) continue
    deleteKey(key)
  }
}

/** 仅供测试：清空内存驱动并复位计数。 */
export function __resetMemoryDriverForTest(): void {
  store.clear()
  totalBytes = 0
}

/** 仅供测试：当前条目数。 */
export function memoryDriverEntryCount(): number {
  return store.size
}

export const memoryDriver: Driver = {
  name: "memory",

  async isAvailable(): Promise<boolean> {
    return true
  },

  async init(): Promise<void> {
    // 无需初始化
  },

  async get(key: string): Promise<string | null> {
    const value = store.get(key)
    if (value === undefined) return null
    touch(key)
    return value
  },

  async put(key: string, value: string): Promise<void> {
    const previous = store.get(key)
    if (previous !== undefined) {
      totalBytes -= entryBytes(key, previous)
    }
    // 先 delete 再 set：保证顺序即最近写入顺序（与 touch 一致）
    store.delete(key)
    store.set(key, value)
    totalBytes += entryBytes(key, value)
    enforceLimits()
  },

  async delete(key: string): Promise<void> {
    deleteKey(key)
  },

  async list(prefix: string): Promise<string[]> {
    return [...store.keys()].filter((k) => k.startsWith(prefix))
  },

  async health(): Promise<any> {
    return {
      configured: true,
      connected: true,
      platform: "Memory",
      mode: "memory",
      hasData: store.size > 0,
      error: null,
    }
  },
}
