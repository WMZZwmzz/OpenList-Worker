import test from "node:test"
import assert from "node:assert/strict"
import { WoPanClient } from "./util"

function stubResponse(data: any): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ STATUS: "200", RSP: { RSP_CODE: "0000", DATA: data } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as any
  return () => {
    globalThis.fetch = original
  }
}

test("DATA 是明文 JSON 时照常解析 (F-215)", async () => {
  const restore = stubResponse('{"files":[1,2]}')
  try {
    const client = new WoPanClient({ access_token: "0123456789abcdef" } as any)
    const data = await client.request<any>("wohome", "KeyQueryAllFiles", {})
    assert.deepEqual(data, { files: [1, 2] })
  } finally {
    restore()
  }
})

test("DATA 是可解密密文时正常解析 (F-215)", async () => {
  const client = new WoPanClient({ access_token: "0123456789abcdef" } as any)
  const cipher = (client as any).crypto.encrypt(
    JSON.stringify({ files: [3] }),
    "wohome",
  )
  const restore = stubResponse(cipher)
  try {
    const data = await client.request<any>("wohome", "KeyQueryAllFiles", {})
    assert.deepEqual(data, { files: [3] })
  } finally {
    restore()
  }
})

test("解密失败时抛错，不把密文当数据返回 (F-215)", async () => {
  const producer = new WoPanClient({
    access_token: "0123456789abcdef",
  } as any)
  const consumer = new WoPanClient({
    access_token: "fedcba9876543210",
  } as any)
  const cipher = (producer as any).crypto.encrypt(
    JSON.stringify({ files: [1] }),
    "wohome",
  )
  const restore = stubResponse(cipher)
  try {
    await assert.rejects(
      () => consumer.request<any>("wohome", "KeyQueryAllFiles", {}),
      /解密/,
    )
  } finally {
    restore()
  }
})

test("短于 16 字符的 access_token 视为无效并触发刷新 (F-216)", async () => {
  const client = new WoPanClient({
    access_token: "short",
    refresh_token: "refresh",
  } as any)
  assert.equal(client.getAccessToken(), "")
  assert.equal((client as any).crypto.accessKey, "")

  ;(client as any).appRefreshToken = async () => ({
    access_token: "0123456789abcdef",
    refresh_token: "new-refresh",
  })
  ;(client as any).appQueryUser = async () => ({})
  ;(client as any).classifyRule = async () => ({})
  ;(client as any).getZoneInfo = async () => ({})
  await client.initData()
  assert.equal(client.getAccessToken(), "0123456789abcdef")
})

test("刷新返回过短的 access_token 时报错 (F-216)", async () => {
  const client = new WoPanClient({
    access_token: "",
    refresh_token: "refresh",
  } as any)
  ;(client as any).appRefreshToken = async () => ({
    access_token: "short",
    refresh_token: "r2",
  })
  await assert.rejects(() => client.refreshToken(), /shorter than 16/)
})
