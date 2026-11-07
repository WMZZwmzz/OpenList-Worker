import assert from "node:assert/strict"
import { test } from "node:test"

import {
  formToMapForTest,
  htmlJsonToMap,
  isAcwScV2Challenge,
  mustParseTime,
  removeJSComment,
  removeNotes,
} from "./help"
import { isWafBlockedError } from "./util"

test("F-160: comment stripping keeps absolute URLs inside string literals", () => {
  const html = '<iframe src="https://xxx.lanzou.com/fn?abc">ok</iframe>'
  assert.equal(removeJSComment(html), html)
  assert.equal(removeNotes(html), html)

  // 协议相对 URL 同样不能被 removeNotes 截断
  const protoRel = '<iframe src="//xxx.lanzou.com/fn?abc"></iframe>'
  assert.equal(removeNotes(protoRel), protoRel)

  // 真正的注释仍然被剥离
  assert.equal(removeJSComment("var a = 1; // note\nvar b = 2;"), "var a = 1; \nvar b = 2;")
  assert.equal(removeNotes("<p>x</p><!-- hidden -->").trim(), "<p>x</p>")
})

test("F-161: relative Chinese times map to the right offset", () => {
  const now = Date.now()
  const DAY = 86400000
  const approx = (iso: string, expected: number) => {
    const delta = Math.abs(Date.parse(iso) - expected)
    assert.ok(delta < 5000, `${iso} not close to ${new Date(expected).toISOString()}`)
  }

  approx(mustParseTime("昨天"), now - DAY)
  approx(mustParseTime("前天"), now - 2 * DAY)
  approx(mustParseTime("半小时前"), now - 30 * 60000)
  approx(mustParseTime("3小时前"), now - 3 * 3600000)
  approx(mustParseTime("5分钟前"), now - 5 * 60000)
  approx(mustParseTime("2天前"), now - 2 * DAY)
})

test("F-162: formToMap keeps '=' inside values and tolerates bad escapes", () => {
  const map = formToMapForTest("a=1&b=ZGF0YQ==&bad=%E0%A4%A&c=")
  assert.equal(map.a, "1")
  assert.equal(map.b, "ZGF0YQ==", "base64 padding must not be truncated")
  assert.equal(map.bad, "%E0%A4%A", "invalid escapes are returned verbatim")
  assert.equal(map.c, "")
})

test("F-162: htmlJsonToMap accepts data: 'k=v' forms with base64 values", () => {
  const html = `x data: 'k=abc==&n=1'`
  const map = htmlJsonToMap(html)
  assert.equal(map.k, "abc==")
  assert.equal(map.n, "1")
})

test("F-163: only the real WAF challenge page is detected", () => {
  const challenge =
    '<script>var arg1=\'ABCDEF0123\';document.cookie="acw_sc__v2"</script>'
  assert.equal(isAcwScV2Challenge(challenge), true)
  // 普通业务响应里只是提到这个名字，不应触发求解
  assert.equal(isAcwScV2Challenge('{"note":"acw_sc__v2 is a cookie"}'), false)
  assert.equal(isAcwScV2Challenge("<html>normal page</html>"), false)
})

test("F-164: 403/405 inside a share id does not look like a WAF block", () => {
  const err = new Error("[Lanzou] /f/140345 [分享ID含403405] 文件或目录未找到")
  assert.equal(isWafBlockedError(err), false)
  assert.equal(
    isWafBlockedError(new Error("[Lanzou] https://pan.lanzoui.com/123 返回 HTTP 403")),
    true,
  )
  assert.equal(isWafBlockedError(Object.assign(new Error("x"), { status: 405 })), true)
})
