import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { Pan123Driver } from "./driver"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const MB = 1024 * 1024

function stubDriver() {
  const driver = new Pan123Driver({ username: "u", password: "p" })
  const urlCalls: Array<{ partNumber: number; totalParts: number }> = []
  const completed: Array<{ size: number; isMultipart: boolean }> = []
  let sessions = 0
  ;(driver as any).ensureFolderId = async () => "0"
  ;(driver as any).client.createUpload = async () => {
    sessions++
    return {
      Reuse: false,
      Bucket: "bucket",
      Key: `key-${sessions}`,
      UploadId: `upload-id-${sessions}`,
      FileId: 1,
      StorageNode: "node",
    }
  }
  ;(driver as any).client.getPartUploadUrl = async (
    _up: unknown,
    partNumber: number,
    totalParts: number,
  ) => {
    urlCalls.push({ partNumber, totalParts })
    return `https://upload.example/part/${partNumber}`
  }
  ;(driver as any).client.completeUpload = async (
    _up: unknown,
    size: number,
    isMultipart: boolean,
  ) => {
    completed.push({ size, isMultipart })
  }
  globalThis.fetch = (async () =>
    new Response("", { status: 200 })) as typeof fetch
  return { driver, urlCalls, completed }
}

test("123pan honours the caller's 10MB slicing for 10MB < size <= 16MB", async () => {
  const { driver, urlCalls, completed } = stubDriver()
  const size = 12 * MB
  const info = await driver.createUploadSession("/", "/", "big.bin", size, "")
  // 名义 partCount 仍是按 16MB 推算的 1，但实际分片判定不依赖它
  assert.equal(info.partCount, 1)

  await driver.uploadPart(info.session, 1, Buffer.alloc(10 * MB))
  await driver.uploadPart(info.session, 2, Buffer.alloc(2 * MB))
  await driver.completeUploadSession(info.session)

  assert.deepEqual(
    urlCalls.map((c) => c.totalParts),
    [2, 2],
    "both parts must use the multipart presign endpoint",
  )
  assert.deepEqual(completed, [{ size, isMultipart: true }])
})

test("123pan keeps single-part uploads single-part", async () => {
  const { driver, urlCalls, completed } = stubDriver()
  const size = 5 * MB
  const info = await driver.createUploadSession("/", "/", "small.bin", size, "")
  await driver.uploadPart(info.session, 1, Buffer.alloc(size))
  await driver.completeUploadSession(info.session)

  assert.deepEqual(
    urlCalls.map((c) => c.totalParts),
    [1],
  )
  assert.deepEqual(completed, [{ size, isMultipart: false }])
})

test("123pan rejects completion when uploaded parts do not cover the file", async () => {
  const { driver, completed } = stubDriver()
  const size = 20 * MB
  const info = await driver.createUploadSession("/", "/", "big.bin", size, "")
  await driver.uploadPart(info.session, 1, Buffer.alloc(10 * MB))

  await assert.rejects(
    () => driver.completeUploadSession(info.session),
    /分片不完整/,
  )
  assert.equal(completed.length, 0)
})

test("123pan rejects parts larger than the declared file size", async () => {
  const { driver } = stubDriver()
  const info = await driver.createUploadSession("/", "/", "x.bin", 2 * MB, "")
  await assert.rejects(
    () => driver.uploadPart(info.session, 1, Buffer.alloc(3 * MB)),
    /超过文件大小/,
  )
})
