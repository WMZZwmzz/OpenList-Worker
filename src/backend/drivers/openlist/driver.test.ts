import test from "node:test"
import assert from "node:assert/strict"
import { DriverOpenlist, parentPath } from "./driver"

function makeDriver() {
  const driver = new DriverOpenlist({ url: "https://peer.example.com" })
  const calls: any[][] = []
  ;(driver as any).client = {
    move: async (src: string, dst: string, names: string[]) => calls.push(["move", src, dst, names]),
    copy: async (src: string, dst: string, names: string[]) => calls.push(["copy", src, dst, names]),
  }
  return { driver, calls }
}

test("F-467: parentPath 从物理路径派生父目录", () => {
  assert.equal(parentPath("/a/b/c.txt"), "/a/b")
  assert.equal(parentPath("/a.txt"), "/")
})

test("F-467: move 发给对端的是物理 src_dir/dst_dir（不含挂载前缀）", async () => {
  const { driver, calls } = makeDriver()
  await driver.move("/mount/src", "/mount/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  assert.deepEqual(calls[0], ["move", "/phys/src", "/phys/dst", ["a.txt"]])
})

test("F-467: copy 发给对端的是物理 src_dir/dst_dir", async () => {
  const { driver, calls } = makeDriver()
  await driver.copy("/mount/src", "/mount/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  assert.deepEqual(calls[0], ["copy", "/phys/src", "/phys/dst", ["a.txt"]])
})

test("F-471: root_path 会加到发给对端的所有路径上", async () => {
  const driver = new DriverOpenlist({
    url: "https://peer.example.com",
    root_path: "sub",
  })
  const original = globalThis.fetch
  const bodies: any[] = []
  globalThis.fetch = (async (_input: any, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : {})
    return new Response(
      JSON.stringify({ code: 200, message: "ok", data: { content: [] } }),
      { status: 200 },
    )
  }) as typeof fetch
  try {
    await driver.list("/m", "/")
    await driver.mkdir("/m/x", "/x")
    await driver.move("/m/a", "/m/b", ["f.txt"], "/a/f.txt", "/b/f.txt")
  } finally {
    globalThis.fetch = original
  }
  assert.equal(bodies[0].path, "/sub")
  assert.equal(bodies[1].path, "/sub/x")
  assert.equal(bodies[2].src_dir, "/sub/a")
  assert.equal(bodies[2].dst_dir, "/sub/b")
})
