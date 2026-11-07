import test from "node:test"
import assert from "node:assert/strict"
import { DriverKodbox, parentPath } from "./driver"

function makeDriver(rootPath = "root") {
  const driver = new DriverKodbox({
    address: "https://kod.example.com",
    username: "u",
    password: "p",
    root_path: rootPath,
  })
  const calls: any[][] = []
  ;(driver as any).client = {
    move: async (src: string, name: string, dst: string) => calls.push(["move", src, name, dst]),
    copy: async (src: string, name: string, dst: string) => calls.push(["copy", src, name, dst]),
  }
  return { driver, calls }
}

test("F-467: parentPath 从物理路径派生父目录", () => {
  assert.equal(parentPath("/a/b/c.txt"), "/a/b")
  assert.equal(parentPath("/a.txt"), "/")
})

test("F-467: move 目标目录 = fullPath(物理父目录)，不再多拼挂载前缀", async () => {
  const { driver, calls } = makeDriver()
  await driver.move("/virt/src", "/virt/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  assert.deepEqual(calls[0], ["move", "/root/phys/src/a.txt", "a.txt", "/root/phys/dst"])
})

test("F-467: copy 目标目录 = fullPath(物理父目录)", async () => {
  const { driver, calls } = makeDriver()
  await driver.copy("/virt/src", "/virt/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  assert.deepEqual(calls[0], ["copy", "/root/phys/src/a.txt", "a.txt", "/root/phys/dst"])
})

test("F-467: 未配置 root_path 时目标为物理父目录本身", async () => {
  const { driver, calls } = makeDriver("")
  await driver.move("/virt/src", "/virt/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  assert.deepEqual(calls[0], ["move", "/phys/src/a.txt", "a.txt", "/phys/dst"])
})

test("F-470: code=10001 只重登录重试一次，不会无限递归", async () => {
  const driver = new DriverKodbox({
    address: "https://kod.example.com",
    username: "u",
    password: "p",
  })
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    urls.push(url)
    const body = url.includes("loginSubmit")
      ? { code: true, info: "tok" }
      : { code: "10001" }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  try {
    await assert.rejects(() => driver.list("/m", "/x"), /10001/)
    // 业务请求 + 重登录 + 唯一一次重试
    assert.equal(urls.length, 3)
  } finally {
    globalThis.fetch = original
  }
})
