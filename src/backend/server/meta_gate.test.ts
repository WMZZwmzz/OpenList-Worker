import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { fsRouter } from "./fs"
import { rawRouter } from "./raw"
import { saveDb } from "../internal/model/db"

/**
 * meta.write_users / read_users 的入口级回归。
 *
 * op 层门禁只覆盖经过 putItem 等封装的路径；分片上传、直传预签名、驱动
 * `other`、seed 与分享浏览都是直接调驱动/直接列举，必须在 handler 层补闸。
 */

const JWT_SECRET = "0123456789abcdef0123456789abcdef"
process.env.JWT_SECRET = JWT_SECRET

const TENANT_ID = 2
const SHARE_PERMISSION = 1 << 14
const WRITE_PERMISSION = 1 << 3

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-meta-"))
  fs.mkdirSync(path.join(root, "u1", "protected"), { recursive: true })
  fs.mkdirSync(path.join(root, "u1", "restricted"), { recursive: true })
  fs.writeFileSync(path.join(root, "u1", "mine.txt"), "MINE")
  fs.writeFileSync(path.join(root, "u1", "protected", "x.txt"), "PROTECTED")
  fs.writeFileSync(path.join(root, "u1", "restricted", "x.txt"), "RESTRICTED")
  return root
}

const metaBase = {
  id: 1,
  password: "",
  p_sub: true,
  read_users: [] as number[],
  read_users_sub: true,
  write_users: [] as number[],
  write_users_sub: true,
  write: false,
  w_sub: false,
  hide: "",
  h_sub: false,
  readme: "",
  r_sub: false,
  header: "",
  header_sub: false,
}

async function seed(
  root: string,
  metas: any[],
  shares: any[] = [],
  settings: any[] = [],
): Promise<string> {
  await saveDb(
    {
      settings,
      users: [
        {
          id: TENANT_ID,
          username: "tenant",
          password: "x",
          role: 0,
          permission: SHARE_PERMISSION | WRITE_PERMISSION,
          base_path: "/local/u1",
          disabled: false,
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
      shares,
      metas,
    },
    {},
  )
  return sign(
    {
      id: TENANT_ID,
      username: "tenant",
      role: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: "meta-gate",
    },
    JWT_SECRET,
  )
}

const newApp = () => {
  const a = new Hono()
  a.route("/api/fs", fsRouter)
  a.route("/api/d", rawRouter)
  a.route("/api/sd", rawRouter)
  return a
}

const post = (a: Hono, url: string, body: any, token?: string) =>
  a.request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

test("SEC-009: 分片/直传/驱动 other 入口都受 meta.write_users 约束", async () => {
  const root = makeRoot()
  const a = newApp()
  const token = await seed(root, [
    {
      ...metaBase,
      path: "/local/u1/protected",
      write_users: [999],
    },
  ])

  // 注意：TS 专有的 /fs/upload/{create,part,complete} 会话式上传端点已随上游
  // 移除（分片上传对齐 Go 只保留 /fs/multipart/*），故这里不再断言该路径。

  const init = await a.request("/api/fs/multipart/init", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "File-Path": "/protected/x.bin",
      "X-File-Size": "10",
    },
  })
  assert.equal(init.status, 403, await init.text())

  const direct = await post(
    a,
    "/api/fs/get_direct_upload_info",
    { path: "/protected", file_name: "x.bin", file_size: 10 },
    token,
  )
  assert.equal(direct.status, 403, await direct.text())

  const other = await post(
    a,
    "/api/fs/other",
    { path: "/protected", method: "direct_upload", file_name: "x.bin" },
    token,
  )
  assert.equal(other.status, 403, await other.text())

  // 未受 write_users 限制的目录仍可正常初始化（确保闸门没有误伤）
  const allowed = await post(
    a,
    "/api/fs/get_direct_upload_info",
    { path: "/", file_name: "ok.bin", file_size: 10 },
    token,
  )
  assert.notEqual(allowed.status, 403, await allowed.text())
})

test("SEC-041: /seed 读取受 meta.read_users 约束", async () => {
  const root = makeRoot()
  const a = newApp()
  const token = await seed(root, [
    {
      ...metaBase,
      path: "/local/u1/protected",
      read_users: [999],
    },
  ])
  const res = await post(
    a,
    "/api/fs/seed/generate",
    { paths: ["/protected/x.txt"], formats: ["oss"] },
    token,
  )
  const body: any = await res.json()
  assert.equal(res.status, 400, JSON.stringify(body))
  assert.match(String(body?.message), /permission denied/i)
})

test("SEC-010: 分享浏览/下载受目录 meta 约束", async () => {
  const root = makeRoot()
  const a = newApp()
  const token = await seed(
    root,
    [
      {
        ...metaBase,
        path: "/local/u1/protected",
        read_users: [TENANT_ID],
      },
    ],
    [
      {
        id: "share1",
        creator: "tenant",
        creator_role: 0,
        files: ["/local/u1/protected/x.txt"],
        pwd: "",
        disabled: false,
        expires: null,
        max_accessed: 0,
        accessed: 0,
      },
    ],
  )

  const got = await post(a, "/api/fs/get", { path: "/@s/share1" })
  assert.equal(got.status, 403, await got.text())

  const listed = await post(a, "/api/fs/list", { path: "/@s/share1" })
  assert.equal(listed.status, 403, await listed.text())

  const downloaded = await a.request("/api/sd/share1")
  assert.equal(downloaded.status, 403, await downloaded.text())

  // 创建者本人满足 read_users 时仍可浏览/下载
  const own = await post(a, "/api/fs/get", { path: "/@s/share1" }, token)
  assert.equal(own.status, 200, await own.text())
})

test("SEC-085: read_users-only 的路径在 /fs/list 会签发下载签名", async () => {
  const root = makeRoot()
  const a = newApp()
  const token = await seed(root, [
    {
      ...metaBase,
      path: "/local/u1/restricted",
      read_users: [TENANT_ID],
    },
  ])

  const listed: any = await (
    await post(a, "/api/fs/list", { path: "/restricted" }, token)
  ).json()
  const item = (listed?.data?.content || []).find(
    (x: any) => x.name === "x.txt",
  )
  assert.ok(item, JSON.stringify(listed))
  assert.ok(item.sign, "read_users-only 路径必须签发 sign")

  const res = await a.request(
    `/api/d/local/u1/restricted/x.txt?sign=${encodeURIComponent(item.sign)}`,
  )
  assert.equal(res.status, 200)
  assert.equal(await res.text(), "RESTRICTED")
})
