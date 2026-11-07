import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { hashReadableStream, TorrentPieceHasher, calculateCasSliceMd5 } from "./hash"
import { createMD5, md5, sha1, sha256 } from "./hashers"
import { encodeCas } from "./codec"
import { DEFAULT_PIECE_SIZE, normalizeSeed } from "./types"

/**
 * 回归测试（F-096）：seed 的哈希实现必须走纯 JS 的 hashers.ts，不得依赖
 * hash-wasm。
 *
 * 背景：hash-wasm 在运行时调用 WebAssembly.compile()/instantiate() 编译内置
 * WASM；Cloudflare Workers / Vercel Edge / EdgeOne 等本项目明确支持的边缘
 * 运行时可能禁止 Wasm 代码生成（"Wasm code generation disallowed by
 * embedder"），此时所有 seed 操作都会抛错。hashers.ts 早已写好纯 JS 实现，
 * 但 hash.ts / codec.ts 仍从 hash-wasm 导入，替换从未生效。
 *
 * 下面对照 node:crypto 校验结果，并在「Wasm 被禁用」的环境下实际执行
 * hash.ts / codec.ts 的哈希路径：若有人把 import 改回 hash-wasm，这些用例
 * 会立即失败。
 */

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function nodeHash(algo: string, data: string | Uint8Array): string {
  return createHash(algo).update(data).digest("hex")
}

/** 在「Wasm 代码生成被禁止」的环境下执行 fn（模拟边缘运行时）。 */
async function withWasmDisabled<T>(fn: () => Promise<T> | T): Promise<T> {
  const wa = WebAssembly as any
  const originalCompile = wa.compile
  const originalInstantiate = wa.instantiate
  const deny = () => {
    throw new Error("WebAssembly.compile(): Wasm code generation disallowed by embedder")
  }
  wa.compile = deny
  wa.instantiate = deny
  try {
    return await fn()
  } finally {
    wa.compile = originalCompile
    wa.instantiate = originalInstantiate
  }
}

test("hashers: 纯 JS 实现与 node:crypto 输出一致（含 binary 输出）", async () => {
  assert.equal(await md5("hello"), nodeHash("md5", "hello"))
  assert.equal(await sha1("abc"), nodeHash("sha1", "abc"))
  assert.equal(await sha256("abc"), nodeHash("sha256", "abc"))

  const hasher = (await createMD5()).init()
  hasher.update(new TextEncoder().encode("hello"))
  assert.equal(hasher.digest("hex"), nodeHash("md5", "hello"))
  const binary = hasher.init().update(new TextEncoder().encode("hello")).digest("binary")
  assert.ok(binary instanceof Uint8Array)
  assert.equal(binary.length, 16)
  assert.equal(hex(binary), nodeHash("md5", "hello"))
})

test("hash.ts: Wasm 被禁用时 hashReadableStream/TorrentPieceHasher 仍可用", async () => {
  await withWasmDisabled(async () => {
    const data = new TextEncoder().encode("hello")
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data)
        controller.close()
      },
    })
    const torrentHasher = await TorrentPieceHasher.create(16384)
    const { size, hashes } = await hashReadableStream(
      stream,
      16384,
      data.length,
      1024 * 1024,
      torrentHasher,
    )

    assert.equal(size, data.length)
    assert.equal(hashes.md5, nodeHash("md5", data))
    assert.equal(hashes.sha1, nodeHash("sha1", data))
    assert.equal(hashes.sha256, nodeHash("sha256", data))
    assert.deepEqual(hashes.pieces.md5, [nodeHash("md5", data)])
    assert.deepEqual(hashes.pieces.sha1, [nodeHash("sha1", data)])
    assert.deepEqual(hashes.pieces.sha256, [nodeHash("sha256", data)])
    assert.deepEqual(torrentHasher.digest(), [nodeHash("sha1", data)])

    const sliceMd5 = await calculateCasSliceMd5(["aa", "bb"], "fallback")
    assert.equal(sliceMd5, nodeHash("md5", "AA\nBB").toUpperCase())
  })
})

test("codec.ts: Wasm 被禁用时 CAS 编码仍可计算 slice md5", async () => {
  const pieceMd5s = [nodeHash("md5", "piece-1"), nodeHash("md5", "piece-2")]
  const seed = normalizeSeed({
    format: "openlist-sharing-seed",
    version: 1,
    name: "two.bin",
    comment: "",
    created_at: "2026-09-08T00:00:00.000Z",
    created_by: "test",
    piece_size: DEFAULT_PIECE_SIZE,
    trackers: [],
    channels: [],
    files: [
      {
        path: "two.bin",
        size: DEFAULT_PIECE_SIZE * pieceMd5s.length,
        modified: "2026-09-08T00:00:00.000Z",
        comment: "",
        hashes: {
          md5: pieceMd5s[0],
          sha1: "",
          sha256: "",
          pieces: { md5: pieceMd5s, sha1: [], sha256: [] },
        },
        sources: [],
        cas_slice_md5: "",
        cas_create_time: "",
        cas_cloud: "",
        missing_channels: [],
      },
    ],
  })

  await withWasmDisabled(async () => {
    const encoded = await encodeCas(seed)
    // encodeCas 输出 base64(JSON)
    const json = JSON.parse(
      Buffer.from(new TextDecoder().decode(encoded), "base64").toString("utf8"),
    )
    const expected = nodeHash(
      "md5",
      pieceMd5s.map((h) => h.toUpperCase()).join("\n"),
    ).toUpperCase()

    // 两个分片 → slice_md5 是对各分片 MD5 再取 MD5（触发 codec 的 md5()）
    assert.equal(json.sliceMd5, expected)
  })
})
