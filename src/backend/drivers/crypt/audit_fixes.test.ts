import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { CryptDriver } from "./driver"
import { CryptCipher } from "./cipher"
import type { FileItem, StorageDriver } from "../../internal/driver/base"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function fileItem(name: string, size: number, isDir = false): FileItem {
  return {
    name,
    size,
    is_dir: isDir,
    modified: new Date().toISOString(),
    sign: "",
    type: isDir ? 1 : 0,
    raw_url: `https://backend.example/${encodeURIComponent(name)}`,
  }
}

function fakeRemote(opts: {
  dirs?: string[]
  files?: Record<string, number>
}): StorageDriver & { ops: Array<{ op: string; paths: string[] }> } {
  const dirs = new Set(opts.dirs || [])
  const files = opts.files || {}
  const ops: Array<{ op: string; paths: string[] }> = []
  const record = (op: string) => async (...args: any[]) => {
    ops.push({
      op,
      paths: args.filter((a) => typeof a === "string" && a) as string[],
    })
  }
  const driver: any = {
    ops,
    async get(_v: string, physicalPath: string) {
      if (dirs.has(physicalPath)) return fileItem("dir", 0, true)
      if (physicalPath in files) {
        return fileItem(physicalPath.split("/").pop()!, files[physicalPath])
      }
      throw new Error("Object not found")
    },
    async list() {
      return []
    },
    rename: record("rename"),
    remove: record("remove"),
    move: record("move"),
    copy: record("copy"),
    async put() {},
  }
  return driver
}

async function makeDriver(remote: StorageDriver, suffix = ".bin") {
  const driver = new CryptDriver({
    remote_path: "/remote",
    password: "secret",
    encrypted_suffix: suffix,
  })
  ;(driver as any).remoteDriver = remote
  ;(driver as any).cipher = await CryptCipher.create("secret", "")
  ;(driver as any).remoteRoot = "/"
  return driver
}

test("F-465: 同名文件与目录共存时，对目录的操作落到目录而不是同名文件", async () => {
  // 远端同时存在目录 /X 与加密文件 /X.bin
  const remote = fakeRemote({ dirs: ["/X"], files: { "/X.bin": 58 } })
  const driver = await makeDriver(remote)

  await driver.remove("/X", "/X", ["X"])
  assert.deepEqual(remote.ops.at(-1), { op: "remove", paths: ["/X"] })

  remote.ops.length = 0
  await driver.rename("/X", "/X", "Y")
  assert.deepEqual(remote.ops.at(-1), { op: "rename", paths: ["/X", "Y"] })

  remote.ops.length = 0
  await driver.move("/", "/", ["X"], "/X", "/Y")
  assert.deepEqual(remote.ops.at(-1), {
    op: "move",
    paths: ["/", "/", "/X", "/Y"],
  })
})

test("F-465: 无同名目录时，加密文件仍按 suffix 操作", async () => {
  const remote = fakeRemote({ files: { "/a.txt.bin": 58 } })
  const driver = await makeDriver(remote)

  await driver.remove("/a.txt", "/a.txt", ["a.txt"])
  assert.deepEqual(remote.ops.at(-1), {
    op: "remove",
    paths: ["/a.txt.bin"],
  })
})

function rangeFetch(ciphertext: Uint8Array, ignoreRange = false) {
  const requests: Array<string | null> = []
  globalThis.fetch = (async (_input: any, init: any) => {
    const range = (init?.headers?.Range as string | undefined) || null
    requests.push(range)
    if (!range || ignoreRange) {
      return new Response(ciphertext as any, {
        status: 200,
        headers: { "content-length": String(ciphertext.length) },
      })
    }
    const m = /bytes=(\d+)-(\d+)/.exec(range)!
    const start = Number(m[1])
    const end = Math.min(Number(m[2]), ciphertext.length - 1)
    const slice = ciphertext.subarray(start, end + 1)
    return new Response(slice as any, {
      status: 206,
      headers: {
        "content-range": `bytes ${start}-${end}/${ciphertext.length}`,
      },
    })
  }) as typeof fetch
  return requests
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

async function streamFixture() {
  const plain = new Uint8Array(200_000)
  for (let i = 0; i < plain.length; i++) plain[i] = i % 251
  const cipher = await CryptCipher.create("secret", "")
  const ciphertext = await cipher.encrypt(plain)
  const remote = fakeRemote({ files: { "/big.bin.bin": ciphertext.length } })
  const driver = await makeDriver(remote)
  // get() 返回 raw_url（fakeRemote 已带）
  return { driver, plain, ciphertext }
}

test("F-466: 全量下载按块流式解密，结果与明文一致", async () => {
  const { driver, plain, ciphertext } = await streamFixture()
  const ranges = rangeFetch(ciphertext)
  const out = await readAll(await driver.createReadStream("/big.bin"))
  assert.equal(out.length, plain.length)
  assert.ok(Buffer.from(plain).equals(out))
  // 只请求了覆盖需要的密文区间（header + 全部块），不是整文件
  assert.equal(ranges.length, 1)
})

test("F-466: Range 请求只取覆盖该区间的密文块，按明文偏移切边", async () => {
  const { driver, plain, ciphertext } = await streamFixture()
  const ranges = rangeFetch(ciphertext)
  // 跨块区间：70_000..140_000（块大小 64KiB）
  const out = await readAll(
    await driver.createReadStream("/big.bin", { start: 70_000, end: 140_000 }),
  )
  assert.equal(out.length, 140_000 - 70_000 + 1)
  assert.ok(Buffer.from(plain.subarray(70_000, 140_001)).equals(out))

  const blockSize = 64 * 1024
  const blockHeader = 16
  const headerSize = 32
  const encStart = headerSize + Math.floor(70_000 / blockSize) * (blockSize + blockHeader)
  const encEnd =
    headerSize + (Math.floor(140_000 / blockSize) + 1) * (blockSize + blockHeader) - 1
  assert.equal(ranges.length, 2, "头部 nonce 与正文块区间各一次请求")
  assert.equal(ranges[0], `bytes=0-${headerSize - 1}`)
  assert.equal(
    ranges[1],
    `bytes=${encStart}-${Math.min(encEnd, ciphertext.length - 1)}`,
  )
})

test("F-466: 末尾 Range 与单块内 Range 都正确", async () => {
  const { driver, plain, ciphertext } = await streamFixture()

  rangeFetch(ciphertext)
  const tail = await readAll(
    await driver.createReadStream("/big.bin", {
      start: plain.length - 1000,
      end: plain.length - 1,
    }),
  )
  assert.ok(
    Buffer.from(plain.subarray(plain.length - 1000)).equals(tail),
  )

  rangeFetch(ciphertext)
  const inner = await readAll(
    await driver.createReadStream("/big.bin", { start: 10, end: 99 }),
  )
  assert.ok(Buffer.from(plain.subarray(10, 100)).equals(inner))
})

test("F-466: 服务端忽略 Range（200 整份）时仍能正确解密", async () => {
  const { driver, plain, ciphertext } = await streamFixture()
  rangeFetch(ciphertext, true)
  const out = await readAll(
    await driver.createReadStream("/big.bin", { start: 65_000, end: 66_000 }),
  )
  assert.ok(Buffer.from(plain.subarray(65_000, 66_001)).equals(out))
})
