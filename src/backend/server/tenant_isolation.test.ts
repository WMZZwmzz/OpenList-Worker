import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { fsRouter } from "./fs"
import { rawRouter } from "./raw"
import { shareRouter } from "./share"
import { saveDb } from "../internal/model/db"

const JWT_SECRET = "0123456789abcdef0123456789abcdef"
// 测试里请求不带 env（c.env 为 undefined），getJwtSecret 会退到 process.env；
// 这里显式对齐，保证自签的 token 能被服务端验通。
process.env.JWT_SECRET = JWT_SECRET

/**
 * 租户隔离端到端回归（SEC-001 / SEC-079）。
 *
 * 存储根：<tmp>/u1/mine.txt 与 <tmp>/other/secret.txt（虚拟路径 /local/u1、/local/other）
 * 租户 base_path = "/local/u1"：任何 `..`（含 %2e%2e、%252e%252e、`....`）都必须被
 * 钳在自己的根目录内，绝不能列到 sibling 目录。
 */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-tenant-"))
  fs.mkdirSync(path.join(root, "u1"), { recursive: true })
  fs.mkdirSync(path.join(root, "other"), { recursive: true })
  fs.writeFileSync(path.join(root, "u1", "mine.txt"), "MINE")
  fs.writeFileSync(path.join(root, "other", "secret.txt"), "SECRET")
  return root
}

const env: any = {}

const token = async (payload: any) =>
  await sign(
    { ...payload, exp: Math.floor(Date.now() / 1000) + 3600, jti: "jti-test" },
    JWT_SECRET,
  )

const newApp = () => {
  const a = new Hono()
  a.route("/api/fs", fsRouter)
  a.route("/api/d", rawRouter)
  a.route("/api/share", shareRouter)
  return a
}

/** 生成指定层数的 `%2e%2e`：每多一层，所有 `%` 再被编码成 `%25`。 */
function encodedDotDot(layers: number): string {
  let p = "%2e%2e"
  for (let i = 1; i < layers; i++) p = p.replace(/%/g, "%25")
  return p
}

const seed = async (root: string, settings: any[] = []) => {
  await saveDb(
    {
      settings,
      users: [
        {
          id: 1,
          username: "admin",
          password: "x",
          role: 2,
          permission: 0,
          base_path: "/",
          disabled: false,
        },
        {
          id: 2,
          username: "tenant",
          password: "x",
          role: 0,
          // SHARE + WRITE/RENAME/MOVE/COPY/DELETE：既覆盖分享创建路径，
          // 也让写类越界用例（D-1 / N-2）真的走到 handler 的门禁之后。
          permission: 1 << 14 | 1 << 3 | 1 << 4 | 1 << 5 | 1 << 6 | 1 << 7,
          base_path: "/local/u1",
          disabled: false,
        },
        {
          id: 3,
          username: "guest",
          password: "x",
          role: 1,
          permission: 0,
          base_path: "/",
          disabled: true,
        },
      ],
      storages: [
        {
          id: 1,
          mount_path: "/local",
          driver: "local",
          disabled: false,
          addition: JSON.stringify({ root_folder_path: root }),
        },
      ],
      shares: [],
      metas: [],
    },
    env,
  )
  return token({ id: 2, username: "tenant", role: 0 })
}

const list = (a: Hono, tenantToken: string, p: string) =>
  a.request("/api/fs/list", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tenantToken}`,
    },
    body: JSON.stringify({ path: p }),
  })

test("SEC-002: 分享创建不接受深层编码的越界路径", async () => {
  const root = makeRoot()
  const a = newApp()
  const tenantToken = await seed(root)

  // 9 层编码：旧实现会把它在入库时降成 5 层，读取时再解码成 `..`。
  const created = await a.request("/api/share/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tenantToken}`,
    },
    body: JSON.stringify({
      files: [`/${encodedDotDot(9)}/other/secret.txt`],
    }),
  })
  assert.equal(created.status, 400, "越界路径必须在创建时被拒绝")

  const okCreated = await a.request("/api/share/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tenantToken}`,
    },
    body: JSON.stringify({ files: ["/mine.txt"] }),
  })
  const okBody: any = await okCreated.json()
  assert.equal(okCreated.status, 200, JSON.stringify(okBody))
  const shareId = okBody?.data?.id
  assert.ok(shareId)

  const got = await a.request("/api/fs/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: `/@s/${shareId}` }),
  })
  const gotBody: any = await got.json()
  assert.equal(got.status, 200, JSON.stringify(gotBody))
  assert.equal(gotBody?.data?.name, "mine.txt")
})

test("SEC-001: 租户列目录时 .. / 编码 .. 都在自己根目录内被钳制", async () => {
  const a = newApp()
  const tenantToken = await seed(makeRoot())

  const own: any = await (await list(a, tenantToken, "/")).json()
  assert.equal(own.code, 200, `fs/list failed: ${JSON.stringify(own)}`)
  const ownNames = (own?.data?.content || []).map((i: any) => i.name)
  assert.ok(ownNames.includes("mine.txt"), "应能看到自己根目录下的文件")
  assert.ok(!ownNames.includes("secret.txt"), "不应看到 sibling 目录内容")

  for (const escapePath of [
    "/../other",
    "/%2e%2e/other",
    "/%252e%252e/other",
    "/....//other",
    "/mine.txt/../../other",
    "\\..\\other",
    `/${encodedDotDot(5)}/other`,
    `/${encodedDotDot(9)}/other`,
    `/${encodedDotDot(13)}/other`,
    `/${encodedDotDot(32)}/other`,
  ]) {
    const res = await list(a, tenantToken, escapePath)
    assert.equal(res.status, 200, `${escapePath} 不应变成 5xx`)
    const body: any = await res.json()
    const names = (body?.data?.content || []).map((i: any) => i.name)
    assert.ok(
      !names.includes("secret.txt"),
      `越权读取: path=${escapePath} -> ${JSON.stringify(names)}`,
    )
  }
})

test("SEC-079: 签名按规范路径计算，等价写法可验通且不可跨路径复用", async () => {
  const root = makeRoot()
  const a = newApp()
  const tenantToken = await seed(root, [{ key: "sign_all", value: "true" }])

  const listed: any = await (await list(a, tenantToken, "/")).json()
  const mine = (listed?.data?.content || []).find(
    (i: any) => i.name === "mine.txt",
  )
  assert.ok(mine?.sign, `/fs/list 应签发 sign，实际 ${JSON.stringify(listed)}`)

  const hit = (p: string, s: string) =>
    a.request(`/api/d${p}?sign=${encodeURIComponent(s)}`, {
      headers: { Authorization: `Bearer ${tenantToken}` },
    })

  const ok = await hit("/local/u1/mine.txt", mine.sign)
  assert.equal(ok.status, 200, "规范路径的签名必须验通")
  assert.equal(await ok.text(), "MINE")

  // 同一目标的另一种写法（`.` / 重复斜杠）规范后与签名同源，仍应放行
  const alt = await hit("/local/u1/./mine.txt", mine.sign)
  assert.equal(alt.status, 200, "等价写法不应被判定为签名无效")

  // sibling 文件：没有有效签名不能下载，别人的签名也不可挪用
  const noSign = await a.request("/api/d/local/other/secret.txt", {
    headers: { Authorization: `Bearer ${tenantToken}` },
  })
  assert.equal(noSign.status, 401, "sign_all 开启后无签名应 401")
  const stolen = await hit("/local/other/secret.txt", mine.sign)
  assert.equal(stolen.status, 401, "签名不得跨路径复用")
})

const post = (
  a: Hono,
  tenantToken: string,
  route: string,
  body: any,
) =>
  a.request(`/api/fs/${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tenantToken}`,
    },
    body: JSON.stringify(body),
  })

test("D-1: /fs/remove 的 names 拒绝编码后的路径分隔符", async () => {
  const root = makeRoot()
  const a = newApp()
  const t = await seed(root)

  // 字面 `..`、`%2e%2e%2f`（解码后是 ../）、`...` 都必须被拒绝
  for (const name of [
    "../other/secret.txt",
    "%2e%2e%2fother%2fsecret.txt",
    ".../other/secret.txt",
    "a%2Fb.txt",
  ]) {
    const res = await post(a, t, "remove", { dir: "/", names: [name] })
    assert.equal(res.status, 400, `${name} 必须被拒绝，实际 ${res.status}`)
  }
  assert.equal(
    fs.existsSync(path.join(root, "other", "secret.txt")),
    true,
    "sibling 目录的文件不得被删除",
  )
})

test("D-1: /fs/move 与 /fs/copy 的 names 同样拒绝编码分隔符", async () => {
  const root = makeRoot()
  const a = newApp()
  const t = await seed(root)
  for (const route of ["move", "copy"]) {
    const res = await post(a, t, route, {
      src_dir: "/",
      dst_dir: "/",
      names: ["%2e%2e%2fother"],
    })
    assert.equal(res.status, 400, `${route} 必须拒绝编码分隔符`)
  }
})

test("N-2: /fs/batch_rename 的 src_name 必须是单段文件名", async () => {
  const root = makeRoot()
  const a = newApp()
  const t = await seed(root)
  const res = await post(a, t, "batch_rename", {
    src_dir: "/",
    rename_objects: [{ src_name: "../other/secret.txt", new_name: "pwn.txt" }],
  })
  assert.equal(res.status, 400, "跨目录 src_name 必须被拒绝")
  assert.equal(
    fs.existsSync(path.join(root, "other", "pwn.txt")),
    false,
    "sibling 目录不得被改名",
  )
  assert.equal(
    fs.existsSync(path.join(root, "other", "secret.txt")),
    true,
    "原文件必须保持不动",
  )
})

test("N-1: /fs 写端点不再把 /@s 当作直通存储根的入口", async () => {
  const root = makeRoot()
  const a = newApp()
  const t = await seed(root)
  const res = await a.request("/api/fs/put", {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${t}`,
      "File-Path": "/@s/../other/pwn.txt",
    },
    body: "PWN",
  })
  // 允许 200（写到自己的根内），但绝不能落到 sibling 目录
  assert.notEqual(res.status, 401)
  assert.equal(
    fs.existsSync(path.join(root, "other", "pwn.txt")),
    false,
    "/@s 前缀不得成为跨租户写入的跳板",
  )
})

test("N-1: /fs/search 的 /@s/.. 不得遍历兄弟租户目录", async () => {
  const root = makeRoot()
  const a = newApp()
  const t = await seed(root)
  // 修复前：parent 原样透传，search 在 /other 上枚举出 secret.txt。
  const res = await post(a, t, "search", {
    parent: "/@s/../other",
    keywords: "",
  })
  const text = await res.text()
  assert.equal(
    text.includes("secret.txt"),
    false,
    "分享命名空间不得被 .. 弹出后读到 sibling 目录",
  )
})

test("N-4: /fs/search 拒绝匿名请求（不再吃 guest 兜底）", async () => {
  const root = makeRoot()
  const a = newApp()
  await seed(root)
  const res = await a.request("/api/fs/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent: "/", keywords: "secret" }),
  })
  assert.equal(res.status, 401, "匿名 search 必须 401")
})
