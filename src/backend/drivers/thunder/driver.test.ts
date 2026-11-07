import test from "node:test"
import assert from "node:assert/strict"
import { ThunderDriver } from "./driver"
import { calcGcid, FOLDER, FILE } from "./util"

function thunderFolder(id: string, name: string) {
  return { kind: FOLDER, id, parent_id: "", name, size: "0" }
}

function thunderFile(id: string, name: string) {
  return {
    kind: FILE,
    id,
    parent_id: "dir-movies",
    name,
    size: "3",
    web_content_link: "https://example.test/file",
  }
}

function makeDriver() {
  const driver = new ThunderDriver({
    root_folder_id: "root-id",
    username: "u",
    password: "p",
  })
  const requests: { url: string; init: any }[] = []
  ;(driver as any).client.authRequest = async (url: string, init: any) => {
    requests.push({ url, init })
    const u = new URL(url)
    if (init?.method === "GET" && u.pathname.endsWith("/files")) {
      const parent = u.searchParams.get("parent_id")
      if (parent === "root-id") {
        return {
          kind: "drive#files",
          files: [thunderFolder("dir-movies", "Movies")],
        }
      }
      if (parent === "dir-movies") {
        return {
          kind: "drive#files",
          files: [thunderFile("file-a", "a.mkv")],
        }
      }
      return { kind: "drive#files", files: [] }
    }
    if (init?.method === "GET" && u.pathname.endsWith("/files/file-a")) {
      return thunderFile("file-a", "a.mkv")
    }
    if (init?.method === "POST" && u.pathname.endsWith("/files")) {
      return { kind: "drive#file", upload_type: "UPLOAD_TYPE_RESUMABLE" }
    }
    throw new Error(`unexpected request: ${init?.method} ${u.pathname}`)
  }
  return { driver, requests }
}

test("list() resolves a physical path's last segment to a real folder ID (F-279)", async () => {
  const { driver, requests } = makeDriver()
  const items = await driver.list("", "/Movies")

  assert.deepEqual(
    items.map((i) => i.name),
    ["a.mkv"],
  )
  // 第一次按 root_folder_id 列目录，找到 Movies 后按其真实 ID 再列
  assert.ok(requests[0].url.includes("parent_id=root-id"))
  assert.ok(requests[1].url.includes("parent_id=dir-movies"))
})

test("get() resolves an item ID instead of using its name (F-279)", async () => {
  const { driver, requests } = makeDriver()
  const item = await driver.get("", "/Movies/a.mkv")
  assert.equal(item.name, "a.mkv")
  const last = requests[requests.length - 1]
  assert.ok(new URL(last.url).pathname.endsWith("/files/file-a"))
})

test("put() uses the resolved parent folder ID and a GCID hash (F-279)", async () => {
  const { driver, requests } = makeDriver()
  await driver.put("", "/Movies/b.mkv", Buffer.from("abc"))
  const post = requests.find((r) => r.init?.method === "POST")
  assert.ok(post)
  assert.equal(post!.init.body.parent_id, "dir-movies")
  assert.equal(post!.init.body.hash, await calcGcid(Buffer.from("abc")))
})
