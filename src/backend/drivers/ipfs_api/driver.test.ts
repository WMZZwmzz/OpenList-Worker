import test from "node:test"
import assert from "node:assert/strict"
import { DriverIpfs, parentPath } from "./driver"

function makeDriver(rootPath = "root") {
  const driver = new DriverIpfs({
    mode: "mfs",
    endpoint: "http://127.0.0.1:5001",
    gateway: "http://127.0.0.1:8080",
    root_path: rootPath,
  })
  const calls: any[][] = []
  ;(driver as any).client = {
    filesMv: async (src: string, dst: string) => calls.push(["mv", src, dst]),
    filesCp: async (src: string, dst: string) => calls.push(["cp", src, dst]),
    filesStat: async (p: string) => ({ Hash: "QmHash", Size: 10, Type: "file" }),
  }
  return { driver, calls }
}

test("F-467: parentPath 从物理路径派生父目录", () => {
  assert.equal(parentPath("/a/b/c.txt"), "/a/b")
  assert.equal(parentPath("/a.txt"), "/")
})

test("F-467: move 的 MFS 目标是 fullPath(物理父目录)", async () => {
  const { driver, calls } = makeDriver()
  await driver.move("/virt/src", "/virt/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  assert.deepEqual(calls[0], ["mv", "/root/phys/src/a.txt", "/root/phys/dst"])
})

test("F-467: copy 的 MFS 目标是 fullPath(物理父目录)，源用 CID", async () => {
  const { driver, calls } = makeDriver()
  await driver.copy("/virt/src", "/virt/dst", ["a.txt"], "/phys/src/a.txt", "/phys/dst/a.txt")
  assert.deepEqual(calls[0], ["cp", "/ipfs/QmHash", "/root/phys/dst"])
})

test("F-473: 顶层 rename 生成 /新名（不再出现 //）", async () => {
  const driver = new DriverIpfs({
    mode: "mfs",
    endpoint: "http://127.0.0.1:5001",
    gateway: "http://127.0.0.1:8080",
  })
  const calls: any[][] = []
  ;(driver as any).client = {
    filesMv: async (src: string, dst: string) => calls.push(["mv", src, dst]),
  }
  await driver.rename("/v/file.txt", "/file.txt", "new.txt")
  assert.deepEqual(calls[0], ["mv", "/file.txt", "/new.txt"])
})

test("F-469: ls 接受 /ipns 前缀，ipns 模式不再拼出 /ipfs//ipns/", async () => {
  const { ClientIpfs } = await import("./util")
  const client = new ClientIpfs({
    mode: "ipns",
    endpoint: "http://127.0.0.1:5001",
    gateway: "http://127.0.0.1:8080",
  })
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input))
    return new Response(JSON.stringify({ Objects: [{ Links: [] }] }), { status: 200 })
  }) as typeof fetch
  try {
    const ipfsPath = await client.resolveIpfsPath("/mykey/sub")
    assert.equal(ipfsPath, "/ipns/mykey/sub")
    await client.ls(ipfsPath)
    const arg = decodeURIComponent(urls[0].split("?arg=")[1])
    assert.equal(arg, "/ipns/mykey/sub")
    assert.ok(!urls[0].includes("%2Fipfs%2F"))
  } finally {
    globalThis.fetch = original
  }
})

test("F-469: get 用真实探活判断目录，不存在的路径抛 not found", async () => {
  const driver = new DriverIpfs({
    mode: "ipfs",
    endpoint: "http://127.0.0.1:5001",
    gateway: "http://127.0.0.1:8080",
  })
  const links: Record<string, any[]> = {
    "/ipfs/": [{ Name: "dir", Type: 1, Hash: "h-dir", Size: 0 }],
    "/ipfs/dir": [{ Name: "f.txt", Type: 0, Hash: "h-f", Size: 3 }],
  }
  ;(driver as any).client = {
    resolveIpfsPath: async (p: string) => "/ipfs/" + p.replace(/^\/+|\/+$/g, ""),
    ls: async (arg: string) => {
      if (links[arg]) return { Objects: [{ Links: links[arg] }] }
      throw new Error(`no such path ${arg}`)
    },
    downloadUrl: (cid: string, name: string) => `https://gw.example.com/ipfs/${cid}?filename=${name}`,
  }
  const dir = await driver.get("/v/dir", "/dir")
  assert.equal(dir.is_dir, true)
  const file = await driver.get("/v/dir/f.txt", "/dir/f.txt")
  assert.equal(file.is_dir, false)
  await assert.rejects(() => driver.get("/v/nope", "/nope"), /not found/)
})

test("F-469: get 传播父目录列表的上游错误", async () => {
  const driver = new DriverIpfs({
    mode: "ipfs",
    endpoint: "http://127.0.0.1:5001",
    gateway: "http://127.0.0.1:8080",
  })
  ;(driver as any).client = {
    resolveIpfsPath: async (p: string) => "/ipfs/" + p.replace(/^\/+|\/+$/g, ""),
    ls: async () => {
      throw new Error("node unreachable")
    },
  }
  await assert.rejects(() => driver.get("/v/x", "/x"), /node unreachable/)
})
