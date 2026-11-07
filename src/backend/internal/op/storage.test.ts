import assert from "node:assert/strict"
import { test } from "node:test"

import type { StorageDriver } from "../driver/base"
import { getDb, saveDb } from "../model/db"
import { Driver115 } from "../../drivers/115/driver"
import { Pan115Driver } from "../../drivers/115open/driver"
import { Pan115ShareDriver } from "../../drivers/115_share/driver"
import { Pan123ShareDriver } from "../../drivers/123_share/driver"
import { AliyundriveShareDriver } from "../../drivers/aliyundrive_share/driver"
import { OnedriveSharelinkDriver } from "../../drivers/onedrive_sharelink/driver"
import { PikPakShareDriver } from "../../drivers/pikpak_share/driver"
import { QuarkDriver } from "../../drivers/quark/driver"
import { VirtualDriver } from "../../drivers/virtual/driver"
import {
  createDriver,
  flushPendingDriverState,
  fsSingleflightKey,
  getItem,
  getOrCreateDriver,
  moveItems,
  renameItem,
  scheduleStoragePersistence,
} from "./storage"

test("concurrent driver initialization shares one Promise", async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const driver = {} as StorageDriver
  const cache = new Map<string, Promise<StorageDriver>>()

  const factory = async () => {
    calls++
    await gate
    return driver
  }

  const first = getOrCreateDriver(cache, "189-1", factory)
  const second = getOrCreateDriver(cache, "189-1", factory)
  release()

  assert.equal(await first, driver)
  assert.equal(await second, driver)
  assert.equal(calls, 1)
})

test("Worker persistence is scheduled instead of awaited", async () => {
  let resolvePersistence!: () => void
  const persistence = new Promise<void>(
    (resolve) => (resolvePersistence = resolve),
  )
  let scheduled: Promise<unknown> | undefined

  await scheduleStoragePersistence((task) => {
    scheduled = task
  }, persistence)

  assert.equal(scheduled, persistence)
  resolvePersistence()
  await scheduled
})

test("Node persistence is awaited without waitUntil", async () => {
  let completed = false
  const persistence = Promise.resolve().then(() => {
    completed = true
  })

  await scheduleStoragePersistence(undefined, persistence)
  assert.equal(completed, true)
})

test("mounted storage roots return without initializing the remote driver", async () => {
  // 通过公开 API 写入内存库（无持久化后端时 getDb 使用模块级 memoryDb）
  const db: any = await getDb()
  db.storages = [
    {
      id: "storage-root-fast-path",
      driver: "189Cloud",
      mount_path: "/189",
      addition: JSON.stringify({ root_folder_id: "-11" }),
      modified: "2026-08-23T00:00:00.000Z",
      disabled: false,
    },
  ]
  await saveDb(db)

  const result = await getItem("/189")
  assert.equal(result.provider, "189Cloud")
  assert.equal(result.item.name, "189")
  assert.equal(result.item.is_dir, true)
  assert.equal(result.item.sign, "-11")
})

// ---------------------------------------------------------------------------
// 驱动工厂注册表（F-090 / F-271 / A5-1）
// ---------------------------------------------------------------------------

/**
 * 驱动 init 会访问网络（115 token 校验、阿里云分享 token、OneDrive 短链），
 * 这里用可同时满足 json()/text()/url 的假响应替代，保证路由测试离线可跑。
 */
function stubDriverFetch(): () => void {
  const original = globalThis.fetch
  const body = {
    state: true,
    data: {},
    share_token: "test-share-token",
  }
  ;(globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    url: "https://example.invalid/share",
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
  return () => {
    globalThis.fetch = original
  }
}

test("F-271: 115 family names route to the intended drivers", async () => {
  const restore = stubDriverFetch()
  try {
    const legacyAddition = JSON.stringify({ access_token: "legacy-token" })
    for (const name of [
      "115",
      "115cloud",
      "115Cloud",
      "115netdisk",
      "115_netdisk",
    ]) {
      const driver = await createDriver(name, {
        driver: name,
        addition: legacyAddition,
      })
      assert.ok(
        driver instanceof Driver115,
        `${name} should instantiate Driver115, got ${driver.constructor.name}`,
      )
    }

    const openAddition = JSON.stringify({
      access_token: "open-access-token",
      refresh_token: "open-refresh-token",
    })
    for (const name of ["115Open", "115open", "115pan"]) {
      const driver = await createDriver(name, {
        driver: name,
        addition: openAddition,
      })
      assert.ok(
        driver instanceof Pan115Driver,
        `${name} should instantiate Pan115Driver, got ${driver.constructor.name}`,
      )
    }
  } finally {
    restore()
  }
})

test("F-271: unknown 115/onedrive names are rejected instead of fuzzy-matched", async () => {
  await assert.rejects(
    createDriver("115surprise", { addition: "{}" }),
    /unsupported driver/,
  )
  await assert.rejects(
    createDriver("onedrivesharelink2", { addition: "{}" }),
    /unsupported driver/,
  )
})

test("F-090: the five share driver templates instantiate their share drivers", async () => {
  const restore = stubDriverFetch()
  try {
    const cases: Array<[string, Record<string, string>, Function]> = [
      [
        "115Share",
        { share_code: "share-code", receive_code: "receive-code" },
        Pan115ShareDriver,
      ],
      [
        "115_share",
        { share_code: "share-code", receive_code: "receive-code" },
        Pan115ShareDriver,
      ],
      ["123PanShare", { sharekey: "share-key" }, Pan123ShareDriver],
      ["AliyundriveShare", { share_id: "share-id" }, AliyundriveShareDriver],
      [
        "OnedriveSharelink",
        { url: "https://1drv.ms/u/s!example" },
        OnedriveSharelinkDriver,
      ],
      ["PikPakShare", { share_id: "share-id" }, PikPakShareDriver],
    ]

    for (const [name, addition, expected] of cases) {
      const driver = await createDriver(name, {
        driver: name,
        addition: JSON.stringify(addition),
      })
      assert.ok(
        driver instanceof expected,
        `${name} should instantiate ${expected.name}, got ${driver.constructor.name}`,
      )
    }
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// F-186：同名 rename / 同目录 move 必须是 no-op，且不能落到驱动层
// ---------------------------------------------------------------------------

async function resetStorages(): Promise<void> {
  const db: any = await getDb()
  db.storages = []
  await saveDb(db)
}

test("F-186: same-name rename is a no-op and never resolves the driver", async () => {
  await resetStorages()

  // 存储表为空：没有 no-op 短路时 resolvePath 会抛 storage not found。
  await renameItem("/a.txt", "a.txt")
  await renameItem("/dir/a%20b.txt", "a b.txt")

  await assert.rejects(renameItem("/a.txt", "b.txt"), /storage not found/)
})

test("F-186: moving into the same directory is a no-op", async () => {
  await resetStorages()

  await moveItems("/dir", "/dir", ["a.txt"])
  await moveItems("/dir/", "/dir", ["a.txt"])
  await moveItems("/dir", "/dir/", ["a.txt", "b.txt"])

  await assert.rejects(
    moveItems("/dir", "/other", ["a.txt"]),
    /storage not found/,
  )
})

// ---------------------------------------------------------------------------
// F-186 加固（复核建议）：目录 move 进自身子树必须拒绝；文件移动到「与源同名
// 的前缀目录下」不得误拒；经「..」段拼写但解析后同一路径的 move 按 no-op 跳过。
// 用 VirtualDriver 离线验证（folder_N 被识别为目录，无网络）。
// ---------------------------------------------------------------------------

async function mountVirtualStorage(): Promise<void> {
  await resetStorages()
  const db: any = await getDb()
  db.storages = [
    {
      id: "storage-move-subtree",
      driver: "virtual",
      mount_path: "/virt",
      addition: JSON.stringify({
        num_file: 1,
        num_folder: 1,
        min_file_size: 1,
        max_file_size: 2,
      }),
      modified: "2026-08-23T00:00:00.000Z",
      disabled: false,
    },
  ]
  await saveDb(db)
}

test("F-186: moving a directory into its own subtree is rejected", async () => {
  await mountVirtualStorage()

  // /virt/folder_0 → /virt/folder_0/folder_0：copy-then-delete 驱动会先复制
  // 再删光源前缀（连带刚复制出的目标），必须直接拒绝且不落到驱动层。
  let moveCalls = 0
  const originalMove = VirtualDriver.prototype.move
  VirtualDriver.prototype.move = async function () {
    moveCalls++
  }
  try {
    await assert.rejects(
      moveItems("/virt", "/virt/folder_0", ["folder_0"]),
      /own subtree/,
    )
    assert.equal(moveCalls, 0)

    // 文件移动即使目标键落在源键前缀下也无害（delete 只删精确键），不得误拒。
    await moveItems("/virt", "/virt/file_0.bin/nested", ["file_0.bin"])
    assert.equal(moveCalls, 1)

    // 「..」段拼写绕过字面 sameDir 比较：解析后同一路径必须按 no-op 跳过。
    await moveItems("/virt", "/virt/../virt", ["file_0.bin"])
    assert.equal(moveCalls, 1)
  } finally {
    VirtualDriver.prototype.move = originalMove
  }
})

// ---------------------------------------------------------------------------
// F-082：singleflight 键超长时必须确定性折叠（MySQL 主键列 VARCHAR(768)）。
// ---------------------------------------------------------------------------

const resolvedStub = { storage: { id: 42, modified: "2026-08-23T00:00:00.000Z" } }

test("F-082: short singleflight keys keep the readable op:id:rev:path format", () => {
  const key = fsSingleflightKey("fs.list", resolvedStub, "/movies")
  assert.equal(key, "fs.list:42:2026-08-23T00:00:00.000Z:/movies")
})

test("F-082: ultra-long keys fold deterministically within the VARCHAR(768) limit", () => {
  // 两条共享超长前缀、仅尾部不同的路径。
  const longPrefix = "/" + "目录".repeat(600)
  const keyA = fsSingleflightKey(
    "fs.list",
    resolvedStub,
    `${longPrefix}/${"a".repeat(300)}`,
  )
  const keyB = fsSingleflightKey(
    "fs.list",
    resolvedStub,
    `${longPrefix}/${"b".repeat(300)}`,
  )

  // 键长有界：MySQL singleflight.key 为 VARCHAR(768)。
  assert.ok(keyA.length <= 768, `key length ${keyA.length} exceeds 768`)
  assert.ok(keyB.length <= 768, `key length ${keyB.length} exceeds 768`)
  // 确定性：同一输入必须得到同一键（L2 跨实例去重依赖可复现性）。
  assert.equal(
    keyA,
    fsSingleflightKey(
      "fs.list",
      resolvedStub,
      `${longPrefix}/${"a".repeat(300)}`,
    ),
  )
  // 单射性：截断前缀相同的不同路径不得折叠到同一键。
  assert.notEqual(keyA, keyB)
  // 短键与折叠键也不得互撞。
  assert.notEqual(keyA, fsSingleflightKey("fs.list", resolvedStub, "/short"))
})

// ---------------------------------------------------------------------------
// F-322：夸克刷新的 __puus/__pus 必须经 flushPendingDriverState 持久化。
// ---------------------------------------------------------------------------

test("F-322: quark pending cookies persist through flushPendingDriverState", async () => {
  await resetStorages()
  const db: any = await getDb()
  const storageConfig = {
    id: "storage-quark-flush",
    driver: "quark",
    mount_path: "/quark",
    addition: JSON.stringify({ cookie: "old=1" }),
    modified: "2026-08-23T00:00:00.000Z",
    disabled: false,
  }
  db.storages = [storageConfig]
  await saveDb(db)

  const driver = new QuarkDriver({ cookie: "old=1" })
  // 模拟 QuarkClient 从 Set-Cookie 轮换 __puus 后触发的 onCookieUpdate。
  ;(driver as any).client.onCookieUpdate?.("old=1; __puus=rotated")

  await flushPendingDriverState("quark", storageConfig, driver)

  const after: any = await getDb()
  const st = after.storages.find(
    (s: any) => s.id === "storage-quark-flush",
  )
  assert.equal(
    JSON.parse(st.addition).cookie,
    "old=1; __puus=rotated",
    "refreshed __puus cookie must be written back to the storage addition",
  )
  // 取走即清空：再次 flush 不应重复触发写库。
  assert.equal(driver.consumePendingCookie(), null)

  // 别名与大小写同走夸克名单（"Quark"/"quark_uc" 归一化后均为夸克系）。
  const aliased = new QuarkDriver({ cookie: "old=2" })
  ;(aliased as any).client.onCookieUpdate?.("old=2; __puus=rotated2")
  await flushPendingDriverState("Quark", storageConfig, aliased)
  const afterAlias: any = await getDb()
  const stAlias = afterAlias.storages.find(
    (s: any) => s.id === "storage-quark-flush",
  )
  assert.equal(JSON.parse(stAlias.addition).cookie, "old=2; __puus=rotated2")
})
