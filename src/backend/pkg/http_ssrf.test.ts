import test from "node:test"
import assert from "node:assert/strict"
import { isSafeUrl, get, post, request } from "./http"

const BLOCKED = [
  // 危险域名（尾点形式）
  "http://metadata.google.internal./x",
  "http://localhost./x",
  "http://foo.internal./x",
  "http://metadata./x",
  "http://169.254.169.254./x",
  "http://169.254.169.254/x",
  // IPv4-mapped IPv6：规范化后的十六进制形式与点分形式都要拦
  "http://[::ffff:7f00:1]/x",
  "http://[::ffff:a9fe:a9fe]/x",
  "http://[::ffff:a00:1]/x",
  "http://[::ffff:127.0.0.1]/x",
  "http://[::ffff:c0a8:1]/x",
  "http://[0:0:0:0:0:ffff:7f00:1]/x",
  // IPv4 兼容 / NAT64 中嵌入的 IPv4
  "http://[::7f00:1]/x",
  "http://[64:ff9b::a9fe:a9fe]/x",
  // IPv6 自身范围
  "http://[::1]/x",
  "http://[fe80::1]/x",
  "http://[fd00::1]/x",
  "http://[fc00::1]/x",
  // 私有 / 元数据 IPv4 与混淆写法
  "http://127.0.0.1/x",
  "http://10.0.0.1/x",
  "http://192.168.1.1/x",
  "http://172.16.0.1/x",
  "http://100.100.100.200/x",
  "http://0177.0.0.1/x",
  "http://0x7f000001/x",
  "http://2130706433/x",
  "http://127.0.0.1.nip.io/x",
  "http://localtest.me/x",
]

const ALLOWED = [
  "https://example.com/file.txt",
  "https://api.github.com/repos/x",
  // 真实存储 host：bucket 名里带连续数字 label，不能被当成整数 IP
  "https://mybucket-1234567890.cos.ap-guangzhou.myqcloud.com/k",
  "https://sub.example.co.uk:8443/a/b",
]

test("isSafeUrl 拦下尾点域名与 IPv4-mapped IPv6 绕过", () => {
  for (const url of BLOCKED) {
    assert.equal(isSafeUrl(url), false, `should block ${url}`)
  }
})

test("isSafeUrl 不误伤公网 host", () => {
  for (const url of ALLOWED) {
    assert.equal(isSafeUrl(url), true, `should allow ${url}`)
  }
})

test("管理员白名单仍放行内网存储 host（尾点形式同样命中）", () => {
  const allow = new Set(["minio.internal"])
  assert.equal(isSafeUrl("http://minio.internal:9000/bucket", allow), true)
  assert.equal(isSafeUrl("http://minio.internal./bucket", allow), true)
  assert.equal(isSafeUrl("http://127.0.0.1:9000/bucket", allow), false)
  assert.equal(isSafeUrl("http://evil.minio.internal/bucket", allow), false)
})

test("非 http(s) 协议一律拒绝", () => {
  assert.equal(isSafeUrl("file:///etc/passwd"), false)
  assert.equal(isSafeUrl("gopher://127.0.0.1:11211/x"), false)
  assert.equal(isSafeUrl("http://user:pass@127.0.0.1/"), false)
})

test("SEC-042: 通用 get/post/request 在出网前做 SSRF 断言", async () => {
  process.env.SSRF_TEST_ENFORCE = "1"
  try {
    for (const call of [
      () => get("http://127.0.0.1/internal"),
      () => post("http://169.254.169.254/latest/meta-data"),
      () =>
        request({
          url: "http://[::ffff:7f00:1]/latest",
          method: "GET",
        }),
    ]) {
      await assert.rejects(call, /SSRF|restricted|not allowed/i)
    }
    // 显式 allowHosts（管理员配置的内网存储）仍可放行到 fetch 阶段
    await assert.rejects(
      () => get("http://127.0.0.1/internal", { allowHosts: ["127.0.0.1"] }),
      (e: any) => !/SSRF|restricted/i.test(String(e?.message || "")),
    )
  } finally {
    delete process.env.SSRF_TEST_ENFORCE
  }
})
