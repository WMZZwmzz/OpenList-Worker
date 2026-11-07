import assert from "node:assert/strict"
import { test } from "node:test"
import { createHmac } from "node:crypto"

import { sessionKeySignatureOfHmac, appKeySignatureOfHmac } from "./util"

function hmacSha1Upper(data: string, key: string): string {
  return createHmac("sha1", key)
    .update(data, "utf8")
    .digest("hex")
    .toUpperCase()
}

test("189TV SessionKey signature matches Go HMAC-SHA1", () => {
  const url = "https://api.cloud.189.cn/family/file/listFiles.action"
  const date = "Mon, 05 Sep 2026 10:30:00 GMT"
  const actual = sessionKeySignatureOfHmac(
    "secret123",
    "key456",
    "GET",
    url,
    date,
  )
  const path = "/family/file/listFiles.action"
  const data = `SessionKey=key456&Operate=GET&RequestURI=${path}&Date=${date}`
  const expected = hmacSha1Upper(data, "secret123")
  assert.equal(actual, expected)
})

test("189TV AppKey signature matches Go HMAC-SHA1", () => {
  const url = "https://api.cloud.189.cn/family/manage/loginFamilyMerge.action"
  const ts = 1725510600000
  const actual = appKeySignatureOfHmac(
    "fe5734c74c2f96a38157f420b32dc995",
    "600100885",
    "GET",
    url,
    ts,
  )
  const path = "/family/manage/loginFamilyMerge.action"
  const data = `AppKey=600100885&Operate=GET&RequestURI=${path}&Timestamp=${ts}`
  const expected = hmacSha1Upper(data, "fe5734c74c2f96a38157f420b32dc995")
  assert.equal(actual, expected)
})

test("189TV rapid upload commits the session when the file already exists", async () => {
  const { Client189TV } = await import("./util")
  const client = new Client189TV({ access_token: "t", type: "personal" })
  ;(client as any).tokenInfo = {
    sessionKey: "session-key",
    sessionSecret: "session-secret",
  }

  const commitBodies: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith("https://api.cloud.189.cn/createUploadFile.action")) {
      return new Response(
        JSON.stringify({
          uploadFileId: 123,
          fileDataExists: 1,
          fileCommitUrl: "https://api.cloud.189.cn/commitUploadFile.action",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (url.startsWith("https://api.cloud.189.cn/commitUploadFile.action")) {
      commitBodies.push(String(init?.body || ""))
      return new Response(JSON.stringify({ res_code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  try {
    const reused = await client.rapidUploadCreate(
      "-11",
      "a.bin",
      5,
      "0123456789abcdef0123456789abcdef",
      false,
    )
    assert.equal(reused, true)
    assert.equal(commitBodies.length, 1)
    const form = new URLSearchParams(commitBodies[0])
    assert.equal(form.get("uploadFileId"), "123")
    assert.equal(form.get("opertype"), "3")
    assert.equal(form.get("resumePolicy"), "1")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("189TV rapid upload does not commit when the file is unknown", async () => {
  const { Client189TV } = await import("./util")
  const client = new Client189TV({ access_token: "t", type: "personal" })
  ;(client as any).tokenInfo = {
    sessionKey: "session-key",
    sessionSecret: "session-secret",
  }

  let commits = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.startsWith("https://api.cloud.189.cn/createUploadFile.action")) {
      return new Response(
        JSON.stringify({
          uploadFileId: 123,
          fileDataExists: 0,
          fileCommitUrl: "https://api.cloud.189.cn/commitUploadFile.action",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (url.startsWith("https://api.cloud.189.cn/commitUploadFile.action")) {
      commits++
      return new Response(JSON.stringify({ res_code: 0 }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  try {
    const reused = await client.rapidUploadCreate(
      "-11",
      "a.bin",
      5,
      "0123456789abcdef0123456789abcdef",
      false,
    )
    assert.equal(reused, false)
    assert.equal(commits, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("189TV family commit sends ResumePolicy/UploadFileId/FamilyId as headers", async () => {
  const { Client189TV } = await import("./util")
  const client = new Client189TV({
    access_token: "t",
    type: "family",
    family_id: "fam-1",
  })
  ;(client as any).tokenInfo = {
    familySessionKey: "session-key",
    familySessionSecret: "session-secret",
  }

  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers || {}) as Record<string, string>
    seen.push({ url, headers, body: String(init?.body || "") })
    if (url.includes("/family/file/createFamilyFile.action")) {
      return new Response(
        JSON.stringify({
          uploadFileId: 42,
          fileUploadUrl: "https://upload.example.com/put",
          fileCommitUrl: "https://api.cloud.189.cn/family/file/commit.action",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (url === "https://upload.example.com/put") {
      return new Response(null, { status: 200 })
    }
    return new Response(JSON.stringify({ res_code: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  try {
    await client.upload("pid-1", "a.bin", new Uint8Array([1, 2, 3]), true)
    const commit = seen.find((s) => s.url.includes("/family/file/commit.action"))!
    assert.ok(commit, "family commit must be requested")
    assert.equal(commit.headers.ResumePolicy, "1")
    assert.equal(commit.headers.UploadFileId, "42")
    assert.equal(commit.headers.FamilyId, "fam-1")
    assert.ok(
      !commit.url.includes("ResumePolicy="),
      "commit fields must not be sent as query parameters",
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("189TV preserves int64 uploadFileId precision", async () => {
  const { Client189TV } = await import("./util")
  const client = new Client189TV({ access_token: "t", type: "personal" })
  ;(client as any).tokenInfo = {
    sessionKey: "session-key",
    sessionSecret: "session-secret",
  }

  const commitForms: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/createUploadFile.action")) {
      // 20 位 int64：JSON.parse 会静默丢失低位精度
      return new Response(
        '{"uploadFileId":1234567890123456789,"fileDataExists":1,' +
          '"fileCommitUrl":"https://api.cloud.189.cn/commitUploadFile.action"}',
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    commitForms.push(String(init?.body || ""))
    return new Response(JSON.stringify({ res_code: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  try {
    const reused = await client.rapidUploadCreate(
      "-11",
      "a.bin",
      5,
      "0123456789abcdef0123456789abcdef",
      false,
    )
    assert.equal(reused, true)
    const form = new URLSearchParams(commitForms[0])
    assert.equal(form.get("uploadFileId"), "1234567890123456789")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("189TV upload streams the given bytes without re-copying the body", async () => {
  const { Client189TV } = await import("./util")
  const client = new Client189TV({ access_token: "t", type: "personal" })
  ;(client as any).tokenInfo = {
    sessionKey: "session-key",
    sessionSecret: "session-secret",
  }

  let putBody: unknown
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/createUploadFile.action")) {
      return new Response(
        JSON.stringify({
          uploadFileId: 7,
          fileUploadUrl: "https://upload.example.com/put",
          fileCommitUrl: "https://api.cloud.189.cn/commitUploadFile.action",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (url === "https://upload.example.com/put") {
      putBody = init?.body
      return new Response(null, { status: 200 })
    }
    return new Response(JSON.stringify({ res_code: 0 }), { status: 200 })
  }) as typeof fetch

  try {
    const buf = new Uint8Array([1, 2, 3, 4])
    await client.upload("-11", "a.bin", buf, false)
    assert.equal(putBody, buf, "PUT body must reference the original bytes")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("189TV cancels the download probe and upload-response bodies", async () => {
  const { Client189TV } = await import("./util")
  const client = new Client189TV({ access_token: "t", type: "personal" })
  ;(client as any).tokenInfo = {
    sessionKey: "session-key",
    sessionSecret: "session-secret",
  }

  let probeCanceled = false
  let putCanceled = false
  const streamingBody = (onCancel: () => void) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("payload"))
        },
        cancel() {
          onCancel()
        },
      }),
      { status: 200 },
    )

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes("/getFileDownloadUrl.action")) {
      return new Response(
        JSON.stringify({ fileDownloadUrl: "https://cdn.example.com/f" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (url === "https://cdn.example.com/f") {
      // redirect:"manual" 下 CDN 直接 200 → 响应体是完整文件流
      return streamingBody(() => {
        probeCanceled = true
      })
    }
    if (url.includes("/createUploadFile.action")) {
      return new Response(
        JSON.stringify({
          uploadFileId: 7,
          fileUploadUrl: "https://upload.example.com/put",
          fileCommitUrl: "https://api.cloud.189.cn/commitUploadFile.action",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (url === "https://upload.example.com/put") {
      return streamingBody(() => {
        putCanceled = true
      })
    }
    return new Response(JSON.stringify({ res_code: 0 }), { status: 200 })
  }) as typeof fetch

  try {
    const direct = await client.getFileDownloadUrl("f-1", false)
    assert.equal(direct, "https://cdn.example.com/f")
    assert.equal(probeCanceled, true, "probe body must be cancelled")

    await client.upload("-11", "a.bin", new Uint8Array([1, 2, 3]), false)
    assert.equal(putCanceled, true, "upload PUT body must be cancelled")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("189TV batch tasks that outlive the polling window are reported as accepted", async () => {
  const { Client189TV } = await import("./util")
  const client = new Client189TV({ access_token: "t", type: "personal" })
  ;(client as any).tokenInfo = {
    sessionKey: "session-key",
    sessionSecret: "session-secret",
  }

  // 用假时钟：sleep 立即返回并推进时间，避免真的等 30 秒
  const realNow = Date.now
  const realSetTimeout = globalThis.setTimeout
  const realWarn = console.warn
  let clock = realNow()
  let polls = 0
  const warnings: string[] = []
  Date.now = () => clock
  ;(globalThis as any).setTimeout = (fn: (...a: any[]) => void, ms?: number) => {
    clock += Number(ms) || 0
    fn()
    return 0
  }
  console.warn = (...args: any[]) => {
    warnings.push(args.map(String).join(" "))
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes("/batch/createBatchTask.action")) {
      return new Response(JSON.stringify({ taskId: "task-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("/batch/checkBatchTask.action")) {
      polls++
      // 服务端任务一直在跑（大目录），永远到不了 4
      return new Response(JSON.stringify({ taskStatus: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  try {
    // 不能抛「批量任务超时」：任务仍在服务端执行，报失败会让上层重试
    // （COPY 重试会产生重复副本）
    await client.move("f-1", false, "a.txt", "-11", false)
    assert.ok(polls >= 2, "must keep polling instead of giving up after 20 rounds")
    assert.ok(
      warnings.some((w) => w.includes("仍在后台执行")),
      "must warn that the task is still running",
    )
  } finally {
    globalThis.fetch = originalFetch
    Date.now = realNow
    ;(globalThis as any).setTimeout = realSetTimeout
    console.warn = realWarn
  }
})
