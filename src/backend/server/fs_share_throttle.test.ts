import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Hono } from "hono"
import { fsRouter } from "./fs"
import { saveDb } from "../internal/model/db"

/**
 * F-091 回归：分享口令暴破节流必须在 `/api/fs/*` 的分享浏览端点上生效。
 *
 * 背景：`resolveShare` 只在调用方传入 `clientKey`（可信来源）时记账与锁定；
 * 旧实现里 `server/fs.ts` 的三处分享解析（/fs/dirs、/fs/list、/fs/get）都漏传
 * 第 4 参，导致 `trustedSource` 恒为 false —— 匿名端点上的 4~6 位提取码可以
 * 被无限速穷举。本测试用「可信反代头」模拟真实客户端 IP，验证第 9 次失败
 * 会被锁定，而不是永远返回 "wrong password"。
 */

process.env.JWT_SECRET = "0123456789abcdef0123456789abcdef"
// clientIpFromContext 只在 TRUST_PROXY_HEADERS=1 时采信反代头（见 pkg/client-ip.ts）
process.env.TRUST_PROXY_HEADERS = "1"

const SHARE_ID = "throttle-share"

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-share-throttle-"))
  fs.mkdirSync(path.join(root, "public"), { recursive: true })
  fs.writeFileSync(path.join(root, "public", "a.txt"), "A")
  return root
}

async function seed(root: string): Promise<void> {
  await saveDb(
    {
      settings: [],
      users: [
        {
          id: 1,
          username: "owner",
          password: "x",
          role: 2,
          permission: 0,
          base_path: "/",
          disabled: false,
        },
      ],
      storages: [
        {
          id: 1,
          mount_path: "/local",
          driver: "local",
          disabled: false,
          addition: JSON.stringify({ root_folder_path: root }),
        },
      ],
      shares: [
        {
          id: SHARE_ID,
          creator: "owner",
          creator_role: 2,
          files: ["/local/public"],
          pwd: "s3cret",
          disabled: false,
          expires: null,
          max_accessed: 0,
          accessed: 0,
        },
      ],
      metas: [],
    },
    {},
    { force: true },
  )
}

const newApp = (): Hono => {
  const a = new Hono()
  a.route("/api/fs", fsRouter)
  return a
}

const listShare = (a: Hono, password: string, clientIp: string) =>
  a.request("/api/fs/list", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": clientIp,
    },
    body: JSON.stringify({ path: `/@s/${SHARE_ID}`, password }),
  })

test("F-091: 分享口令连续错误会触发锁定（/api/fs/list 传 clientKey）", async () => {
  await seed(makeRoot())
  const a = newApp()
  const attacker = "203.0.113.7"

  // 前 8 次错误：正常返回 403 wrong password（并计入失败次数）
  for (let i = 0; i < 8; i++) {
    const res = await listShare(a, `bad-${i}`, attacker)
    assert.equal(res.status, 403, `attempt ${i}: ${await res.clone().text()}`)
    const body: any = await res.json()
    assert.match(String(body?.message), /wrong password/i)
  }

  // 第 9 次：已锁定，必须以 400 + 明确文案拒绝（旧实现恒为 wrong password）
  const locked = await listShare(a, "s3cret", attacker)
  assert.equal(locked.status, 400, await locked.clone().text())
  const lockedBody: any = await locked.json()
  assert.match(String(lockedBody?.message), /too many wrong passwords/i)

  // 计数按来源隔离：其他来源即使口令正确也不受牵连
  const other = await listShare(a, "s3cret", "198.51.100.9")
  assert.equal(other.status, 200, await other.clone().text())
})
