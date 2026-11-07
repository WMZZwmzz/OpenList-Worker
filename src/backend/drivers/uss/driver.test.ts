import test from "node:test"
import assert from "node:assert/strict"
import { UssDriver } from "./driver"

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
}

function stubFetch(responses: {
  body: string
  status?: number
  headers?: Record<string, string>
}[]): {
  captured: Captured[]
  restore: () => void
} {
  const original = globalThis.fetch
  const captured: Captured[] = []
  let i = 0
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: String(init?.method || "GET"),
      headers: { ...((init?.headers as Record<string, string>) || {}) },
    })
    const r = responses[Math.min(i++, responses.length - 1)]
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: r.headers,
    })
  }) as typeof fetch
  return {
    captured,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

function makeDriver() {
  return new UssDriver({
    bucket: "mybucket",
    endpoint: "https://dl.example.com",
    operator_name: "op",
    operator_password: "pw",
  })
}

test("F-475: JSON 响应 {files:[...]} 正确解析，目录 type=folder", async () => {
  const body = JSON.stringify({
    files: [
      { type: "folder", length: 0, name: "bar", last_modified: 1700000000 },
      { type: "image/jpeg", length: 1234, name: "foo.jpg", last_modified: 1700000001 },
    ],
    iter: "",
  })
  const { captured, restore } = stubFetch([{ body }])
  try {
    const items = await makeDriver().list("/", "/")
    assert.equal(items.length, 2)
    const byName = new Map(items.map((i) => [i.name, i]))
    assert.equal(byName.get("bar")?.is_dir, true)
    assert.equal(byName.get("foo.jpg")?.is_dir, false)
    assert.equal(byName.get("foo.jpg")?.size, 1234)
    assert.equal(byName.get("foo.jpg")?.modified, new Date(1700000001 * 1000).toISOString())
    // 不得把整段 JSON 当成一个条目
    assert.ok(!items.some((i) => i.name.includes("{")))
    assert.equal(captured[0].headers.Accept, "application/json")
  } finally {
    restore()
  }
})

test("F-475: 文本行格式仍然可用（text/plain 回退）", async () => {
  const body = "foo.jpg\tN\t1234\t1700000001\nbar\tF\t0\t1700000000\n"
  const { restore } = stubFetch([{ body }])
  try {
    const items = await makeDriver().list("/", "/")
    const byName = new Map(items.map((i) => [i.name, i]))
    assert.equal(byName.get("bar")?.is_dir, true)
    assert.equal(byName.get("foo.jpg")?.size, 1234)
  } finally {
    restore()
  }
})

test("F-475: 结构不符的 JSON 不再退化为按行解析", async () => {
  const { restore } = stubFetch([{ body: '{"unexpected":true}' }])
  try {
    const items = await makeDriver().list("/", "/")
    assert.deepEqual(items, [])
  } finally {
    restore()
  }
})

test("F-476: move 的 X-Upyun-Move-Source 带 bucket 段", async () => {
  const { captured, restore } = stubFetch([{ body: "" }])
  try {
    const driver = makeDriver()
    await driver.move("/src", "/dst", ["a.txt"], "/dir/a.txt", "/dst/a.txt")
    assert.equal(captured.length, 1)
    assert.equal(captured[0].method, "PUT")
    assert.equal(captured[0].url, "https://v0.api.upyun.com/mybucket/dst/a.txt")
    assert.equal(captured[0].headers["X-Upyun-Move-Source"], "/mybucket/dir/a.txt")
  } finally {
    restore()
  }
})

test("F-476: copy 与 rename 的源地址同样带 bucket 段", async () => {
  const { captured, restore } = stubFetch([{ body: "" }])
  try {
    const driver = makeDriver()
    await driver.copy("/src", "/dst", ["a.txt"], "/dir/a.txt", "/dst/a.txt")
    await driver.rename("/dir/b.txt", "/dir/b.txt", "c.txt")
    assert.equal(captured[0].headers["X-Upyun-Copy-Source"], "/mybucket/dir/a.txt")
    assert.equal(captured[0].url, "https://v0.api.upyun.com/mybucket/dst/a.txt")
    assert.equal(captured[1].headers["X-Upyun-Move-Source"], "/mybucket/dir/b.txt")
    assert.equal(captured[1].url, "https://v0.api.upyun.com/mybucket/dir/c.txt")
  } finally {
    restore()
  }
})

test("F-478: 列表按 x-upyun-list-iter 翻页直到结束标记", async () => {
  const page1 = JSON.stringify({
    files: [{ type: "N", length: 1, name: "a.txt", last_modified: 1700000000 }],
    iter: "page2token",
  })
  const page2 = JSON.stringify({
    files: [{ type: "N", length: 2, name: "b.txt", last_modified: 1700000001 }],
    iter: "g2gCZAAEbmV4dGQAA2VvZg",
  })
  const { captured, restore } = stubFetch([
    { body: page1, headers: { "x-upyun-list-iter": "page2token" } },
    { body: page2, headers: { "x-upyun-list-iter": "g2gCZAAEbmV4dGQAA2VvZg" } },
  ])
  try {
    const items = await makeDriver().list("/", "/")
    assert.deepEqual(
      items.map((i) => i.name),
      ["a.txt", "b.txt"],
      "第二页条目不得丢失",
    )
    assert.equal(captured.length, 2, "必须发出第二页请求")
    assert.ok(
      captured[0].headers["x-list-limit"],
      "必须显式请求较大页长（默认仅 100）",
    )
    assert.equal(captured[1].headers["x-list-iter"], "page2token")
  } finally {
    restore()
  }
})

test("F-478: 服务端忽略 x-list-iter（迭代值不前进）时不死循环", async () => {
  const body = JSON.stringify({
    files: [{ type: "N", length: 1, name: "a.txt", last_modified: 1700000000 }],
    iter: "same",
  })
  const { captured, restore } = stubFetch([
    { body, headers: { "x-upyun-list-iter": "same" } },
    { body, headers: { "x-upyun-list-iter": "same" } },
  ])
  try {
    await makeDriver().list("/", "/")
    assert.equal(captured.length, 2, "迭代值重复时必须终止")
  } finally {
    restore()
  }
})

test("F-479: 含 # / ? 的 key 在 URL 路径中必须百分号编码", async () => {
  const { captured, restore } = stubFetch([{ body: "" }])
  try {
    const driver = makeDriver()
    await driver.mkdir("/v", "/dir#1/sub?x")
    await driver.remove("/v", "/dir#1/a b.txt", [])
    await driver.put("/v", "/dir#1/a b.txt", Buffer.from("x"))
    assert.equal(
      captured[0].url,
      "https://v0.api.upyun.com/mybucket/dir%231/sub%3Fx/",
    )
    assert.equal(
      captured[1].url,
      "https://v0.api.upyun.com/mybucket/dir%231/a%20b.txt",
    )
    assert.equal(
      captured[2].url,
      "https://v0.api.upyun.com/mybucket/dir%231/a%20b.txt",
    )
  } finally {
    restore()
  }
})

test("F-480: get() 对目录返回 is_dir:true，对不存在路径抛错，文件带 size", async () => {
  // 目录
  const dirStub = stubFetch([
    {
      body: "",
      headers: { "x-upyun-file-type": "folder", "x-upyun-file-date": "1700000000" },
    },
  ])
  try {
    const item = await makeDriver().get("/v", "/somedir")
    assert.equal(item.is_dir, true)
    assert.equal(item.raw_url, "", "目录不应生成文件直链")
    assert.equal(item.modified, new Date(1700000000 * 1000).toISOString())
  } finally {
    dirStub.restore()
  }

  // 文件
  const fileStub = stubFetch([
    {
      body: "",
      headers: { "x-upyun-file-type": "file", "x-upyun-file-size": "42" },
    },
  ])
  try {
    const item = await makeDriver().get("/v", "/a#b.txt")
    assert.equal(item.is_dir, false)
    assert.equal(item.size, 42)
    assert.ok(
      (item.raw_url || "").includes("/a%23b.txt?"),
      item.raw_url,
    )
  } finally {
    fileStub.restore()
  }

  // 不存在
  const missingStub = stubFetch([{ body: "", status: 404 }])
  try {
    await assert.rejects(() => makeDriver().get("/v", "/nope"), /not found/i)
  } finally {
    missingStub.restore()
  }
})
