import test from "node:test"
import assert from "node:assert/strict"
import { MediatrackDriver } from "./driver"

interface Harness {
  driver: MediatrackDriver
  registerCalls: number[]
  tokenResponse: () => any
}

function makeDriver(tokenResponse: () => any): Harness {
  const driver = new MediatrackDriver({
    access_token: "mock_mediatrack_token",
    project_id: "mock_proj_123",
  })
  const registerCalls: number[] = []
  ;(driver as any).client = {
    request: async (url: string) => {
      if (url.includes("/storage/tokens/asset")) return tokenResponse()
      if (url.includes("/children")) {
        registerCalls.push(registerCalls.length + 1)
        return {}
      }
      return {}
    },
  }
  return { driver, registerCalls, tokenResponse }
}

test("MediaTrack driver instantiation", () => {
  const driver = new MediatrackDriver({
    access_token: "mock_mediatrack_token",
    project_id: "mock_proj_123",
  })
  assert.ok(driver)
})

test("F-364: object storage PUT failure aborts put() and skips asset registration", async () => {
  const { driver, registerCalls } = makeDriver(() => ({
    data: { url: "https://cos.example.com/upload/obj" },
  }))
  const originalFetch = globalThis.fetch
  let putCalls = 0
  globalThis.fetch = (async () => {
    putCalls++
    return new Response("denied", { status: 403 })
  }) as any
  try {
    await assert.rejects(
      () => driver.put("/", "/a.txt", Buffer.from("hello")),
      /HTTP 403/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(putCalls, 1)
  assert.equal(registerCalls.length, 0)
})

test("F-364: missing upload url throws instead of registering without uploading", async () => {
  const { driver, registerCalls } = makeDriver(() => ({}))
  const originalFetch = globalThis.fetch
  let putCalls = 0
  globalThis.fetch = (async () => {
    putCalls++
    return new Response("", { status: 200 })
  }) as any
  try {
    await assert.rejects(
      () => driver.put("/", "/a.txt", Buffer.from("hello")),
      /upload url missing/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(putCalls, 0)
  assert.equal(registerCalls.length, 0)
})

test("F-364: successful PUT still registers the asset exactly once", async () => {
  const { driver, registerCalls } = makeDriver(() => ({
    data: { url: "https://cos.example.com/upload/obj" },
  }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response("", { status: 200 })) as any
  try {
    await driver.put("/", "/a.txt", Buffer.from("hello"))
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(registerCalls.length, 1)
})

test("F-373: remove/move/copy 找不到源对象时抛错，不再静默成功", async () => {
  const driver = new MediatrackDriver({ access_token: "t" })
  ;(driver as any).client = {
    getFiles: async (id: string) =>
      id === "" ? [{ id: "dst", title: "dst", size: "0" }] : [],
    request: async () => ({}),
  }
  await assert.rejects(
    () => driver.remove("", "/gone.txt", ["gone.txt"]),
    /Source not found: gone.txt/,
  )
  await assert.rejects(
    () => driver.move("", "/dst", ["gone.txt"], "/gone.txt", "/dst/gone.txt"),
    /Source not found: gone.txt/,
  )
  await assert.rejects(
    () => driver.copy("", "/dst", ["gone.txt"], "/gone.txt", "/dst/gone.txt"),
    /Source not found: gone.txt/,
  )
})

test("F-366: 变更操作后整体清空 idCache，旧路径不再指向已移走目录", async () => {
  const driver = new MediatrackDriver({ access_token: "t" })
  const tree: Record<string, any[]> = {
    "": [
      { id: "a", title: "a", size: "0" },
      { id: "dst", title: "dst", size: "0" },
    ],
    a: [{ id: "b", title: "b", size: "0" }],
    b: [],
    dst: [],
  }
  ;(driver as any).client = {
    getFiles: async (id: string) => tree[id] || [],
    request: async () => ({}),
  }
  await driver.list("", "/a/b")
  assert.equal((driver as any).idCache.get("/a/b"), "b")

  await driver.move("", "/dst", ["b"], "/a/b", "/dst/b")
  assert.equal((driver as any).idCache.size, 0)
})
