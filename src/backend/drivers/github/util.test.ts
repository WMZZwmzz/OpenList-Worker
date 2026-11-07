import assert from "node:assert/strict"
import { test } from "node:test"
import { GithubApiClient, isChildPath, renderCommitMessage } from "./util"

/**
 * F-200 回归：`renewParentTrees` 必须按【目录名】而不是【子树 sha】在父树中定位
 * 待替换的条目。git 树的 sha 完全由内容决定，两个都只含空 .gitkeep 的兄弟目录
 * sha 必然相同（本驱动 mkdir 就是给每个新目录建同一棵树），按 sha 匹配会命中
 * 排序靠前的兄弟，导致提交落到错误目录。
 */

type Call = { method: string; url: string; body?: string }

const ROOT_SHA = "root-sha"
const SAME_SHA = "same-empty-dir-sha"

function mockGithub(calls: Call[]) {
  return async (input: any, init: any = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url))
    const method = String(init.method || "GET").toUpperCase()
    calls.push({
      method,
      url: url.toString(),
      body: typeof init.body === "string" ? init.body : undefined,
    })

    // GET /contents[/...]：根目录内容
    if (method === "GET" && url.pathname.endsWith("/contents")) {
      return Response.json({
        type: "dir",
        sha: ROOT_SHA,
        entries: [
          { name: "d1", type: "dir", sha: SAME_SHA, size: 0 },
          { name: "d2", type: "dir", sha: SAME_SHA, size: 0 },
        ],
      })
    }

    // GET /git/trees/root-sha：d1、d2 的 sha 完全相同，d1 排在前面
    if (method === "GET" && url.pathname.endsWith(`/git/trees/${ROOT_SHA}`)) {
      return Response.json({
        sha: ROOT_SHA,
        truncated: false,
        tree: [
          { path: "d1", mode: "040000", type: "tree", sha: SAME_SHA },
          { path: "d2", mode: "040000", type: "tree", sha: SAME_SHA },
        ],
      })
    }

    // POST /git/trees：创建新树（无论 base_tree 是谁都返回固定 sha）
    if (method === "POST" && url.pathname.endsWith("/git/trees")) {
      return Response.json({ sha: "new-root-sha" })
    }

    return new Response("not found", { status: 404 })
  }
}

test("renewParentTrees 按目录名定位同 sha 的兄弟目录（F-200）", async () => {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = mockGithub(calls) as any
  try {
    const client = new GithubApiClient({
      token: "",
      owner: "o",
      repo: "r",
    })

    const rootSha = await client.renewParentTrees(
      "/d2",
      SAME_SHA,
      "new-d2-tree-sha",
      "/",
      "main",
    )
    assert.equal(rootSha, "new-root-sha")

    const post = calls.find((c) => c.method === "POST")
    assert.ok(post, "应创建新树")
    const body = JSON.parse(post!.body || "{}")
    assert.equal(body.base_tree, ROOT_SHA)
    assert.deepEqual(body.tree, [
      { path: "d2", mode: "040000", type: "tree", sha: "new-d2-tree-sha" },
    ])
  } finally {
    globalThis.fetch = original
  }
})

test("renewParentTrees 目标目录不存在时报错（不再误命中同 sha 条目）", async () => {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = mockGithub(calls) as any
  try {
    const client = new GithubApiClient({
      token: "",
      owner: "o",
      repo: "r",
    })
    await assert.rejects(
      () => client.renewParentTrees("/missing", SAME_SHA, "x", "/", "main"),
      /not found/,
    )
  } finally {
    globalThis.fetch = original
  }
})

// ---- F-201: 路径段百分号编码 ----
test("getContentApiUrl 对每个路径段做百分号编码（F-201）", () => {
  const client = new GithubApiClient({ token: "", owner: "o", repo: "r" })
  assert.equal(
    client.getContentApiUrl("/dir/a#b?c%d"),
    "https://api.github.com/repos/o/r/contents/dir/a%23b%3Fc%25d",
  )
  assert.equal(
    client.getContentApiUrl("/中文 目录/x.txt"),
    "https://api.github.com/repos/o/r/contents/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/x.txt",
  )
  assert.equal(
    client.getContentApiUrl("/"),
    "https://api.github.com/repos/o/r/contents",
  )
})

// ---- F-202: 段级父子判断 ----
test("isChildPath 使用路径段前缀而非字符串前缀（F-202）", () => {
  assert.equal(isChildPath("/aa/1", "/aa/1x"), false)
  assert.equal(isChildPath("/aa", "/aab/x"), false)
  assert.equal(isChildPath("/aa", "/aa/1"), true)
  assert.equal(isChildPath("/", "/aa"), true)
  assert.equal(isChildPath("/aa", "/aa"), false)
})

// ---- F-206: 提交消息模板变量不得展开 $ 替换模式 ----
test("renderCommitMessage 不展开 $& / $' / $$（F-206）", () => {
  assert.equal(
    renderCommitMessage("upload {{.ObjName}} to {{.ObjPath}}", {
      UserName: "u",
      ObjName: "$&x.txt",
      ObjPath: "/docs/$&x.txt",
      ParentName: "docs",
      ParentPath: "/docs",
    }, "upload"),
    "upload $&x.txt to /docs/$&x.txt",
  )
  assert.equal(
    renderCommitMessage("rename {{.ObjName}} -> {{.TargetName}}", {
      UserName: "u",
      ObjName: "photo$'",
      ObjPath: "/docs/photo$'",
      ParentName: "docs",
      ParentPath: "/docs",
      TargetName: "pay$$100.txt",
    }, "rename"),
    "rename photo$' -> pay$$100.txt",
  )
})
