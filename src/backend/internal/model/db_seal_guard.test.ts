import assert from "node:assert/strict"
import { test } from "node:test"

/**
 * 字段加密（enc:v1: 封套）安全回归测试。
 *
 * 锁定两条线上事故的防护（2026-09-19：一次部署后 admin 登录失败、存储配置以
 * 密文形态漏到前端，报 `Unexpected token 'e', "enc:v1:b0c"... is not valid JSON`）：
 *
 *  1. **sealDb 必须幂等**：AES-GCM 每次随机 IV，把一个已是封套的值再封一层，
 *     解密只能剥掉外层，剩下的是密文 —— 属于不可逆数据损坏。任何一次
 *     「未解密的读 + 随后的写」都不允许造成这个结果。
 *  2. **读到密文却没有密钥时禁止写回**：`dbTrusted=false` 只拦「空壳落盘」，
 *     带存储的正常载荷要靠 `isDbSealedReadUntrusted()` 单独拦，并且必须留下
 *     可诊断的日志 —— 否则线上只会表现为「莫名登录失败」。
 */

const mod = await import("./db")
const {
  getDb,
  saveDb,
  isDbTrusted,
  isDbWriteBlocked,
  isDbSealedReadUntrusted,
  getDbLoadError,
  __resetDbCacheForTest,
  __setStoreBackendLoaderForTest,
} = mod as any

const KEY = "seal-guard-test-secret-0123456789abcdef"
const ADDITION = JSON.stringify({ cookie: "session-token", root_folder_id: "/1" })

/** 有密钥 / 无密钥两种 env。DB_DRIVER=memory 让密钥回退查询确定性地落空。 */
const envWithKey = () =>
  ({ DB_DRIVER: "memory", JWT_SECRET: KEY }) as any
const envNoKey = () => ({ DB_DRIVER: "memory" }) as any

function fakeBackend(initial: any) {
  let data = initial ? JSON.parse(JSON.stringify(initial)) : null
  const backend = {
    name: "fake",
    isConfigured: async () => true,
    load: async () => (data ? JSON.parse(JSON.stringify(data)) : null),
    save: async (next: any) => {
      data = JSON.parse(JSON.stringify(next))
      return true
    },
  }
  return { backend, peek: () => data }
}

const payload = () => ({
  settings: [{ key: "site_title", value: "OpenList" }],
  users: [{ id: 1, username: "admin", role: 2, password: "hash-value" }],
  storages: [
    { id: 1, mount_path: "/x", driver: "alias", addition: ADDITION, enabled: true },
  ],
  shares: [],
  metas: [],
  plugins: [],
})

test("sealDb 幂等：连续保存不会把封套再封一层", async () => {
  const { backend, peek } = fakeBackend(null)

  __resetDbCacheForTest()
  __setStoreBackendLoaderForTest(async () => backend)
  assert.equal(await saveDb(payload(), envWithKey(), { force: true }), true)
  assert.ok(
    String(peek().storages[0].addition).startsWith("enc:v1:"),
    "首次保存应把 addition 加密落盘",
  )

  // 读回（解密）→ 再保存一次，模拟后台任意一次普通编辑保存
  __resetDbCacheForTest()
  __setStoreBackendLoaderForTest(async () => backend)
  const loaded = await getDb(envWithKey())
  assert.equal(loaded.storages[0].addition, ADDITION, "读回应是明文")
  assert.equal(await saveDb(loaded, envWithKey()), true, "可信状态下的保存应放行")

  // 关键断言：仍必须能一层解开。若被二次加密，这里拿到的会是 enc:v1: 密文。
  __resetDbCacheForTest()
  __setStoreBackendLoaderForTest(async () => backend)
  const again = await getDb(envWithKey())
  assert.equal(
    again.storages[0].addition,
    ADDITION,
    "二次保存后必须仍能一层解开（未二次加密）",
  )
})

test("双钥解密：旧密钥封存的数据可读，写入后自动迁移到新密钥", async () => {
  const LEGACY = "legacy-key-0000000000000000000000000000000000000000000000000000a"
  const NEW = "new-key-10000000000000000000000000000000000000000000000000000000b"

  // 1. 用旧密钥封存（模拟历史部署：字段加密密钥来源是 ENCRYPTION_SECRET）
  const { backend, peek } = fakeBackend(null)
  __resetDbCacheForTest()
  __setStoreBackendLoaderForTest(async () => backend)
  assert.equal(
    await saveDb(payload(), { JWT_SECRET: LEGACY } as any, { force: true }),
    true,
  )
  const sealed = String(peek().storages[0].addition)
  assert.ok(sealed.startsWith("enc:v1:"), "前置条件：已用旧密钥封存")

  // 2. 新密钥 + 保留旧密钥：必须能解开（否则线上就是「登录失败 + 密文漏给前端」）
  __resetDbCacheForTest()
  __setStoreBackendLoaderForTest(async () => backend)
  const mixedEnv = { JWT_SECRET: NEW, ENCRYPTION_SECRET: LEGACY } as any
  const loaded = await getDb(mixedEnv)
  assert.equal(loaded.storages[0].addition, ADDITION, "旧密钥封存的值应被回退解密")

  // 3. 再保存一次应迁移到新密钥
  assert.equal(await saveDb(loaded, mixedEnv), true)
  assert.notEqual(
    String(peek().storages[0].addition),
    sealed,
    "迁移后密文应发生变化",
  )

  // 4. 只配新密钥的实例也必须能解开，说明迁移完成
  __resetDbCacheForTest()
  __setStoreBackendLoaderForTest(async () => backend)
  const migrated = await getDb({ JWT_SECRET: NEW } as any)
  assert.equal(
    migrated.storages[0].addition,
    ADDITION,
    "迁移后仅用新密钥即可解开",
  )
})

test("读到密文却无密钥：标记不可信、禁止写回并留下诊断信息", async () => {
  // 先用带密钥的 env 造出真实的封套数据
  const first = fakeBackend(null)
  __resetDbCacheForTest()
  __setStoreBackendLoaderForTest(async () => first.backend)
  assert.equal(await saveDb(payload(), envWithKey(), { force: true }), true)
  const sealedRaw = JSON.parse(JSON.stringify(first.peek()))
  assert.ok(
    String(sealedRaw.storages[0].addition).startsWith("enc:v1:"),
    "前置条件：库里应有 enc:v1: 封套",
  )

  // 换一个「没有 JWT_SECRET」的 isolate 读同一份密文
  const second = fakeBackend(sealedRaw)
  __resetDbCacheForTest()
  __setStoreBackendLoaderForTest(async () => second.backend)
  const env = envNoKey()
  const loaded = await getDb(env)

  assert.ok(
    String(loaded.storages[0].addition).startsWith("enc:v1:"),
    "无密钥时读到的仍是未解密密文",
  )
  assert.equal(isDbTrusted(), false, "未解密状态不得标记可信")
  assert.equal(isDbSealedReadUntrusted(), true, "应记录「密文未解密」状态")
  assert.match(
    String(getDbLoadError()),
    /encryption key unavailable/,
    "应留下可诊断的读取错误",
  )

  // 核心：此时写回必须被拒绝，否则就是把密文再封一层
  assert.equal(
    await saveDb(loaded, env),
    false,
    "未解密的读取必须拒绝写回，避免二次加密",
  )
  assert.equal(isDbWriteBlocked(), true, "守卫应记录本次拦截")
  assert.equal(
    second.peek().storages[0].addition,
    sealedRaw.storages[0].addition,
    "被拦截后存储内容不得被改写",
  )
})
