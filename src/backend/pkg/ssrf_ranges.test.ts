import assert from "node:assert/strict"
import test from "node:test"
import { isSafeUrl } from "./http"

/**
 * L-10（SECURITY-AUDIT-2026-10-20）回归测试：`isSafeUrl` 的网段覆盖。
 *
 * 补的两类：
 *   - `fec0::/10`：站点本地地址（RFC 3879 已废弃，但仍可能指向内网服务）
 *   - `ff00::/8`：IPv6 组播
 *
 * 另外确认「短式 / 整数 / 八进制 IPv4」不需要单独规则：WHATWG URL 解析阶段就会
 * 把它们规范化成点分十进制（`http://127.1` → `127.0.0.1`），随后由 isBlockedIpv4
 * 拦下。这里把这层依赖也钉成用例，避免将来换成手写解析时静默失效。
 */

test("L-10: 新增的 IPv6 受限网段被拦下", () => {
  for (const host of [
    "http://[fec0::1]/",
    "http://[fec0:0:0:1::5]/",
    "http://[ff02::1]/",
    "http://[ff05::1:3]/",
  ]) {
    assert.equal(isSafeUrl(host), false, `${host} 必须被拒`)
  }
})

test("L-10: 已有的 IPv6 受限范围仍然生效", () => {
  for (const host of [
    "http://[::1]/",
    "http://[::]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
  ]) {
    assert.equal(isSafeUrl(host), false, `${host} 必须被拒`)
  }
})

test("L-10: 短式 / 整数 / 八进制 IPv4 依赖 URL 规范化后同样被拦", () => {
  for (const host of [
    "http://127.1/",
    "http://10.1/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://169.254.169.254/",
    "http://100.100.100.200/",
  ]) {
    assert.equal(isSafeUrl(host), false, `${host} 必须被拒`)
  }
})

test("L-10: 正常公网地址不受影响", () => {
  for (const host of [
    "https://example.com/a/b.zip",
    "https://cdn.example.com:8443/x",
    // 腾讯云 COS 的 host 里带 10 位 AppID，不能被整数 IP 规则误伤
    "https://bucket-1250000000.cos.ap-guangzhou.myqcloud.com/a.zip",
    "http://[2001:db8::1]/x",
  ]) {
    assert.equal(isSafeUrl(host), true, `${host} 不应被拦截`)
  }
})
