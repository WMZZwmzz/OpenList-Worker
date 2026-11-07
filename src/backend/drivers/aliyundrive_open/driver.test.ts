import test from "node:test"
import assert from "node:assert/strict"
import { AliyundriveOpen } from "./driver"
import { AliyunOpenClient } from "./util"

/**
 * aliyundrive_open 回归测试：F-342（use_online_api 门控）、F-343（无 upload_url
 * 必须报错）、F-345（并发刷新去重 + 回写回调）、F-347（路径缓存失效）、
 * F-350（仅根目录换盘重试）、F-351（秒传未命中清理孤儿条目）、
 * F-352（错误消息不得包含完整响应 JSON）。
 */

function installFetch(handler: (url: string, init: any) => Response) {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input)
    calls.push(url)
    return handler(url, init)
  }) as any
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })

test("use_online_api=false 时不把 refresh_token 发给第三方中转（F-342）", async () => {
  const mock = installFetch((url) => {
    if (url.startsWith("https://openapi.aliyundrive.com/oauth/access_token")) {
      return json({ access_token: "at1", refresh_token: "rt2", expires_in: 7200 })
    }
    return json({ error: "unexpected" }, 500)
  })
  try {
    let persisted = ""
    const client = new AliyunOpenClient(
      {
        refresh_token: "rt1",
        drive_type: "resource",
        use_online_api: false,
        client_id: "cid",
        client_secret: "secret",
      },
      (rt) => {
        persisted = rt
      },
    )
    await client.refreshAccessToken()
    assert.ok(mock.calls.length === 1, `calls=${mock.calls.join(",")}`)
    assert.ok(mock.calls[0].includes("openapi.aliyundrive.com"))
    assert.ok(!mock.calls.some((u) => u.includes("oplist.org")))
    assert.ok(!mock.calls.some((u) => u.includes("alist.nn.ci")))
    assert.equal(persisted, "rt2")
  } finally {
    mock.restore()
  }
})

test("配置自建应用凭据（use_online_api 未设置）时默认直连（F-342）", async () => {
  const mock = installFetch((url) => {
    if (url.startsWith("https://openapi.aliyundrive.com/oauth/access_token")) {
      return json({ access_token: "at1", expires_in: 7200 })
    }
    return json({ error: "unexpected" }, 500)
  })
  try {
    const client = new AliyunOpenClient({
      refresh_token: "rt1",
      drive_type: "resource",
      client_id: "my-app",
      client_secret: "my-secret",
    })
    await client.refreshAccessToken()
    assert.equal(mock.calls.length, 1)
    assert.ok(!mock.calls.some((u) => /oplist\.org|alist\.nn\.ci/.test(u)))
  } finally {
    mock.restore()
  }
})

test("并发刷新只发一次请求（F-345）", async () => {
  const mock = installFetch(
    () =>
      new Response(
        JSON.stringify({ access_token: "at1", expires_in: 7200 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  )
  try {
    const client = new AliyunOpenClient({
      refresh_token: "rt1",
        drive_type: "resource",
      use_online_api: false,
      client_secret: "secret",
    })
    await Promise.all([
      client.refreshAccessToken(),
      client.refreshAccessToken(),
      client.refreshAccessToken(),
    ])
    assert.equal(mock.calls.length, 1)
  } finally {
    mock.restore()
  }
})

test("putFile 在缺少 upload_url 时必须抛错（F-343）", async () => {
  const client = new AliyunOpenClient({
    refresh_token: "rt1",
        drive_type: "resource",
    use_online_api: false,
  })
  ;(client as any).accessToken = "at"
  ;(client as any).tokenExpiresAt = Date.now() + 3600_000
  const mock = installFetch(() => json({ file_id: "f1" }))
  try {
    await assert.rejects(
      () => client.putFile("parent", "a.txt", Buffer.from("x")),
      /no upload_url/,
    )
  } finally {
    mock.restore()
  }
})

test("在线中转错误消息不包含完整响应 JSON（F-352）", async () => {
  const mock = installFetch(() =>
    json({ refresh_token: "SECRET-ROTATED-TOKEN", data: {} }),
  )
  const warns: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: any[]) => {
    warns.push(args.map(String).join(" "))
  }
  try {
    const client = new AliyunOpenClient({
      refresh_token: "rt1",
        drive_type: "resource",
      use_online_api: true,
      client_secret: "secret",
    })
    await assert.rejects(() => client.refreshAccessToken(), /All token refresh/)
  } finally {
    console.warn = originalWarn
    mock.restore()
  }
  assert.ok(!warns.join("\n").includes("SECRET-ROTATED-TOKEN"))
})

test("listFiles 非根目录不做换盘重试（F-350）", async () => {
  const client = new AliyunOpenClient(
    { refresh_token: "rt1",
        drive_type: "resource", use_online_api: false, drive_id: "drive-old" },
    undefined,
  )
  ;(client as any).accessToken = "at"
  ;(client as any).tokenExpiresAt = Date.now() + 3600_000
  const mock = installFetch(
    () => new Response("UserNotAllowedAccessDrive", { status: 403 }),
  )
  try {
    await assert.rejects(
      () => client.listFiles("folder-x"),
      /UserNotAllowedAccessDrive/,
    )
    assert.equal(mock.calls.length, 1, "非根目录不应触发换盘请求")
  } finally {
    mock.restore()
  }
})

test("listFiles 根目录仍可换盘重试（F-350）", async () => {
  const client = new AliyunOpenClient(
    { refresh_token: "rt1",
        drive_type: "resource", use_online_api: false, drive_id: "drive-old" },
    undefined,
  )
  ;(client as any).accessToken = "at"
  ;(client as any).tokenExpiresAt = Date.now() + 3600_000
  let listCalls = 0
  const mock = installFetch((url, init) => {
    const path = new URL(url).pathname
    if (path.endsWith("/user/getDriveInfo")) {
      return json({ resource_drive_id: "drive-new" })
    }
    if (path.endsWith("/openFile/list")) {
      listCalls++
      if (listCalls === 1) {
        return new Response("UserNotAllowedAccessDrive", { status: 403 })
      }
      const body = JSON.parse(init.body)
      assert.equal(body.drive_id, "drive-new")
      return json({ items: [{ file_id: "x", name: "x", type: "file" }] })
    }
    return json({}, 500)
  })
  try {
    const items = await client.listFiles("root")
    assert.equal(items.length, 1)
    assert.equal(listCalls, 2)
  } finally {
    mock.restore()
  }
})

test("变更操作后清空 pathFileIdCache（F-347）", async () => {
  const driver = new AliyundriveOpen({ refresh_token: "rt1", drive_type: "resource" })
  const cache = (driver as any).pathFileIdCache as Map<string, string>
  cache.set("a/b", "stale-id")
  const removed: string[] = []
  ;(driver as any).client.remove = async (fileId: string) => {
    removed.push(fileId)
  }
  await driver.remove("/a/b", "/a/b", [])
  assert.deepEqual(removed, ["stale-id"])
  assert.equal(cache.size, 0, "变更成功后缓存必须失效")
})

test("秒传未命中时删除 create 产生的未完成条目（F-351）", async () => {
  const driver = new AliyundriveOpen({ refresh_token: "rt1", drive_type: "resource" })
  ;(driver as any).resolveFileId = async () => "parent"
  ;(driver as any).client.accessToken = "at"
  ;(driver as any).client.tokenExpiresAt = Date.now() + 3600_000
  const calls: { path: string; body: any }[] = []
  ;(driver as any).client.openApiRequest = async (path: string, body: any) => {
    calls.push({ path, body })
    if (path.endsWith("/openFile/create")) {
      return { rapid_upload: false, file_id: "orphan-1" }
    }
    return {}
  }
  const ok = await driver.rapidUpload("/", "/big.bin", {
    size: 200 * 1024,
    sha1: "a".repeat(40),
    readRange: async () => new Uint8Array(8),
  })
  assert.equal(ok, false)
  const del = calls.find((c) => c.path.endsWith("/openFile/delete"))
  assert.ok(del, "必须清理未完成条目")
  assert.equal(del!.body.file_id, "orphan-1")
})
