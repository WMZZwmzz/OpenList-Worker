import assert from "node:assert/strict"
import { test } from "node:test"
import { GoogleDrive } from "./driver"
import { GoogleDriveClient } from "./util"
import { GOOGLE_DRIVE_SHORTCUT_MIME } from "./types"

/**
 * F-356 / F-357 回归：
 *  - 快捷方式条目保留自身 id，写操作必须作用在快捷方式上（不能替换成 targetId）
 *  - pathCache 在写操作后按前缀失效，删除/重建同名路径后能解析到新 file id
 */

type Call = { method: string; url: string; body?: string }

function installDrive(
  calls: Call[],
  state: {
    root: any[]
    children?: Record<string, any[]>
    onWrite?: (method: string, id: string) => void
  },
) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(typeof input === "string" ? input : input.url))
    const method = String(init.method || "GET").toUpperCase()
    calls.push({
      method,
      url: url.toString(),
      body: typeof init.body === "string" ? init.body : undefined,
    })

    if (method === "GET" && url.pathname === "/drive/v3/files") {
      const q = url.searchParams.get("q") || ""
      const parent = /'([^']+)' in parents/.exec(q)?.[1] || ""
      const files =
        parent === "root"
          ? state.root
          : (state.children?.[parent] ?? [])
      return Response.json({ files })
    }

    const idMatch = /\/drive\/v3\/files\/([^/?]+)/.exec(url.pathname)
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1])
      if (method === "DELETE") {
        state.onWrite?.(method, id)
        return new Response(null, { status: 204 })
      }
      if (method === "PATCH") {
        state.onWrite?.(method, id)
        return Response.json({ id })
      }
      if (method === "GET") {
        const all = [...state.root, ...Object.values(state.children || {}).flat()]
        const f = all.find((x) => x.id === id)
        return f ? Response.json(f) : new Response("not found", { status: 404 })
      }
    }
    return Response.json({})
  }) as any
  return () => {
    globalThis.fetch = original
  }
}

function autoToken(client: GoogleDriveClient): void {
  ;(client as any).accessToken = "test-token"
  ;(client as any).tokenExpiresAt = Date.now() + 3600_000
}

const SHORTCUT = {
  id: "sc1",
  name: "shortcut to doc",
  mimeType: GOOGLE_DRIVE_SHORTCUT_MIME,
  shortcutDetails: {
    targetId: "REAL-TARGET",
    targetMimeType: "application/pdf",
  },
}

test("F-356：列表保留快捷方式自身 id，写操作作用在快捷方式上", async () => {
  const calls: Call[] = []
  const restore = installDrive(calls, {
    root: [SHORTCUT],
    children: {
      "FOLDER-TARGET": [{ id: "child1", name: "inside.txt", mimeType: "text/plain" }],
    },
  })
  try {
    const driver = new GoogleDrive({ refresh_token: "r" })
    autoToken((driver as any).client)

    // 列表不把 id 换成 targetId，但展示按目标类型
    const listed = await driver.list("/", "/")
    assert.equal(listed[0].is_dir, false)

    // 删除作用在快捷方式自身，绝不能是 REAL-TARGET
    await driver.remove("/shortcut to doc", "/shortcut to doc", [
      "shortcut to doc",
    ])
    const del = calls.find((c) => c.method === "DELETE")
    assert.ok(del)
    assert.ok(del!.url.includes("/files/sc1"), `DELETE 应指向 sc1：${del!.url}`)
    assert.ok(!del!.url.includes("REAL-TARGET"), "不得删除快捷方式的目标")

    // 目录快捷方式：列子项时跟随到目标
    const folderShortcut = {
      id: "sf1",
      name: "shortcut to folder",
      mimeType: GOOGLE_DRIVE_SHORTCUT_MIME,
      shortcutDetails: {
        targetId: "FOLDER-TARGET",
        targetMimeType: "application/vnd.google-apps.folder",
      },
    }
    const restore2 = installDrive(calls, {
      root: [folderShortcut],
      children: {
        "FOLDER-TARGET": [
          { id: "child1", name: "inside.txt", mimeType: "text/plain" },
        ],
      },
    })
    try {
      const driver2 = new GoogleDrive({ refresh_token: "r" })
      autoToken((driver2 as any).client)
      const kids = await driver2.list("/shortcut to folder", "/shortcut to folder")
      assert.deepEqual(kids.map((k) => k.name), ["inside.txt"])
    } finally {
      restore2()
    }
  } finally {
    restore()
  }
})

test("F-357：写操作后 pathCache 按前缀失效，删除重建后可解析到新 id", async () => {
  const calls: Call[] = []
  const state = {
    root: [{ id: "f1", name: "a.txt", mimeType: "text/plain" }] as any[],
    children: {
      d1: [{ id: "x1", name: "x.txt", mimeType: "text/plain" }],
    } as Record<string, any[]>,
  }
  const restore = installDrive(calls, state)
  try {
    const client = new GoogleDriveClient({ refresh_token: "r" })
    autoToken(client)

    assert.equal(await client.resolveFileId("/a.txt"), "f1")
    // 服务端已重建同名文件（新 id），缓存仍返回旧 id
    state.root = [{ id: "f2", name: "a.txt", mimeType: "text/plain" }]
    assert.equal(await client.resolveFileId("/a.txt"), "f1")

    client.invalidatePathCache("/a.txt")
    assert.equal(await client.resolveFileId("/a.txt"), "f2")

    // 前缀失效：目录及其子路径一起清掉
    state.root = [{ id: "d1", name: "d", mimeType: "application/vnd.google-apps.folder" }]
    assert.equal(await client.resolveFileId("/d/x.txt"), "x1")
    state.children = {
      d1: [{ id: "x2", name: "x.txt", mimeType: "text/plain" }],
    }
    assert.equal(await client.resolveFileId("/d/x.txt"), "x1")
    client.invalidatePathCache("/d")
    assert.equal(await client.resolveFileId("/d/x.txt"), "x2")
  } finally {
    restore()
  }
})

test("F-357：driver.remove/put 成功后驱动自身失效路径缓存", async () => {
  const calls: Call[] = []
  const state = {
    root: [{ id: "f1", name: "a.txt", mimeType: "text/plain" }] as any[],
    onWrite: (method: string) => {
      if (method === "DELETE") state.root = []
    },
  }
  const restore = installDrive(calls, state)
  try {
    const driver = new GoogleDrive({ refresh_token: "r" })
    autoToken((driver as any).client)
    await driver.remove("/a.txt", "/a.txt", ["a.txt"])

    // 重新上传同名文件：服务端返回新 id
    state.root = [{ id: "f2", name: "a.txt", mimeType: "text/plain" }]
    await driver.put("/a.txt", "/a.txt", Buffer.from("hello"))
    // put 只解析父目录，写后必须失效自身；随后 get 应命中新 id
    const file = await driver.get("/a.txt", "/a.txt")
    assert.equal(file.name, "a.txt")
    assert.ok(
      file.raw_url?.includes("/files/f2"),
      `get 应解析到重建后的 f2，实际 raw_url=${file.raw_url}`,
    )
  } finally {
    restore()
  }
})
