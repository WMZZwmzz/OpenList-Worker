import assert from "node:assert/strict"
import test from "node:test"
import {
  __resetPruneThrottleForTest,
  getSession,
  MAX_TOTAL_CHUNKS,
  MAX_UPLOAD_BYTES,
  newUploadId,
  putSession,
  sessionLimitError,
  snapshot,
  type MultipartSession,
} from "./multipart"

function makeSession(over: Partial<MultipartSession> = {}): MultipartSession {
  const chunkSize = 10 * 1024 * 1024
  const size = 15 * 1024 * 1024
  return {
    upload_id: newUploadId(),
    state: "receiving",
    attempt: 0,
    path: "/demo.bin",
    size,
    chunk_size: chunkSize,
    total_chunks: Math.ceil(size / chunkSize),
    received: new Set<number>(),
    driver_session: "sess",
    partMd5s: [],
    storage_driver: "local",
    owner_id: 1,
    created_at: Date.now(),
    ...over,
  }
}

test("F-117: received_bytes 按最后一片的实际字节数折算，不得超过文件大小", () => {
  const s = makeSession()
  s.received = new Set([0, 1])
  const snap = snapshot(s)
  assert.equal(snap.received_bytes, s.size, "全部分片收完后应等于文件真实大小")
  assert.ok(snap.received_bytes <= s.size)

  s.received = new Set([0])
  assert.equal(snapshot(s).received_bytes, s.chunk_size, "只收首片时为整片大小")

  // 整除场景保持原值
  const even = makeSession({ size: 20 * 1024 * 1024, total_chunks: 2 })
  even.received = new Set([0, 1])
  assert.equal(snapshot(even).received_bytes, 20 * 1024 * 1024)
})

test("F-114: putSession 拒绝越过 MAX_TOTAL_CHUNKS / MAX_UPLOAD_BYTES 的会话", () => {
  const tooMany = makeSession({
    size: 1024 * 1024,
    chunk_size: 1,
    total_chunks: MAX_TOTAL_CHUNKS + 1,
  })
  assert.match(String(sessionLimitError(tooMany)), /MAX_TOTAL_CHUNKS/)
  assert.throws(() => putSession(tooMany), /MAX_TOTAL_CHUNKS/)
  assert.equal(getSession(tooMany.upload_id), undefined)

  const tooBig = makeSession({ size: MAX_UPLOAD_BYTES + 1 })
  assert.throws(() => putSession(tooBig), /MAX_UPLOAD_BYTES/)

  // 合规会话正常入库
  const ok = makeSession()
  putSession(ok)
  assert.equal(getSession(ok.upload_id)?.upload_id, ok.upload_id)
})

test("F-114: putSession 会（节流地）自动清扫过期会话", () => {
  __resetPruneThrottleForTest()
  const stale = makeSession({
    state: "completed",
    created_at: Date.now() - 2 * 60 * 60 * 1000,
  })
  putSession(stale)
  assert.equal(
    getSession(stale.upload_id),
    undefined,
    "过期 completed 会话应在写入入口被自动清扫",
  )

  __resetPruneThrottleForTest()
  const fresh = makeSession()
  putSession(fresh)
  assert.notEqual(
    getSession(fresh.upload_id),
    undefined,
    "活跃会话不得被误删",
  )
})
