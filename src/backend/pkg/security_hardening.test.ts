import test from "node:test"
import assert from "node:assert/strict"
import { collapsePathSegments, decodePathFully, escapeRegExp } from "./path"
import { findUserByTokenPayload, getActualPath } from "./permission"
import { isHidden, validateHide } from "./meta"
import {
  findReceivingSession,
  MAX_TOTAL_CHUNKS,
  MAX_UPLOAD_BYTES,
  pruneSessions,
  putSession,
  getSession,
  newUploadId,
  type MultipartSession,
} from "../internal/upload/multipart"
import { parseRangeHeader } from "../internal/stream/stream"
import { extractZipEntry, type ZipEntry } from "../internal/archive/zip"
import { sanitizeData, sanitizeLine } from "./secure-log"
import { injectCdnIntoHtml } from "../server/assets"
import {
  AuditCategory,
  AuditLevel,
  getAuditLogger,
  InMemoryAuditLogStorage,
  setAuditLogStorage,
} from "./audit"

test("SEC-074: 审计条目在入库前压平用户可控换行并脱敏 details", async () => {
  const captured: any[] = []
  setAuditLogStorage({
    write: async (e: any) => void captured.push(e),
    query: async () => [],
    count: async () => 0,
  })
  try {
    const fakeCtx: any = {
      get: (k: string) =>
        k === "user" ? { id: 7, username: "atk\n注入者" } : undefined,
      req: {
        header: (k: string) =>
          k === "user-agent" ? "probe\r\n[AUDIT] forged" : null,
      },
    }
    await getAuditLogger().log(
      fakeCtx,
      AuditLevel.WARN,
      AuditCategory.AUTH,
      "login_failed",
      "Failed login for atk\n[AUDIT][01-01][AUTH] forged record",
      { details: { authorization: "Bearer abc.def.ghi", path: "/a\nb" } },
    )
    const entry = captured[0]
    assert.ok(entry, "应写入一条审计记录")
    assert.ok(
      !/[\r\n]/.test(entry.message),
      `message 仍含换行：${JSON.stringify(entry.message)}`,
    )
    assert.match(entry.message, /_\[AUDIT\]/, "伪造行应被压平成同一行文本")
    assert.ok(!/[\r\n]/.test(entry.username), "用户名同样需压平")
    assert.ok(!/[\r\n]/.test(entry.user_agent), "UA 同样需压平")
    assert.equal(entry.details.authorization, "[REDACTED]")
    assert.equal(entry.details.path, "/a_b")
  } finally {
    setAuditLogStorage(new InMemoryAuditLogStorage(100))
  }
})
import { Hono } from "hono"
import { adminRouter } from "../server/admin"
import { saveDb } from "../internal/model/db"

test("SEC-051: 注入 HTML 的 CDN 值不能提前闭合 <script>", () => {
  const evil = "https://cdn.example.com/</script><script>alert(1)</script>"
  const out = injectCdnIntoHtml(
    "<html><head><script>window.OPENLIST_CONFIG={cdn: undefined}</script></head></html>",
    evil,
  )
  assert.ok(out.includes("cdn: '"), `应完成注入：${out.slice(0, 200)}`)
  // 注入值里不得出现可用于闭合标签的原始 < / >
  const injected = out.slice(
    out.indexOf("cdn: '"),
    out.indexOf("}", out.indexOf("cdn: '")),
  )
  assert.ok(!/[<>]/.test(injected), `注入片段仍含尖括号：${injected}`)
  assert.equal(
    (out.match(/<\/script>/g) || []).length,
    1,
    "整页只应保留模板自身那一个 </script>",
  )
})

test("SEC-074/089: 日志脱敏会去掉控制字符并遮蔽敏感字段", () => {
  assert.equal(sanitizeLine("a\u0000b\nc\rtd"), "a_b_c_td")
  assert.equal(sanitizeLine("x".repeat(600), 500).length, 515)
  const data: any = sanitizeData({
    username: "atk",
    password: "plain",
    otp_secret: "SECRETVALUE",
    note: "line1\nline2",
  })
  assert.equal(data.password, "[REDACTED]")
  assert.equal(data.otp_secret, "[REDACTED]")
  assert.equal(data.note, "line1_line2", "字符串值也不得带裸换行进日志")
  assert.equal(data.username, "atk", "普通字段保持原值")
})

test("SEC-012: settings.token 不再作为管理令牌；api_token 需足够长", async () => {
  const env: any = {}
  const baseDb = {
    settings: [
      { key: "token", value: "legacy-driver-token-0123456789" },
      { key: "api_token", value: "short" },
    ],
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
        password: "x",
        role: 1,
        permission: 0,
        base_path: "/",
        disabled: true,
      },
    ],
    storages: [],
    metas: [],
    shares: [],
  }
  await saveDb(baseDb as any, env)
  const app = new Hono()
  app.route("/", adminRouter)
  for (const token of ["legacy-driver-token-0123456789", "short"]) {
    const res = await app.request("/setting", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
    const body: any = await res.json().catch(() => null)
    assert.ok(
      res.status === 401 || body?.code === 401,
      `不得获得管理权限：token=${token} status=${res.status}`,
    )
  }

  const strong = "api-token-0123456789abcdef"
  await saveDb(
    { ...baseDb, settings: [{ key: "api_token", value: strong }] } as any,
    env,
  )
  const ok = await app.request("/setting", {
    method: "GET",
    headers: { Authorization: `Bearer ${strong}` },
  })
  assert.notEqual(ok.status, 401, "独立的 api_token 应能作为管理令牌")
})
import {
  exceedsUploadLimit,
  getUploadSizeLimit,
  overLimitResponse,
  readBodyBytesLimited,
} from "./body_limit"

/** 只带 header/json 的最小 Hono 上下文替身 */
function fakeCtx(
  headers: Record<string, string>,
  env: Record<string, any> = {},
) {
  return {
    env,
    req: { header: (k: string) => headers[k] ?? null },
    json: (body: any, status?: number) => ({ body, status }),
  } as any
}

test("上传体积限制在无 Content-Length 时仍按实际字节数生效", () => {
  const max = getUploadSizeLimit(fakeCtx({}, { MAX_UPLOAD: "1000" }))
  assert.equal(max, 1000)
  // 有 Content-Length：可预判
  assert.equal(
    exceedsUploadLimit(
      fakeCtx({ "Content-Length": "2000" }, { MAX_UPLOAD: "1000" }),
    ),
    1000,
  )
  assert.equal(
    exceedsUploadLimit(
      fakeCtx({ "Content-Length": "500" }, { MAX_UPLOAD: "1000" }),
    ),
    null,
  )
  // 无 Content-Length（分块传输）：预判失效，但读完后必须仍能拦下
  const noLength = fakeCtx({}, { MAX_UPLOAD: "1000" })
  assert.equal(exceedsUploadLimit(noLength), null)
  assert.equal(overLimitResponse(noLength, 1500)?.status, 413)
  assert.equal(overLimitResponse(noLength, 900), null)
  assert.equal(overLimitResponse(noLength, 1001)?.status, 413)
  // 分片走独立上限
  const partCtx = fakeCtx({}, { MAX_UPPART: "10" })
  assert.equal(getUploadSizeLimit(partCtx, true), 10)
  assert.equal(overLimitResponse(partCtx, 11, true)?.status, 413)
})

test("SEC-021: 无 Content-Length 的 chunked body 在读取过程中被截断", async () => {
  const makeStream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700))
        controller.enqueue(new Uint8Array(700))
        controller.close()
      },
    })
  const fake: any = {
    env: { MAX_UPLOAD: "1000" },
    req: {
      header: () => null,
      raw: { body: makeStream() },
    },
  }
  const result = await readBodyBytesLimited(fake)
  assert.equal(result.tooLarge, 1000)
  assert.equal(result.bytes.byteLength, 0)

  const small: any = {
    env: { MAX_UPLOAD: "1000" },
    req: {
      header: () => null,
      raw: {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(400))
            controller.close()
          },
        }),
      },
    },
  }
  const ok = await readBodyBytesLimited(small)
  assert.equal(ok.tooLarge, null)
  assert.equal(ok.bytes.byteLength, 400)
})

test("SEC-055: 解压条目超过上限时被拒绝", async () => {
  const payload = new TextEncoder().encode("0123456789").buffer
  const entry: ZipEntry = {
    name: "bomb.txt",
    isDir: false,
    size: 10,
    compressedSize: 10,
    compressionMethod: 0,
    dataOffset: 0,
    modified: "",
  }
  await assert.rejects(
    () => extractZipEntry(payload, entry, 5),
    /extraction limit/i,
  )
  const ok = await extractZipEntry(payload, entry, 10)
  assert.equal(new TextDecoder().decode(ok), "0123456789")
})

test("decodePathFully 与 resolvePath 一样看穿多重编码", () => {
  assert.equal(decodePathFully("/a/%2e%2e/b"), "/a/../b")
  assert.equal(decodePathFully("/a/%252e%252e/b"), "/a/../b")
  assert.equal(decodePathFully("/a/....b"), "/a/..b")
  assert.equal(decodePathFully("/a%2fb"), "/a/b")
  // 非法百分号序列不抛错，原样返回
  assert.equal(decodePathFully("/100%.txt"), "/100%.txt")
})

test("collapsePathSegments 在指定层数处钳制", () => {
  assert.deepEqual(collapsePathSegments("/u1/../x", 1), ["u1", "x"])
  assert.deepEqual(collapsePathSegments("/u1/x/../../y", 1), ["u1", "y"])
  assert.deepEqual(collapsePathSegments("/u1/x", 0), ["u1", "x"])
  assert.deepEqual(collapsePathSegments("/u1/../x", 0), ["x"])
})

test("escapeRegExp 把输入当字面量", () => {
  for (const evil of ["(a+)+", "*", "[", "a.b", "$1"]) {
    const re = new RegExp(escapeRegExp(evil))
    assert.ok(re.test(evil), `${evil} 应能字面匹配自身`)
  }
})

test("token 主体以 id 为准，username 仅作历史回退", () => {
  const users = [
    { id: 1, username: "alice" },
    { id: 2, username: "bob" },
  ]
  assert.equal(
    findUserByTokenPayload(users, { id: 2, username: "alice" }),
    users[1],
  )
  // id 不存在时不再按 username 认领他人账号
  assert.equal(
    findUserByTokenPayload(users, { id: 99, username: "alice" }),
    null,
  )
  // 无 id 的历史 token 才回退用户名
  assert.equal(findUserByTokenPayload(users, { username: "bob" }), users[1])
  assert.equal(findUserByTokenPayload(users, {}), null)
})

test("base_path 用户在 meta 隐藏规则下仍受限", () => {
  // getActualPath 的越界钳制已在 permission_basepath.test.ts 覆盖，
  // 这里确认对管理员（base_path="/"）不改写正常路径
  const admin = { role: 2, permission: 0, base_path: "/" } as any
  assert.equal(getActualPath(admin, "/a/b"), "/a/b")
})

test("meta.hide 拒收灾难性回溯模式，运行时跳过历史脏数据", () => {
  assert.equal(validateHide("^good$"), null)
  assert.equal(validateHide("(a|b)+"), null)
  for (const evil of [
    "(a+)+$",
    "^(a|a?)+$",
    "(a*)*b",
    "(a|aa)+$",
    "(foo|foobar)+$",
    "(\\w+|\\d+)+$",
    "(a)\\1+",
    "a*a*a*a*b",
    "x".repeat(300),
  ]) {
    assert.equal(
      typeof validateHide(evil),
      "string",
      `validateHide 应拒绝: ${evil}`,
    )
  }
  const meta: any = { path: "/", hide: "(a+)+$", h_sub: false }
  const long = "a".repeat(40)
  const started = Date.now()
  assert.equal(isHidden(meta, "/", long), false, "危险模式应被跳过而非执行")
  assert.ok(Date.now() - started < 200, "跳过危险模式不应产生回溯耗时")

  const safe: any = { path: "/", hide: "^secret", h_sub: false }
  assert.equal(isHidden(safe, "/", "secret.txt"), true)
})

function makeSession(over: Partial<MultipartSession>): MultipartSession {
  return {
    upload_id: newUploadId(),
    state: "receiving",
    attempt: 0,
    path: "/dir/file.bin",
    size: 10 * 1024 * 1024,
    chunk_size: 1024 * 1024,
    total_chunks: 10,
    received: new Set<number>(),
    driver_session: "drv",
    partMd5s: new Array(10).fill(undefined),
    storage_driver: "s3",
    created_at: Date.now(),
    ...over,
  }
}

test("分片会话按发起者隔离，过期会话会被回收", () => {
  const ownerA = makeSession({ owner: "1:alice" })
  putSession(ownerA)
  assert.equal(
    findReceivingSession(ownerA.path, ownerA.size, "1:alice")?.upload_id,
    ownerA.upload_id,
  )
  assert.equal(
    findReceivingSession(ownerA.path, ownerA.size, "2:bob"),
    undefined,
  )
  assert.equal(getSession(ownerA.upload_id)?.owner, "1:alice")

  const done = makeSession({
    owner: "1:alice",
    state: "completed",
    created_at: Date.now() - 2 * 60 * 60 * 1000,
  })
  putSession(done)
  const staleReceiving = makeSession({
    owner: "9:zed",
    created_at: Date.now() - 7 * 60 * 60 * 1000,
  })
  putSession(staleReceiving)
  pruneSessions(60 * 60 * 1000, 6 * 60 * 60 * 1000)
  assert.equal(getSession(done.upload_id), undefined, "过期 completed 应被清理")
  assert.equal(
    getSession(staleReceiving.upload_id),
    undefined,
    "过期 receiving 应被清理",
  )
  assert.notEqual(getSession(ownerA.upload_id), undefined, "活跃会话不应被清理")
})

test("上传规模上限存在且可校验", () => {
  assert.ok(MAX_UPLOAD_BYTES > 0 && MAX_TOTAL_CHUNKS > 0)
  // 一个荒谬的 X-File-Size 会折算出超限的分片数
  const chunkSize = 1024 * 1024
  const total = Math.ceil(MAX_UPLOAD_BYTES / chunkSize) + 1
  assert.ok(total > MAX_TOTAL_CHUNKS)
})

test("parseRangeHeader 拒绝畸形区间并截断越界末端", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-49", 100), {
    start: 0,
    end: 49,
    chunksize: 50,
  })
  assert.deepEqual(parseRangeHeader("bytes=50-", 100), {
    start: 50,
    end: 99,
    chunksize: 50,
  })
  assert.deepEqual(parseRangeHeader("bytes=-30", 100), {
    start: 70,
    end: 99,
    chunksize: 30,
  })
  assert.deepEqual(parseRangeHeader("bytes=0-99999", 100), {
    start: 0,
    end: 99,
    chunksize: 100,
  })
  assert.equal(parseRangeHeader("bytes=90-10", 100), null, "反向区间")
  assert.equal(parseRangeHeader("bytes=100-", 100), null, "起点越界")
  assert.equal(parseRangeHeader("bytes=-", 100), null)
  assert.equal(parseRangeHeader("items=0-1", 100), null)
  assert.equal(parseRangeHeader("bytes=0-1", 0), null, "大小未知")
})
