import assert from "node:assert/strict"
import { test } from "node:test"

import { calcAcwScV2 } from "./help"
import { LanzouClient } from "./util"

/** F-155：读取即报错的响应体——探测循环若整读该响应体，测试会失败 */
function unreadableBodyResponse(
  status: number,
  headers: Record<string, string>,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("F-155: 探测循环不应整读该响应体"))
    },
  })
  return new Response(body, { status, headers })
}

const SHARE_PAGE = '<html><body><iframe src="/fn?abc123"></iframe></body></html>'
const IFRAME_PAGE =
  "<html><body><script>var src='/ajaxm.php?file=123456';data : {'file':'123456','sign':'abcdef','ves':'1'}</script></body></html>"
const AJAX_RESP = JSON.stringify({
  zt: 1,
  dom: "https://bogus.lanrar.com",
  url: "f/2023/file.zip",
})

/** 按路由 stub 全局 fetch，返回恢复函数 */
function stubFetch(handler: (url: string) => Response): () => void {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : String(input?.url || "")
    return handler(url)
  }) as any
  return () => {
    globalThis.fetch = real
  }
}

function makeShareClient(): LanzouClient {
  return new LanzouClient({
    type: "url",
    shareUrl: "https://pan.lanzoui.com",
    baseUrl: "https://pc.woozooo.com",
  } as any)
}

function makeAccountClient(): LanzouClient {
  return new LanzouClient({
    type: "account",
    account: "user",
    password: "pass",
  } as any)
}

test("F-155: a 200 direct-file probe resolves without reading the body", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("/fn?")) {
      return new Response(IFRAME_PAGE, {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    }
    if (url.includes("ajaxfile.php")) {
      return new Response(AJAX_RESP, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("bogus.lanrar.com")) {
      // 文件直出：非 HTML 200。旧实现会整读响应体并误报解析失败
      return unreadableBodyResponse(200, {
        "content-type": "application/octet-stream",
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  try {
    const client = makeShareClient()
    const file = await client.getFilesByShareUrl(
      "abc123",
      "",
      SHARE_PAGE,
      "https://pan.lanzoui.com",
    )
    assert.equal(file.url, "https://bogus.lanrar.com/file/f/2023/file.zip")
  } finally {
    restore()
  }
})

test("F-155: a 302 probe resolves via Location without reading the body", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("/fn?")) {
      return new Response(IFRAME_PAGE, {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    }
    if (url.includes("ajaxfile.php")) {
      return new Response(AJAX_RESP, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("bogus.lanrar.com")) {
      return unreadableBodyResponse(302, {
        location: "https://cdn.example.com/real.zip",
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  try {
    const client = makeShareClient()
    const file = await client.getFilesByShareUrl(
      "abc123",
      "",
      SHARE_PAGE,
      "https://pan.lanzoui.com",
    )
    assert.equal(file.url, "https://cdn.example.com/real.zip")
  } finally {
    restore()
  }
})

test("F-163: login() ignores responses that merely mention acw_sc__v2", async () => {
  let calls = 0
  const restore = stubFetch(() => {
    calls++
    return new Response(
      JSON.stringify({ zt: 1, info: "acw_sc__v2 已写入 cookie" }),
      { status: 200 },
    )
  })
  try {
    const client = makeAccountClient()
    // 旧实现会因裸 includes("acw_sc__v2") 去求解并抛「无法匹配到 arg1」
    await client.login()
    assert.equal(calls, 1)
  } finally {
    restore()
  }
})

test("F-163: login() still solves a real acw challenge and retries", async () => {
  const challengePage =
    "<script>var arg1='ABCDEF0123';var acw_sc__v2='';</script>"
  let calls = 0
  const restore = stubFetch(() => {
    calls++
    if (calls === 1) {
      return new Response(challengePage, { status: 200 })
    }
    return new Response(JSON.stringify({ zt: 1 }), { status: 200 })
  })
  try {
    const client = makeAccountClient()
    await client.login()
    assert.equal(calls, 2, "challenge must be solved and retried once")
    assert.equal(
      (client as any).acwMap.get("up.woozooo.com"),
      calcAcwScV2(challengePage),
    )
  } finally {
    restore()
  }
})
