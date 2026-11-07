import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { WeiyunDriver } from "./driver"
import { WeiyunClient } from "./util"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeDriver(): WeiyunDriver {
  const driver = new WeiyunDriver({ cookies: "uin=1; skey=x; wyctoken=T" })
  ;(driver as any).rootFolderId = "root"
  ;(driver as any).rootPdirKey = "proot"
  ;(driver as any).pathFolderCache.set("/", {
    dirKey: "root",
    pdirKey: "proot",
    dirName: "root",
  })
  return driver
}

test("weiyun put fails when the server terminates channels before the whole file is accepted", async () => {
  const driver = makeDriver()
  const size = 3 * 1024 * 1024
  let pieces = 0
  ;(driver as any).client = {
    preUpload: async () => ({
      upload_key: "k",
      ex: "e",
      channel_list: [{ id: 0, offset: 0, len: 1024 * 1024 }],
    }),
    // 服务端声明该通道无剩余分片，却从未确认收到任何数据
    uploadPiece: async () => {
      pieces++
      return { upload_state: 3 }
    },
  }

  await assert.rejects(
    () => driver.put("/a.bin", "/a.bin", Buffer.alloc(size)),
    /上传未完成/,
  )
  assert.equal(pieces, 1, "state=3 must stop the channel loop immediately")
})

test("weiyun put follows upload_state=1 channels and succeeds on state=2", async () => {
  const driver = makeDriver()
  const size = 2 * 1024 * 1024
  const offsets: number[] = []
  ;(driver as any).client = {
    preUpload: async () => ({
      upload_key: "k",
      ex: "e",
      channel_list: [{ id: 0, offset: 0, len: 1024 * 1024 }],
    }),
    uploadPiece: async (channel: { offset: number; len: number }) => {
      offsets.push(channel.offset)
      const next = channel.offset + 1024 * 1024
      if (next >= size) return { upload_state: 2 }
      return { upload_state: 1, channel: { id: 0, offset: next, len: 1024 * 1024 } }
    },
  }

  await driver.put("/a.bin", "/a.bin", Buffer.alloc(size))
  assert.deepEqual(offsets, [0, 1024 * 1024])
})

test("weiyun 403 retry rebuilds the URL with the refreshed g_tk", async () => {
  const urls: string[] = []
  let calls = 0
  globalThis.fetch = (async (input) => {
    const url = String(input)
    urls.push(url)
    calls++
    if (calls === 1) {
      return new Response("forbidden", {
        status: 403,
        headers: { "set-cookie": "wyctoken=NEWTOKEN" },
      })
    }
    return new Response(
      JSON.stringify({
        ret: 0,
        data: {
          rsp_header: { retcode: 0 },
          rsp_body: { RspMsg_body: { items: [] } },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch

  const client = new WeiyunClient({ cookies: "uin=1; skey=x; wyctoken=OLD" })
  ;(client as any).refreshCtoken = async () => {}

  await client.diskDirFileList("root", { count: 500 })
  assert.equal(urls.length, 2)
  assert.match(urls[0], /g_tk=OLD/)
  assert.match(urls[1], /g_tk=NEWTOKEN/)
})

test("weiyun invalidates cached folder ids after rename and remove", async () => {
  const driver = makeDriver()
  const driverAny = driver as any
  driverAny.pathFolderCache.set("/docs", {
    dirKey: "d1",
    pdirKey: "root",
    dirName: "docs",
  })
  driverAny.pathFolderCache.set("/docs/sub", {
    dirKey: "d2",
    pdirKey: "d1",
    dirName: "sub",
  })
  driverAny.client = {
    diskDirFileList: async () => ({ dir_list: [], file_list: [] }),
    diskDirAttrModify: async () => {},
    diskDirDelete: async () => {},
  }
  // resolveFile 通过 diskDirFileList 找到 /docs（父目录为 root）
  driverAny.client.diskDirFileList = async () => ({
    dir_list: [{ dir_key: "d1", dir_name: "docs" }],
    file_list: [],
  })

  await driver.rename("/docs", "/docs", "docs2")
  assert.ok(!driverAny.pathFolderCache.has("/docs"))
  assert.ok(!driverAny.pathFolderCache.has("/docs/sub"))

  driverAny.pathFolderCache.set("/docs", {
    dirKey: "d1",
    pdirKey: "root",
    dirName: "docs",
  })
  await driver.remove("/docs", "/docs", ["docs"])
  assert.ok(!driverAny.pathFolderCache.has("/docs"))
})

test("weiyun resolveFolder paginates until the target directory is found", async () => {
  const driver = makeDriver()
  const starts: number[] = []
  const page1 = Array.from({ length: 500 }, (_, i) => ({
    dir_key: `filler-${i}`,
    dir_name: `filler-${i}`,
  }))
  ;(driver as any).client = {
    diskDirFileList: async (
      _dirKey: string,
      opts: { start?: number; getType?: number },
    ) => {
      if (opts.getType === 0) {
        // list() 自身
        return {
          dir_list: [{ dir_key: "d-target", dir_name: "big" }],
          file_list: [],
          finish_flag: true,
        }
      }
      starts.push(opts.start || 0)
      if ((opts.start || 0) === 0) {
        return { dir_list: page1, file_list: [], finish_flag: false }
      }
      return {
        dir_list: [{ dir_key: "d-target", dir_name: "big" }],
        file_list: [],
        finish_flag: true,
      }
    },
  }

  const items = await driver.list("/big", "/big")
  assert.deepEqual(starts, [0, 500])
  assert.deepEqual(
    items.map((i) => i.name),
    ["big"],
  )
})

test("weiyun list throws instead of returning a truncated directory on budget exhaustion", async () => {
  const driver = makeDriver()
  ;(driver as any).budget.limit = 2
  ;(driver as any).client = {
    diskDirFileList: async () => ({
      dir_list: [],
      file_list: [{ file_id: "f", filename: "f.txt" }],
      finish_flag: false,
    }),
  }

  await assert.rejects(() => driver.list("/", "/"), /子请求上限|结果不完整/)
})

test("weiyun move resolves the destination folder from dstPhysical, not the virtual dstDir", async () => {
  const driver = makeDriver()
  const driverAny = driver as any
  const resolved: string[] = []
  driverAny.resolveFile = async () => ({
    file: { file_id: "f1", filename: "a.txt" },
    parent: { dirKey: "root", pdirKey: "proot", dirName: "root" },
    isDir: false,
  })
  driverAny.resolveFolder = async (path: string) => {
    resolved.push(path)
    return { dirKey: "d-docs", pdirKey: "root", dirName: "docs" }
  }
  let target: any
  driverAny.client = {
    diskFileMove: async (_src: any, dst: any) => {
      target = dst
    },
  }

  // 挂载点 /mnt 下的虚拟目录 "/mnt/docs" 在微云内并不存在
  await driver.move("/mnt", "/mnt/docs", ["a.txt"], "/a.txt", "/docs/a.txt")
  assert.deepEqual(resolved, ["/docs"])
  assert.equal(target.dir_key, "d-docs")
})
