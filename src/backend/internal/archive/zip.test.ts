import assert from "node:assert/strict"
import test from "node:test"
import zlib from "node:zlib"
import { extractZipEntry, type ZipEntry } from "./zip"

/**
 * F-113 回归：zip-bomb 中止路径不得留下未处理的 writer Promise 拒绝。
 *
 * 旧实现 `writer.write(compressed)` / `writer.close()` 既不 await 也不挂
 * catch；超限时 `reader.cancel()` 会把可写侧 error 掉，挂起的 write/close
 * 以 AbortError 拒绝且无人处理 —— Node 15+ 默认把 unhandled rejection 当
 * 未捕获异常，进程直接退出（实测复现）。
 *
 * 这里临时接管 unhandledRejection：修复后计数必须保持 0；旧实现会累加并
 * 在无监听器时直接杀掉测试进程。
 */

/** 构造 deflate 条目与其数据（dataOffset=0，即压缩数据从 buffer 起始处开始） */
function deflateFixture(plain: Uint8Array, name = "data.bin") {
  const compressed = zlib.deflateRawSync(plain)
  const buffer = compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength,
  ) as ArrayBuffer
  const entry: ZipEntry = {
    name,
    isDir: false,
    // 故意谎报 size：/fs/archive/decompress 的上游预算只信中央目录声明
    size: 1024,
    compressedSize: compressed.byteLength,
    compressionMethod: 8,
    dataOffset: 0,
    modified: "2026-01-01T00:00:00Z",
  }
  return { buffer, entry }
}

test("F-113: zip-bomb 中止不产生 unhandled rejection", async () => {
  const unhandled: any[] = []
  const onUnhandled = (err: any) => unhandled.push(err)
  process.on("unhandledRejection", onUnhandled)

  try {
    const plain = new Uint8Array(5 * 1024 * 1024) // 解压 5MiB，上限 64KiB
    const { buffer, entry } = deflateFixture(plain, "bomb.bin")

    await assert.rejects(
      () => extractZipEntry(buffer, entry, 64 * 1024),
      /exceeds the 65536-byte extraction limit/,
    )

    // 给挂起的 Promise 拒绝一个落定窗口
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [], "中止路径不得产生 unhandled rejection")
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("F-113: 正常 deflate 条目仍能正确解压", async () => {
  const text = new TextEncoder().encode("hello zip ".repeat(1000))
  const { buffer, entry } = deflateFixture(text, "ok.txt")
  const out = await extractZipEntry(buffer, entry, 1024 * 1024)
  assert.equal(out.byteLength, text.byteLength)
  assert.equal(new TextDecoder().decode(out), new TextDecoder().decode(text))
})

test("F-113: 畸形 deflate 数据报错但不产生 unhandled rejection", async () => {
  const unhandled: any[] = []
  const onUnhandled = (err: any) => unhandled.push(err)
  process.on("unhandledRejection", onUnhandled)

  try {
    const garbage = new Uint8Array([0xff, 0x00, 0x13, 0x37, 0x42, 0x99, 0x01])
    const entry: ZipEntry = {
      name: "broken.bin",
      isDir: false,
      size: 10,
      compressedSize: garbage.byteLength,
      compressionMethod: 8,
      dataOffset: 0,
      modified: "2026-01-01T00:00:00Z",
    }
    await assert.rejects(
      () => extractZipEntry(garbage.buffer as ArrayBuffer, entry, 64 * 1024),
      (err: any) => err instanceof Error,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [], "畸形输入同样不得产生 unhandled rejection")
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})
