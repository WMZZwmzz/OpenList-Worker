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
 * 获取 EdgeOne Blob Store（使用 SDK）
 */
async function getEdgeOneStore(namespace: string = "default"): Promise<any | null> {
  try {
    const { getStore } = await import("@edgeone/pages-blob")
    return getStore(namespace)
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
      const keys: string[] = []
      let cursor: string | undefined

      do {
        const result = await esaBlob.list({ prefix, cursor })
        keys.push(...(result?.keys || []).map((k: any) => k.name))
        cursor = result?.cursor
      } while (cursor)

      return keys
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
        await esaBlob.head("__health_check__")
        return {
          driver: "blob",
          platform: "ESA Blob (binding)",
          available: true,
        }
      } catch (err: any) {
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
