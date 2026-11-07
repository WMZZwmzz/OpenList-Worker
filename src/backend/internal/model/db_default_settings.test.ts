import assert from "node:assert/strict"
import { test } from "node:test"

/**
 * 回归测试（F-069）：ensureDefaultSettings 不得对非字符串的 setting.value
 * 调用 .trim()。
 *
 * 复现的历史故障：
 *   1. POST /admin/setting/save 只对 object 做 JSON.stringify，number / boolean
 *      原样入库（例如 default_page_size = 20）。
 *   2. loadDb() 内 ensureDefaultSettings 用 `s.value && s.value.trim() !== ""`
 *      选值 → 对数字抛 TypeError → 被 loadDb 的 catch 当成「读取失败」。
 *   3. 结果是 dbTrusted=false + 返回默认空壳：所有 storages / users / 真实设置
 *      在内存中消失；管理员再改一个设置就能让空壳通过写前守卫并覆盖真实配置。
 *
 * 断言口径：非字符串 value 必须被视为「有值」，读取必须成功（dbTrusted=true），
 * 且真实数据完整保留。
 */

function freshEnv(): any {
  return {
    DB_DRIVER: "auto",
    DB_FORMAT: "map",
    JWT_SECRET: "test-secret-for-default-settings",
    ENCRYPTION_SECRET: "test-secret-for-default-settings",
  }
}

test("ensureDefaultSettings: number/boolean 的 value 不会让整库读取失败", async () => {
  const db = await import("./db")
  db.__resetDbCacheForTest()

  const persisted = {
    settings: [
      // 重复键：旧的空串在前、真实值在后 —— 仍应选中真实值
      { key: "site_title", value: "" },
      { key: "site_title", value: "MySite" },
      // 以下两项在修复前会让 .trim() 抛 TypeError
      { key: "default_page_size", value: 20 },
      { key: "allow_indexed", value: false },
    ],
    storages: [{ id: 1, mount_path: "/real", driver: "local" }],
    users: [
      { id: 1, username: "admin", role: 2, password: "hash", permission: 0 },
    ],
    shares: [],
    metas: [],
    plugins: [],
  }

  let saveCalls = 0
  db.__setStoreBackendLoaderForTest(async () => ({
    name: "stub",
    load: async () => JSON.parse(JSON.stringify(persisted)),
    save: async () => {
      saveCalls += 1
      return true
    },
    isConfigured: async () => true,
    health: async () => ({ connected: true }),
  }))

  try {
    const loaded: any = await db.getDb(freshEnv())

    // 修复前：读取被判定为失败，dbTrusted=false 且返回空壳（storages=0）。
    assert.equal(db.isDbTrusted(), true, "含非字符串设置值的库必须读取成功")
    assert.equal(loaded.storages.length, 1, "真实存储不得被空壳替换")
    assert.equal(loaded.storages[0].mount_path, "/real")
    assert.equal(loaded.users.length, 1)
    assert.equal(loaded.users[0].username, "admin")

    const byKey = new Map<string, any>(
      loaded.settings.map((s: any) => [s.key, s.value]),
    )
    assert.equal(byKey.get("site_title"), "MySite", "重复键应选中非空值")
    assert.equal(byKey.get("default_page_size"), 20, "数字值必须原样保留")
    assert.equal(byKey.get("allow_indexed"), false, "布尔值必须原样保留")

    // 读取路径不得产生隐式写入（空壳回填的历史缺陷）
    assert.equal(saveCalls, 0, "getDb() 不得隐式 save")
  } finally {
    db.__resetDbCacheForTest()
  }
})
