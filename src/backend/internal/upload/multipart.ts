/**
 * 服务层 Multipart 上传会话管理器。
 *
 * 目标：让 TS 后端提供与官方前端 `multipart.ts` 完全一致的 API 契约
 * （/fs/multipart/init | chunk | complete | status），内部桥接到驱动层的
 * createUploadSession / uploadPart / completeUploadSession（会话式分片）。
 *
 * 说明：
 * - 会话状态存于进程内 Map（Worker 单实例存活期间可断点续传）。
 *   跨实例/冷启动恢复依赖驱动 session token 的自包含性，本层不做 KV 持久化。
 * - chunk 按 index（0-based）桥接到驱动 uploadPart(partNumber = index + 1)，
 *   与官方前端 multipart.ts 的 chunk index 语义对齐。
 * - received 以区间数组 [number, number][] 表示，供前端断点续传跳过已收分片。
 */

export type MultipartState =
  | "receiving"
  | "completed"
  | "failed_retriable"
  | "failed_permanent"
  | "aborted"

export interface MultipartSession {
  upload_id: string
  state: MultipartState
  attempt: number
  path: string
  size: number
  /** 发起该会话的已认证身份（`${id}:${username}`），用于跨用户接管防护 */
  owner?: string
  chunk_size: number
  total_chunks: number
  /** 已收到分片 index 集合（0-based） */
  received: Set<number>
  /** 驱动层 session token（createUploadSession 返回） */
  driver_session: string
  /** 驱动层分片 md5（complete 时传给 completeUploadSession） */
  partMd5s: (string | undefined)[]
  /** 驱动名 + 存储引用，用于 chunk/complete 时重新 resolve 驱动 */
  storage_driver: string
  created_at: number
  error?: string
}

export interface MultipartSnapshot {
  upload_id: string
  state: MultipartState
  attempt: number
  path: string
  size: number
  chunk_size: number
  total_chunks: number
  received: [number, number][]
  received_bytes: number
  frontier: number
  storage_progress: number
  error?: string
}

const sessions = new Map<string, MultipartSession>()

const CHUNK_MIN = 1 * 1024 * 1024 // 1MB
const CHUNK_MAX = 64 * 1024 * 1024 // 64MB
const CHUNK_DEFAULT = 10 * 1024 * 1024 // 10MB

/**
 * 单次分片上传的硬上限。X-File-Size / X-Chunk-Size 都来自请求头，若不设上限，
 * 一个 X-File-Size: 1e15 就会让服务端 `new Array(1e9)` 分配 partMd5s，并把
 * snapshot() 里按 total_chunks 的线性扫描变成几十秒级的主循环。
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024 * 1024 // 100GB
export const MAX_TOTAL_CHUNKS = 20000

/** 将前端建议的 chunk_size clamp 到 [1MB, 64MB] */
export function clampChunkSize(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return CHUNK_DEFAULT
  return Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, Math.floor(raw)))
}

/** 区间数组 → 有序区间列表（合并相邻） */
function intervalsOf(set: Set<number>): [number, number][] {
  const arr = Array.from(set).sort((a, b) => a - b)
  if (arr.length === 0) return []
  const out: [number, number][] = []
  let start = arr[0]
  let end = arr[0]
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === end + 1) {
      end = arr[i]
    } else {
      out.push([start, end])
      start = end = arr[i]
    }
  }
  out.push([start, end])
  return out
}

export function snapshot(s: MultipartSession): MultipartSnapshot {
  const intervals = intervalsOf(s.received)
  const receivedBytes = s.received.size * s.chunk_size
  // frontier：连续已收的最大 index + 1（驱动顺序写入进度）
  let frontier = 0
  for (let i = 0; i < s.total_chunks; i++) {
    if (!s.received.has(i)) break
    frontier = i + 1
  }
  const storageProgress =
    s.total_chunks > 0
      ? Math.floor((s.received.size / s.total_chunks) * 100)
      : 0
  return {
    upload_id: s.upload_id,
    state: s.state,
    attempt: s.attempt,
    path: s.path,
    size: s.size,
    chunk_size: s.chunk_size,
    total_chunks: s.total_chunks,
    received: intervals,
    received_bytes: receivedBytes,
    frontier,
    storage_progress: storageProgress,
    error: s.error,
  }
}

export function getSession(uploadId: string): MultipartSession | undefined {
  return sessions.get(uploadId)
}

/** 查找同 path+size 的未完成会话（用于断点续传）；owner 不匹配时不复用 */
export function findReceivingSession(
  path: string,
  size: number,
  owner?: string,
): MultipartSession | undefined {
  for (const s of sessions.values()) {
    if (
      s.path === path &&
      s.size === size &&
      (s.state === "receiving" || s.state === "failed_retriable") &&
      // 会话只按 (path,size) 复用会让另一个用户拿到同一 upload_id 并继续灌分片，
      // 因此 owner 必须一致（owner 缺省表示调用方未认证，保持旧行为）
      (owner === undefined || s.owner === undefined || s.owner === owner)
    ) {
      return s
    }
  }
  return undefined
}

export function putSession(s: MultipartSession): void {
  sessions.set(s.upload_id, s)
}

export function deleteSession(uploadId: string): void {
  sessions.delete(uploadId)
}

/** 生成 upload_id */
export function newUploadId(): string {
  const rnd =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `mp_${rnd}`
}

/**
 * 清理过期会话。此前定义了却从未被调用，于是 Map 只增不减；同时补上对
 * receiving 会话的回收——攻击者只要反复 init 而不传分片，就能把条目堆到 isolate
 * 内存里。
 */
export function pruneSessions(
  maxAgeMs = 60 * 60 * 1000,
  receivingMaxAgeMs = 6 * 60 * 60 * 1000,
): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    const age = now - s.created_at
    if ((s.state === "completed" || s.state === "aborted") && age > maxAgeMs) {
      sessions.delete(id)
      continue
    }
    if (
      (s.state === "receiving" ||
        s.state === "failed_retriable" ||
        s.state === "failed_permanent") &&
      age > receivingMaxAgeMs
    ) {
      sessions.delete(id)
    }
  }
}
