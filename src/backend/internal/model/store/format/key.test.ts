import assert from "node:assert/strict"
import { test } from "node:test"
import type { Driver } from "../types"
import {
  keyFormat,
  keyFormatListCompletenessProven,
  mayUnderReportList,
} from "./key"

/**
 * key 格式回归测试（QS-1 / F-084）。
 *
 * QS-1（P1）：KV 族后端的 list 是最终一致的。多实例下 `list` 会暂时漏报其他实例
 * 刚写入的键；差集删除把「不在快照里」的键当陈旧数据删掉，真实用户/存储记录被
 * 静默永久删除。审计给出了 3/3 复现。
 *
 * F-084：初始化标记位于保存序列末尾时，首次保存中途失败会留下「有数据、无标记」
 * 的库，load 返回 null → 匿名 /init/setup 重新开放。
 */

type FakeKv = {
  driver: Driver
  store: Map<string, string>
  /** 模拟最终一致性：这些键对 list 暂时不可见 */
  hiddenFromList: Set<string>
  deleted: string[]
  putOrder: string[]
}

function createFakeKv(name: string): FakeKv {
  const store = new Map<string, string>()
  const hiddenFromList = new Set<string>()
  const deleted: string[] = []
  const putOrder: string[] = []

  const driver: Driver = {
    name,
    isAvailable: async () => true,
    init: async () => {},
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      putOrder.push(key)
      store.set(key, value)
    },
    delete: async (key: string) => {
      deleted.push(key)
      store.delete(key)
    },
    list: async (prefix: string) =>
      [...store.keys()].filter(
        (k) => k.startsWith(prefix) && !hiddenFromList.has(k),
      ),
    health: async () => ({ connected: true }),
  }

  return { driver, store, hiddenFromList, deleted, putOrder }
}

const DB_SNAPSHOT = {
  settings: [{ key: "site_title", value: "OpenList" }],
  users: [{ id: 1, username: "admin", role: 2, password: "hash" }],
  storages: [
    { id: 1, mount_path: "/s1", driver: "onedrive" },
    { id: 2, mount_path: "/s2", driver: "webdav" },
  ],
  shares: [{ id: "sh1", files: ["/s1/a.txt"] }],
  metas: [] as any[],
  plugins: [] as any[],
}

/** 把一份快照直接写进「远端」（模拟其他实例已落盘的真实数据）。 */
function seedRemote(fake: FakeKv, data: any): void {
  fake.store.set("openlist_config", String(Date.now()))
  const ids: Record<string, string> = {
    settings: "key",
    users: "id",
    storages: "id",
    shares: "id",
    metas: "id",
    plugins: "id",
  }
  for (const [table, records] of Object.entries(data)) {
    for (const rec of records as any[]) {
      const id = String(rec?.[ids[table] ?? "id"] ?? "")
      if (!id) continue
      fake.store.set(`${table}_${id}`, JSON.stringify(rec))
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

/**
 * QS-1 的三种「漏报一个键」场景：漏报后的实例 load 到的快照缺一条记录，
 * 之后带传播到达的完整 list 做一次 save。
 */
const MISSED_KEY_CASES: Array<{
  name: string
  missingKey: string
  mutate: (snapshot: any) => void
  expectKept: (reloaded: any) => void
}> = [
  {
    name: "漏报 storages_2（存储记录）",
    missingKey: "storages_2",
    mutate: (snapshot) => {
      snapshot.settings[0].value = "Renamed"
      snapshot.storages[0].order = 9
    },
    expectKept: (reloaded) => {
      assert.deepEqual(
        reloaded.storages.map((s: any) => s.id).sort(),
        [1, 2],
        "被漏报的存储记录必须仍然存在",
      )
    },
  },
  {
    name: "漏报 shares_sh1（分享记录）",
    missingKey: "shares_sh1",
    mutate: (snapshot) => {
      snapshot.users[0].username = "admin2"
    },
    expectKept: (reloaded) => {
      assert.equal(reloaded.shares.length, 1, "被漏报的分享记录必须仍然存在")
      assert.equal(reloaded.shares[0].id, "sh1")
    },
  },
  {
    name: "漏报 users_1（用户记录）",
    missingKey: "users_1",
    mutate: (snapshot) => {
      snapshot.settings.push({ key: "new_setting", value: "1" })
    },
    expectKept: (reloaded) => {
      assert.equal(reloaded.users.length, 1, "被漏报的用户记录必须仍然存在")
      assert.equal(reloaded.users[0].username, "admin")
    },
  },
]

for (const c of MISSED_KEY_CASES) {
  test(`QS-1: KV 最终一致漏报后 save 不得删除真实键 —— ${c.name}`, async () => {
    const fake = createFakeKv("kv")
    seedRemote(fake, DB_SNAPSHOT)

    // 实例 I2：list 暂时看不到该键（最终一致性）
    fake.hiddenFromList.add(c.missingKey)
    const partial = await keyFormat.load(fake.driver)
    assert.ok(partial, "load 应成功（标记存在）")

    // 传播到达：之后的 list 能看到全部键（正是历史上触发误删的时刻）
    fake.hiddenFromList.clear()

    c.mutate(partial)
    assert.equal(await keyFormat.save(partial, fake.driver), true)

    assert.ok(
      fake.store.has(c.missingKey),
      `${c.missingKey} 不得被删除（这正是 QS-1 的数据丢失路径）`,
    )
    assert.ok(
      !fake.deleted.includes(c.missingKey),
      `delete() 不得作用于未观察到的键 ${c.missingKey}`,
    )

    // 再读一次应能看到完整数据（没有记录消失）
    const reloaded = await keyFormat.load(fake.driver)
    c.expectKept(reloaded)
  })
}

test("QS-1 对照：强一致驱动仍按差集清理（证明测试能检出误删）", async () => {
  // 强一致后端（d1）不会漏报；这里故意构造漏报以证明「没有护栏时会删除」，
  // 从而确保上面的用例不是在空跑。
  const fake = createFakeKv("d1")
  seedRemote(fake, DB_SNAPSHOT)

  fake.hiddenFromList.add("storages_2")
  const partial = await keyFormat.load(fake.driver)
  fake.hiddenFromList.clear()

  await keyFormat.save(partial, fake.driver)
  assert.equal(
    fake.store.has("storages_2"),
    false,
    "对照：强一致路径仍会差集删除（这正是 KV 上必须加护栏的原因）",
  )
})

test("QS-1: 正常删除语义不受影响（观察过的键仍会被清理）", async () => {
  const fake = createFakeKv("kv")
  seedRemote(fake, DB_SNAPSHOT)

  const loaded = await keyFormat.load(fake.driver)
  assert.equal(loaded.storages.length, 2)

  // 管理员删除存储 2：快照里不再包含它
  loaded.storages = loaded.storages.filter((s: any) => s.id !== 2)
  await keyFormat.save(loaded, fake.driver)

  assert.equal(fake.store.has("storages_2"), false, "被删除的实体必须真正删除")
  const reloaded = await keyFormat.load(fake.driver)
  assert.deepEqual(reloaded.storages.map((s: any) => s.id), [1])
})

test("QS-1: 完整性可证明性按驱动区分（dbTrusted 的输入）", () => {
  assert.equal(mayUnderReportList({ name: "kv" } as any), true)
  assert.equal(mayUnderReportList({ name: "cfkv" } as any), true)
  assert.equal(mayUnderReportList({ name: "d1" } as any), false)
  assert.equal(mayUnderReportList({ name: "mysql" } as any), false)
  assert.equal(mayUnderReportList({ name: "memory" } as any), false)

  assert.equal(keyFormatListCompletenessProven({ name: "kv" } as any), false)
  assert.equal(keyFormatListCompletenessProven({ name: "cfkv" } as any), false)
  assert.equal(keyFormatListCompletenessProven({ name: "d1" } as any), true)
})

test("F-084: 标记缺失但已有表键时不得被当作全新空库", async () => {
  const fake = createFakeKv("kv")
  // 模拟「首次保存中途失败」：数据键已写入，INIT_MARK 从未写成
  fake.store.set("storages_1", JSON.stringify({ id: 1, mount_path: "/s1" }))

  await assert.rejects(
    () => keyFormat.load(fake.driver),
    /init marker .* is missing/i,
    "有数据但无标记必须报错，不能静默呈现为全新空库",
  )
})

test("F-084: 真正的全新空库（无标记、无键）仍返回 null", async () => {
  const fake = createFakeKv("kv")
  assert.equal(await keyFormat.load(fake.driver), null)
})

test("F-084: 标记是写入序列的第一步（首写失败不会留下无标记的库）", async () => {
  const fake = createFakeKv("kv")
  await keyFormat.save(clone(DB_SNAPSHOT), fake.driver)

  assert.equal(fake.putOrder[0], "openlist_config", "标记必须先行")
  assert.ok(fake.store.has("openlist_config"))
})
