import test from "node:test"
import assert from "node:assert/strict"
import { parseRange } from "./stream"

test("F-060: suffix range bytes=-N returns the trailing N bytes", () => {
  assert.deepEqual(parseRange("bytes=-500", 1000), {
    start: 500,
    end: 999,
    total: 1000,
    size: 500,
  })
  // 请求的后缀比文件还大：从 0 开始
  assert.deepEqual(parseRange("bytes=-5000", 1000), {
    start: 0,
    end: 999,
    total: 1000,
    size: 1000,
  })
  // bytes=-0 无意义（RFC: 不可满足）
  assert.equal(parseRange("bytes=-0", 1000), undefined)
  assert.equal(parseRange("bytes=-abc", 1000), undefined)
})

test("F-060: out-of-range end is clamped to total-1 (RFC 7233)", () => {
  assert.deepEqual(parseRange("bytes=0-99999", 100), {
    start: 0,
    end: 99,
    total: 100,
    size: 100,
  })
  assert.deepEqual(parseRange("bytes=90-99999", 100), {
    start: 90,
    end: 99,
    total: 100,
    size: 10,
  })
  // start 越界仍然不可满足
  assert.equal(parseRange("bytes=100-200", 100), undefined)
  assert.equal(parseRange("bytes=50-40", 100), undefined)
})

test("F-060: multi-range requests are rejected instead of misread as the first range", () => {
  assert.equal(parseRange("bytes=0-1,5-9", 100), undefined)
  assert.equal(parseRange("bytes=0-1, 5-9", 100), undefined)
})

test("F-060: open-ended and normal ranges keep working", () => {
  assert.deepEqual(parseRange("bytes=0-", 100), {
    start: 0,
    end: 99,
    total: 100,
    size: 100,
  })
  assert.deepEqual(parseRange("bytes=10-19", 100), {
    start: 10,
    end: 19,
    total: 100,
    size: 10,
  })
  assert.deepEqual(parseRange("bytes=99-", 100), {
    start: 99,
    end: 99,
    total: 100,
    size: 1,
  })
})

test("F-060: malformed headers / totals fall back to the whole-file response", () => {
  assert.equal(parseRange(undefined, 100), undefined)
  assert.equal(parseRange(null, 100), undefined)
  assert.equal(parseRange("items=0-1", 100), undefined)
  assert.equal(parseRange("bytes=abc", 100), undefined)
  assert.equal(parseRange("bytes=1.5-2", 100), undefined)
  assert.equal(parseRange("bytes=0-1", 0), undefined)
  assert.equal(parseRange("bytes=0-1", NaN), undefined)
  assert.equal(parseRange("bytes=0-1", -5), undefined)
})
