import test from "node:test"
import assert from "node:assert/strict"
import { GithubDriver } from "./driver"

/**
 * github 驱动回归测试：F-203（私有仓库无 download_url 的流式回退）、
 * F-204（空仓库可用）、F-205（只有 404 才降级为非分支）、
 * F-207（写入对象本身为 .gitkeep 时不得构造重复 tree 条目）。
 */

type Call = { method: string; url: string; body: string }

type Route = {
  method: string
  /** URL pathname 包含该片段即命中 */
  match: string
  response: () => Response
}

function installFetch(routes: Route[]): { calls: Call[]; restore: () => void } {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url))
    const method = String(init.method || "GET").toUpperCase()
    calls.push({
      method,
      url: url.toString(),
      body: typeof init.body === "string" ? init.body : "",
    })
    const route = routes.find(
      (r) => r.method === method && url.pathname.includes(r.match),
    )
    if (!route) {
      return new Response(JSON.stringify({ message: "unexpected" }), {
        status: 500,
      })
    }
    return route.response()
  }) as any
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })

function newDriver(ref = "main") {
  return new GithubDriver({
    token: "tok",
    owner: "o",
    repo: "r",
    ref,
  })
}

test("get(): 私有仓库 download_url=null 时返回 raw_url_error（F-203）", async () => {
  const mock = installFetch([
    {
      method: "GET",
      match: "/contents/",
      response: () =>
        json({
          type: "file",
          name: "secret.txt",
          path: "secret.txt",
          sha: "blob-sha",
          size: 5,
          download_url: null,
        }),
    },
  ])
  try {
    const item = await newDriver().get("/secret.txt", "/secret.txt")
    assert.equal(item.is_dir, false)
    assert.equal(item.raw_url, "")
    assert.match(item.raw_url_error || "", /私有仓库/)
  } finally {
    mock.restore()
  }
})

test("createReadStream(): 用带 token 的 blob API 取原始字节（F-203）", async () => {
  const body = new TextEncoder().encode("hello")
  const mock = installFetch([
    {
      method: "GET",
      match: "/contents/",
      response: () =>
        json({
          type: "file",
          name: "secret.txt",
          path: "secret.txt",
          sha: "blob-sha",
          size: 5,
          download_url: null,
        }),
    },
    {
      method: "GET",
      match: "/git/blobs/blob-sha",
      response: () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    },
  ])
  try {
    const stream = await newDriver().createReadStream("/secret.txt")
    assert.equal(await new Response(stream).text(), "hello")
    const blobCall = mock.calls.find((c) => c.url.includes("/git/blobs/"))
    assert.ok(blobCall)
  } finally {
    mock.restore()
  }
})

test("空仓库：init/list 可用，put 走首次提交 + 创建 ref（F-204）", async () => {
  const mock = installFetch([
    {
      method: "GET",
      match: "/branches/main",
      response: () => json({ message: "Branch not found" }, 404),
    },
    {
      method: "GET",
      match: "/branches",
      response: () => json([]),
    },
    {
      method: "GET",
      match: "/contents",
      response: () =>
        json({ message: "This repository is empty." }, 404),
    },
    {
      method: "POST",
      match: "/git/blobs",
      response: () => json({ sha: "blob1" }),
    },
    {
      method: "POST",
      match: "/git/trees",
      response: () => json({ sha: "tree1" }),
    },
    {
      method: "POST",
      match: "/git/commits",
      response: () => json({ sha: "commit1" }),
    },
    {
      method: "POST",
      match: "/git/refs",
      response: () => json({ ref: "refs/heads/main" }, 201),
    },
  ])
  try {
    const driver = newDriver()
    await driver.init()
    assert.deepEqual(await driver.list("/", "/"), [])

    await driver.put("/x.txt", "/x.txt", Buffer.from("hi"))

    const treePost = mock.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/git/trees"),
    )
    assert.ok(treePost, "应创建 tree")
    const treeBody = JSON.parse(treePost!.body)
    assert.equal(treeBody.base_tree, undefined)
    assert.deepEqual(treeBody.tree, [
      { path: "x.txt", mode: "100644", type: "blob", sha: "blob1" },
    ])

    const commitPost = mock.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/git/commits"),
    )
    assert.ok(commitPost)
    assert.equal(JSON.parse(commitPost!.body).parents, undefined)

    const refPost = mock.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/git/refs"),
    )
    assert.ok(refPost, "首次提交后必须创建分支引用")
    assert.deepEqual(JSON.parse(refPost!.body), {
      ref: "refs/heads/main",
      sha: "commit1",
    })
    assert.ok(
      !mock.calls.some((c) => c.method === "PATCH"),
      "空仓库不应 PATCH 不存在的 ref",
    )
  } finally {
    mock.restore()
  }
})

test("init(): 非 404 的 getBranchHead 失败原样抛出（F-205）", async () => {
  const mock = installFetch([
    {
      method: "GET",
      match: "/branches/main",
      response: () => json({ message: "rate limited" }, 429),
    },
  ])
  try {
    await assert.rejects(() => newDriver().init(), /429/)
    assert.ok(!mock.calls.some((c) => c.url.includes("/branches?")))
  } finally {
    mock.restore()
  }
})

test("init(): 404 且仓库非空时降级为非分支（F-205/F-204）", async () => {
  const mock = installFetch([
    {
      method: "GET",
      match: "/branches/release",
      response: () => json({ message: "Branch not found" }, 404),
    },
    {
      method: "GET",
      match: "/branches",
      response: () => json([{ name: "main" }]),
    },
  ])
  try {
    const driver = newDriver("release")
    await driver.init()
    await assert.rejects(
      () => driver.put("/x.txt", "/x.txt", Buffer.from("hi")),
      /cannot write to non-branch reference/,
    )
  } finally {
    mock.restore()
  }
})

test("put(): 上传名为 .gitkeep 的文件时不追加删除同 path 条目（F-207）", async () => {
  const mock = installFetch([
    {
      method: "GET",
      match: "/contents",
      response: () =>
        json({
          type: "dir",
          sha: "parent-sha",
          entries: [{ name: ".gitkeep", type: "file", sha: "k" }],
        }),
    },
    {
      method: "POST",
      match: "/git/blobs",
      response: () => json({ sha: "blob1" }),
    },
    {
      method: "POST",
      match: "/git/trees",
      response: () => json({ sha: "tree1" }),
    },
    {
      method: "GET",
      match: "/branches/main",
      response: () => json({ commit: { sha: "head" } }),
    },
    {
      method: "POST",
      match: "/git/commits",
      response: () => json({ sha: "commit1" }),
    },
    {
      method: "PATCH",
      match: "/git/refs/heads/main",
      response: () => json({}),
    },
  ])
  try {
    const driver = newDriver()
    await driver.init()
    await driver.put("/.gitkeep", "/.gitkeep", Buffer.from("x"))

    const treePost = mock.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/git/trees"),
    )
    assert.ok(treePost)
    const entries = JSON.parse(treePost!.body).tree
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, ".gitkeep")
    assert.equal(entries[0].sha, "blob1")
  } finally {
    mock.restore()
  }
})
