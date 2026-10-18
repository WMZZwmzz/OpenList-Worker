import assert from "node:assert/strict"
import { test } from "node:test"
import { saveDb } from "../model/db"
import { resolveShare } from "./share"

const env: any = {}

const seed = (files: string[], pwd = "") =>
  saveDb(
    {
      settings: [],
      users: [],
      storages: [],
      shares: [
        {
          id: "abc",
          files,
          pwd,
          disabled: false,
          expires: null,
          max_accessed: 0,
          accessed: 0,
        },
      ],
    },
    env,
  )

test("Security(C-3): '..' must not escape a single-file share", async () => {
  await seed(["/data/secret.txt"])
  const r = await resolveShare("/@s/abc/../../../", "", env)
  assert.equal(
    r.ok,
    false,
    "traversal out of a single-file share must be rejected",
  )
})

test("Security(C-3): '..' must not escape a multi-file share sub-path", async () => {
  await seed(["/data/dir1/a.txt", "/data/dir2/b.txt"])
  const r = await resolveShare("/@s/abc/a.txt/../../..", "", env)
  assert.equal(r.ok, false)
})

test("Security(C-3): traversal is blocked even with the correct share password", async () => {
  await seed(["/data/secret.txt"], "s3cret")
  const r = await resolveShare("/@s/abc/../../../", "s3cret", env)
  assert.equal(
    r.ok,
    false,
    "holding the extract code must not grant traversal (password is checked before path joining)",
  )
})

test("Security(C-3): a legitimate single-file share still resolves (no regression)", async () => {
  await seed(["/data/secret.txt"])
  const r = await resolveShare("/@s/abc", "", env)
  assert.equal(r.ok, true)
  assert.equal(r.realPath, "/data/secret.txt")
})

test("Security(C-3): multi-file sub-path still resolves to the shared file (no regression)", async () => {
  await seed(["/data/dir1/a.txt", "/data/dir2/b.txt"])
  const r = await resolveShare("/@s/abc/a.txt", "", env)
  assert.equal(r.ok, true)
  assert.equal(r.realPath, "/data/dir1/a.txt")
})

test("SEC-034: 连续错口令后锁定该客户端对该分享的尝试", async () => {
  await seed(["/data/secret.txt"], "s3cret")
  for (let i = 0; i < 8; i++) {
    const r = await resolveShare("/@s/abc", `bad${i}`, env, "9.9.9.9")
    assert.equal(r.ok, false)
    assert.equal(r.error, "wrong password")
  }
  const locked = await resolveShare("/@s/abc", "s3cret", env, "9.9.9.9")
  assert.equal(locked.ok, false, "达到失败上限后应拒绝，即使口令正确")
  assert.match(String(locked.error), /too many wrong passwords/)

  const otherClient = await resolveShare("/@s/abc", "s3cret", env, "8.8.8.8")
  assert.equal(otherClient.ok, true, "节流按客户端区分，不应误伤他人")
})

const seedTenant = async (files: string[]) =>
  saveDb(
    {
      settings: [],
      users: [
        {
          id: 5,
          username: "u1",
          password: "x",
          role: 0,
          permission: 0,
          base_path: "/u1",
          disabled: false,
        },
      ],
      storages: [],
      shares: [
        {
          id: "abc",
          files,
          pwd: "",
          creator: "u1",
          disabled: false,
          expires: null,
          max_accessed: 0,
          accessed: 0,
        },
      ],
    },
    env,
  )

test("SEC-002: 历史脏数据里的 %2e%2e 不能把分享抬出创建者根目录", async () => {
  await seedTenant(["/u1/%2e%2e/etc/passwd"])
  const r = await resolveShare("/@s/abc", "", env)
  assert.equal(r.ok, false, "落点越出创建者 base_path 时必须拒绝")
})

test("SEC-002: 5 层及以上百分号编码的历史条目同样不能越出创建者根目录", async () => {
  const encodedDotDot = (layers: number) => {
    let p = "%2e%2e"
    for (let i = 1; i < layers; i++) p = p.replace(/%/g, "%25")
    return p
  }
  for (const layers of [5, 9, 13, 32]) {
    await seedTenant([`/u1/${encodedDotDot(layers)}/etc/passwd`])
    const r = await resolveShare("/@s/abc", "", env)
    assert.equal(
      r.ok,
      false,
      `${layers} 层编码的分享条目必须被拒绝，实际 realPath=${r.realPath}`,
    )
  }
})

test("SEC-002: 多文件分享条目在返回虚拟列表前就被过滤到创建者根目录内", async () => {
  await seedTenant(["/u1/a.txt", "/u1/%2e%2e/etc/passwd"])
  const r = await resolveShare("/@s/abc", "", env)
  assert.equal(r.ok, true)
  assert.equal(r.virtualList, true)
  assert.deepEqual(r.share?.files, ["/u1/a.txt"])
})
