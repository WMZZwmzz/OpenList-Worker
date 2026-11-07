import test from "node:test"
import assert from "node:assert/strict"
import {
  AuditLevel,
  AuditCategory,
  InMemoryAuditLogStorage,
  type AuditLogEntry,
} from "./audit"

function entry(id: string, timestamp: string): AuditLogEntry {
  return {
    id,
    timestamp,
    level: AuditLevel.INFO,
    category: AuditCategory.SYSTEM,
    action: "test",
    message: id,
    success: true,
  }
}

test("F-065: query({}) must not reorder the internal store (eviction stays oldest-first)", async () => {
  const storage = new InMemoryAuditLogStorage(3)
  await storage.write(entry("A-oldest", "2026-01-01T00:00:00.000Z"))
  await storage.write(entry("B-mid", "2026-01-02T00:00:00.000Z"))
  await storage.write(entry("C-newest", "2026-01-03T00:00:00.000Z"))

  // 一次无过滤查询之后，再写入 D 必须淘汰最旧的 A，而不是最新的 C
  const before = await storage.query({})
  assert.deepEqual(
    before.map((e) => e.id),
    ["C-newest", "B-mid", "A-oldest"],
  )

  await storage.write(entry("D-newest2", "2026-01-04T00:00:00.000Z"))
  const after = await storage.query({})
  const ids = after.map((e) => e.id)
  assert.deepEqual(ids, ["D-newest2", "C-newest", "B-mid"])
  assert.equal(ids.includes("A-oldest"), false, "oldest entry must be evicted")
  assert.equal(ids.includes("C-newest"), true, "newest entry must survive")
})

test("F-065: repeated unfiltered queries keep write() ordering intact", async () => {
  const storage = new InMemoryAuditLogStorage(2)
  await storage.write(entry("A", "2026-01-01T00:00:00.000Z"))
  await storage.write(entry("B", "2026-01-02T00:00:00.000Z"))
  await storage.query({})
  await storage.query({})
  await storage.write(entry("C", "2026-01-03T00:00:00.000Z"))
  assert.deepEqual(
    (await storage.query({})).map((e) => e.id),
    ["C", "B"],
  )
})

test("F-065: query returns an independent array (callers cannot corrupt the store order)", async () => {
  const storage = new InMemoryAuditLogStorage(5)
  await storage.write(entry("A", "2026-01-01T00:00:00.000Z"))
  const rows = await storage.query({})
  rows.length = 0
  rows.reverse()
  const again = await storage.query({})
  assert.deepEqual(
    again.map((e) => e.id),
    ["A"],
  )
})

test("F-065: count() goes through query() and reports the live size", async () => {
  const storage = new InMemoryAuditLogStorage(3)
  await storage.write(entry("A", "2026-01-01T00:00:00.000Z"))
  await storage.write(entry("B", "2026-01-02T00:00:00.000Z"))
  assert.equal(await storage.count({}), 2)
  await storage.write(entry("C", "2026-01-03T00:00:00.000Z"))
  assert.equal(await storage.count({}), 3)
})
