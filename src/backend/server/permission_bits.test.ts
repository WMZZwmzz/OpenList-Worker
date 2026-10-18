import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { fsRouter } from "./fs"
import { saveDb } from "../internal/model/db"

/**
 * SEC-078：RENAME / MOVE / COPY / DELETE / DECOMPRESS 权限位不能是死代码。
 * WRITE_CONTENT 只应覆盖 mkdir/upload，不能顺带授予改名/删除。
 */

const JWT_SECRET = "0123456789abcdef0123456789abcdef"
process.env.JWT_SECRET = JWT_SECRET

const WRITE = 1 << 3
const RENAME = 1 << 4
const MOVE = 1 << 5
const COPY = 1 << 6
const DELETE = 1 << 7

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-perm-"))
  fs.writeFileSync(path.join(root, "a.txt"), "A")
  fs.writeFileSync(path.join(root, "b.txt"), "B")
  fs.mkdirSync(path.join(root, "dir"))
  return root
}

async function seed(root: string, permission: number): Promise<string> {
  await saveDb(
    {
      settings: [],
      users: [
        {
          id: 2,
          username: "user",
          password: "x",
          role: 0,
          permission,
          base_path: "/local",
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
      shares: [],
      metas: [],
    },
    {},
  )
  return sign(
    {
      id: 2,
      username: "user",
      role: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: "perm",
    },
    JWT_SECRET,
  )
}

const post = (a: Hono, url: string, body: any, token: string) =>
  a.request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })

const app = () => {
  const a = new Hono()
  a.route("/api/fs", fsRouter)
  return a
}

test("SEC-078: WRITE_CONTENT 不再顺带授予 rename/remove", async () => {
  const root = makeRoot()
  const a = app()
  let token = await seed(root, WRITE)

  assert.equal(
    (
      await post(a, "/api/fs/rename", { path: "/a.txt", name: "c.txt" }, token)
    ).status,
    403,
  )
  assert.equal(
    (await post(a, "/api/fs/remove", { dir: "/", names: ["a.txt"] }, token))
      .status,
    403,
  )
  // mkdir/上传仍归 WRITE_CONTENT
  assert.equal(
    (await post(a, "/api/fs/mkdir", { path: "/newdir" }, token)).status,
    200,
  )

  token = await seed(root, WRITE | RENAME)
  assert.equal(
    (
      await post(a, "/api/fs/rename", { path: "/a.txt", name: "c.txt" }, token)
    ).status,
    200,
  )
})

test("SEC-078: move/copy/remove 各自需要对应权限位", async () => {
  const root = makeRoot()
  const a = app()
  const token = await seed(root, WRITE | MOVE | COPY | DELETE)

  assert.equal(
    (
      await post(
        a,
        "/api/fs/move",
        { src_dir: "/", dst_dir: "/dir", names: ["a.txt"] },
        token,
      )
    ).status,
    200,
  )
  assert.equal(
    (
      await post(
        a,
        "/api/fs/copy",
        { src_dir: "/dir", dst_dir: "/", names: ["a.txt"] },
        token,
      )
    ).status,
    200,
  )
  assert.equal(
    (await post(a, "/api/fs/remove", { dir: "/", names: ["b.txt"] }, token))
      .status,
    200,
  )
})
