import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { SeafileDriver } from "./driver"
import { SeafileApiClient } from "./util"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("F-358: 配置 repo_id 时也会对加密资料库发送解密请求", async () => {
  const driver = new SeafileDriver({
    address: "https://sf.example",
    token: "t",
    repo_id: "enc1",
    repo_pwd: "pw",
  } as any)
  const calls: Array<{ method: string; url: string }> = []
  ;(driver as any).client.request = async (pathOrUrl: string, opts: any = {}) => {
    calls.push({ method: opts.method || "GET", url: pathOrUrl })
    if (pathOrUrl === "/api2/repos/enc1/") {
      return opts.method === "POST"
        ? "success"
        : { id: "enc1", name: "enc", encrypted: true }
    }
    if (pathOrUrl.endsWith("/dir/")) return []
    throw new Error(`unexpected ${pathOrUrl}`)
  }

  await driver.list("/", "/")
  const decrypt = calls.find(
    (c) => c.method === "POST" && c.url === "/api2/repos/enc1/",
  )
  assert.ok(decrypt, "必须对加密库发起解密 POST")
})

test("F-358: 未加密资料库不会额外解密", async () => {
  const driver = new SeafileDriver({
    address: "https://sf.example",
    token: "t",
    repo_id: "r1",
    repo_pwd: "pw",
  } as any)
  const posts: string[] = []
  ;(driver as any).client.request = async (pathOrUrl: string, opts: any = {}) => {
    if (opts.method === "POST") posts.push(pathOrUrl)
    if (pathOrUrl === "/api2/repos/r1/") {
      return opts.method === "POST"
        ? "success"
        : { id: "r1", name: "r", encrypted: false }
    }
    return []
  }
  await driver.list("/", "/")
  assert.deepEqual(posts, [])
})

test("F-359: 不存在的路径抛错，而不是返回伪造的目录条目", async () => {
  const driver = new SeafileDriver({
    address: "https://sf.example",
    token: "t",
    repo_id: "r1",
  } as any)
  ;(driver as any).client.request = async (pathOrUrl: string) => {
    if (pathOrUrl === "/api2/repos/r1/") {
      return { id: "r1", name: "r", encrypted: false }
    }
    if (pathOrUrl.endsWith("/file/")) {
      throw new Error("Seafile request failed (404): not found")
    }
    if (pathOrUrl.endsWith("/dir/")) return []
    return []
  }

  await assert.rejects(
    () => driver.get("/missing.txt", "/missing.txt"),
    /not found/,
  )
})

test("F-359: 目录仍由父目录列表正确识别", async () => {
  const driver = new SeafileDriver({
    address: "https://sf.example",
    token: "t",
    repo_id: "r1",
  } as any)
  ;(driver as any).client.request = async (pathOrUrl: string) => {
    if (pathOrUrl === "/api2/repos/r1/") {
      return { id: "r1", name: "r", encrypted: false }
    }
    if (pathOrUrl.endsWith("/file/")) {
      throw new Error("Seafile request failed (404)")
    }
    return [{ id: "d1", name: "docs", type: "dir" }]
  }

  const item = await driver.get("/docs", "/docs")
  assert.equal(item.is_dir, true)
  assert.equal(item.raw_url, "")
})

test("F-363: 401 重试会用 username/password 强制重新认证", async () => {
  const addition = {
    address: "https://sf.example",
    token: "dead-token",
    username: "u",
    password: "p",
  } as any
  const client = new SeafileApiClient(addition)
  ;(client as any).authorization = "Token dead-token"
  const auth: string[] = []
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input)
    if (url.includes("/api2/auth-token/")) {
      return jsonResponse({ token: "fresh-token" })
    }
    auth.push(init?.headers?.Authorization || "")
    return auth.length === 1
      ? jsonResponse({ detail: "expired" }, 401)
      : jsonResponse({ ok: true })
  }) as typeof fetch

  const data = await client.request("/api2/repos/")
  assert.deepEqual(data, { ok: true })
  assert.deepEqual(auth, ["Token dead-token", "Token fresh-token"])
})

test("F-363: 仅有静态 token 时不再重放同一个死 token", async () => {
  const client = new SeafileApiClient({
    address: "https://sf.example",
    token: "dead-token",
  } as any)
  let hits = 0
  globalThis.fetch = (async () => {
    hits++
    return jsonResponse({ detail: "expired" }, 401)
  }) as typeof fetch

  await assert.rejects(() => client.request("/api2/repos/"), /401/)
  assert.equal(hits, 1, "无可用凭据时不应再发一次注定 401 的重试")
})
