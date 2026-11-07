import test from "node:test"
import assert from "node:assert/strict"
import { get, post, request } from "./http"

type FetchInit = RequestInit & { signal?: AbortSignal }

/** 用一个可控的假 fetch 捕获传给 fetch 的 init/signal。 */
function withFakeFetch<T>(
  fn: (capture: {
    signal: () => AbortSignal | undefined
    calls: () => number
  }) => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch
  let captured: AbortSignal | undefined
  let calls = 0
  globalThis.fetch = ((_url: any, init?: FetchInit) => {
    calls++
    captured = init?.signal ?? undefined
    return new Promise((resolve, reject) => {
      const signal = init?.signal
      if (!signal) return reject(new Error("no signal passed to fetch"))
      if (signal.aborted) {
        return reject(new DOMException("Aborted", "AbortError"))
      }
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      )
      // 正常响应用例由调用方主动 abort，这里不 resolve
    })
  }) as any
  return fn({ signal: () => captured, calls: () => calls }).finally(() => {
    globalThis.fetch = realFetch
  })
}

test("F-059: get() forwards the caller's AbortSignal", async () => {
  await withFakeFetch(async ({ signal, calls }) => {
    const controller = new AbortController()
    const pending = get("http://example.com/x", { signal: controller.signal })
    pending.catch(() => {})
    assert.equal(calls(), 1)
    assert.ok(signal(), "fetch must receive an AbortSignal")
    assert.equal(signal()!.aborted, false)
    controller.abort()
    await assert.rejects(pending, /abort/i)
    assert.equal(signal()!.aborted, true)
  })
})

test("F-059: post() and request() also forward the signal", async () => {
  await withFakeFetch(async ({ signal }) => {
    const controller = new AbortController()
    const pendingPost = post(
      "http://example.com/p",
      { a: 1 },
      { signal: controller.signal },
    )
    pendingPost.catch(() => {})
    controller.abort()
    await assert.rejects(pendingPost)
    assert.equal(signal()!.aborted, true)

    const controller2 = new AbortController()
    const pendingRequest = request({
      url: "http://example.com/r",
      method: "put",
      data: { b: 2 },
      signal: controller2.signal,
    })
    pendingRequest.catch(() => {})
    controller2.abort()
    await assert.rejects(pendingRequest)
    assert.equal(signal()!.aborted, true)
  })
})

test("F-059: an already-aborted signal rejects without waiting for the timeout", async () => {
  await withFakeFetch(async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      get("http://example.com/x", { signal: controller.signal }),
      /abort/i,
    )
  })
})

test("F-059: requests without a caller signal keep working (timeout-only)", async () => {
  await withFakeFetch(async ({ signal }) => {
    const controller = new AbortController()
    const pending = get("http://example.com/x", { timeout: 50 })
    pending.catch(() => {})
    assert.ok(signal(), "internal timeout signal must still be passed")
    // 超时之后内部 controller 自己 abort
    await assert.rejects(pending, /abort/i)
    assert.equal(signal()!.aborted, true)
    controller.abort()
  })
})
