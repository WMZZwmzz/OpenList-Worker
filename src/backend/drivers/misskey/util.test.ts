import test from "node:test"
import assert from "node:assert/strict"
import { ClientMisskey, PAGE_LIMIT } from "./util"

function stubFetch(
  handler: (path: string, body: any) => any,
): { calls: { path: string; body: any }[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: { path: string; body: any }[] = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const path = String(input).replace("https://mk.example.com/api/drive", "")
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, body })
    const out = handler(path, body)
    return new Response(JSON.stringify(out), { status: 200 })
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

function makeClient() {
  return new ClientMisskey({
    endpoint: "https://mk.example.com",
    access_token: "token",
  })
}

/** 模拟 Misskey：无游标时 id DESC；untilId 时只返回 id < untilId */
function pagedSource(total: number) {
  const ids = Array.from({ length: total }, (_, i) => `id${String(total - i).padStart(4, "0")}`)
  return (body: any) => {
    const limit = body.limit ?? 10
    const pool = body.untilId ? ids.filter((id) => id < body.untilId) : ids
    return pool.slice(0, limit).map((id) => ({ id, name: `${id}.txt` }))
  }
}

test("F-468: getFiles 携带 limit=100 并按 untilId 翻页拉全量", async () => {
  const source = pagedSource(250)
  const { calls, restore } = stubFetch((path, body) => {
    assert.equal(path, "/files")
    return source(body)
  })
  try {
    const files = await makeClient().getFiles("folder-1")
    assert.equal(files.length, 250)
    assert.equal(new Set(files.map((f) => f.id)).size, 250)
    assert.equal(calls.length, 3)
    for (const c of calls) {
      assert.equal(c.body.limit, PAGE_LIMIT)
      assert.equal(c.body.folderId, "folder-1")
    }
    // 游标推进：下一页游标 = 本页最后一项（id 降序，故是页内最小的 id）
    assert.equal(calls[0].body.untilId, undefined)
    assert.equal(calls[1].body.untilId, "id0151")
    assert.equal(calls[2].body.untilId, "id0051")
  } finally {
    restore()
  }
})

test("F-468: getFolders 同样翻页且根目录不传 folderId", async () => {
  const source = pagedSource(120)
  const { calls, restore } = stubFetch((path, body) => {
    assert.equal(path, "/folders")
    return source(body)
  })
  try {
    const folders = await makeClient().getFolders()
    assert.equal(folders.length, 120)
    assert.equal(calls.length, 2)
    for (const c of calls) {
      assert.equal(c.body.limit, PAGE_LIMIT)
      assert.equal("folderId" in c.body, false)
    }
  } finally {
    restore()
  }
})

test("F-468: 服务端游标不前进时不死循环", async () => {
  const { calls, restore } = stubFetch(() => {
    // 永远返回满页且 id 不变（异常服务端）
    return Array.from({ length: PAGE_LIMIT }, () => ({ id: "same", name: "x" }))
  })
  try {
    const files = await makeClient().getFiles()
    // 重复 id 被去重，第二页没有任何新条目即停止
    assert.equal(files.length, 1)
    assert.equal(calls.length, 2)
  } finally {
    restore()
  }
})

test("F-468: 空目录只请求一次", async () => {
  const { calls, restore } = stubFetch(() => [])
  try {
    const files = await makeClient().getFiles()
    assert.deepEqual(files, [])
    assert.equal(calls.length, 1)
  } finally {
    restore()
  }
})
