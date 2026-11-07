import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { BunnyStorageDriver } from "./driver"
import { cdnURL, signCDNURL } from "./util"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function baseAddition(extra: Record<string, unknown> = {}) {
  return {
    storage_zone_name: "zone",
    access_key: "k",
    endpoint: "storage.bunnycdn.com",
    ...extra,
  } as any
}

test("F-404: init() 把无协议的 cdn_base_url 归一化并写回，get() 不再抛 Invalid URL", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        { ObjectName: "a.mp4", IsDirectory: false, Length: 5, Guid: "g1" },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch

  const driver = new BunnyStorageDriver(
    baseAddition({ cdn_base_url: "myzone.b-cdn.net" }),
  )
  await driver.init()
  assert.match((driver as any).addition.cdn_base_url, /^https:\/\//)

  const item = await driver.get("/a.mp4", "/a.mp4")
  assert.equal(item.raw_url, "https://myzone.b-cdn.net/a.mp4")
})

test("F-408: 文件名含非法 % 转义时签名不抛 URIError", async () => {
  const addition = baseAddition({
    cdn_base_url: "https://cdn.example.com",
    cdn_token_key: "secret",
  })
  const url = cdnURL(addition, "/dir/50%off.zip")
  const signed = await signCDNURL(addition, url)
  assert.match(signed, /token=/)
  assert.match(signed, /50%off\.zip/)
})

test("F-405: 开启 cdn_token_include_ip 后签名包含客户端 IP", async () => {
  const addition = baseAddition({
    cdn_base_url: "https://cdn.example.com",
    cdn_token_key: "secret",
    cdn_token_include_ip: true,
  })
  const url = "https://cdn.example.com/video.mp4"
  const withIp = await signCDNURL(addition, url, "192.0.2.1")
  const otherIp = await signCDNURL(addition, url, "198.51.100.7")
  const noIp = await signCDNURL(addition, url, "")

  const token = (u: string) => new URL(u).searchParams.get("token")
  assert.notEqual(token(withIp), token(otherIp))
  assert.notEqual(token(withIp), token(noIp))

  // 关闭开关时 IP 不参与签名
  const off = { ...addition, cdn_token_include_ip: false }
  assert.equal(
    token(await signCDNURL(off, url, "192.0.2.1")),
    token(await signCDNURL(off, url, "")),
  )
})

test("F-409: cdnURL 剥离 cdn_base_url 里的挂载前缀（Go TestCDNURLDropsMountPathFromBaseURL）", async () => {
  const addition = baseAddition({ cdn_base_url: "https://cdn.firmant.me/BS/" })
  assert.equal(
    cdnURL(addition, "/Video", "/BS"),
    "https://cdn.firmant.me/Video",
  )
  // 无挂载前缀时不改变现有行为
  assert.equal(
    cdnURL(addition, "/Video", ""),
    "https://cdn.firmant.me/BS/Video",
  )

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        { ObjectName: "Video", IsDirectory: false, Length: 5, Guid: "g" },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch
  const driver = new BunnyStorageDriver(
    baseAddition({ cdn_base_url: "https://cdn.firmant.me/BS/" }),
  )
  await driver.init()
  // 虚拟路径含挂载点 /BS，物理路径不含
  const item = await driver.get("/BS/Video", "/Video")
  assert.equal(item.raw_url, "https://cdn.firmant.me/Video")
})
