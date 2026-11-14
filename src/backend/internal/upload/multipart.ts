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
 * - **部署限制（F-010）**：`/fs/multipart/*` 的会话不跨 isolate/进程，因此可靠的
 *   断点续传只在「单实例 / 有会话粘性」的部署上成立。CF Workers、EdgeOne、Vercel
 *   这类无会话亲和的多 isolate 运行时上，init 与后续 chunk/complete 可能落到不同
 *   实例，表现为 404 "upload session not found"。要做真正的跨实例续传，必须把
 *   会话落到 KV/D1/DO（并让 fs.ts 在 chunk/complete 时按 upload_id 回读），或把
 *   driver_session 令牌下发客户端保存、chunk 时回传重建——两者都需要 fs.ts 侧
 *   的接线，不在本模块范围内。
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
  /**
   * 会话所有者的用户 id。
   *
   * 安全不变量：分片会话是**用户私有状态**，续传/完成/查询都必须校验所有者。
   * 历史缺陷：会话只按 `path + size` 复用，不含用户维度，导致不同用户（即使
   * base_path 不同）会命中同一个会话并互相续传（实测：两个不同根目录的用户
   * 拿到同一个 upload_id，且 resumed=true）。
   */
  owner_id?: number
  /** 创建会话时的用户根目录，用于校验会话未被跨根复用 */
  owner_root?: string
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
/**
 * A-64：单个 isolate 内的会话数量上限。每个会话都持有 received Set 与
 * partMd5s 数组，无上限时持写权限的用户可反复 init 打满内存。
 */
export const MAX_SESSIONS = 1000

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

/**
 * 第 idx 个分片的实际字节数。除最后一片外恒为 chunk_size，最后一片为剩余量
 * （size - idx*chunk_size）。越界 index（脏数据）计 0，绝不让统计值超过 size。
 */
export function chunkLengthOf(
  s: Pick<MultipartSession, "size" | "chunk_size" | "total_chunks">,
  idx: number,
): number {
  if (!Number.isInteger(idx) || idx < 0 || idx >= s.total_chunks) return 0
  const start = idx * s.chunk_size
  const remaining = s.size - start
  if (!Number.isFinite(remaining) || remaining <= 0) return 0
  return Math.min(s.chunk_size, remaining)
}

export function snapshot(s: MultipartSession): MultipartSnapshot {
  const intervals = intervalsOf(s.received)
  // F-117：received_bytes 必须按**每个分片的实际字节数**累加，不能简单乘
  // chunk_size —— 最后一片通常不足 chunk_size（15MB 文件按 10MB 分片，两片收完
  // 原生实现会报 20MB），进度会超过文件真实大小。
  let receivedBytes = 0
  for (const idx of s.received) {
    receivedBytes += chunkLengthOf(s, idx)
  }
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

/**
 * 查找同 owner + path + size 的未完成会话（用于断点续传）。
 *
 * `ownerId` 必填：会话必须按所有者隔离，否则不同用户会共享同一上传会话并拿到
 * 同一 upload_id 继续灌分片。未绑定所有者的历史会话不再被复用，避免跨用户命中。
 */
export function findReceivingSession(
  path: string,
  size: number,
  ownerId?: number,
): MultipartSession | undefined {
  if (ownerId === undefined) return undefined
  for (const s of sessions.values()) {
    if (s.owner_id !== ownerId) continue
    if (
      s.path === path &&
      s.size === size &&
      (s.state === "receiving" || s.state === "failed_retriable")
    ) {
      return s
    }
  }
  return undefined
}

export function putSession(s: MultipartSession): void {
  // A-64：会话数量上限（先尝试清理过期会话，仍满则拒绝）。
  if (!sessions.has(s.upload_id) && sessions.size >= MAX_SESSIONS) {
    pruneSessions()
    if (sessions.size >= MAX_SESSIONS) {
      throw new Error(
        `too many upload sessions (limit ${MAX_SESSIONS}); finish or abort existing uploads first`,
      )
    }
  }
  const limit = sessionLimitError(s)
  if (limit) {
    // 越界会话不得进入内存 Map：MAX_UPLOAD_BYTES / MAX_TOTAL_CHUNKS 此前只被
    // 测试引用，生产路径完全没有护栏（F-114）。这里在会话入库的唯一入口拒绝。
    throw new Error(limit)
  }
  sessions.set(s.upload_id, s)
  // F-114：pruneSessions 原先只在测试里被调用，被放弃/失败的会话永久滞留。
  // putSession 是所有 init/chunk 的公共入口（fs.ts 每次写入都会经过这里），
  // 在这里按分钟节流执行一次清扫，无需给 fs.ts 增加调用点，也没有定时器。
  maybePruneSessions()
}

/**
 * 校验会话规模是否符合硬上限。返回错误文案，合规时返回 null。
 *
 * 单独导出便于 fs.ts / 测试在分配 `new Array(total_chunks)` **之前**校验，
 * 避免先分配再拒绝。
 */
export function sessionLimitError(
  s: Pick<MultipartSession, "size" | "chunk_size" | "total_chunks">,
): string | null {
  if (!Number.isFinite(s.size) || s.size <= 0) return "invalid upload size"
  if (s.size > MAX_UPLOAD_BYTES) {
    return `upload size exceeds MAX_UPLOAD_BYTES (${MAX_UPLOAD_BYTES})`
  }
  if (!Number.isInteger(s.chunk_size) || s.chunk_size <= 0) {
    return "invalid chunk size"
  }
  if (
    !Number.isInteger(s.total_chunks) ||
    s.total_chunks < 1 ||
    s.total_chunks > MAX_TOTAL_CHUNKS
  ) {
    return `total_chunks exceeds MAX_TOTAL_CHUNKS (${MAX_TOTAL_CHUNKS})`
  }
  return null
}

const PRUNE_INTERVAL_MS = 60_000
let lastPruneAt = 0

/** 节流清扫：距上次超过 PRUNE_INTERVAL_MS 才真正遍历 Map。 */
function maybePruneSessions(): void {
  const now = Date.now()
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now
  pruneSessions()
}

/** 仅供测试：重置节流计时，让下一次 putSession 触发清扫。 */
export function __resetPruneThrottleForTest(): void {
  lastPruneAt = 0
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
