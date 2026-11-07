import assert from "node:assert/strict"
import { test } from "node:test"
import {
  memoryDriver,
  memoryDriverEntryCount,
  __resetMemoryDriverForTest,
} from "./memory"

/**
 * 内存驱动容量护栏回归（F-107）。
 *
 * 历史实现是裸 Map：无容量上限、无过期淘汰。显式 CACHE_DRIVER=memory 时，每个
 * 被浏览过的目录（完整 FileItem[] JSON）都会在 Node 长驻进程中永久驻留。
 *
 * 修复后：
 *   - 缓存信封超过条目/字节上限时按 LRU 淘汰；
 *   - 写入时顺带清扫已过期的缓存信封；
 *   - **业务数据键**（非 `{v,ts,exp}` 形态）绝不被容量策略删除
 *     （DB_DRIVER=memory 时配置就存在同一个 Map 里）。
 */

function envelope(ttlMs: number, payload = "x") {
  const now = Date.now()
  return JSON.stringify({ v: payload, ts: now, exp: now + ttlMs })
}

test("F-107: 条目超过上限时淘汰最久未使用的缓存条目", async () => {
  __resetMemoryDriverForTest()
  // 上限 5000：写 5100 条缓存信封，最旧的应被淘汰
  for (let i = 0; i < 5100; i++) {
    await memoryDriver.put(`openlist_cache_ft_1_p${i}`, envelope(60_000, String(i)))
  }
  assert.ok(
    memoryDriverEntryCount() <= 5000,
    `条目数必须有界，实际 ${memoryDriverEntryCount()}`,
  )
  assert.equal(
    await memoryDriver.get("openlist_cache_ft_1_p0"),
    null,
    "最旧的条目应被淘汰",
  )
  assert.notEqual(
    await memoryDriver.get("openlist_cache_ft_1_p5099"),
    null,
    "最新的条目必须保留",
  )
})

test("F-107: 读命中会刷新 LRU 位置（近期访问的条目优先保留）", async () => {
  __resetMemoryDriverForTest()
  for (let i = 0; i < 5000; i++) {
    await memoryDriver.put(`k${i}`, envelope(60_000, String(i)))
  }
  // 访问最旧的一条，把它移到队尾
  await memoryDriver.get("k0")
  await memoryDriver.put("k-overflow", envelope(60_000))

  assert.notEqual(await memoryDriver.get("k0"), null, "刚访问过的条目不得被淘汰")
})

test("F-107: 已过期的缓存信封会被清扫", async () => {
  __resetMemoryDriverForTest()
  await memoryDriver.put("expired", envelope(-1_000))
  await memoryDriver.put("fresh", envelope(60_000))

  // 触发一次摊薄清扫（每 64 次写入一次）
  for (let i = 0; i < 64; i++) {
    await memoryDriver.put(`fill${i}`, envelope(60_000))
  }

  assert.equal(await memoryDriver.get("expired"), null, "过期条目应被清掉")
  assert.notEqual(await memoryDriver.get("fresh"), null)
})

test("F-107: 业务数据键不受容量淘汰影响", async () => {
  __resetMemoryDriverForTest()
  // 模拟 DB_DRIVER=memory：配置与表记录都存在同一个 Map 里（非信封形态）
  await memoryDriver.put("openlist_config", String(Date.now()))
  await memoryDriver.put("storages_1", JSON.stringify({ id: 1, mount_path: "/a" }))

  for (let i = 0; i < 5100; i++) {
    await memoryDriver.put(`openlist_cache_ft_1_p${i}`, envelope(60_000))
  }

  assert.notEqual(
    await memoryDriver.get("openlist_config"),
    null,
    "整库标记键不得被容量淘汰删除",
  )
  assert.notEqual(
    await memoryDriver.get("storages_1"),
    null,
    "业务表记录不得被容量淘汰删除",
  )
})
