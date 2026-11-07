import assert from "node:assert/strict"
import { test } from "node:test"

/**
 * QS-1（db 层）：当「键列表完整性无法证明」时，内存库不得被标记为 dbTrusted。
 *
 * 背景：key 格式 + KV/cfkv 的 list 是最终一致的。某个实例 load 可能只看到部分键，
 * 此时内存库**可用但不完整** —— 它不是持久化状态的完整镜像，所以：
 *   - `isDbTrusted()` 必须为 false（否则匿名 /init/setup 会把它当全新库）；
 *   - 但后续写入不能被「空壳守卫」误拦（非空 payload 照常落盘，key 格式已保证
 *     不删除本实例从未观察到的键）；
 *   - 「读到空」时仍要用这份快照挡住默认空壳（dbSnapshotLoaded）。
 */

const mod = await import("./db")
const {
  getDb,
  saveDb,
  setEnvCtx,
  isDbTrusted,
  isDbShell,
  __resetDbCacheForTest,
  __setStoreBackendLoaderForTest,
} = mod as any

const SAMPLE = {
  settings: [{ key: "site_title", value: "OpenList" }],
  users: [{ id: 1, username: "admin", role: 2, password: "hash" }],
  storages: [{ id: 1, mount_path: "/onedrive", driver: "onedrive" }],
  shares: [],
  metas: [],
  plugins: [],
}

function createBackend(initial: any, completenessProven: boolean | undefined) {
  let data = initial ? JSON.parse(JSON.stringify(initial)) : null
  const stats = { load: 0, save: 0 }
  const backend: any = {
    name: "kv",
    isConfigured: async () => true,
    async load() {
      stats.load++
      return data ? JSON.parse(JSON.stringify(data)) : null
    },
    async save(next: any) {
      stats.save++
      data = JSON.parse(JSON.stringify(next))
      return true
    },
  }
  if (completenessProven !== undefined) {
    backend.loadCompletenessProven = () => completenessProven
  }
  return {
    backend,
    stats,
    getData: () => data,
    clear: () => {
      data = null
    },
  }
}

test("QS-1: list 完整性不可证明时不置 dbTrusted，但数据仍可读", async () => {
  __resetDbCacheForTest()
  const { backend } = createBackend(SAMPLE, false)
  __setStoreBackendLoaderForTest(async () => backend)

  const env = { DB_DRIVER: "kv", DB_FORMAT: "key" }
  const db = await getDb(env)

  assert.equal(db.storages.length, 1)
  assert.equal(
    isDbTrusted(),
    false,
    "最终一致的 list 无法证明完整 → 内存库不是完整镜像，不得标记可信",
  )
})

test("QS-1: 完整性可证明时仍标记 dbTrusted（强一致驱动行为不变）", async () => {
  __resetDbCacheForTest()
  const { backend } = createBackend(SAMPLE, true)
  __setStoreBackendLoaderForTest(async () => backend)

  const env = { DB_DRIVER: "d1", DB_FORMAT: "key" }
  const db = await getDb(env)
  assert.equal(db.storages.length, 1)
  assert.equal(isDbTrusted(), true)
})

test("QS-1: 未实现 loadCompletenessProven 的后端按「可证明」处理（向后兼容）", async () => {
  __resetDbCacheForTest()
  const { backend } = createBackend(SAMPLE, undefined)
  __setStoreBackendLoaderForTest(async () => backend)

  const env = { DB_DRIVER: "mysql", DB_FORMAT: "sql" }
  await getDb(env)
  assert.equal(isDbTrusted(), true)
})

test("QS-1: 不可证明完整时，非空快照的写入不会被守卫误拦", async () => {
  __resetDbCacheForTest()
  const { backend, stats, getData } = createBackend(SAMPLE, false)
  __setStoreBackendLoaderForTest(async () => backend)

  const env = { DB_DRIVER: "kv", DB_FORMAT: "key" }
  const db = await getDb(env)
  db.settings[0].value = "Renamed"

  const ok = await saveDb(db, env)
  assert.equal(ok, true, "非空快照必须能落盘（否则 KV 部署完全不可写）")
  assert.equal(stats.save, 1)
  assert.equal(getData().settings[0].value, "Renamed")
  assert.equal(isDbTrusted(), false, "写入成功后仍不得声称「完整镜像」")
})

test("QS-1: 读到空后端时，不完整快照同样要挡住默认空壳", async () => {
  __resetDbCacheForTest()
  const fake = createBackend(SAMPLE, false)
  __setStoreBackendLoaderForTest(async () => fake.backend)

  const env1 = { DB_DRIVER: "kv", DB_FORMAT: "key" }
  const first = await getDb(env1)
  assert.equal(first.storages.length, 1)
  assert.equal(isDbTrusted(), false)

  // 后端暂时返回「空」（最终一致性抖动 / 标记键不可见）
  fake.clear()

  // 换一个 cache key 强制重新加载（模拟新的请求上下文）
  const env2 = { DB_DRIVER: "kv", DB_FORMAT: "key", __nonce: 2 }
  const second = await getDb(env2)

  assert.equal(
    isDbShell(second),
    false,
    "读到空时必须保留既有快照，不得回退到默认空壳",
  )
  assert.equal(second.storages.length, 1)
})
