import assert from "node:assert/strict"
import { test } from "node:test"

import { MoPanDriver } from "./driver"
import { TaskStatusCompleted, TaskStatusFailed } from "./consts"

const PAGE = 100

function folder(id: string, name: string) {
  return { id, name, lastOpTime: "2026-01-01T00:00:00Z" }
}

function file(id: string, name: string) {
  return { id, name, size: 3, lastOpTime: "2026-01-01T00:00:00Z" }
}

function makeDriver(addition: Record<string, any> = {}) {
  const driver = new MoPanDriver({
    phone: "13800000000",
    password: "p",
    root_folder_id: "root",
    ...addition,
  } as any)
  const client: any = (driver as any).client
  return { driver, client }
}

test("F-244: concurrent logins are singleflighted", async () => {
  const { driver, client } = makeDriver()
  let logins = 0
  client.login = async () => {
    logins++
    await new Promise((r) => setTimeout(r, 20))
    return { token: "token-1", userCloudStorageRelations: [] }
  }
  client.getUserInfo = async () => ({ userID: "u1" })

  await Promise.all([
    (driver as any).performLogin(),
    (driver as any).performLogin(),
    (driver as any).performLogin(),
  ])

  assert.equal(logins, 1, "concurrent 401s must share one login")
  assert.equal(client.getAuthorization(), "Bearer token-1")
  assert.equal((driver as any).userId, "u1")
})

test("F-248: a persisted token is reused instead of logging in again", async () => {
  const { driver, client } = makeDriver({ token: "persisted" })
  let logins = 0
  client.login = async () => {
    logins++
    throw new Error("should not login")
  }
  client.getUserInfo = async () => ({ userID: "u-restored" })

  await (driver as any).performLogin()

  assert.equal(logins, 0)
  assert.equal(client.getAuthorization(), "Bearer persisted")
  assert.equal((driver as any).userId, "u-restored")
})

test("F-246: list() sends pageSize and stops at a short page", async () => {
  const { driver, client } = makeDriver()
  const pageSizes: Array<number | undefined> = []
  client.queryFiles = async (
    _id: string,
    page: number,
    _orderBy: string,
    _desc: boolean,
    _cloud?: string,
    pageSize?: number,
  ) => {
    pageSizes.push(pageSize)
    if (page === 1) {
      return {
        fileListAO: {
          folderList: Array.from({ length: PAGE }, (_, i) =>
            folder(`f${i}`, `folder-${i}`),
          ),
          fileList: [],
        },
      }
    }
    return { fileListAO: { folderList: [folder("last", "last")], fileList: [] } }
  }

  const items = await driver.list("", "/")
  assert.deepEqual(pageSizes, [PAGE, PAGE])
  assert.equal(items.length, PAGE + 1)
})

test("F-247: get() and path resolution search past the first page", async () => {
  const { driver, client } = makeDriver()
  client.queryFiles = async (
    id: string,
    page: number,
    _orderBy: string,
    _desc: boolean,
  ) => {
    if (id === "root") {
      // "target-dir" 排在第二页
      return page === 1
        ? {
            fileListAO: {
              folderList: Array.from({ length: PAGE }, (_, i) =>
                folder(`x${i}`, `x-${i}`),
              ),
              fileList: [],
            },
          }
        : { fileListAO: { folderList: [folder("dir-id", "target-dir")], fileList: [] } }
    }
    if (id === "dir-id") {
      return page === 1
        ? {
            fileListAO: {
              folderList: [],
              fileList: Array.from({ length: PAGE }, (_, i) =>
                file(`y${i}`, `y-${i}`),
              ),
            },
          }
        : { fileListAO: { folderList: [], fileList: [file("file-id", "late.txt")] } }
    }
    return { fileListAO: { folderList: [], fileList: [] } }
  }

  const item = await driver.get("", "/target-dir/late.txt")
  assert.equal(item.name, "late.txt")
  assert.equal(item.sign, "file-id")
})

test("F-249: a failed async task is reported instead of timing out", async () => {
  const { driver, client } = makeDriver()
  client.addBatchTask = async () => ({
    taskIDList: ["task-1"],
    taskType: 2,
    targetFolderID: "dest",
  })
  client.checkBatchTask = async () => ({
    taskID: "task-1",
    taskStatus: TaskStatusFailed,
  })

  await assert.rejects(
    () =>
      (driver as any).performBatchTask(
        { sign: "file-1", is_dir: false, name: "a.txt" },
        "dest",
        2,
      ),
    /Task task-1 failed/,
  )
})

test("F-249: an empty taskIDList is reported explicitly", async () => {
  const { driver, client } = makeDriver()
  client.addBatchTask = async () => ({ taskIDList: [], taskType: 2 })
  client.checkBatchTask = async () => ({ taskID: "x", taskStatus: TaskStatusCompleted })

  await assert.rejects(
    () =>
      (driver as any).performBatchTask(
        { sign: "file-1", is_dir: false, name: "a.txt" },
        "dest",
        2,
      ),
    /Task was not created/,
  )
})

test("F-245/F-250: parts upload with bounded concurrency and fail loudly", async () => {
  const { driver, client } = makeDriver({ upload_thread: "2" })
  assert.equal((driver as any).uploadThread, 2)

  client.initMultiUpload = async () => ({
    uploadFileID: "up-1",
    fileDataExists: 0,
    partSize: 2,
    partInfos: ["1", "2", "3", "4"],
  })
  client.getAllMultiUploadUrls = async () => [
    { partNumber: 1, uploadUrl: "https://up.test/1" },
    { partNumber: 2, uploadUrl: "https://up.test/2" },
    { partNumber: 3, uploadUrl: "https://up.test/3" },
    { partNumber: 4, uploadUrl: "https://up.test/4" },
  ]
  let committed = 0
  client.commitMultiUploadFile = async () => {
    committed++
  }

  const originalFetch = globalThis.fetch
  let inFlight = 0
  let maxInFlight = 0
  let failing = false
  globalThis.fetch = (async (url: any) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 10))
    inFlight--
    if (failing && String(url).endsWith("/2")) {
      return new Response("denied", { status: 403 })
    }
    return new Response("ok", { status: 200 })
  }) as typeof fetch
  try {
    await driver.put("", "/a.bin", Buffer.from("abcdefgh"))

    // 有限并发：不超过 upload_thread
    assert.equal(maxInFlight, 2)
    assert.equal(committed, 1)

    // 分片失败必须抛出且不得 commit
    failing = true
    committed = 0
    await assert.rejects(
      () => driver.put("", "/b.bin", Buffer.from("abcdefgh")),
      /上传分片 2\/4 失败: HTTP 403/,
    )
    assert.equal(committed, 0, "must not commit after a failed part")
  } finally {
    globalThis.fetch = originalFetch
  }
})
