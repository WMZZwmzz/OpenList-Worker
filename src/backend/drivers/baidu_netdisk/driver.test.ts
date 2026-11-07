import test from "node:test"
import assert from "node:assert/strict"
import { BaiduDriver } from "./driver"

test("move()/copy() target the physical destination's parent (F-208)", async () => {
  const driver = new BaiduDriver({ access_token: "token", refresh_token: "" })
  const calls: any[] = []
  ;(driver as any).client.manage = async (op: string, items: any[]) => {
    calls.push({ op, items })
  }

  await driver.move(
    "/mnt/src",
    "/mnt/dst",
    ["a.txt"],
    "/apps/root/src/a.txt",
    "/apps/root/dst/a.txt",
  )
  await driver.copy(
    "/mnt/src",
    "/mnt/dst",
    ["a.txt"],
    "/apps/root/src/a.txt",
    "/apps/root/dst/a.txt",
  )

  assert.deepEqual(calls, [
    {
      op: "move",
      items: [
        {
          path: "/apps/root/src/a.txt",
          dest: "/apps/root/dst",
          newname: "a.txt",
        },
      ],
    },
    {
      op: "copy",
      items: [
        {
          path: "/apps/root/src/a.txt",
          dest: "/apps/root/dst",
          newname: "a.txt",
        },
      ],
    },
  ])
})

test("move() to the known root uses '/' as dest", async () => {
  const driver = new BaiduDriver({ access_token: "token", refresh_token: "" })
  const calls: any[] = []
  ;(driver as any).client.manage = async (op: string, items: any[]) => {
    calls.push({ op, items })
  }
  await driver.move("/mnt/a", "/", ["a.txt"], "/a.txt", "/a.txt")
  assert.equal(calls[0].items[0].dest, "/")
})

test("upload_thread 不可解析时回退为安全并发数而不是 NaN (F-209)", async () => {
  const driver = new BaiduDriver({
    access_token: "token",
    refresh_token: "",
    upload_thread: "abc",
  })
  ;(driver as any).client.uinfo = async () => 0
  await driver.init()
  assert.equal((driver as any).uploadThread, 1)

  const driver2 = new BaiduDriver({
    access_token: "token",
    refresh_token: "",
    upload_thread: "8",
  })
  ;(driver2 as any).client.uinfo = async () => 0
  await driver2.init()
  assert.equal((driver2 as any).uploadThread, 8)
})

test("get() 直链失败时写入 raw_url_error (F-211)", async () => {
  const driver = new BaiduDriver({ access_token: "token", refresh_token: "" })
  ;(driver as any).client.getFiles = async () => [
    {
      fs_id: 1,
      path: "/a.txt",
      server_filename: "a.txt",
      isdir: 0,
      size: 1,
    },
  ]
  ;(driver as any).getDownloadLink = async () => {
    throw new Error("errno 31023 risk control")
  }
  const item = await driver.get("/a.txt", "a.txt")
  assert.equal(item.raw_url, "")
  assert.match(String(item.raw_url_error), /31023/)
})

test("put() 的 content-md5 / block-list 使用流式哈希且值正确 (F-213)", async () => {
  const { createHash } = await import("node:crypto")
  const driver = new BaiduDriver({
    access_token: "token",
    refresh_token: "",
    upload_thread: "1",
  })
  const anyDriver = driver as any
  anyDriver.client.accessToken = "token"
  anyDriver.uploadThread = 1
  anyDriver.client.getSliceSize = () => 4 * 1024 * 1024

  // 第一次 create 为秒传尝试（失败），随后 precreate / uploadSlice / create
  let createCalls = 0
  const created: any[] = []
  anyDriver.client.create = async (...args: any[]) => {
    createCalls++
    created.push(args)
    if (createCalls === 1) throw new Error("rapid miss")
  }
  let precreateArgs: any[] | null = null
  anyDriver.client.precreate = async (...args: any[]) => {
    precreateArgs = args
    return { return_type: 1, uploadid: "upload-id", block_list: [0] }
  }
  anyDriver.client.uploadSlice = async () => {}

  const content = Buffer.from("hello baidu netdisk")
  await driver.put("/a.bin", "a.bin", content)

  const md5Hex = createHash("md5").update(content).digest("hex")
  assert.ok(precreateArgs)
  assert.equal(precreateArgs![3], md5Hex)
  assert.deepEqual(JSON.parse(precreateArgs![2]), [md5Hex])
  assert.equal(created.length, 2)
})
