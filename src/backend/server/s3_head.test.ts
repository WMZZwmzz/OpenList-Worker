import assert from "node:assert/strict"
import test from "node:test"
import { httpDateOf } from "./s3"

/**
 * F-052：Last-Modified 必须是 RFC 9110 的 HTTP-date（IMF-fixdate）。
 * 驱动返回的 FileItem.modified 主要是 ISO 8601，原样回传会让严格解析
 * HTTP-date 的 S3 客户端丢弃该头。
 */
test("F-052: ISO 8601 被转换为 IMF-fixdate", () => {
  assert.equal(
    httpDateOf("2024-01-02T03:04:05.000Z"),
    "Tue, 02 Jan 2024 03:04:05 GMT",
  )
  assert.equal(
    httpDateOf("2015-10-21T07:28:00Z"),
    "Wed, 21 Oct 2015 07:28:00 GMT",
  )
})

test("F-052: 无法解析时回退当前时间，而不是吐出非法 HTTP-date", () => {
  const now = httpDateOf(undefined)
  assert.match(now, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/)
  assert.ok(Number.isFinite(Date.parse(now)))

  const garbage = httpDateOf("not-a-date")
  assert.match(garbage, /GMT$/)
  assert.ok(Number.isFinite(Date.parse(garbage)))
})
