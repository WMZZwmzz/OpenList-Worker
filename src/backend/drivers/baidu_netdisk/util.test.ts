import test from "node:test"
import assert from "node:assert/strict"
import { BaiduClient } from "./util"

test("getOfficialLink 在 HEAD 无 Location 时报错，不返回被剥离 token 的断链 (F-210)", async () => {
  const client = new BaiduClient({
    access_token: "TOKEN",
    refresh_token: "",
  } as any)
  ;(client as any).get = async () => ({
    list: [{ dlink: "https://d.pcs.baidu.com/file/x?fid=1" }],
  })
  ;(client as any).accessToken = "TOKEN"

  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(null, { status: 200 })) as any
  try {
    await assert.rejects(
      () => client.getOfficialLink(1),
      /no redirect location/,
    )
  } finally {
    globalThis.fetch = original
  }
})

test("getOfficialLink 仅对 302 Location 做 sanitize，保留必要参数 (F-210)", async () => {
  const client = new BaiduClient({
    access_token: "TOKEN",
    refresh_token: "",
  } as any)
  ;(client as any).get = async () => ({
    list: [{ dlink: "https://d.pcs.baidu.com/file/x?fid=1" }],
  })
  ;(client as any).accessToken = "TOKEN"

  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 302,
      headers: {
        location:
          "https://d.pcs.baidu.com/file/x?fid=1&uk=7&access_token=SECRET",
      },
    })) as any
  try {
    const link = await client.getOfficialLink(1)
    assert.match(link.url, /fid=1/)
    assert.match(link.url, /uk=7/)
    assert.doesNotMatch(link.url, /access_token/)
  } finally {
    globalThis.fetch = original
  }
})
