import test from "node:test"
import assert from "node:assert/strict"
import { ChunkDriver } from "./driver"
import { FileItem } from "../../internal/driver/base"

function fileItem(partial: Partial<FileItem> & { name: string }): FileItem {
  return {
    name: partial.name,
    size: partial.size ?? 0,
    is_dir: partial.is_dir ?? false,
    modified: partial.modified ?? "2024-01-01T00:00:00.000Z",
    sign: partial.sign ?? partial.name,
    type: partial.type ?? 0,
    raw_url: partial.raw_url ?? "",
  }
}

function makeDriver() {
  const driver = new ChunkDriver({
    remote_path: "/remote",
    part_size: 4,
    chunk_prefix: "[c]",
  })
  const listed: string[] = []
  const remote = {
    list: async (_v: string, physicalPath: string): Promise<FileItem[]> => {
      listed.push(physicalPath)
      if (physicalPath === "/dir") {
        return [
          fileItem({ name: "[c]big.bin", is_dir: true }),
          fileItem({ name: "plain.txt", size: 3 }),
        ]
      }
      if (physicalPath === "/dir/[c]big.bin") {
        return [
          fileItem({ name: "0", size: 4 }),
          fileItem({ name: "1", size: 2 }),
        ]
      }
      return []
    },
  }
  // init() 需要 db/op 层，测试直接注入底层驱动
  ;(driver as any).remoteDriver = remote
  return { driver, listed }
}

test("F-420: list() sums parts from the real single-prefixed chunk directory", async () => {
  const { driver, listed } = makeDriver()

  const items = await driver.list("/dir", "/dir")
  const big = items.find((i) => i.name === "big.bin")
  assert.ok(big)
  assert.equal(big!.size, 6)

  assert.ok(listed.includes("/dir/[c]big.bin"))
  assert.ok(
    !listed.some((p) => p.includes("[c][c]")),
    `double-prefixed path requested: ${listed.join(", ")}`,
  )
})

test("F-420: list() keeps normal entries untouched", async () => {
  const { driver } = makeDriver()
  const items = await driver.list("/dir", "/dir")
  const plain = items.find((i) => i.name === "plain.txt")
  assert.ok(plain)
  assert.equal(plain!.size, 3)
  assert.equal(plain!.is_dir, false)
})

test("F-425: list() rejects when a chunk part index is missing", async () => {
  const driver = new ChunkDriver({
    remote_path: "/remote",
    part_size: 4,
    chunk_prefix: "[c]",
  })
  ;(driver as any).remoteDriver = {
    list: async (_v: string, physicalPath: string): Promise<FileItem[]> => {
      if (physicalPath === "/dir") {
        return [fileItem({ name: "[c]gap.bin", is_dir: true })]
      }
      if (physicalPath === "/dir/[c]gap.bin") {
        return [fileItem({ name: "0", size: 4 }), fileItem({ name: "2", size: 4 })]
      }
      return []
    },
  }
  await assert.rejects(() => driver.list("/dir", "/dir"), /chunk part 1 is missing/)
})

test("F-425: duplicate chunk part indices are rejected instead of silently overwritten", async () => {
  const driver = new ChunkDriver({
    remote_path: "/remote",
    part_size: 4,
    chunk_prefix: "[c]",
    custom_ext: ".bin",
  })
  ;(driver as any).remoteDriver = {
    list: async (_v: string, physicalPath: string): Promise<FileItem[]> => {
      if (physicalPath === "/dir") {
        return [fileItem({ name: "[c]big.bin", is_dir: true })]
      }
      return [fileItem({ name: "0", size: 4 }), fileItem({ name: "0.bin", size: 2 })]
    },
  }
  await assert.rejects(
    () => driver.list("/dir", "/dir"),
    /duplicate chunk part index 0/,
  )
})

test("F-430: createReadStream refuses parts with unknown (0) size", async () => {
  const driver = new ChunkDriver({
    remote_path: "/remote",
    part_size: 4,
    chunk_prefix: "[c]",
  })
  ;(driver as any).remoteDriver = {
    list: async (): Promise<FileItem[]> => [
      fileItem({ name: "0", size: 0 }),
      fileItem({ name: "1", size: 4 }),
    ],
  }
  await assert.rejects(
    () => driver.createReadStream("/dir/f.bin"),
    /unknown size/,
  )
})
