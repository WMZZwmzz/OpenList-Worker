import test from "node:test"
import assert from "node:assert/strict"
import { CryptDriver } from "./driver"
import { CryptCipher } from "./cipher"
import type { FileItem, StorageDriver } from "../../internal/driver/base"

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

/** 极简远端驱动：只有 dirPath 是目录，只有 filePath 是文件 */
function fakeRemote(opts: {
  dirs?: string[]
  files?: Record<string, number>
}): StorageDriver & { calls: string[] } {
  const calls: string[] = []
  const dirs = new Set(opts.dirs || [])
  const files = opts.files || {}
  const driver: any = {
    calls,
    async get(_v: string, physicalPath: string) {
      calls.push(physicalPath)
      if (dirs.has(physicalPath)) return fileItem("dir", 0, true)
      if (physicalPath in files) {
        return fileItem(physicalPath.split("/").pop()!, files[physicalPath])
      }
      throw new Error("Object not found")
    },
    async list() {
      return []
    },
  }
  return driver
}

async function makeDriver(remote: StorageDriver, suffix = ".bin") {
  const driver = new CryptDriver({
    remote_path: "/remote",
    password: "secret",
    encrypted_suffix: suffix,
  })
  // 跳过 init()（依赖 DB/resolvePath），直接注入依赖
  ;(driver as any).remoteDriver = remote
  ;(driver as any).cipher = await CryptCipher.create("secret", "")
  ;(driver as any).remoteRoot = "/"
  return driver
}

test("F-457: get() 对文件追加 encrypted_suffix 查询远端", async () => {
  // 远端只有加密文件名 a.txt.bin（大小 = 32 + 16 + 10）
  const remote = fakeRemote({ dirs: ["/docs"], files: { "/a.txt.bin": 58 } })
  const driver = await makeDriver(remote)
  const item = await driver.get("/a.txt", "/a.txt")
  assert.equal(item.name, "a.txt")
  assert.equal(item.is_dir, false)
  assert.equal(item.size, 10)
  assert.equal(item.raw_url, "")
  // 末段像文件：先查带后缀的文件名（命中即止）
  assert.deepEqual(remote.calls, ["/a.txt.bin"])
})

test("F-457: 无扩展名的加密文件（目录优先探测）仍能查到", async () => {
  const remote = fakeRemote({ dirs: [], files: { "/README.bin": 58 } })
  const driver = await makeDriver(remote)
  const item = await driver.get("/README", "/README")
  assert.equal(item.name, "README")
  assert.equal(item.is_dir, false)
  assert.deepEqual(remote.calls, ["/README", "/README.bin"])
})

test("F-457: get() 目录仍按裸路径命中（不加后缀）", async () => {
  const remote = fakeRemote({ dirs: ["/docs"], files: {} })
  const driver = await makeDriver(remote)
  const item = await driver.get("/docs", "/docs")
  assert.equal(item.is_dir, true)
  assert.deepEqual(remote.calls, ["/docs"])
})

test("F-457: 文件与目录都不存在时抛错，而不是伪造条目", async () => {
  const remote = fakeRemote({ dirs: [], files: {} })
  const driver = await makeDriver(remote)
  await assert.rejects(() => driver.get("/nope", "/nope"), /not found/)
})

test("F-457/F-458: list() 只对带后缀的文件剥后缀并折算尺寸", async () => {
  const items = [fileItem("docs", 0, true), fileItem("a.txt.bin", 58), fileItem("raw.txt", 7)]
  const remote: any = {
    async list() {
      return items
    },
    async get() {
      throw new Error("unused")
    },
  }
  const driver = await makeDriver(remote)
  const out = await driver.list("/", "/")
  const byName = new Map(out.map((i) => [i.name, i]))
  assert.equal(byName.get("docs")?.is_dir, true)
  assert.equal(byName.get("a.txt")?.size, 10)
  assert.equal(byName.get("a.txt")?.raw_url, "")
  // 不带后缀的文件（非本驱动写入）原样保留
  assert.equal(byName.get("raw.txt")?.size, 7)
})
