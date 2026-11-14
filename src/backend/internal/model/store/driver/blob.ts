/**
 * Blob 驱动：EdgeOne Blob Storage / ESA Blob
 * 
 * EdgeOne Blob 使用 SDK 方式（不是 binding）
 * ESA Blob 使用 binding 方式
 */
import type { Driver } from "../types"

/**
 * 判断对象是否具备 Blob binding 的接口形态。
 *
 * 与 KV 同理，必须做接口校验：环境变量可能只是「绑定名」字符串，
 * 而非绑定对象本身；直接当作 binding 使用会得到
 * "xxx.get is not a function"。
 */
function isBlobLike(b: any): boolean {
  if (!b || typeof b !== "object") return false
  // 属性访问可能触发异常 getter，任何异常都视为「不是可用绑定」。
  try {
    // ESA Blob 至少需要读取能力
    if (typeof b.get !== "function") return false
    return typeof b.put === "function" || typeof b.set === "function"
  } catch {
    return false
  }
}

/**
 * 检测 ESA Blob binding（阿里云）。
 *
 * env 与 globalThis 独立检查：env 为真值时不应阻断对 globalThis 的探测。
 */
function getEsaBlobBinding(env?: any): any | null {
  const g = globalThis as any

  const fromEnv = env?.ESA_BLOB
  if (isBlobLike(fromEnv)) return fromEnv

  const fromGlobal = g?.ESA_BLOB
  if (isBlobLike(fromGlobal)) return fromGlobal

  return null
}

/**
 * 获取 EdgeOne Blob Store（使用 SDK）。
 *
 * A-16：store 名必须与 legacy 实现（internal/model/store/json.ts）一致——
 * `openlist_db` + strong consistency。历史新驱动固定 `getStore("default")`，
 * 从 legacy 升级后读到空库，进而可能触发重新初始化并覆盖真实配置。
 */
async function getEdgeOneStore(namespace: string = "openlist_db"): Promise<any | null> {
  try {
    const { getStore } = await import("@edgeone/pages-blob")
    return getStore({ name: namespace, consistency: "strong" } as any)
  } catch {
    return null
  }
}

/**
 * 判断异常是否表示「对象不存在」。
 *
 * D-2 的关键：`get` 必须区分「确实没有这个 key」与「读取失败」。早期实现对
 * 所有异常一律 `return null`，上层（map.load → loadDb）就会把**读取故障**
 * 当成「全新空库」，`/public/init/setup` 于是可以匿名重建管理员并覆盖整库。
 * 只有明确的 not-found 才算不存在；其余异常必须抛出去，让 loadDb 置
 * dbLastLoadError。
 */
function isNotFoundError(err: any): boolean {
  const code = String(err?.code ?? err?.name ?? "")
  const message = String(err?.message ?? err ?? "")
  const status = Number(err?.status ?? err?.statusCode ?? 0)
  if (status === 404) return true
  return /not\s*found|no\s+such\s+(key|object|blob)|NOSUCHKEY|NotFound|404/i.test(
    `${code} ${message}`,
  )
}

function throwReadFailure(platform: string, key: string, err: any): never {
  const reason = err?.message || String(err)
  console.error(`[Blob] ${platform} get key="${key}" failed:`, reason)
  throw new Error(`blob read failed (${platform}, key="${key}"): ${reason}`)
}

export const blobDriver: Driver = {
  name: "blob",

  async isAvailable(env?: any): Promise<boolean> {
    // 检查 ESA Blob binding
    if (getEsaBlobBinding(env) !== null) {
      return true
    }
    
    // 检查 EdgeOne Blob SDK
    const store = await getEdgeOneStore()
    return store !== null
  },

  async init(env?: any): Promise<void> {
    // Blob 无需初始化
  },

  async get(key: string, env?: any): Promise<string | null> {
    // 优先使用 ESA Blob binding
    const esaBlob = getEsaBlobBinding(env)
    if (esaBlob) {
      try {
        const obj = await esaBlob.get(key)
        if (!obj) return null
        return await obj.text() // ESA Blob 返回对象，需要 .text()
      } catch (err) {
        if (isNotFoundError(err)) return null
        throwReadFailure("ESA", key, err)
      }
    }

    // 使用 EdgeOne Blob SDK
    const store = await getEdgeOneStore()
    if (!store) throw new Error("Blob not available")

    try {
      // EdgeOne SDK 默认 type="text" 返回字符串
      const v = await store.get(key)
      if (v == null) return null
      return typeof v === "string" ? v : JSON.stringify(v)
    } catch (err) {
      if (isNotFoundError(err)) return null
      throwReadFailure("EdgeOne", key, err)
    }
  },

  async put(key: string, value: string, env?: any): Promise<void> {
    // 优先使用 ESA Blob binding
    const esaBlob = getEsaBlobBinding(env)
    if (esaBlob) {
      await esaBlob.put(key, value)
      return
    }
    
    // 使用 EdgeOne Blob SDK（注意：SDK 方法是 set，不是 put）
    const store = await getEdgeOneStore()
    if (!store) throw new Error("Blob not available")
    
    await store.set(key, value)
  },

  async delete(key: string, env?: any): Promise<void> {
    // 优先使用 ESA Blob binding
    const esaBlob = getEsaBlobBinding(env)
    if (esaBlob) {
      await esaBlob.delete(key)
      return
    }
    
    // 使用 EdgeOne Blob SDK
    const store = await getEdgeOneStore()
    if (!store) throw new Error("Blob not available")
    
    await store.delete(key)
  },

  async list(prefix: string, env?: any): Promise<string[]> {
    // 优先使用 ESA Blob binding
    const esaBlob = getEsaBlobBinding(env)
    if (esaBlob) {
      // F-089：移植 kv.ts 针对 issue #125 的三层防护 ——
      //   - 空页即终止（不能假设平台一定会给「末页」标记）；
      //   - 重复页检测（首键与上一页相同 = 游标没推进）；
      //   - guard 迭代上限（游标恒非空时无界重发真实子请求会打满配额）。
      // 历史实现是裸 `do { ... } while (cursor)`：一旦平台返回不推进的游标
      // （或忽略 cursor），就会无限重发同一页并无限累积重复键。
      const seen = new Set<string>()
      let cursor: string | undefined
      let guard = 0
      let prevFirstKey: string | null = null

      while (guard < 1000) {
        guard += 1
        const result = await esaBlob.list({ prefix, cursor })
        const pageKeys = Array.isArray(result?.keys) ? result.keys : []

        // 空页视为末页
        if (pageKeys.length === 0) break

        // 只接受字符串 name（与 kv.ts 的类型过滤一致）
        const names: string[] = []
        for (const item of pageKeys) {
          const name = typeof (item as any)?.name === "string" ? (item as any).name : null
          if (name) names.push(name)
        }
        if (names.length === 0) break

        if (prevFirstKey !== null && names[0] === prevFirstKey) {
          console.warn("[Blob] repeated page detected; stopping list pagination")
          break
        }
        prevFirstKey = names[0]

        for (const name of names) seen.add(name)

        const nextCursor = result?.cursor
        if (!nextCursor || nextCursor === cursor) break
        cursor = nextCursor
      }

      return [...seen]
    }
    
    // 使用 EdgeOne Blob SDK
    const store = await getEdgeOneStore()
    if (!store) throw new Error("Blob not available")
    
    // 文档：list({ prefix, paginate: true }) 自动聚合所有分页，返回 { blobs: [{ key, etag }] }
    const result = await store.list({ prefix, paginate: true })
    return (result?.blobs || []).map((b: any) => b.key)
  },

  async health(env?: any): Promise<any> {
    const esaBlob = getEsaBlobBinding(env)
    const edgeOneStore = await getEdgeOneStore()
    
    if (esaBlob) {
      try {
        // F-085：探测用 `get`（空安全），而不是 `head("__health_check__")`。
        //
        // 全仓库从来没有写入过 __health_check__，而 ESA 读取不存在的键会抛
        // not-found（本文件 get() 自己就专门处理了这一点）。历史实现直接 head
        // 且不区分异常类型：not-found 落入 catch → available:false → 全局 503
        // （ESA 默认主存储）；若平台改为静默返回 null，这条探测又什么都没验证。
        // 现在与 get 的语义对齐：not-found 视为「健康（能读）」，其余异常才算故障
        // —— 注意 get 的回退分支同样可用：读取调用本身成功即证明绑定可用。
        const obj = await esaBlob.get("__health_check__")
        void obj
        return {
          driver: "blob",
          platform: "ESA Blob (binding)",
          available: true,
        }
      } catch (err: any) {
        if (isNotFoundError(err)) {
          return {
            driver: "blob",
            platform: "ESA Blob (binding)",
            available: true,
          }
        }
        return {
          driver: "blob",
          platform: "ESA Blob (binding)",
          available: false,
          error: err?.message || String(err),
        }
      }
    }
    
    if (edgeOneStore) {
      try {
        // EdgeOne SDK 没有 head 方法，用 get 测试（不存在不报错）
        await edgeOneStore.get("__health_check__")
        return {
          driver: "blob",
          platform: "EdgeOne Blob (SDK)",
          available: true,
        }
      } catch (err: any) {
        return {
          driver: "blob",
          platform: "EdgeOne Blob (SDK)",
          available: false,
          error: err?.message || String(err),
        }
      }
    }
    
    return {
      driver: "blob",
      available: false,
      error: "No Blob storage available",
    }
  },
}
