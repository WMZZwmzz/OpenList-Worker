import test from "node:test"
import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import {
  calcGcid,
  generateDeviceSign,
  getAction,
  buildCustomUserAgent,
} from "./util"
import { PikPakDriver } from "./driver"

function sha1Hex(data: Uint8Array | string): string {
  return createHash("sha1").update(data).digest("hex")
}

test("calcGcid is a chunked double SHA-1 (F-254)", async () => {
  const small = new TextEncoder().encode("hello pikpak")
  const expectedSmall = sha1Hex(
    Buffer.from(sha1Hex(small), "hex"),
  ).toUpperCase()
  assert.equal(await calcGcid(small), expectedSmall)

  // 700KB → 256KB blocks (3 chunks), outer SHA-1 over concatenated digests
  const data = new Uint8Array(700 * 1024)
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff
  const inner: Buffer[] = []
  for (let offset = 0; offset < data.length; offset += 0x40000) {
    const chunk = data.subarray(offset, Math.min(offset + 0x40000, data.length))
    inner.push(Buffer.from(sha1Hex(chunk), "hex"))
  }
  const expected = sha1Hex(Buffer.concat(inner)).toUpperCase()
  assert.equal(await calcGcid(data), expected)
  assert.notEqual(await calcGcid(data), sha1Hex(data).toUpperCase())
})

test("PikPak signature and user agent generation", async () => {
  const deviceId = "testdevice1234567890123456789012"
  const sign = await generateDeviceSign(deviceId, "mypikpak.com")
  assert.ok(sign.startsWith("div101.testdevice1234567890123456789012"))

  const ua = await buildCustomUserAgent(
    deviceId,
    "YNxT9w7GMdWvEOKa",
    "com.pikcloud.pikpak",
    "2.0.6",
    "1.53.2",
    "com.pikcloud.pikpak",
    "user123",
  )
  assert.ok(ua.includes("ANDROID-com.pikcloud.pikpak/1.53.2"))
  assert.ok(ua.includes("clientid/YNxT9w7GMdWvEOKa"))
})

test("PikPak getAction utility", () => {
  const action = getAction(
    "GET",
    "https://api-drive.mypikpak.net/drive/v1/files",
  )
  assert.equal(action, "GET:/drive/v1/files")

  const actionPost = getAction(
    "POST",
    "https://user.mypikpak.net/v1/auth/signin",
  )
  assert.equal(actionPost, "POST:/v1/auth/signin")
})

test("PikPak driver instantiation", () => {
  const driver = new PikPakDriver({
    username: "user@example.com",
    password: "password123",
    platform: "web",
  })
  assert.ok(driver)
})

function createDriverWithRequests(responses: unknown[]) {
  const driver = new PikPakDriver({
    username: "user@example.com",
    password: "password123",
    platform: "web",
  })
  const calls: { url: string; params?: Record<string, string> }[] = []
  ;(driver as any).resolveParentId = async () => "file-id-1"
  ;(driver as any).client = {
    request: async (url: string, options: any) => {
      calls.push({ url, params: options?.params })
      return responses[calls.length - 1]
    },
  }
  return { driver, calls }
}

test("put() signs the OSS PUT with AK/SK Authorization (F-253)", async () => {
  const driver = new PikPakDriver({
    username: "user@example.com",
    password: "password123",
    platform: "web",
  })
  const anyDriver = driver as any
  anyDriver.resolveParentId = async () => "parent-id"

  const resumable = {
    resumable: {
      params: {
        endpoint: "oss-cn-hangzhou.aliyuncs.com",
        bucket: "pikpak-bucket",
        key: "obj/key.bin",
        access_key_id: "AKID",
        access_key_secret: "SECRET",
        security_token: "STS-TOKEN",
      },
    },
  }
  let taskBody: any = null
  anyDriver.client.request = async (_url: string, init: any) => {
    taskBody = init.body
    return resumable
  }

  const captured: { url: string; headers: Record<string, string> }[] = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    captured.push({ url: String(url), headers: init.headers })
    return new Response("", { status: 200 })
  }) as any
  try {
    const content = Buffer.from("signed oss upload")
    await driver.put("", "/files/a.bin", content)

    assert.equal(captured.length, 1)
    assert.equal(
      captured[0].url,
      "https://pikpak-bucket.oss-cn-hangzhou.aliyuncs.com/obj/key.bin",
    )
    const headers = captured[0].headers
    assert.equal(headers["x-oss-security-token"], "STS-TOKEN")
    assert.ok(headers.Authorization, "Authorization header is required")
    assert.ok(headers.Date)

    const stringToSign =
      `PUT\n\napplication/octet-stream\n${headers.Date}\n` +
      `x-oss-security-token:STS-TOKEN\n` +
      `/pikpak-bucket/obj/key.bin`
    const expectedSig = createHmac("sha1", "SECRET")
      .update(stringToSign)
      .digest("base64")
    assert.equal(headers.Authorization, `OSS AKID:${expectedSig}`)
    assert.equal(taskBody.hash, await calcGcid(new Uint8Array(content)))
  } finally {
    globalThis.fetch = origFetch
  }
})

test("put() fails closed when OSS credentials are missing", async () => {
  const driver = new PikPakDriver({
    username: "user@example.com",
    password: "password123",
    platform: "web",
  })
  const anyDriver = driver as any
  anyDriver.resolveParentId = async () => "parent-id"
  anyDriver.client.request = async () => ({
    resumable: {
      params: {
        endpoint: "oss-cn-hangzhou.aliyuncs.com",
        bucket: "b",
        key: "k",
        security_token: "t",
      },
    },
  })
  await assert.rejects(
    () => driver.put("", "/a.bin", Buffer.from("x")),
    /access_key_id/,
  )
})

test("rapidUpload requires a real GCID instead of a bare SHA-1 (F-254)", async () => {
  const driver = new PikPakDriver({
    username: "user@example.com",
    password: "password123",
    platform: "web",
  })
  const anyDriver = driver as any
  let calls = 0
  const bodies: any[] = []
  anyDriver.resolveParentId = async () => "parent-id"
  anyDriver.client.request = async (_url: string, init: any) => {
    calls++
    bodies.push(init.body)
    return {}
  }

  const size = 1234
  // 只有普通 SHA-1 时必须拒绝秒传（不能把裸 SHA-1 当 GCID 上报）
  assert.equal(
    await driver.rapidUpload("", "/a.bin", {
      size,
      sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    }),
    false,
  )
  assert.equal(calls, 0)

  const gcid = "0123456789ABCDEF0123456789ABCDEF01234567"
  assert.equal(
    await driver.rapidUpload("", "/a.bin", {
      size,
      hashes: { gcid },
    }),
    true,
  )
  assert.equal(calls, 1)
  assert.equal(bodies[0].hash, gcid)
})

test("并发 refreshToken 共享同一次刷新（singleflight）(F-255)", async () => {
  const { PikPakApiClient } = await import("./util")
  const client = new PikPakApiClient({
    username: "user@example.com",
    password: "password123",
    platform: "web",
    refresh_token: "old-refresh",
    client_id: "cid",
    client_secret: "secret",
  })
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    // 延迟返回，确保两个调用真正并发
    await new Promise((r) => setTimeout(r, 20))
    return new Response(
      JSON.stringify({
        access_token: "new-access-token",
        refresh_token: "new-refresh",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as any
  try {
    await Promise.all([client.refreshToken(), client.refreshToken()])
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = original
  }
})

test("并发 refreshCaptchaToken 共享同一次请求 (F-255)", async () => {
  const { PikPakApiClient } = await import("./util")
  const client = new PikPakApiClient({
    platform: "web",
    client_id: "cid",
    client_secret: "secret",
    device_id: "device-id",
  } as any)
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    await new Promise((r) => setTimeout(r, 20))
    return new Response(JSON.stringify({ captcha_token: "ct" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as any
  try {
    const [a, b] = await Promise.all([
      client.refreshCaptchaToken("GET:/x", { a: "1" }),
      client.refreshCaptchaToken("GET:/x", { a: "1" }),
    ])
    assert.equal(a, "ct")
    assert.equal(b, "ct")
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = original
  }
})

test("非 JSON 的 token 刷新响应报出 HTTP 状态而不是 SyntaxError (F-259)", async () => {
  const { PikPakApiClient } = await import("./util")
  const client = new PikPakApiClient({
    username: "user@example.com",
    password: "password123",
    platform: "web",
    refresh_token: "old-refresh",
    client_id: "cid",
    client_secret: "secret",
  })
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response("<html>bad gateway</html>", { status: 502 })) as any
  try {
    await assert.rejects(
      () => client.refreshToken(),
      /HTTP 502/,
    )
  } finally {
    globalThis.fetch = original
  }
})

test("remove/move/copy 找不到目标项时报错而不是静默成功 (F-256)", async () => {
  const driver = new PikPakDriver({
    username: "user@example.com",
    password: "password123",
    platform: "web",
  })
  const anyDriver = driver as any
  anyDriver.resolveParentId = async () => "parent-id"
  anyDriver.getFiles = async () => []
  anyDriver.client.request = async () => ({})

  await assert.rejects(
    () => driver.remove("", "docs/a.txt", ["a.txt"]),
    /not found/,
  )
  await assert.rejects(
    () => driver.move("", "", ["a.txt"], "docs/a.txt", "dst/a.txt"),
    /not found/,
  )
  await assert.rejects(
    () => driver.copy("", "", ["a.txt"], "docs/a.txt", "dst/a.txt"),
    /not found/,
  )
})

test("rename/move 迁移子路径的 idCache 键 (F-258)", async () => {
  const driver = new PikPakDriver({
    username: "user@example.com",
    password: "password123",
    platform: "web",
  })
  const anyDriver = driver as any
  anyDriver.resolveParentId = async (p: string) =>
    p === "" ? "root" : p === "src" ? "src-id" : "dst-id"
  anyDriver.client.request = async () => ({})

  anyDriver.idCache.set("/docs", "docs-id")
  anyDriver.idCache.set("/docs/child", "child-id")
  await driver.rename("", "docs", "renamed")
  assert.equal(anyDriver.idCache.has("/docs"), false)
  assert.equal(anyDriver.idCache.get("/renamed"), "docs-id")
  assert.equal(anyDriver.idCache.get("/renamed/child"), "child-id")

  anyDriver.idCache.set("/src", "src-id")
  anyDriver.idCache.set("/src/child", "child-id")
  anyDriver.getFiles = async () => [{ id: "src-id", name: "src" }]
  await driver.move("", "", ["src"], "src", "dst/src")
  assert.equal(anyDriver.idCache.has("/src"), false)
  assert.equal(anyDriver.idCache.get("/dst/src"), "src-id")
  assert.equal(anyDriver.idCache.get("/dst/src/child"), "child-id")
})

test("remove 清理目标及其全部子路径的 idCache 键 (F-258)", async () => {
  const driver = new PikPakDriver({
    username: "user@example.com",
    password: "password123",
    platform: "web",
  })
  const anyDriver = driver as any
  anyDriver.resolveParentId = async () => "parent-id"
  anyDriver.getFiles = async () => [{ id: "docs-id", name: "docs" }]
  anyDriver.client.request = async () => ({})
  anyDriver.idCache.set("/docs", "docs-id")
  anyDriver.idCache.set("/docs/child", "child-id")
  anyDriver.idCache.set("/docs/child/deep", "deep-id")
  anyDriver.idCache.set("/other", "other-id")

  await driver.remove("", "docs", ["docs"])

  assert.equal(anyDriver.idCache.has("/docs"), false)
  assert.equal(anyDriver.idCache.has("/docs/child"), false)
  assert.equal(anyDriver.idCache.has("/docs/child/deep"), false)
  // 其它路径的缓存不受影响
  assert.equal(anyDriver.idCache.get("/other"), "other-id")
})

test("OSS 上传 URL 对 key 逐段编码但签名仍用原始 key (F-257)", async () => {
  const { createHmac } = await import("node:crypto")
  const driver = new PikPakDriver({
    username: "user@example.com",
    password: "password123",
    platform: "web",
  })
  const anyDriver = driver as any
  anyDriver.resolveParentId = async () => "parent-id"
  anyDriver.client.request = async () => ({
    resumable: {
      params: {
        endpoint: "oss-cn-hangzhou.aliyuncs.com",
        bucket: "bkt",
        key: "obj/a#b?.bin",
        access_key_id: "AKID",
        access_key_secret: "SECRET",
      },
    },
  })
  const captured: { url: string; headers: Record<string, string> }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    captured.push({ url: String(url), headers: init.headers })
    return new Response("", { status: 200 })
  }) as any
  try {
    await driver.put("", "/a.bin", Buffer.from("x"))
    assert.equal(captured.length, 1)
    assert.match(captured[0].url, /obj\/a%23b%3F\.bin$/)
    const headers = captured[0].headers
    const stringToSign =
      `PUT\n\napplication/octet-stream\n${headers.Date}\n` +
      `/bkt/obj/a#b?.bin`
    const expected = createHmac("sha1", "SECRET")
      .update(stringToSign)
      .digest("base64")
    assert.equal(headers.Authorization, `OSS AKID:${expected}`)
  } finally {
    globalThis.fetch = original
  }
})

test("PikPak get falls back to usage=FETCH when CACHE returns no link", async () => {
  const { driver, calls } = createDriverWithRequests([
    { id: "file-id-1", kind: "drive#file", name: "readme.txt", size: "12" },
    {
      id: "file-id-1",
      kind: "drive#file",
      name: "readme.txt",
      size: "12",
      web_content_link: "https://dl.example.com/readme.txt",
    },
  ])

  const item = await driver.get("/readme.txt", "/readme.txt")
  assert.equal(item.raw_url, "https://dl.example.com/readme.txt")
  assert.equal(calls.length, 2)
  assert.equal(calls[0].params?.usage, "CACHE")
  assert.equal(calls[1].params?.usage, "FETCH")
})

test("PikPak get keeps a single CACHE request when medias is present", async () => {
  const { driver, calls } = createDriverWithRequests([
    {
      id: "file-id-1",
      kind: "drive#file",
      name: "movie.mp4",
      size: "1024",
      medias: [{ link: { url: "https://media.example.com/movie.mp4" } }],
    },
  ])

  const item = await driver.get("/movie.mp4", "/movie.mp4")
  assert.equal(item.raw_url, "https://media.example.com/movie.mp4")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params?.usage, "CACHE")
})
