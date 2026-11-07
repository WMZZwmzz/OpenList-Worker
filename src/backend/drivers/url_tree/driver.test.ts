import test from "node:test"
import assert from "node:assert/strict"
import { UrlTreeDriver } from "./driver"
import { UrlTreeAddition } from "./types"

function makeDriver(structure: string) {
  let persisted = ""
  const addition: UrlTreeAddition = {
    url_structure: structure,
    writable: true,
  }
  const driver = new UrlTreeDriver(addition, (text) => {
    persisted = text
  })
  return {
    driver,
    addition,
    getPersisted: () => persisted,
    reload: () => new UrlTreeDriver({ ...addition, url_structure: persisted }),
  }
}

test("F-432: move recursively updates descendant levels so persisted tree survives reload", async () => {
  const initial = [
    "Top:",
    "  Sub:",
    "    deep.txt:100:1700000000:https://a.com/d.txt",
    "L1:",
    "  L2:",
  ].join("\n")
  const ctx = makeDriver(initial)

  await ctx.driver.move("/", "/", ["Sub"], "/Top/Sub", "/L1/L2/Sub")

  const persisted = ctx.getPersisted()
  // Sub must be indented at level 2 (4 spaces), deep.txt at level 3 (6 spaces)
  assert.match(persisted, /^ {4}Sub:$/m)
  assert.match(persisted, /^ {6}deep\.txt:100:1700000000:https:\/\/a\.com\/d\.txt$/m)

  const reloaded = ctx.reload()
  const subItems = await reloaded.list("/", "/L1/L2/Sub")
  assert.deepEqual(
    subItems.map((i) => i.name),
    ["deep.txt"],
  )
  const deep = await reloaded.get("/", "/L1/L2/Sub/deep.txt")
  assert.equal(deep.raw_url, "https://a.com/d.txt")
  const parentItems = await reloaded.list("/", "/L1/L2")
  assert.deepEqual(
    parentItems.map((i) => i.name),
    ["Sub"],
  )
})

test("F-433: put over an existing file replaces it in place instead of appending a duplicate", async () => {
  const ctx = makeDriver("f.txt:1:1700000000:https://a.com/old.txt")

  await ctx.driver.put("/", "/f.txt", Buffer.from("https://a.com/new.txt"))

  const items = await ctx.driver.list("/", "/")
  assert.equal(items.length, 1)
  assert.equal(items[0].name, "f.txt")
  assert.equal(items[0].raw_url, "https://a.com/new.txt")

  const got = await ctx.driver.get("/", "/f.txt")
  assert.equal(got.raw_url, "https://a.com/new.txt")

  const persisted = ctx.getPersisted()
  assert.equal(persisted.split("\n").filter((l) => l.includes("f.txt")).length, 1)
  assert.match(persisted, /f\.txt:https:\/\/a\.com\/new\.txt/)

  const reloaded = ctx.reload()
  assert.equal((await reloaded.get("/", "/f.txt")).raw_url, "https://a.com/new.txt")
})

test("F-433: put refuses to overwrite a directory instead of corrupting the tree", async () => {
  const ctx = makeDriver("dir:\n  a.txt:1:1700000000:https://a.com/a.txt")
  await assert.rejects(
    ctx.driver.put("/", "/dir", Buffer.from("https://a.com/x.txt")),
    /cannot overwrite directory/i,
  )
  const items = await ctx.driver.list("/", "/dir")
  assert.equal(items.length, 1)
})

test("F-441: https URL whose query contains http:// parses from the earlier https index", async () => {
  const url = "https://example.com/redir?to=http://other.com/file.zip"
  const ctx = makeDriver(url)
  const items = await ctx.driver.list("/", "/")
  assert.equal(items.length, 1)
  assert.equal(items[0].raw_url, url)

  const withInfo = makeDriver(
    "video.zip:1024:1700000000:https://example.com/d?u=http://x/y",
  )
  const item = await withInfo.driver.get("/", "/video.zip")
  assert.equal(item.size, 1024)
  assert.equal(item.raw_url, "https://example.com/d?u=http://x/y")
})

test("F-443: head_size 不跟随到不安全主机的重定向", async () => {
  const addition: UrlTreeAddition = {
    url_structure: "",
    writable: true,
    head_size: true,
  }
  const driver = new UrlTreeDriver(addition, () => {})
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith("https://example.com/")) {
      return new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1/victim" },
      })
    }
    return new Response(null, { status: 200, headers: { "Content-Length": "1234" } })
  }) as any
  try {
    await driver.put("/", "/f.zip", Buffer.from("https://example.com/f.zip"))
  } finally {
    globalThis.fetch = original
  }
  assert.deepEqual(calls, ["https://example.com/f.zip"])
  const item = await driver.get("/", "/f.zip")
  assert.equal(item.size, 0)
})
