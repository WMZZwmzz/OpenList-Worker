import test from "node:test"
import assert from "node:assert/strict"
import {
  normalizeDeviceID,
  normalizePhoneE164,
  unixOrNow,
  GuangYaPanClient,
} from "./util"
import { GuangYaPanDriver, normalizeGuangYaPanAddition } from "./driver"

test("normalizePhoneE164 formats CN mobile numbers", () => {
  assert.equal(normalizePhoneE164("13800138000"), "+86 13800138000")
  assert.equal(normalizePhoneE164("+86 13800138000"), "+86 13800138000")
  assert.equal(normalizePhoneE164(""), "")
})

test("normalizeDeviceID validates 32-hex", () => {
  const hex = "0123456789abcdef0123456789abcdef"
  assert.equal(normalizeDeviceID(hex.toUpperCase()), hex)
  assert.equal(normalizeDeviceID("bad"), "")
  assert.equal(normalizeDeviceID(""), "")
})

test("unixOrNow converts epoch seconds", () => {
  const iso = unixOrNow(1700000000)
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T/)
})

test("GuangYaPanClient.md5 matches RFC 1321 vector", () => {
  const digest = GuangYaPanClient.md5(new TextEncoder().encode("abc"))
  assert.equal(digest, "900150983cd24fb0d6963f7d28e17f72")
})

test("normalizeGuangYaPanAddition generates device_id fallback", () => {
  const a = normalizeGuangYaPanAddition({ client_id: "cid" })
  assert.equal(a.client_id, "cid")
  assert.match(a.device_id, /^[0-9a-f]{32}$/)
  assert.ok(a.device_sign.startsWith("wdi10."))
})

test("GuangYaPanDriver instantiation", () => {
  const driver = new GuangYaPanDriver({
    client_id: "cid",
    access_token: "at",
  })
  assert.ok(driver)
})

/** 用假 fetch 跑 init 的辅助：routes 为 `${method} ${path}` -> 响应体 */
async function withMockFetch(
  routes: Record<string, { status?: number; body: any }>,
  fn: () => Promise<void>,
) {
  const calls: string[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = new URL(String(url))
    const key = `${init?.method || "GET"} ${u.pathname}`
    calls.push(key)
    const r = routes[key]
    if (!r) throw new Error(`unexpected fetch: ${key}`)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }) as any
  try {
    await fn()
  } finally {
    globalThis.fetch = orig
  }
  return calls
}

test("init: phone+send_code 发短信并暂存 verification_id，不视为失败", async () => {
  const persisted: Record<string, any>[] = []
  const driver = new GuangYaPanDriver(
    {
      client_id: "cid",
      device_id: "0123456789abcdef0123456789abcdef",
      phone_number: "13800138000",
      send_code: true,
    },
    async (changes) => {
      persisted.push(changes)
    },
  )
  await withMockFetch(
    {
      "POST /v1/shield/captcha/init": { body: { captcha_token: "ct1" } },
      "POST /v1/auth/verification": { body: { verification_id: "vid1" } },
    },
    async () => {
      await driver.init()
    },
  )
  // 发送成功后自动复位 send_code，并回写 verification_id
  const last = persisted[persisted.length - 1]
  assert.equal(last.verification_id, "vid1")
  assert.equal(last.send_code, false)
})

test("init: phone+verify_code 完成登录并清空一次性字段", async () => {
  const persisted: Record<string, any>[] = []
  const driver = new GuangYaPanDriver(
    {
      client_id: "cid",
      device_id: "0123456789abcdef0123456789abcdef",
      phone_number: "+86 13800138000",
      verify_code: "123456",
      verification_id: "vid1",
    },
    async (changes) => {
      persisted.push(changes)
    },
  )
  await withMockFetch(
    {
      "POST /v1/auth/verification/verify": {
        body: { verification_token: "vt1" },
      },
      "POST /v1/auth/signin": {
        body: { access_token: "at1", refresh_token: "rt1" },
      },
      "GET /v1/user/me": { body: { sub: "u1" } },
    },
    async () => {
      await driver.init()
    },
  )
  const last = persisted[persisted.length - 1]
  assert.equal(last.access_token, "at1")
  assert.equal(last.refresh_token, "rt1")
  assert.equal(last.verify_code, "")
  assert.equal(last.verification_id, "")
})

test("init: captcha 失效时自动刷新并重试发短信", async () => {
  const driver = new GuangYaPanDriver({
    client_id: "cid",
    device_id: "0123456789abcdef0123456789abcdef",
    phone_number: "13800138000",
    send_code: true,
    captcha_token: "old-ct",
  })
  let captchaInits = 0
  let verificationCalls = 0
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = new URL(String(url))
    const key = `${init?.method || "GET"} ${u.pathname}`
    if (key === "POST /v1/shield/captcha/init") {
      captchaInits++
      return new Response(JSON.stringify({ captcha_token: "new-ct" }))
    }
    if (key === "POST /v1/auth/verification") {
      // 第一次模拟 captcha 失效，刷新后第二次成功
      verificationCalls++
      if (verificationCalls === 1) {
        return new Response(
          JSON.stringify({
            error: "captcha_invalid",
            error_description: "captcha_token expired",
          }),
          { status: 400 },
        )
      }
      return new Response(JSON.stringify({ verification_id: "vid2" }))
    }
    throw new Error(`unexpected fetch: ${key}`)
  }) as any
  try {
    await driver.init()
  } finally {
    globalThis.fetch = orig
  }
  // ensureCaptchaToken(false) 因已有旧 token 而跳过；发码失败后 force 刷新一次
  assert.equal(captchaInits, 1)
})

test("init: 无任何凭据时抛出可读错误", async () => {
  const driver = new GuangYaPanDriver({ client_id: "cid" })
  await assert.rejects(() => driver.init(), /login failed/)
})

test("init: 缺 client_id 直接失败", async () => {
  const driver = new GuangYaPanDriver({ access_token: "at" })
  await assert.rejects(() => driver.init(), /client_id is required/)
})

test("init: verify_code 错误时抛 verify code failed 且不触发 signin", async () => {
  const driver = new GuangYaPanDriver({
    client_id: "cid",
    device_id: "0123456789abcdef0123456789abcdef",
    phone_number: "13800138000",
    verify_code: "000000",
    verification_id: "vid1",
  })
  await withMockFetch(
    {
      "POST /v1/auth/verification/verify": {
        status: 400,
        body: {
          error: "verification_code_mismatch",
          error_description: "短信验证码不正确或已过期",
        },
      },
    },
    async () => {
      // signin 路由未注册：若错误路径继续调用 signin，withMockFetch 会抛
      // unexpected fetch，断言会先于此失败
      await assert.rejects(() => driver.init(), /verify code failed/)
    },
  )
})

test("init: 过期 verification_id 同样不触发 signin", async () => {
  const driver = new GuangYaPanDriver({
    client_id: "cid",
    device_id: "0123456789abcdef0123456789abcdef",
    phone_number: "13800138000",
    verify_code: "123456",
    verification_id: "vid-expired",
  })
  await withMockFetch(
    {
      "POST /v1/auth/verification/verify": {
        status: 400,
        body: {
          error: "verification_id_expired",
          error_description: "verification_id 已过期，请重新发送验证码",
        },
      },
    },
    async () => {
      await assert.rejects(() => driver.init(), /verify code failed/)
    },
  )
})

test("init: captcha 持续失效达到重试上限后报错，重试次数封顶", async () => {
  const driver = new GuangYaPanDriver({
    client_id: "cid",
    device_id: "0123456789abcdef0123456789abcdef",
    phone_number: "13800138000",
    send_code: true,
  })
  let captchaInits = 0
  let verificationCalls = 0
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = new URL(String(url))
    const key = `${init?.method || "GET"} ${u.pathname}`
    if (key === "POST /v1/shield/captcha/init") {
      captchaInits++
      return new Response(
        JSON.stringify({ captcha_token: "ct-" + captchaInits }),
      )
    }
    if (key === "POST /v1/auth/verification") {
      // 一直返回 captcha 失效
      verificationCalls++
      return new Response(
        JSON.stringify({
          error: "captcha_invalid",
          error_description: "captcha_token expired",
        }),
        { status: 400 },
      )
    }
    throw new Error(`unexpected fetch: ${key}`)
  }) as any
  try {
    // 初次发码 + 2 次刷新重试共 3 次；之后停止，绝不无限循环
    await assert.rejects(() => driver.init(), /after 2 captcha refreshes/)
  } finally {
    globalThis.fetch = orig
  }
  assert.equal(captchaInits, 3)
  assert.equal(verificationCalls, 3)
})

/** 拦截光亚盘 API：记录路径/请求体，返回 handler 构造的 JSON */
function mockApi(handler: (path: string, body: any) => any) {
  const calls: { path: string; body: any }[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = new URL(String(url))
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ path: u.pathname, body })
    return new Response(JSON.stringify(handler(u.pathname, body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as any
  return {
    calls,
    restore: () => {
      globalThis.fetch = orig
    },
  }
}

const listPath = "/userres/v1/file/get_file_list"

function gypFile(
  fileName: string,
  fileId: string,
  resType: number,
): Record<string, any> {
  return { fileName, fileId, resType, fileSize: 1, utime: 1700000000 }
}

test("list() advances the page parameter and dedupes entries (F-220)", async () => {
  const driver = new GuangYaPanDriver({
    client_id: "cid",
    access_token: "at",
    page_size: 2,
  })
  const pages = new Map<number, any[]>([
    [0, [gypFile("b", "id-b", 1), gypFile("a", "id-a", 1)]],
    [1, [gypFile("c", "id-c", 1)]],
  ])
  const mock = mockApi((path, body) => {
    assert.equal(path, listPath)
    return {
      code: 0,
      msg: "success",
      data: { list: pages.get(body.page) || [], total: 3 },
    }
  })
  try {
    const items = await driver.list("/", "/")
    assert.deepEqual(
      items.map((i) => i.name),
      ["a", "b", "c"],
    )
    assert.deepEqual(
      mock.calls.map((c) => c.body.page),
      [0, 1],
    )
  } finally {
    mock.restore()
  }
})

test("list() stops when the server ignores the page parameter", async () => {
  const driver = new GuangYaPanDriver({
    client_id: "cid",
    access_token: "at",
    page_size: 2,
  })
  let calls = 0
  const mock = mockApi(() => {
    calls++
    // 永远返回同一页（无 total），旧实现会空转 10000 次
    return {
      code: 0,
      msg: "success",
      data: { list: [gypFile("a", "id-a", 1), gypFile("b", "id-b", 1)] },
    }
  })
  try {
    const items = await driver.list("/", "/")
    assert.equal(items.length, 2)
    assert.ok(calls <= 3, `expected pagination to stop, got ${calls} calls`)
  } finally {
    mock.restore()
  }
})

test("destructive ops re-resolve IDs and invalidate the id cache (F-221)", async () => {
  const driver = new GuangYaPanDriver({
    client_id: "cid",
    access_token: "at",
    page_size: 100,
  })
  let currentAId = "id-a1"
  const deleted: string[][] = []
  const mock = mockApi((path, body) => {
    if (path === listPath) {
      if (body.parentId === "") {
        return {
          code: 0,
          msg: "success",
          data: { list: [gypFile("docs", "dir-docs", 2)], total: 1 },
        }
      }
      if (body.parentId === "dir-docs") {
        return {
          code: 0,
          msg: "success",
          data: { list: [gypFile("a.txt", currentAId, 1)], total: 1 },
        }
      }
    }
    if (path === "/nd.bizuserres.s/v1/file/delete_file") {
      deleted.push(body.fileIds)
      return { code: 0, msg: "success", data: {} }
    }
    throw new Error(`unexpected call: ${path}`)
  })
  try {
    await driver.remove("/docs", "/docs/a.txt", ["a.txt"])
    // 服务端状态变化：a.txt 换了新 ID
    currentAId = "id-a2"
    await driver.remove("/docs", "/docs/a.txt", ["a.txt"])

    assert.deepEqual(deleted, [["id-a1"], ["id-a2"]])
    const listCalls = mock.calls.filter((c) => c.path === listPath).length
    assert.ok(listCalls >= 4, `expected fresh lookups, got ${listCalls}`)
  } finally {
    mock.restore()
  }
})

// ---- F-222: 深层路径解析必须翻页 ----
test("resolveId/get 在条目位于第二页时仍能命中（F-222）", async () => {
  const driver = new GuangYaPanDriver({
    client_id: "cid",
    access_token: "at",
    page_size: 2,
  })
  const mock = mockApi((path, body) => {
    if (path === "/nd.bizuserres.s/v1/get_res_download_url") {
      return { code: 0, msg: "success", data: { signedURL: "https://dl/x" } }
    }
    assert.equal(path, listPath)
    if (body.parentId === "") {
      if (body.page === 0) {
        return {
          code: 0,
          msg: "success",
          data: { list: [gypFile("a", "id-a", 1), gypFile("b", "id-b", 1)], total: 3 },
        }
      }
      return {
        code: 0,
        msg: "success",
        data: { list: [gypFile("docs", "dir-docs", 2)], total: 3 },
      }
    }
    return {
      code: 0,
      msg: "success",
      data: { list: [gypFile("x.txt", "id-x", 1)], total: 1 },
    }
  })
  try {
    const items = await driver.list("/", "/docs")
    assert.deepEqual(items.map((i) => i.name), ["x.txt"])

    const item = await driver.get("/docs/x.txt", "/docs/x.txt")
    assert.equal(item.name, "x.txt")
    assert.equal(item.raw_url, "https://dl/x")
    assert.ok(
      mock.calls.some((c) => c.body?.page === 1),
      "必须翻到第二页",
    )
  } finally {
    mock.restore()
  }
})

// ---- F-223: OSS 上传 URL 逐段编码，签名仍用原始路径 ----
test("OSS 上传 URL 编码 objectPath 且签名用原始路径（F-223）", async () => {
  const { hmacSha1Base64 } = await import("./util")
  const driver = new GuangYaPanDriver({ client_id: "cid", access_token: "at" })
  const ossPuts: { url: string; headers: Record<string, string> }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    const method = String(init.method || "GET").toUpperCase()
    if (method === "PUT") {
      ossPuts.push({ url, headers: init.headers || {} })
      return new Response("", { status: 200 })
    }
    if (url.includes("get_res_center_token")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "success",
          data: {
            taskId: "task-1",
            objectPath: "2024/abc#final.mp4",
            bucketName: "bucket",
            endPoint: "oss.example.com",
            creds: { accessKeyID: "ak", secretAccessKey: "sk" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (url.includes("get_info_by_task_id")) {
      return new Response(
        JSON.stringify({ code: 0, msg: "success", data: { fileId: "f1" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  }) as any
  try {
    await driver.put("/abc#final.mp4", "/abc#final.mp4", Buffer.from("x"))
    assert.ok(ossPuts.length > 0, "应发起 OSS PUT")
    const ossPut = ossPuts[0]
    assert.equal(new URL(ossPut.url).pathname, "/2024/abc%23final.mp4")

    // 签名覆盖的 canonicalizedResource 必须是未编码的原始路径
    const expected = await hmacSha1Base64(
      `PUT\n\napplication/octet-stream\n${ossPut.headers.Date}\n/bucket/2024/abc#final.mp4`,
      "sk",
    )
    assert.equal(ossPut.headers.Authorization, `OSS ak:${expected}`)
  } finally {
    globalThis.fetch = original
  }
})

// ---- F-224: 上传登记轮询必须识别业务错误 ----
test("waitUploadTaskInfo 遇到业务错误立即抛出（F-224）", async () => {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls++
    return new Response(JSON.stringify({ code: 500, msg: "boom" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as any
  try {
    const { GuangYaPanClient } = await import("./util")
    const client = new GuangYaPanClient({ client_id: "cid" })
    await assert.rejects(() => client.waitUploadTaskInfo("t1"), /boom/)
    assert.equal(calls, 1, "不应空转到超时")
  } finally {
    globalThis.fetch = original
  }
})

// ---- F-225: 86 前缀 13 位号码 ----
test("normalizePhoneE164 处理 86 开头未带 + 的 13 位号码（F-225）", () => {
  assert.equal(normalizePhoneE164("8613800138000"), "+86 13800138000")
  assert.equal(normalizePhoneE164("86 138 0013 8000"), "+86 13800138000")
  assert.equal(normalizePhoneE164("+8613800138000"), "+86 13800138000")
})

// ---- F-226: null/空串/非数字配置回落默认值 ----
test("normalizeGuangYaPanAddition 对 null/''/NaN 回落默认值（F-226）", () => {
  const a = normalizeGuangYaPanAddition({
    client_id: "cid",
    page_size: "abc",
    order_by: null,
    sort_type: "",
  })
  assert.equal(a.page_size, 100)
  assert.equal(a.order_by, 3)
  assert.equal(a.sort_type, 1)

  const b = normalizeGuangYaPanAddition({
    client_id: "cid",
    page_size: "250",
    order_by: "0",
    sort_type: "2",
  })
  assert.equal(b.page_size, 250)
  assert.equal(b.order_by, 0)
  assert.equal(b.sort_type, 2)
})

// ---- F-227: 真实上传缺少 taskId 必须报错 ----
test("真实上传缺少 taskId 时抛错而不是静默成功（F-227）", async () => {
  const driver = new GuangYaPanDriver({ client_id: "cid", access_token: "at" })
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    if (String(init.method || "GET").toUpperCase() === "PUT") {
      return new Response("", { status: 200 })
    }
    if (url.includes("get_res_center_token")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "success",
          data: {
            objectPath: "a.txt",
            bucketName: "bucket",
            endPoint: "oss.example.com",
            creds: { accessKeyID: "ak", secretAccessKey: "sk" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as any
  try {
    await assert.rejects(
      () => driver.put("/a.txt", "/a.txt", Buffer.from("x")),
      /empty task id/,
    )
  } finally {
    globalThis.fetch = original
  }
})

// ---- F-228: 生成的 device_id 通过 onStateChanged 持久化 ----
test("init 回写随机生成的 device_id（F-228）", async () => {
  const persisted: Record<string, any>[] = []
  const driver = new GuangYaPanDriver(
    { client_id: "cid", access_token: "at" },
    async (changes) => {
      persisted.push(changes)
    },
  )
  await withMockFetch(
    { "GET /v1/user/me": { body: { sub: "u1" } } },
    async () => {
      await driver.init()
    },
  )
  const dev = persisted.find((p) => p.device_id)
  assert.ok(dev, "必须回写 device_id")
  assert.match(dev!.device_id, /^[0-9a-f]{32}$/)
  assert.equal(dev!.device_sign, "wdi10." + dev!.device_id)
})
