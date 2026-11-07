import test from "node:test"
import assert from "node:assert/strict"
import {
  canAccess,
  canRead,
  canWrite,
  getNearestMeta,
  type Meta,
} from "./meta"

// 动态导入，避免测试文件顶层就初始化 store 后端探测
const db = (await import("../internal/model/db")) as any

function makeMeta(over: Partial<Meta> & { path: string }): Meta {
  return {
    id: 0,
    password: "",
    p_sub: false,
    read_users: [],
    read_users_sub: false,
    write_users: [],
    write_users_sub: false,
    write: false,
    w_sub: false,
    hide: "",
    h_sub: false,
    readme: "",
    r_sub: false,
    header: "",
    header_sub: false,
    ...over,
  } as Meta
}

/** 注入只含 metas 的桩库；返回一个全新的 env 对象以绕开 db 缓存。 */
function installDb(metas: Meta[]): any {
  db.__resetDbCacheForTest()
  const backend = {
    name: "meta-test",
    isConfigured: async () => true,
    async load() {
      return {
        settings: [{ key: "site_title", value: "meta-test" }],
        storages: [],
        users: [],
        shares: [],
        metas: JSON.parse(JSON.stringify(metas)),
        plugins: [],
      }
    },
    async save() {
      return true
    },
  }
  db.__setStoreBackendLoaderForTest(async () => backend)
  return { DB_DRIVER: `meta-test-${Math.random()}` }
}

const USER_1 = { id: 1, role: 0, permission: 0 }
const USER_2 = { id: 2, role: 0, permission: 0 }

test("F-062: canAccess enforces read_users of ancestor metas, not just the nearest one", async () => {
  const env = installDb([
    makeMeta({ id: 1, path: "/vault", read_users: [1], read_users_sub: true }),
    // 更近的一条 meta 只配 readme，没有 read_users
    makeMeta({ id: 2, path: "/vault/public", readme: "hello" }),
  ])

  const nearest = await getNearestMeta("/vault/public/x", env)
  assert.equal(nearest?.id, 2, "nearest meta is the child one")

  // 修复前：只看最近一条 → 放行；修复后：祖先白名单生效
  assert.equal(canAccess(USER_2, nearest, "/vault/public/x"), false)
  assert.equal(canAccess(USER_1, nearest, "/vault/public/x"), true)

  // 同一口径也适用于 canRead / canWrite 之外的一致语义（read 名单）
  assert.equal(canRead(USER_2, nearest, "/vault/public/x"), false)
  assert.equal(canRead(USER_1, nearest, "/vault/public/x"), true)
})

test("F-062: write_users of an ancestor meta is enforced through canWrite", async () => {
  const env = installDb([
    makeMeta({ id: 1, path: "/team", write_users: [1], write_users_sub: true }),
    makeMeta({ id: 2, path: "/team/sub", readme: "child" }),
  ])
  const nearest = await getNearestMeta("/team/sub/f.txt", env)
  assert.equal(nearest?.id, 2)
  assert.equal(canWrite(USER_2, nearest, "/team/sub/f.txt"), false)
  assert.equal(canWrite(USER_1, nearest, "/team/sub/f.txt"), true)
})

test("F-062: read_users with read_users_sub=false does not leak into children", async () => {
  const env = installDb([
    makeMeta({ id: 1, path: "/vault", read_users: [1], read_users_sub: false }),
    makeMeta({ id: 2, path: "/vault/public", readme: "hello" }),
  ])
  const nearest = await getNearestMeta("/vault/public/x", env)
  assert.equal(canAccess(USER_2, nearest, "/vault/public/x"), true)
})

test("F-063: getNearestMeta matches meta paths case-insensitively", async () => {
  const env = installDb([
    makeMeta({
      id: 1,
      path: "/Photos",
      password: "secret123",
      p_sub: true,
      read_users: [5],
      read_users_sub: true,
    }),
  ])

  const nearest = await getNearestMeta("/photos/2024", env)
  assert.ok(nearest, "case-different request must still find the meta")
  assert.equal(nearest?.path, "/Photos")

  // 密码与 read_users 因此重新生效
  assert.equal(canAccess(USER_2, nearest, "/photos/2024", ""), false)
  assert.equal(canAccess(USER_2, nearest, "/photos/2024", "wrong"), false)
  assert.equal(canAccess(USER_2, nearest, "/photos/2024", "secret123"), false)
  assert.equal(canAccess(USER_1, nearest, "/photos/2024", "secret123"), false)
  // 管理员不受限制
  assert.equal(
    canAccess({ id: 9, role: 2, permission: 0 }, nearest, "/photos/2024", ""),
    true,
  )
})

test("F-063: exact-case lookups still behave the same", async () => {
  const env = installDb([makeMeta({ id: 1, path: "/Photos", readme: "x" })])
  assert.equal((await getNearestMeta("/Photos", env))?.id, 1)
  assert.equal((await getNearestMeta("/Photos/a/b", env))?.id, 1)
  assert.equal(await getNearestMeta("/other", env), null)
})

test("F-067: canRead/canWrite accept undefined users without throwing", () => {
  const meta = makeMeta({
    path: "/x",
    read_users: [1],
    read_users_sub: true,
    write_users: [1],
    write_users_sub: true,
  })
  const guest = undefined as any
  assert.equal(canRead(guest, meta, "/x/1.txt"), false)
  assert.equal(canWrite(guest, meta, "/x/1.txt"), false)
  // 不在名单里的登录用户同样拒绝
  assert.equal(canRead(USER_2, meta, "/x/1.txt"), false)
  assert.equal(canWrite(USER_2, meta, "/x/1.txt"), false)
  // 名单内用户放行
  assert.equal(canRead(USER_1, meta, "/x/1.txt"), true)
  assert.equal(canWrite(USER_1, meta, "/x/1.txt"), true)
})

test("F-067: null user keeps the system-context semantics", () => {
  const meta = makeMeta({
    path: "/x",
    read_users: [1],
    read_users_sub: true,
    write_users: [1],
    write_users_sub: true,
  })
  assert.equal(canRead(null, meta, "/x/1.txt"), true)
  assert.equal(canWrite(null, meta, "/x/1.txt"), true)
})

test("F-067: undefined user does not throw when no ACL applies", () => {
  const meta = makeMeta({ path: "/x" })
  assert.equal(canRead(undefined as any, meta, "/x/1.txt"), true)
  assert.equal(canWrite(undefined as any, meta, "/x/1.txt"), true)
  assert.equal(canRead(undefined as any, null, "/x/1.txt"), true)
})
