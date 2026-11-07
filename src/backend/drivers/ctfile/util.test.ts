import assert from "node:assert/strict"
import { test } from "node:test"

import { CtFileClient } from "./util"
import { normalizeCtFileAddition } from "./driver"

interface CapturedCall {
  url: string
  body: any
}

/**
 * 用脚本化的 fetch stub 替换全局 fetch，
 * 按调用顺序返回预设响应，并捕获请求体用于断言。
 */
function stubFetch(
  responses: Array<{
    status?: number
    body?: any
    /** 未显式给出 body 时，其余字段整体作为响应体 */
    [key: string]: any
  }>,
): { calls: CapturedCall[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: CapturedCall[] = []
  let index = 0

  globalThis.fetch = (async (input: any, init?: any) => {
    const payload = (() => {
      try {
        return init?.body ? JSON.parse(String(init.body)) : {}
      } catch {
        return {}
      }
    })()
    calls.push({ url: String(input), body: payload })

    const scripted = responses[Math.min(index, responses.length - 1)]
    index++
    const status = scripted.status ?? 200
    const body =
      scripted.body !== undefined
        ? scripted.body
        : // 未显式给出 body 时，脚本对象的其余字段整体作为响应体
          Object.fromEntries(
            Object.entries(scripted).filter(([k]) => k !== "status"),
          )
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as any

  return { calls, restore: () => (globalThis.fetch = original) }
}

test("session 缺失时给出明确提示", async () => {
  const client = new CtFileClient({} as any)
  await assert.rejects(() => client.listFolders("d0"), /未配置 Session/)
})

test("401 响应转换为 Session 失效提示", async () => {
  const stub = stubFetch([{ code: 401, message: "未登录" }])
  try {
    const client = new CtFileClient({ session: "expired-token" } as any)
    await assert.rejects(
      () => client.profile(),
      /Session 已失效（未登录）.*开放接口登录密钥管理/,
    )
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].body.session, "expired-token")
  } finally {
    stub.restore()
  }
})

test("folder/meta 按文档优先去前缀，400 后回退带 d 前缀 (F-234)", async () => {
  const stub = stubFetch([
    { code: 400, message: "资源不存在" },
    { code: 200, key: "d123", name: "相册" },
  ])
  try {
    const client = new CtFileClient({ session: "s" } as any)
    const meta = await client.folderMeta("d123")
    assert.equal(meta.name, "相册")
    assert.equal(stub.calls.length, 2)
    assert.equal(stub.calls[0].body.folder_id, "123")
    assert.equal(stub.calls[1].body.folder_id, "d123")
    assert.equal(
      stub.calls[1].url,
      "https://rest.ctfile.com/v1/public/folder/meta",
    )
  } finally {
    stub.restore()
  }
})

test("fetch_url 按文档优先去前缀，400 后回退带前缀", async () => {
  const stub = stubFetch([
    { code: 400, message: "参数错误" },
    { code: 200, download_url: "https://download.ctfile.com/getfile.php?x=1" },
  ])
  try {
    const client = new CtFileClient({ session: "s" } as any)
    const url = await client.fetchDownloadUrl("f478659195")
    assert.match(url, /^https:\/\/download\.ctfile\.com\//)
    assert.equal(stub.calls[0].body.file_id, "478659195")
    assert.equal(stub.calls[1].body.file_id, "f478659195")
  } finally {
    stub.restore()
  }
})

test("file/list 自动翻页并在空页终止", async () => {
  const stub = stubFetch([
    {
      code: 200,
      results: [
        { key: "f1", name: "a.txt", size: 1 },
        { key: "f2", name: "b.txt", size: 2 },
      ],
    },
    { code: 200, results: [] },
  ])
  try {
    const client = new CtFileClient({ session: "s" } as any)
    const files = await client.listFiles("d0")
    assert.equal(files.length, 2)
    assert.equal(files[0].key, "f1")
    assert.equal(stub.calls.length, 2)
    assert.equal(stub.calls[0].body.start, 0)
    assert.equal(stub.calls[1].body.start, 2)
    assert.equal(stub.calls[0].body.folder_id, "d0")
  } finally {
    stub.restore()
  }
})

test("file/list 服务端忽略 start 时靠重复首项终止（防死循环）", async () => {
  const page = {
    code: 200,
    results: [
      { key: "f1", name: "a.txt", size: 1 },
      { key: "f2", name: "b.txt", size: 2 },
    ],
  }
  const stub = stubFetch([page, page, page, page])
  try {
    const client = new CtFileClient({ session: "s" } as any)
    const files = await client.listFiles("d0")
    assert.equal(files.length, 2)
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
  }
})

test("delete ids 先逗号字符串，400 后回退数组", async () => {
  const stub = stubFetch([
    { code: 400, message: "参数错误" },
    { code: 200, message: "文件已删除" },
  ])
  try {
    const client = new CtFileClient({ session: "s" } as any)
    await client.remove(["f1", "f2"])
    assert.equal(stub.calls.length, 2)
    assert.equal(stub.calls[0].body.ids, "f1,f2")
    assert.deepEqual(stub.calls[1].body.ids, ["f1", "f2"])
  } finally {
    stub.restore()
  }
})

test("private 云走 /v1/private/ 命名空间", async () => {
  const stub = stubFetch([{ code: 200, results: [] }])
  try {
    const client = new CtFileClient({
      session: "s",
      cloud_type: "private",
    } as any)
    await client.listFolders("d0")
    assert.match(stub.calls[0].url, /\/v1\/private\/folder\/list$/)
  } finally {
    stub.restore()
  }
})

test("uploadTicket 生成 md5-size 校验和", async () => {
  const stub = stubFetch([
    { code: 200, upload_url: "https://upload.ctfile.com/web/upload.do?key=k" },
  ])
  try {
    const client = new CtFileClient({ session: "s" } as any)
    const content = new TextEncoder().encode("hello")
    const ticket = await client.uploadTicket("d0", "hello.txt", content)
    assert.match(String(ticket.upload_url), /^https:\/\/upload\.ctfile\.com\//)
    // md5("hello") = 5d41402abc4b2a76b9719d911017c592，长度 5
    assert.equal(
      stub.calls[0].body.checksum,
      "5d41402abc4b2a76b9719d911017c592-5",
    )
    assert.equal(stub.calls[0].body.size, 5)
    assert.equal(stub.calls[0].body.name, "hello.txt")
  } finally {
    stub.restore()
  }
})

test("normalizeCtFileAddition 填充默认值", () => {
  const norm = normalizeCtFileAddition({})
  assert.equal(norm.session, "")
  assert.equal(norm.cloud_type, "public")
  assert.equal(norm.base_url, "https://rest.ctfile.com/v1")
  assert.equal(norm.order_by, "name")
  assert.equal(norm.order_direction, "asc")
  assert.match(norm.user_agent || "", /Mozilla\/5\.0/)

  const custom = normalizeCtFileAddition({
    session: "  abc  ",
    cloud_type: "private",
    order_by: "size",
    order_direction: "desc",
  })
  assert.equal(custom.session, "abc")
  assert.equal(custom.cloud_type, "private")
  assert.equal(custom.order_by, "size")
  assert.equal(custom.order_direction, "desc")
})

test("withOrder：asc 的 size/time 发出升序令牌，desc 翻转 (F-233)", async () => {
  const stub = stubFetch([{ code: 200, results: [] }])
  try {
    const asc = new CtFileClient({
      session: "s",
      order_by: "size",
      order_direction: "asc",
    } as any)
    await asc.listFolders("d0")
    assert.equal(stub.calls[0].body.orderby, "small")

    const desc = new CtFileClient({
      session: "s",
      order_by: "time",
      order_direction: "desc",
    } as any)
    await desc.listFolders("d0")
    assert.equal(stub.calls[1].body.orderby, "new")
  } finally {
    stub.restore()
  }
})

test("429/5xx 会继续重试且不把响应体留在未消费状态 (F-232)", async () => {
  const original = globalThis.fetch
  let calls = 0
  let cancelled = false
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) {
      const res = new Response("rate limited", { status: 429 })
      const origBody = res.body
      Object.defineProperty(res, "body", {
        value: {
          cancel: async () => {
            cancelled = true
            await origBody?.cancel()
          },
        },
      })
      return res
    }
    return new Response(JSON.stringify({ code: 200, results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as any
  try {
    const client = new CtFileClient({ session: "s" } as any)
    const folders = await client.listFolders("d0")
    assert.deepEqual(folders, [])
    assert.equal(calls, 2)
    assert.equal(cancelled, true)
  } finally {
    globalThis.fetch = original
  }
})

test("读取响应体中途失败时走重试与统一错误包装 (F-232)", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) {
      return {
        status: 200,
        ok: true,
        text: async () => {
          throw new TypeError("terminated")
        },
      }
    }
    return new Response(JSON.stringify({ code: 200, results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as any
  try {
    const client = new CtFileClient({ session: "s" } as any)
    assert.deepEqual(await client.listFolders("d0"), [])
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = original
  }
})

test("uploadTicket 只对传入的视图计算 md5（不复制整文件）(F-231)", async () => {
  const stub = stubFetch([{ code: 200, upload_url: "https://u/" }])
  try {
    const client = new CtFileClient({ session: "s" } as any)
    const backing = new TextEncoder().encode("XXhelloYY")
    const view = backing.subarray(2, 7) // "hello"
    await client.uploadTicket("d0", "hello.txt", view)
    assert.equal(
      stub.calls[0].body.checksum,
      "5d41402abc4b2a76b9719d911017c592-5",
    )
  } finally {
    stub.restore()
  }
})
