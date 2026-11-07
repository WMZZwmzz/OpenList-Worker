import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  ClientBaiduPhoto,
  getTid,
  parseBaiduPhotoJson,
} from "./util"

const BIG_TID = "3171468985035633694"

function md5Hex(data: Uint8Array | string): string {
  return createHash("md5").update(data).digest("hex")
}

test("getTid 生成 18 位字符串 (F-300)", () => {
  const tid = getTid()
  assert.equal(typeof tid, "string")
  assert.equal(tid.length, 18)
  assert.match(tid, /^3\d{17}$/)
})

test("parseBaiduPhotoJson 把大整数 tid 预置为字符串 (F-300)", () => {
  const parsed = parseBaiduPhotoJson<any>(
    `{"tid":${BIG_TID},"title":"t"}`,
  )
  assert.equal(parsed.tid, BIG_TID)
  assert.equal(typeof parsed.tid, "string")
  // 其它数字字段保持数字语义
  const nested = parseBaiduPhotoJson<any>(
    `{"data":{"tid":${BIG_TID}},"size":12}`,
  )
  assert.equal(nested.data.tid, BIG_TID)
  assert.equal(nested.size, 12)
})

test("getAllAlbum 解析服务端数字 tid 时保留精度 (F-300)", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      `{"list":[{"album_id":"a","tid":${BIG_TID},"title":"t","create_time":0,"mtime":0}]}`,
      { status: 200, headers: { "content-type": "application/json" } },
    )) as any
  try {
    const client = new ClientBaiduPhoto({ cookie: "c" })
    const albums = await client.getAllAlbum()
    assert.equal(String(albums[0].tid), BIG_TID)
  } finally {
    globalThis.fetch = original
  }
})

test("requestJson 对非 2xx 和非 JSON 响应显式报错 (F-299)", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      new Response("<html>bad gateway</html>", { status: 502 })) as any
    const client = new ClientBaiduPhoto({ cookie: "c" })
    await assert.rejects(() => client.uInfo(), /HTTP 502/)

    globalThis.fetch = (async () =>
      new Response("<html>waf</html>", { status: 200 })) as any
    await assert.rejects(() => client.uInfo(), /invalid JSON/)
  } finally {
    globalThis.fetch = original
  }
})

test("upload 分片读取并校验 errno，失败分片有限重试 (F-303)", async () => {
  const client = new ClientBaiduPhoto({ cookie: "c" }) as any
  client.requestJson = async () => ({
    return_type: 1,
    uploadid: "upload-id",
    block_list: [0],
  })
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response('{"errno":2}', { status: 200 })
  }) as any
  try {
    await assert.rejects(
      () => client.upload(null, "a.bin", new Uint8Array([1, 2, 3])),
      /errno 2/,
    )
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = original
  }
})

test("upload 在 create 未返回 fs_id 时报错而不是静默成功 (F-303)", async () => {
  const client = new ClientBaiduPhoto({ cookie: "c" }) as any
  let step = 0
  client.requestJson = async () => {
    step++
    if (step === 1) {
      return { return_type: 1, uploadid: "upload-id", block_list: [0] }
    }
    return { errno: 0 } // create 成功但缺少 data.fs_id
  }
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"errno":0}', { status: 200 })) as any
  try {
    await assert.rejects(
      () => client.upload(null, "a.bin", new Uint8Array([1, 2, 3])),
      /fs_id/,
    )
  } finally {
    globalThis.fetch = original
  }
})

test("upload 的 content-md5 / block-list / slice-md5 计算正确 (F-304)", async () => {
  const client = new ClientBaiduPhoto({ cookie: "c" }) as any
  const content = Buffer.from("hello baidu photo upload")
  let form: any = null
  client.requestJson = async (
    _method: string,
    _url: string,
    options: any,
  ) => {
    form = options.form
    // 秒传命中：跳过切片上传
    return { return_type: 2, data: { fs_id: 123 } }
  }

  await client.upload(null, "a.bin", content)

  assert.ok(form)
  assert.equal(form!["content-md5"], md5Hex(content))
  assert.equal(
    form!["slice-md5"],
    md5Hex(content.subarray(0, Math.min(256 * 1024, content.length))),
  )
  assert.deepEqual(JSON.parse(form!.block_list), [md5Hex(content)])
})

test("upload 分片成功路径（HTTP 200 + errno 0）正常完成 (F-303)", async () => {
  const client = new ClientBaiduPhoto({ cookie: "c" }) as any
  let step = 0
  client.requestJson = async () => {
    step++
    if (step === 1) {
      return { return_type: 1, uploadid: "upload-id", block_list: [0] }
    }
    return { data: { fs_id: 9 } }
  }
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"errno":0}', { status: 200 })) as any
  try {
    await client.upload(null, "a.bin", new Uint8Array([1, 2, 3]))
    assert.equal(step, 2)
  } finally {
    globalThis.fetch = original
  }
})
