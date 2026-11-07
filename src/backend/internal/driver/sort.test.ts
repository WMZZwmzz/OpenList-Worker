import test from "node:test"
import assert from "node:assert/strict"
import { sortFileItems } from "./sort"
import type { FileItem } from "./base"

function file(
  name: string,
  over: Partial<FileItem> = {},
): FileItem {
  return {
    name,
    size: 0,
    is_dir: false,
    modified: "2020-01-01T00:00:00Z",
    sign: "",
    type: 0,
    ...over,
  }
}

const byName = (items: FileItem[]) => items.map((i) => i.name)

test("F-109: uppercase DESC is treated as descending", () => {
  const items = [file("a", { size: 1 }), file("b", { size: 9 })]
  assert.deepEqual(byName(sortFileItems(items, "size", "DESC")), ["b", "a"])
  assert.deepEqual(byName(sortFileItems(items, "size", "desc")), ["b", "a"])
  assert.deepEqual(byName(sortFileItems(items, "size", "ASC")), ["a", "b"])
  assert.deepEqual(byName(sortFileItems(items, "size", "asc")), ["a", "b"])
  assert.deepEqual(byName(sortFileItems(items, "size", undefined)), ["a", "b"])
})

test("F-108: updated_at / update_at sort by modified time instead of falling back to name", () => {
  const items = [
    file("zzz.doc", { modified: "2025-01-01T00:00:00Z" }),
    file("aaa.txt", { modified: "2025-06-01T00:00:00Z" }),
    file("mmm.pdf", { modified: "2024-01-01T00:00:00Z" }),
  ]
  assert.deepEqual(byName(sortFileItems(items, "updated_at", "asc")), [
    "mmm.pdf",
    "zzz.doc",
    "aaa.txt",
  ])
  assert.deepEqual(byName(sortFileItems(items, "update_at", "desc")), [
    "aaa.txt",
    "zzz.doc",
    "mmm.pdf",
  ])
})

test("F-108: unknown order_by keys preserve the upstream (driver) order", () => {
  const items = [
    file("b", { size: 9 }),
    file("a", { size: 1 }),
    file("c", { size: 5 }),
  ]
  // 123Pan 的默认 file_id：驱动 API 已排好序，不能再被 name 序覆盖
  assert.deepEqual(byName(sortFileItems(items, "file_id", "asc")), ["b", "a", "c"])
  assert.deepEqual(byName(sortFileItems(items, "file_type", "asc")), ["b", "a", "c"])
  // 返回副本，原数组顺序不被破坏
  assert.deepEqual(byName(items), ["b", "a", "c"])
})

test("F-108: known keys still map to the right comparator", () => {
  const items = [file("b", { size: 9 }), file("a", { size: 1 })]
  assert.deepEqual(byName(sortFileItems(items, "size", "asc")), ["a", "b"])
  assert.deepEqual(byName(sortFileItems(items, "file_size", "desc")), ["b", "a"])
  assert.deepEqual(byName(sortFileItems(items, "name", "asc")), ["a", "b"])
  assert.deepEqual(byName(sortFileItems(items, "file_name", "desc")), ["b", "a"])
})

test("F-110: created ordering uses the created field (falls back to modified)", () => {
  const items = [
    file("a", { created: "2025-01-01T00:00:00Z", modified: "2020-01-01T00:00:00Z" }),
    file("b", { created: "2020-01-01T00:00:00Z", modified: "2025-01-01T00:00:00Z" }),
  ]
  // 按 created 升序：b(2020) 在 a(2025) 之前（旧实现按 modified 会给出 a,b）
  assert.deepEqual(byName(sortFileItems(items, "created", "asc")), ["b", "a"])
  assert.deepEqual(byName(sortFileItems(items, "created_at", "desc")), ["a", "b"])

  const noCreated = [
    file("a", { modified: "2025-01-01T00:00:00Z" }),
    file("b", { modified: "2020-01-01T00:00:00Z" }),
  ]
  // created 缺失时用 modified 兜底
  assert.deepEqual(byName(sortFileItems(noCreated, "created", "asc")), ["b", "a"])
})

test("F-110: invalid/missing timestamps do not produce NaN comparisons", () => {
  const items = [
    file("a", { created: "not-a-date" }),
    file("b", { created: "2020-01-01T00:00:00Z" }),
    file("c", { created: undefined, modified: "" }),
  ]
  const out = byName(sortFileItems(items, "created", "asc"))
  assert.equal(out.length, 3)
  assert.equal(out[0], "a")
})

test("folders stay first regardless of order_by", () => {
  const items = [
    file("file-a", { size: 1 }),
    file("dir-b", { is_dir: true, size: 999 }),
    file("file-c", { size: 5 }),
  ]
  assert.deepEqual(byName(sortFileItems(items, "size", "desc")), [
    "dir-b",
    "file-c",
    "file-a",
  ])
})

test("sorting never mutates the input array", () => {
  const items = [file("b"), file("a")]
  sortFileItems(items, "name", "asc")
  assert.deepEqual(byName(items), ["b", "a"])
})
