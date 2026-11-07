import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { Cloud189PCDriver } from "./driver"
import {
  ListFilesURL,
  GetDownloadURLURL,
  GetUploadURLsURL,
  InitUploadURL,
  CommitUploadURL,
  RenameFileURL,
  DeleteFileURL,
  CreateFolderURL,
  DefaultChunkSize,
} from "./consts"

type Node = { id: string; name: string; isFolder: boolean; size?: number }

function makeDriver(tree: Record<string, Node[]>) {
  const driver = new Cloud189PCDriver({
    username: "u",
    password: "p",
    root_folder_id: "root",
  } as any)
  const client: any = (driver as any).client
  const listCalls: Array<{ folderId: string; pageNum: number }> = []
  let recordCountMode: "normal" | "missing" = "normal"
  let pageSize = 100

  client.requestAPI = async (endpoint: string, params: any = {}) => {
    if (endpoint === ListFilesURL) {
      listCalls.push({ folderId: params.folderId, pageNum: params.pageNum })
      const all = tree[params.folderId] ?? []
      const start = (params.pageNum - 1) * pageSize
      const page = all.slice(start, start + pageSize)
      const resp: any = {
        folderList: page.filter((n) => n.isFolder),
        fileList: page.filter((n) => !n.isFolder),
        fileListSize: page.length,
      }
      if (recordCountMode === "normal") resp.recordCount = all.length
      return resp
    }
    if (endpoint === GetDownloadURLURL) {
      return { fileDownloadUrl: `https://dl.test/${params.fileId}` }
    }
    if (endpoint === "/open/file/copyFile.action") {
      return {}
    }
    if (endpoint === DeleteFileURL) {
      return {}
    }
    if (endpoint === RenameFileURL) {
      return {}
    }
    if (endpoint === CreateFolderURL) {
      return { id: "created" }
    }
    throw new Error(`unexpected requestAPI: ${endpoint}`)
  }
  client.requestUploadAPI = async () => ({})
  client.request = async () => ({})

  return {
    driver,
    client,
    listCalls,
    setPageSize: (n: number) => {
      pageSize = n
    },
    setRecordCountMode: (m: "normal" | "missing") => {
      recordCountMode = m
    },
  }
}

test("F-341: filesystem operations resolve physical paths to real IDs", async () => {
  const tree: Record<string, Node[]> = {
    root: [{ id: "dir-1", name: "dir", isFolder: true }],
    "dir-1": [{ id: "file-1", name: "a.txt", isFolder: false, size: 7 }],
  }
  const { driver, client } = makeDriver(tree)
  const downloaded: string[] = []
  const original = client.requestAPI
  client.requestAPI = async (endpoint: string, params: any) => {
    if (endpoint === GetDownloadURLURL) downloaded.push(String(params.fileId))
    return original(endpoint, params)
  }

  const items = await driver.list("", "/dir")
  assert.deepEqual(items.map((i) => [i.name, i.sign]), [["a.txt", "file-1"]])

  const item = await driver.get("", "/dir/a.txt")
  assert.equal(item.name, "a.txt")
  assert.equal(item.raw_url, "https://dl.test/file-1")
  assert.deepEqual(downloaded, ["file-1"])
})

test("F-341: rename/remove/move/copy use resolved IDs, never raw paths", async () => {
  const tree: Record<string, Node[]> = {
    root: [
      { id: "dir-1", name: "dir", isFolder: true },
      { id: "dir-2", name: "dst", isFolder: true },
    ],
    "dir-1": [{ id: "file-1", name: "a.txt", isFolder: false, size: 1 }],
    "dir-2": [],
  }
  const { driver, client } = makeDriver(tree)
  const calls: Array<{ endpoint: string; params: any }> = []
  const original = client.requestAPI
  client.requestAPI = async (endpoint: string, params: any) => {
    calls.push({ endpoint, params })
    return original(endpoint, params)
  }

  await driver.rename("", "/dir/a.txt", "b.txt")
  assert.deepEqual(calls.at(-1)!.params, {
    fileId: "file-1",
    fileName: "b.txt",
  })

  await driver.copy("", "/dst", ["a.txt"], "/dir/a.txt", "/dst/a.txt")
  assert.deepEqual(calls.at(-1)!.params, {
    fileId: "file-1",
    destFolderId: "dir-2",
  })

  await driver.move("", "/dst", ["a.txt"], "/dir/a.txt", "/dst/a.txt")
  const moveEndpoints = calls.slice(-2).map((c) => c.endpoint)
  assert.deepEqual(moveEndpoints, ["/open/file/copyFile.action", DeleteFileURL])
  assert.equal(calls.at(-1)!.params.fileId, "file-1")

  await driver.remove("", "/dir/a.txt", ["a.txt"])
  assert.deepEqual(calls.at(-1)!.params, { fileId: "file-1" })
})

test("F-348: a missing recordCount aborts paging instead of looping forever", async () => {
  const tree: Record<string, Node[]> = {
    root: Array.from({ length: 250 }, (_, i) => ({
      id: `d${i}`,
      name: `dir-${i}`,
      isFolder: true,
    })),
  }
  const { driver, listCalls, setRecordCountMode } = makeDriver(tree)
  setRecordCountMode("missing")

  await assert.rejects(() => driver.list("", "/"), /recordCount/)
  assert.equal(listCalls.length, 1, "must stop after the first malformed page")
})

test("F-348: paging follows recordCount across multiple pages", async () => {
  const tree: Record<string, Node[]> = {
    root: Array.from({ length: 250 }, (_, i) => ({
      id: `d${i}`,
      name: `dir-${i}`,
      isFolder: true,
    })),
  }
  const { driver, listCalls } = makeDriver(tree)
  const items = await driver.list("", "/")
  assert.equal(items.length, 250)
  assert.deepEqual(
    listCalls.map((c) => c.pageNum),
    [1, 2, 3],
  )
})

test("F-349: put() declares and uploads one part per sliceSize", async () => {
  const { driver, client } = makeDriver({ root: [] })
  const initCalls: any[] = []
  const urlCalls: any[] = []
  const uploads: string[] = []
  let committed = 0
  client.requestUploadAPI = async (endpoint: string, data: any) => {
    if (endpoint === InitUploadURL) {
      initCalls.push(data)
      return { uploadFileId: "up-1", fileDataExists: 0 }
    }
    if (endpoint === GetUploadURLsURL) {
      urlCalls.push(data)
      const count = JSON.parse(data.partInfo).length
      return {
        uploadUrls: Array.from({ length: count }, (_, i) => `https://up.test/${i + 1}`),
      }
    }
    if (endpoint === CommitUploadURL) {
      committed++
      return {}
    }
    throw new Error(`unexpected upload endpoint ${endpoint}`)
  }
  client.request = async (url: string) => {
    uploads.push(url)
    return {}
  }

  const content = Buffer.alloc(DefaultChunkSize + 1024, 7)
  await driver.put("", "/big.bin", content)

  assert.equal(initCalls.length, 1)
  assert.equal(initCalls[0].sliceSize, DefaultChunkSize)
  const parts = JSON.parse(urlCalls[0].partInfo)
  assert.equal(parts.length, 2, "2 parts for >10MB")
  assert.deepEqual(parts, [{ partNumber: 1 }, { partNumber: 2 }])
  assert.deepEqual(uploads, ["https://up.test/1", "https://up.test/2"])
  assert.equal(committed, 1)
})

test("F-346: 189pc no longer imports Node's crypto module", () => {
  for (const file of ["./crypto.ts", "./util.ts", "./driver.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf-8")
    assert.ok(
      !/^\s*import[^;\n]*from\s+["'](node:)?crypto["']/m.test(src),
      `${file} must not statically import node crypto`,
    )
  }
})
