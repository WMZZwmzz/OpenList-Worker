import test from "node:test"
import assert from "node:assert/strict"
import { getActualPath } from "./permission"
import { decodePathFully } from "./path"

/**
 * 复刻 internal/model/db.ts resolvePath() 的 cleanPath 计算（2236-2301）：
 * 多重百分号解码 → 段归一化 → 折叠 `.`/`..`（空栈时钳在根）。
 * 这是攻击者真正落到的位置，也是本次修复的判定基准。
 */
function resolvePathView(virtualPath: string): string {
  const decoded = decodePathFully(virtualPath)
  const stack: string[] = []
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  const clean = "/" + stack.join("/")
  return clean === "" ? "/" : clean
}

const tenant = { role: 0, permission: 0, base_path: "/u1" } as any

/** 生成指定层数的 `%2e%2e`：每多一层，所有 `%` 再被编码成 `%25`。 */
function encodedDotDot(layers: number): string {
  let p = "%2e%2e"
  for (let i = 1; i < layers; i++) p = p.replace(/%/g, "%25")
  return p
}

const HOSTILE = [
  "/../secret.txt",
  "/%2e%2e/secret.txt",
  "/%252e%252e/secret.txt",
  "/..%2fsecret.txt",
  "/%2e%2e/%2e%2e/secret.txt",
  "/a/../../secret.txt",
  "/....//secret.txt",
  "/...//secret.txt",
  "/b/..",
  "/b/../..",
  "/%2E%2E/%2E%2E/x",
  "..\\..\\windows\\win.ini",
  "/u1/../u2/secret.txt",
  // 5 层起是旧实现的真实缺口：固定 4 次解码会残留一层 `%2e%2e`，
  // 而 resolvePath 会再解一次并折叠成 `..`。
  ...[5, 9, 13, 32].map((n) => `/${encodedDotDot(n)}/secret.txt`),
]

test("base_path 用户无法用 .. / 编码 .. 逃逸出自己的根目录", () => {
  for (const req of HOSTILE) {
    const actual = getActualPath(tenant, req)
    const landed = resolvePathView(actual)
    assert.ok(
      landed === "/u1" || landed.startsWith("/u1/"),
      `escape: req=${JSON.stringify(req)} actual=${JSON.stringify(actual)} landed=${JSON.stringify(landed)}`,
    )
  }
})

test("无 base_path 的用户仍按存储根钳制，且返回规范形式", () => {
  const root = { role: 2, permission: 0, base_path: "/" } as any
  // 规范形式与 resolvePath 的落点一致：meta 覆盖判定与签名计算才能同源
  assert.equal(getActualPath(root, "/a/../../x"), "/x")
  assert.equal(getActualPath(root, "/public/../secret/x.txt"), "/secret/x.txt")
  assert.equal(getActualPath(root, "/a/./b/"), "/a/b")
  assert.equal(getActualPath(root, "/sub"), "/sub")
  assert.equal(getActualPath(root, "/"), "/")
})

test("正常路径不再被保留编码形式，而是与存储落点同源", () => {
  assert.equal(getActualPath(tenant, "/photos/2024"), "/u1/photos/2024")
  // %20 会被解码：resolvePath 本来就会解码，签名/meta 现在看同一个字符串
  assert.equal(getActualPath(tenant, "/a%20b.txt"), "/u1/a b.txt")
  assert.equal(getActualPath(tenant, "/中文/文件.txt"), "/u1/中文/文件.txt")
  // 非法百分号序列解码失败 → 原样保留（不抛错）
  assert.equal(getActualPath(tenant, "/100%.txt"), "/u1/100%.txt")
  assert.equal(getActualPath(tenant, "/"), "/u1")
  assert.equal(getActualPath(tenant, "sub"), "/u1/sub")
})

test("/@s 分享虚拟路径不被 base_path 前缀污染", () => {
  assert.equal(getActualPath(tenant, "/@s/abc123"), "/@s/abc123")
})

test("深层 base_path 同样只在自己的根内活动", () => {
  const deep = { role: 0, permission: 0, base_path: "/team/a/u1" } as any
  for (const req of HOSTILE) {
    const landed = resolvePathView(getActualPath(deep, req))
    assert.ok(
      landed === "/team/a/u1" || landed.startsWith("/team/a/u1/"),
      `escape: req=${JSON.stringify(req)} landed=${JSON.stringify(landed)}`,
    )
  }
})
