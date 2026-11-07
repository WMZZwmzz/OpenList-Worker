import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { before, test } from "node:test"
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { adminRouter, normalizeDriver } from "./admin"
import { buildArchiveListing, fsRouter } from "./fs"
import { seedTestHelpers } from "./seed"
import {
  __loginFailuresForTest,
  clearLoginFailures,
  isLoginLocked,
  recordLoginFailure,
} from "./auth"
import {
  getDb,
  readPersistedSecret,
  saveDb,
} from "../internal/model/db"
import { putSession } from "../internal/upload/multipart"
import { parseZip } from "../internal/archive/zip"

/**
 * 服务端审计修复回归（fs.ts / seed.ts / admin.ts / auth.ts）。
 *
 * 覆盖 F-004、F-005、F-008、F-003、F-006、F-007、F-001、F-013、F-014、
 * F-015、F-017、F-020、F-116、F-195、F-021、F-022、F-023、F-027、F-030、F-034。
 */

const JWT_SECRET = "0123456789abcdef0123456789abcdef"
process.env.JWT_SECRET = JWT_SECRET
const ADMIN_TOKEN = "server-audit-fixes-token-0123456789"
const AUTH = { Authorization: `Bearer ${ADMIN_TOKEN}` }

const env: any = {}
// getJwtSecret 优先读 c.env.JWT_SECRET（env 存在时不再回退 process.env）
env.JWT_SECRET = JWT_SECRET
const tmpRoots: string[] = []

function makeRoot(withMany = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-audit-"))
  tmpRoots.push(root)
  fs.mkdirSync(path.join(root, "@staging"), { recursive: true })
  fs.writeFileSync(path.join(root, "@staging", "inside.txt"), "i")
  if (withMany) {
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(
        path.join(root, `f${String(i).padStart(2, "0")}.txt`),
        "x",
      )
    }
    fs.mkdirSync(path.join(root, "sub"), { recursive: true })
    fs.writeFileSync(path.join(root, "sub", "nested.txt"), "n")
    fs.mkdirSync(path.join(root, "subway"), { recursive: true })
    fs.writeFileSync(path.join(root, "subway", "other.txt"), "o")
  }
  return root
}

let seedSerial = 0

async function seedDb(
  root: string,
  overrides: Record<string, any> = {},
): Promise<void> {
  const serial = ++seedSerial
  await saveDb(
    {
      settings: [{ key: "api_token", value: ADMIN_TOKEN }],
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
      ],
      storages: [
        {
          id: 1000 + serial,
          mount_path: "/",
          driver: "local",
          addition: JSON.stringify({ root_folder_path: root }),
          disabled: false,
          status: "work",
          modified: new Date(Date.UTC(2026, 0, 1, 0, 0, serial)).toISOString(),
        },
      ],
      shares: [],
      metas: [],
      ...overrides,
    },
    env,
  )
}

function adminJwt(): string {
  return ADMIN_JWT
}

/** sign() 是异步的：在 before 里算一次，避免模板字符串拼出 [object Promise] */
let ADMIN_JWT = ""
before(async () => {
  ADMIN_JWT = await sign(
    {
      id: 1,
      username: "admin",
      role: 2,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: "server-audit-fixes",
    },
    JWT_SECRET,
  )
})

function adminApp(): Hono {
  const app = new Hono()
  app.route("/api/admin", adminRouter)
  return app
}

function fsApp(): Hono {
  const app = new Hono()
  app.route("/api/fs", fsRouter)
  return app
}

/** 构造一个仅含 store（method 0）条目的最小 zip，用于归档浏览测试。 */
function makeZip(
  files: Array<{ name: string; data: string }>,
): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const name = enc.encode(file.name)
    const data = enc.encode(file.data)
    const local = new Uint8Array(30 + name.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, 0, true) // stored
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(data, 30 + name.length)
    locals.push(local)

    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, 0, true) // stored
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cd.set(name, 46)
    central.push(cd)
    offset += local.length
  }
  const centralSize = central.reduce((sum, c) => sum + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const parts = [...locals, ...central, eocd]
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// ---------- admin.ts ----------

test("F-004: storage update/delete/enable/disable 对非法/未知 id 明确报错", async () => {
  const root = makeRoot()
  await seedDb(root)
  const app = adminApp()
  const json = { ...AUTH, "Content-Type": "application/json" }

  const missing = await app.request(
    "/api/admin/storage/update",
    { method: "POST", headers: json, body: JSON.stringify({ id: 999 }) },
    env,
  )
  assert.equal(missing.status, 404)

  const bad = await app.request(
    "/api/admin/storage/update",
    { method: "POST", headers: json, body: JSON.stringify({ id: "abc" }) },
    env,
  )
  assert.equal(bad.status, 400)

  for (const action of ["delete", "enable", "disable"]) {
    const notFound = await app.request(
      `/api/admin/storage/${action}?id=999`,
      { method: "POST", headers: AUTH },
      env,
    )
    assert.equal(notFound.status, 404, `${action} 未知 id 应 404`)
    const invalid = await app.request(
      `/api/admin/storage/${action}?id=nope`,
      { method: "POST", headers: AUTH },
      env,
    )
    assert.equal(invalid.status, 400, `${action} 非法 id 应 400`)
  }

  // 数字字符串 id 必须命中真实存储（此前严格相等导致静默无操作）
  const seededId = String((await getDb(env)).storages[0].id)
  const ok = await app.request(
    "/api/admin/storage/update",
    {
      method: "POST",
      headers: json,
      body: JSON.stringify({ id: seededId, remark: "renamed-by-test" }),
    },
    env,
  )
  assert.equal(ok.status, 200)
  const db = await getDb(env)
  assert.equal(db.storages[0].remark, "renamed-by-test")
})

test("F-005: enable 复查挂载点冲突，不允许两个已启用存储挂同一路径", async () => {
  const root = makeRoot()
  await seedDb(root, {
    storages: [
      {
        id: 1,
        mount_path: "/same",
        driver: "local",
        addition: JSON.stringify({ root_folder_path: root }),
        disabled: true,
      },
      {
        id: 2,
        mount_path: "/same",
        driver: "local",
        addition: JSON.stringify({ root_folder_path: root }),
        disabled: false,
      },
    ],
  })
  const app = adminApp()
  const blocked = await app.request(
    "/api/admin/storage/enable?id=1",
    { method: "POST", headers: AUTH },
    env,
  )
  assert.equal(blocked.status, 400)

  await app.request("/api/admin/storage/disable?id=2", {
    method: "POST",
    headers: AUTH,
  }, env)
  const allowed = await app.request(
    "/api/admin/storage/enable?id=1",
    { method: "POST", headers: AUTH },
    env,
  )
  assert.equal(allowed.status, 200)
})

test("F-008: 非规范驱动名 + 空 mount_path 时按归一化名取 default_mount_path", async () => {
  const root = makeRoot()
  await seedDb(root)
  const app = adminApp()
  const res = await app.request(
    "/api/admin/storage/create",
    {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ driver: "webdav", disabled: true }),
    },
    env,
  )
  const body: any = await res.json()
  assert.equal(body.code, 200, JSON.stringify(body))
  assert.equal(normalizeDriver("webdav"), "WebDav")
  assert.equal(body.data.mount_path, "/webdav")
})

test("F-003: enable 的驱动初始化通过 executionCtx.waitUntil 调度", async () => {
  const root = makeRoot()
  await seedDb(root, {
    storages: [
      {
        id: 1,
        mount_path: "/x",
        driver: "local",
        addition: JSON.stringify({ root_folder_path: root }),
        disabled: true,
      },
    ],
  })
  const scheduled: Promise<unknown>[] = []
  const res = await adminApp().request(
    "/api/admin/storage/enable?id=1",
    { method: "POST", headers: AUTH },
    env,
    { waitUntil: (p: Promise<unknown>) => scheduled.push(p) } as any,
  )
  assert.equal(res.status, 200)
  assert.equal(scheduled.length, 1, "启用后的初始化必须登记为 waitUntil 任务")
  await scheduled[0]
})

test("F-006: meta/update 把非字符串 hide 转成字符串入库", async () => {
  const root = makeRoot()
  await seedDb(root, {
    metas: [
      {
        id: 1,
        path: "/",
        hide: "",
        password: "",
        read_users: [],
        write_users: [],
        readme: "",
        header: "",
      },
    ],
  })
  const res = await adminApp().request(
    "/api/admin/meta/update",
    {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, hide: ["aaa", "bbb"] }),
    },
    env,
  )
  assert.equal(res.status, 200)
  const db = await getDb(env)
  assert.equal(typeof db.metas[0].hide, "string")
  assert.equal(db.metas[0].hide, "aaa,bbb")
})

test("F-007: /driver/names 与 /driver/list 的驱动集合一致", async () => {
  const root = makeRoot()
  await seedDb(root)
  const app = adminApp()
  const namesRes = await app.request(
    "/api/admin/driver/names",
    { headers: AUTH },
    env,
  )
  const names: string[] = (await namesRes.json() as any).data
  const listRes = await app.request(
    "/api/admin/driver/list",
    { headers: AUTH },
    env,
  )
  const listKeys = Object.keys((await listRes.json() as any).data)
  for (const key of listKeys) {
    assert.ok(names.includes(key), `driver/names 缺少 ${key}`)
  }
  assert.equal(new Set(names).size, names.length, "driver/names 不应有重复项")
  for (const extra of ["CtFile", "Cloudflare R2", "WeiYun", "SFTP", "FTP"]) {
    assert.ok(names.includes(extra), `driver/names 缺少 ${extra}`)
  }
})

test("F-001: index/build 与 index/update 保存全量且不重复的索引", async () => {
  const root = makeRoot(true)
  await seedDb(root)
  const app = adminApp()

  const build = await app.request("/api/admin/index/build", {
    method: "POST",
    headers: AUTH,
  }, env)
  assert.equal(build.status, 200)
  let db = await getDb(env)
  const built: any[] = db.search_index.items
  assert.ok(built.length > 30, `索引被截断为 ${built.length} 条`)
  assert.equal(db.search_index.total, built.length)
  assert.equal(
    new Set(built.map((it) => `${it.parent}|${it.name}`)).size,
    built.length,
  )

  // paths 前缀必须按路径边界匹配："/sub" 不能命中 "/subway"
  const update = await app.request(
    "/api/admin/index/update",
    {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["/sub"] }),
    },
    env,
  )
  assert.equal(update.status, 200)
  db = await getDb(env)
  const items: any[] = db.search_index.items
  assert.equal(db.search_index.total, items.length)
  assert.equal(
    new Set(items.map((it) => `${it.parent}|${it.name}`)).size,
    items.length,
    "index/update 不得产生重复条目",
  )
  assert.ok(
    items.some((it) => it.parent === "/subway" && it.name === "other.txt"),
    "index/update 不应误删 /subway 下的条目",
  )
  assert.equal(items.length, built.length)
})

// ---------- fs.ts ----------

test("F-013: /fs/form 在解析 multipart 前按 Content-Length 预检", async () => {
  const root = makeRoot()
  await seedDb(root)
  const app = fsApp()
  const form = new FormData()
  form.set("file", new Blob([new Uint8Array(200 * 1024)]), "big.bin")

  env.MAX_UPLOAD = "1024"
  try {
    const res = await app.request(
      "/api/fs/form",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${adminJwt()}`, "File-Path": "/big.bin" },
        body: form,
      },
      env,
    )
    assert.equal(res.status, 413)
  } finally {
    delete env.MAX_UPLOAD
  }
})

test("F-014: regex_rename 拒绝灾难性回溯模式与非法正则", async () => {
  const root = makeRoot()
  fs.writeFileSync(path.join(root, "aaaa.txt"), "a")
  await seedDb(root)
  const app = fsApp()
  const headers = {
    Authorization: `Bearer ${adminJwt()}`,
    "Content-Type": "application/json",
  }
  const unsafe = await app.request(
    "/api/fs/regex_rename",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        src_dir: "/",
        src_name_regex: "(a+)+$",
        new_name_regex: "b",
      }),
    },
    env,
  )
  assert.equal(unsafe.status, 400)

  const invalid = await app.request(
    "/api/fs/regex_rename",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        src_dir: "/",
        src_name_regex: "[",
        new_name_regex: "b",
      }),
    },
    env,
  )
  assert.equal(invalid.status, 400)

  const ok = await app.request(
    "/api/fs/regex_rename",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        src_dir: "/",
        src_name_regex: "^a+\\.txt$",
        new_name_regex: "safe.txt",
      }),
    },
    env,
  )
  assert.equal(ok.status, 200)
  assert.ok(fs.existsSync(path.join(root, "safe.txt")), JSON.stringify(fs.readdirSync(root)))
})

test("F-015: /fs/archive/list 在根级与深层级都合成目录项", () => {
  // 归档下载依赖驱动返回 raw_url（本地驱动没有），因此这里直接对合成逻辑
  // 做单元测试：parseZip 只返回文件条目，目录必须由 buildArchiveListing 合成。
  const zipBytes = makeZip([
      { name: "b.txt", data: "b" },
      { name: "a/b.txt", data: "bb" },
    { name: "a/b/c.txt", data: "ccc" },
  ])
  const archive = parseZip(zipBytes.buffer as ArrayBuffer)
  const rootItems = buildArchiveListing(archive.entries)
  const rootDir = rootItems.find((it) => it.name === "a")
  assert.ok(rootDir, `根级应能看到目录 a: ${JSON.stringify(rootItems)}`)
  assert.equal(rootDir.is_dir, true)
  assert.equal(
    rootItems.find((it) => it.name === "b.txt")?.is_dir,
    false,
  )

  const deepItems = buildArchiveListing(archive.entries, "a")
  const deepDir = deepItems.find((it) => it.name === "b")
  assert.ok(deepDir, `深层应能看到目录 b: ${JSON.stringify(deepItems)}`)
  assert.equal(deepDir.is_dir, true)
  assert.equal(deepDir.size, 0)
})

test("F-017: 以 @s 开头的普通目录不再被当作分享路径", async () => {
  const root = makeRoot()
  await seedDb(root)
  const res = await fsApp().request(
    "/api/fs/list",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminJwt()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: "/@staging" }),
    },
    env,
  )
  assert.equal(res.status, 200)
  const body: any = await res.json()
  assert.ok(
    body.data.content.some((it: any) => it.name === "inside.txt"),
    JSON.stringify(body),
  )
})

test("F-020: /fs/add_offline_download 缺 urls 返回 HTTP 400", async () => {
  const root = makeRoot()
  await seedDb(root)
  const res = await fsApp().request(
    "/api/fs/add_offline_download",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminJwt()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: "/" }),
    },
    env,
  )
  assert.equal(res.status, 400)
})

test("F-116: /fs/multipart/init 对非数字 X-File-Size 返回 400", async () => {
  const root = makeRoot()
  await seedDb(root)
  const res = await fsApp().request(
    "/api/fs/multipart/init",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminJwt()}`,
        "File-Path": "/x.bin",
        "X-File-Size": "abc",
      },
    },
    env,
  )
  assert.equal(res.status, 400)
})

test("F-195: /fs/multipart/complete 拒绝未收齐分片的会话", async () => {
  const root = makeRoot()
  await seedDb(root)
  putSession({
    upload_id: "mp_audit_f195",
    state: "receiving",
    attempt: 0,
    path: "/x.bin",
    size: 100,
    chunk_size: 10,
    total_chunks: 10,
    received: new Set([0]),
    driver_session: "driver-session",
    partMd5s: [],
    storage_driver: "local",
    owner_id: 1,
    owner_root: "/",
    created_at: Date.now(),
  })
  const res = await fsApp().request(
    "/api/fs/multipart/complete",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminJwt()}`,
        "X-Upload-Id": "mp_audit_f195",
      },
    },
    env,
  )
  assert.equal(res.status, 400)
  const body: any = await res.json()
  assert.match(body.message, /upload incomplete/)
})

// ---------- seed.ts ----------

test("F-022: 同源 /d/ 与 /sd/ 源可通过 validateSource（与 fetchSafe 同一判定）", () => {
  const ctx: any = {
    req: { url: "https://openlist.example/api/fs/seed/update" },
    env: {},
  }
  const direct = seedTestHelpers.validateSource(ctx, {
    type: "share",
    url: "https://openlist.example/d/a.txt",
    expires_at: "",
    share_id: "",
  })
  assert.equal(direct.pathname, "/d/a.txt")
  const share = seedTestHelpers.validateSource(ctx, {
    type: "direct",
    url: "https://openlist.example/sd/abc123",
    expires_at: "",
    share_id: "",
  })
  assert.equal(share.pathname, "/sd/abc123")
  assert.equal(
    seedTestHelpers.isSameOpenListUrl(
      new URL("https://openlist.example/sd/abc"),
      new URL("https://openlist.example/api/x"),
    ),
    true,
  )
  // 跨域且不在白名单的源仍然拒绝（同源 /p/ 的路径放到别的域就不算同源）
  assert.throws(() =>
    seedTestHelpers.validateSource(ctx, {
      type: "direct",
      url: "https://evil.example/p/a.txt",
      expires_at: "",
      share_id: "",
    }),
  )
})

test("F-027: contentBytes 尊重显式 encoding=base64", () => {
  const bytes = seedTestHelpers.contentBytes("dGhpcyBpcyBhIHRlc3Q=", "base64")
  assert.equal(new TextDecoder().decode(bytes), "this is a test")
  // 启发式（无 encoding）行为保持不变
  const heuristic = seedTestHelpers.contentBytes("dGhpcyBpcyBhIHRlc3Q=")
  assert.equal(heuristic.byteLength, 20)
})

test("F-030: selected_files 中的 null/空串被拒绝而不是折叠成索引 0", async () => {
  const root = makeRoot()
  await seedDb(root)
  const seed = {
    name: "s",
    comment: "",
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "t",
    piece_size: 16384,
    trackers: [],
    channels: [],
    files: [
      {
        path: "a.txt",
        size: 1,
        modified: "2026-01-01T00:00:00.000Z",
        comment: "",
        hashes: {
          md5: "0".repeat(32),
          sha1: "0".repeat(40),
          sha256: "0".repeat(64),
          pieces: { md5: [], sha1: [], sha256: [] },
        },
        cas_slice_md5: "",
        cas_create_time: "",
        cas_cloud: "",
        missing_channels: [],
        sources: [],
      },
    ],
  }
  const app = fsApp()
  for (const bad of [[null], [""], [false]]) {
    const res = await app.request(
      "/api/fs/seed/rapid_upload",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminJwt()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ seed, selected_files: bad, target_path: "/" }),
      },
      env,
    )
    assert.equal(res.status, 400, `${JSON.stringify(bad)} 应 400`)
    assert.match(await res.text(), /invalid index/)
  }
})

test("F-021: fetchSafe 跨域重定向剥离 Authorization/Cookie 凭证头", async () => {
  const root = makeRoot()
  fs.writeFileSync(path.join(root, "x.bin"), "junk")
  await seedDb(root)
  const calls: Array<{ url: string; headers: Headers }> = []
  const originalFetch = globalThis.fetch
  // 桩掉全局 fetch：第一次请求 302 跳到「白名单外」的公网域，第二次记下请求头
  globalThis.fetch = (async (input: any, init?: any) => {
    // fetchSafe 传入的是 URL 对象（.href），也可能是字符串 / Request
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String(input?.url ?? input)
    calls.push({ url, headers: new Headers(init?.headers) })
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://mirror.openlist-test.example/x.bin" },
      })
    }
    return new Response("junk", { status: 200 })
  }) as any
  try {
    // 用公网源发起请求：c.req.url 决定 readStoredSeed 里 rawUrl 的 origin
    const res = await fsApp().request(
      "https://openlist.example/api/fs/seed/parse",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminJwt()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ seed_path: "/x.bin" }),
      },
      env,
    )
    // 重定向后取回的内容不是合法种子，400 是预期终点；断言核心在请求头上
    assert.equal(res.status, 400)
    assert.equal(calls.length, 2, "应恰好发起初始请求与重定向请求")
    assert.ok(calls[0].url.startsWith("https://openlist.example/"))
    // 同源初始请求携带凭证（证明凭证确实存在，只被跨域跳剥离）
    assert.equal(calls[0].headers.get("authorization"), `Bearer ${adminJwt()}`)
    assert.equal(calls[1].url, "https://mirror.openlist-test.example/x.bin")
    // F-021 本体：跨域重定向不得携带 Authorization/Cookie/proxy-authorization
    assert.equal(calls[1].headers.get("authorization"), null)
    assert.equal(calls[1].headers.get("cookie"), null)
    assert.equal(calls[1].headers.get("proxy-authorization"), null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("F-023: GET /seed/capabilities 带 path 探测必须过读 ACL", async () => {
  const root = makeRoot()
  fs.writeFileSync(path.join(root, "pub.bin"), "P")
  fs.mkdirSync(path.join(root, "secret"), { recursive: true })
  fs.writeFileSync(path.join(root, "secret", "hidden.bin"), "S")
  await seedDb(root, {
    // guest 兜底需要一个名为 guest 的真实用户行，匿名探测才会拿到 guest 身份
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
        username: "guest",
        password: "",
        role: 0,
        permission: 0,
        base_path: "/",
        disabled: false,
      },
    ],
    metas: [
      {
        path: "/secret",
        password: "123",
        p_sub: true,
        read_users: [],
        read_users_sub: true,
        write_users: [],
        write_users_sub: true,
        write: false,
        w_sub: false,
        hide: "",
        h_sub: false,
        readme: "",
        r_sub: false,
        header: "",
        header_sub: false,
      },
    ],
  })
  const app = fsApp()
  // 匿名（guest 兜底）探测受保护路径：必须被读 ACL 拦截，且不泄露驱动名
  const denied = await app.request(
    `/api/fs/seed/capabilities?path=${encodeURIComponent("/secret/hidden.bin")}`,
    { method: "GET" },
    env,
  )
  assert.equal(denied.status, 200)
  const deniedBody: any = await denied.json()
  assert.match(
    String(deniedBody.data?.target?.error || ""),
    /permission denied/,
  )
  assert.equal(
    deniedBody.data?.target?.driver,
    undefined,
    "被拒绝的探测不得回显存储驱动名",
  )
  // 对照：未受保护的路径仍可探测（公开的静态能力协商不受影响）
  const ok = await app.request(
    `/api/fs/seed/capabilities?path=${encodeURIComponent("/pub.bin")}`,
    { method: "GET" },
    env,
  )
  assert.equal(ok.status, 200)
  const okBody: any = await ok.json()
  assert.equal(okBody.data?.target?.driver, "local")
})

// ---------- auth.ts ----------

test("F-034: 登录失败计数写入统一持久化后端（不再依赖 KV binding 形态）", async () => {
  const logoutEnv: any = {}
  const ctx: any = {
    env: logoutEnv,
    req: { raw: {}, header: () => undefined },
  }
  await recordLoginFailure(ctx, "audit-f034", logoutEnv)
  const raw = await readPersistedSecret(
    logoutEnv,
    "login_fail:__global__|audit-f034",
  )
  assert.ok(raw, "失败计数必须经 readPersistedSecret 可读（旧实现依赖 KV binding）")
  const rec = JSON.parse(raw!)
  assert.equal(rec.count, 1)

  for (let i = 0; i < 19; i++) {
    await recordLoginFailure(ctx, "audit-f034", logoutEnv)
  }
  assert.equal(await isLoginLocked(ctx, "audit-f034", logoutEnv), true)

  await clearLoginFailures(ctx, "audit-f034", logoutEnv)
  assert.equal(await isLoginLocked(ctx, "audit-f034", logoutEnv), false)
  assert.equal(
    await readPersistedSecret(
      logoutEnv,
      "login_fail:__global__|audit-f034",
    ),
    null,
    "清除后持久化记录应为空",
  )
})

test("F-037: 懒清理按 updatedAt 回收 count>0 的陈旧条目", async () => {
  const failures = __loginFailuresForTest() as Map<string, any>
  failures.clear()
  const now = Date.now()
  // 26h > LOGIN_FAILURE_RECORD_TTL_MS（24h 锁定上限 + 1h）。
  // 历史缺陷：失败 1-4 次（count>=1、lockedUntil=0）的条目永不满足
  // 「lockedUntil < now && count === 0」，攻击者用随机用户名打 /login
  // 即可让 Map 在长驻实例里无界增长。
  const staleAt = now - 26 * 60 * 60 * 1000
  for (let i = 0; i < 10001; i++) {
    failures.set(`f037-stale-${i}`, {
      count: 1,
      lockedUntil: 0,
      attempts: 1,
      updatedAt: staleAt,
    })
  }
  failures.set("__global__|audit-f037-fresh", {
    count: 2,
    lockedUntil: 0,
    attempts: 2,
    updatedAt: now,
  })

  const ctx: any = {
    env: {},
    req: { raw: {}, header: () => undefined },
  }
  // size 超过上限（10000）才会进入懒清理分支
  assert.equal(await isLoginLocked(ctx, "audit-f037-fresh", ctx.env), false)

  const staleLeft = [...failures.keys()].filter((k) =>
    k.startsWith("f037-stale-"),
  ).length
  assert.equal(staleLeft, 0, "count>0 但长期无更新的条目必须被回收")
  assert.ok(failures.size <= 10000, "清理后不得超过容量上限（含硬上限裁剪）")
  assert.ok(failures.has("__global__|audit-f037-fresh"), "新条目不受懒清理影响")
  failures.clear()
})

test("cleanup", () => {
  for (const root of tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})
