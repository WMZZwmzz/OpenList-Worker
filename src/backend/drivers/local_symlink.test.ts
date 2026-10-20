import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Hono } from "hono"
import { LocalDriver } from "./local"
import { rawRouter } from "../server/raw"
import { saveDb, __resetDbCacheForTest } from "../internal/model/db"

/**
 * M-9（SECURITY-AUDIT-2026-10-20）回归测试：
 *
 * 本地存储驱动完全跟随符号链接 —— `resolvePath` 对 root_folder 的钳制是纯字符串
 * 层面的，`fs.stat` / `createReadStream` / `writeFile` 都会跟随软链。存储根内
 * 只要有一条指向外部的软链，`GET /d/local/leak` 就能读到根外文件。
 *
 * 修复后：所有落盘操作前 realpath 一次并断言仍在 root 之内；list 跳过越界软链。
 */

const tmpDirs: string[] = []

function mkdtemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** 建一个指向根外的软链；Windows 上优先用 junction（无需开发者模式）。 */
function makeEscapeLink(linkPath: string, target: string): boolean {
  for (const type of ["junction", "dir", undefined] as const) {
    try {
      fs.symlinkSync(target, linkPath, type as any)
      return true
    } catch {
      // 换下一种方式
    }
  }
  return false
}

test("M-9: 根内指向根外的软链不能通过驱动读取，list 也不列出", async (t) => {
  const root = mkdtemp("openlist-symlink-root-")
  const outside = mkdtemp("openlist-symlink-outside-")
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET")
  fs.writeFileSync(path.join(root, "ok.txt"), "OK")

  if (!makeEscapeLink(path.join(root, "leak"), outside)) {
    t.skip("当前平台不允许创建符号链接/junction，跳过")
    return
  }

  const driver = new LocalDriver(root)

  // list：越界软链不出现在结果里，普通文件仍在
  const items = await driver.list("/", root)
  const names = items.map((i) => i.name).sort()
  assert.deepEqual(names, ["ok.txt"], `list 结果应为 ${names.join(",")}`)

  // get：直接命中越界软链必须抛错（而不是读出根外内容）
  await assert.rejects(
    () => driver.get("/leak/secret.txt", path.join(root, "leak", "secret.txt")),
    /escapes storage root/,
  )

  // put：不能借软链写到根外
  await assert.rejects(
    () =>
      driver.put(
        "/leak/evil.txt",
        path.join(root, "leak", "evil.txt"),
        Buffer.from("x"),
      ),
    /escapes storage root/,
  )
  assert.equal(
    fs.existsSync(path.join(outside, "evil.txt")),
    false,
    "根外文件不得被写入",
  )

  // 正常文件不受影响
  const ok = await driver.get("/ok.txt", path.join(root, "ok.txt"))
  assert.equal(ok.name, "ok.txt")
})

test("M-9: /d 直链同样拦得住软链越界", async (t) => {
  const root = mkdtemp("openlist-symlink-raw-root-")
  const outside = mkdtemp("openlist-symlink-raw-outside-")
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET")

  if (!makeEscapeLink(path.join(root, "leak"), outside)) {
    t.skip("当前平台不允许创建符号链接/junction，跳过")
    return
  }

  __resetDbCacheForTest()
  const env: any = {}
  await saveDb(
    {
      settings: [],
      users: [],
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
      metas: [],
    },
    env,
    { force: true },
  )

  const app = new Hono()
  app.route("/api/d", rawRouter)
  const res = await app.request("/api/d/local/leak/secret.txt")
  const body = await res.text()
  assert.notEqual(res.status, 200, "越界软链不得返回 200")
  assert.equal(body.includes("TOP-SECRET"), false)
})
