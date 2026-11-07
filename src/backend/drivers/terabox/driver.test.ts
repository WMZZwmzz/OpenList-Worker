import test from "node:test"
import assert from "node:assert/strict"
import { teraboxSign, TeraboxApiClient } from "./util"
import { TeraboxDriver } from "./driver"
import { md5 } from "../../pkg/crypto"

const chunkSize = 4 * 1024 * 1024

function makeDriver(precreate: any, createResponse: any) {
  const createCalls: any[] = []
  const driver = new TeraboxDriver({
    cookie: "ndus=mockcookie; ndut_fmt=mock;",
    download_api: "official",
  })
  ;(driver as any).client.request = async (path: string, opts: any) => {
    if (path === "/api/precreate") return precreate
    if (path === "/api/create") {
      createCalls.push(opts)
      return createResponse
    }
    throw new Error("unexpected request " + path)
  }
  return { driver, createCalls }
}

function stubFetch(
  content: Buffer,
  chunkResponse: (seq: number, digest: string) => Response,
) {
  const digests: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("locateupload")) {
      return new Response(JSON.stringify({ host: "upload.example.com" }), {
        status: 200,
      })
    }
    if (url.includes("superfile2")) {
      const seq = Number(new URL(url).searchParams.get("partseq"))
      const start = seq * chunkSize
      const digest = md5(
        content.subarray(start, Math.min(start + chunkSize, content.length)),
      )
      digests.push(digest)
      return chunkResponse(seq, digest)
    }
    throw new Error("unexpected fetch " + url)
  }) as any
  return {
    digests,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

test("TeraBox cipher sign function", () => {
  const sign = teraboxSign("sign3key", "sign1data")
  assert.ok(typeof sign === "string" && sign.length > 0)
})

test("TeraBox driver instantiation", () => {
  const driver = new TeraboxDriver({
    cookie: "ndus=mockcookie; ndut_fmt=mock;",
    download_api: "official",
  })
  assert.ok(driver)
})

test("F-328: put uploads >4MB files chunk by chunk and sends per-chunk MD5 block_list", async () => {
  const content = Buffer.alloc(chunkSize + 1024, 7)
  const { driver, createCalls } = makeDriver(
    { errno: 0, uploadid: "up1", return_type: 1, path: "/big.bin", block_list: [] },
    { errno: 0 },
  )
  const stub = stubFetch(
    content,
    (_seq, digest) =>
      new Response(JSON.stringify({ errno: 0, md5: digest }), { status: 200 }),
  )
  try {
    await driver.put("/", "/big.bin", content)
  } finally {
    stub.restore()
  }
  assert.equal(stub.digests.length, 2)
  assert.equal(createCalls.length, 1)
  assert.deepEqual(
    JSON.parse(createCalls[0].body.block_list),
    stub.digests,
  )
  assert.equal(createCalls[0].body.size, String(content.length))
  assert.equal(createCalls[0].body.uploadid, "up1")
})

test("F-328: chunk errno aborts put() instead of reporting success", async () => {
  const content = Buffer.alloc(1024 * 1024, 1)
  const { driver, createCalls } = makeDriver(
    { errno: 0, uploadid: "up1", return_type: 1, path: "/a.bin", block_list: [] },
    { errno: 0 },
  )
  const stub = stubFetch(
    content,
    (_seq, digest) =>
      new Response(JSON.stringify({ errno: 105, md5: digest }), { status: 200 }),
  )
  try {
    await assert.rejects(
      () => driver.put("/", "/a.bin", content),
      /errno: 105/,
    )
  } finally {
    stub.restore()
  }
  assert.equal(createCalls.length, 0)
})

test("F-328: server MD5 mismatch aborts put()", async () => {
  const content = Buffer.alloc(1024, 1)
  const { driver, createCalls } = makeDriver(
    { errno: 0, uploadid: "up1", return_type: 1, path: "/a.bin", block_list: [] },
    { errno: 0 },
  )
  const stub = stubFetch(
    content,
    () =>
      new Response(
        JSON.stringify({ errno: 0, md5: "00000000000000000000000000000000" }),
        { status: 200 },
      ),
  )
  try {
    await assert.rejects(
      () => driver.put("/", "/a.bin", content),
      /MD5 mismatch/,
    )
  } finally {
    stub.restore()
  }
  assert.equal(createCalls.length, 0)
})

test("F-328: create errno aborts put() instead of reporting success", async () => {
  const content = Buffer.alloc(1024, 1)
  const { driver } = makeDriver(
    { errno: 0, uploadid: "up1", return_type: 1, path: "/a.bin", block_list: [] },
    { errno: 42 },
  )
  const stub = stubFetch(
    content,
    (_seq, digest) =>
      new Response(JSON.stringify({ errno: 0, md5: digest }), { status: 200 }),
  )
  try {
    await assert.rejects(
      () => driver.put("/", "/a.bin", content),
      /failed to create file \(errno: 42\)/,
    )
  } finally {
    stub.restore()
  }
})

test("F-329: manage 返回 errno≠0 时抛错", async () => {
  const client = new TeraboxApiClient({ cookie: "c" })
  ;(client as any).request = async () => ({ errno: -8 })
  await assert.rejects(
    () => client.manage("rename", [{ path: "/a", newname: "b" }]),
    /rename failed \(errno: -8\)/,
  )
})

test("F-329: mkdir 的 /api/create errno≠0 时抛错", async () => {
  const driver = new TeraboxDriver({ cookie: "c" })
  ;(driver as any).client.request = async (path: string) =>
    path === "/api/create" ? { errno: -8 } : {}
  await assert.rejects(
    () => driver.mkdir("", "/dir"),
    /mkdir failed \(errno: -8\)/,
  )
})

test("F-330: list() 遇 errno≠0 抛错而不是返回空目录", async () => {
  const driver = new TeraboxDriver({ cookie: "c" })
  ;(driver as any).client.request = async (path: string) =>
    path === "/api/list" ? { errno: -6 } : {}
  await assert.rejects(() => driver.list("", "/"), /list failed \(errno: -6\)/)
})

test("F-331: get() 翻页查找且不存在时抛 not found", async () => {
  const driver = new TeraboxDriver({ cookie: "c" })
  let page = 0
  ;(driver as any).client.request = async () => {
    page++
    if (page === 1) {
      return {
        errno: 0,
        list: [
          {
            fs_id: 1,
            server_filename: "a.txt",
            isdir: 0,
            size: 5,
            server_mtime: 0,
          },
        ],
      }
    }
    if (page === 2) {
      return {
        errno: 0,
        list: [
          {
            fs_id: 2,
            server_filename: "b.txt",
            isdir: 0,
            size: 6,
            server_mtime: 0,
          },
        ],
      }
    }
    return { errno: 0, list: [] }
  }

  const item = await driver.get("", "/b.txt")
  assert.equal(item.sign, "2")
  assert.equal(item.size, 6)

  ;(driver as any).client.request = async () => ({ errno: 0, list: [] })
  await assert.rejects(() => driver.get("", "/nope"), /'nope' not found/)
})
