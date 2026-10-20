import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Hono } from "hono"
import { rawRouter } from "./raw"
import { saveDb, __resetDbCacheForTest } from "../internal/model/db"
import { needDownloadSign, signDownloadPath } from "../pkg/sign"

/**
 * H-1（SECURITY-AUDIT-2026-10-20）回归测试：
 *
 * `read_users` 目录保护在公开下载端点对**子路径**失效。
 *
 * 根因：pkg/sign.ts 的 isReadUsersRestricted 用了 `meta.r_sub`（readme 是否
 * 应用到子目录）来判断 read_users 是否覆盖子目录，正确字段是
 * `read_users_sub`。`r_sub` 默认 false，于是「只配 read_users、不配密码」的
 * 目录在 /d、/p 上被判为「无需签名」，匿名请求只要比 meta.path 深一层就能
 * 直接拿到文件。
 */

const tmpRoots: string[] = []

/** 建一棵 local 存储的临时根：secret/sub/a.txt 与 public/b.txt */
function makeLocalRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-readusers-"))
  fs.mkdirSync(path.join(root, "secret", "sub"), { recursive: true })
  fs.mkdirSync(path.join(root, "public"), { recursive: true })
  fs.writeFileSync(path.join(root, "secret", "sub", "a.txt"), "SECRET")
  fs.writeFileSync(path.join(root, "secret", "a.txt"), "SECRET")
  fs.writeFileSync(path.join(root, "public", "b.txt"), "PUBLIC")
  tmpRoots.push(root)
  return root
}

const dbWith = (root: string) => ({
  settings: [],
  users: [
    {
      id: 1,
      username: "guest",
      password: "xxx",
      role: 1,
      permission: 0,
      base_path: "/",
      disabled: false,
    },
    {
      id: 2,
      username: "alice",
      password: "xxx",
      role: 0,
      permission: 0,
      base_path: "/",
      disabled: false,
    },
  ],
  storages: [
    {
      id: "s1",
      driver: "Local",
      mount_path: "/local",
      addition: JSON.stringify({ root_folder_path: root }),
      modified: "2026-01-01T00:00:00.000Z",
      disabled: false,
    },
  ],
  shares: [],
  metas: [
    {
      id: 1,
      path: "/local/secret",
      password: "",
      p_sub: false,
      read_users: [2],
      read_users_sub: true,
      write_users: [],
      write_users_sub: false,
      write: false,
      w_sub: false,
      hide: "",
      h_sub: false,
      readme: "",
      // 关键：r_sub 保持 false —— 修复前正是它让 read_users 判定为「不覆盖子目录」
      r_sub: false,
      header: "",
      header_sub: false,
    },
  ],
})

const appOf = () => {
  const app = new Hono()
  app.route("/api/d", rawRouter)
  return app
}

test("H-1: read_users + read_users_sub 覆盖的子路径，/d 匿名也必须验签", async () => {
  __resetDbCacheForTest()
  const env: any = {}
  const root = makeLocalRoot()
  await saveDb(dbWith(root), env)

  // 判定层：子路径与文件自身都必须「需要签名」
  assert.equal(
    await needDownloadSign({ env }, "/local/secret/sub/a.txt"),
    true,
    "/local/secret/sub/a.txt 应要求签名",
  )
  assert.equal(await needDownloadSign({ env }, "/local/secret/a.txt"), true)
  // 名单外的普通目录不受影响
  assert.equal(await needDownloadSign({ env }, "/local/public/b.txt"), false)

  // 端点层：无签名必须 401（修复前这里是 200 + 文件内容）
  const app = appOf()
  const res = await app.request("/api/d/local/secret/sub/a.txt")
  assert.equal(res.status, 401, "匿名直链子路径必须被拒")

  // 带合法签名（等价于 /fs/list 为已授权用户签发）才放行
  const sign = await signDownloadPath({ env }, "/local/secret/sub/a.txt", 0)
  const ok = await app.request(
    `/api/d/local/secret/sub/a.txt?sign=${encodeURIComponent(sign)}`,
  )
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), "SECRET")
})

test("H-1: 未配置 read_users 的目录仍可直接下载（无误伤）", async () => {
  __resetDbCacheForTest()
  const env: any = {}
  const root = makeLocalRoot()
  await saveDb(dbWith(root), env)

  const app = appOf()
  const res = await app.request("/api/d/local/public/b.txt")
  assert.equal(res.status, 200)
  assert.equal(await res.text(), "PUBLIC")
})
