import assert from "node:assert/strict"
import test from "node:test"
import { cborDecode } from "./webauthn"

const reader = (bytes: number[]) => ({ u8: new Uint8Array(bytes), i: 0 })

/**
 * F-033：cborDecode 必须把「输入已耗尽」当作硬错误。
 *
 * 历史实现在越界后读到 undefined（undefined >> 5 === 0），不定长数组的
 * `while (r.u8[r.i] !== 0xff)` 永不终止：2 字节输入 `9f 01` 迭代约 1.34 亿次
 * 并 push 上亿元素（8s CPU / >1GB 堆），已登录用户即可打爆 isolate。
 */
test("F-033: 缺少终止符的不定长数组立即抛错而不是无限迭代", () => {
  const started = Date.now()
  assert.throws(
    () => cborDecode(reader([0x9f, 0x01])),
    /unterminated indefinite-length CBOR array/,
  )
  assert.throws(
    () => cborDecode(reader([0xbf, 0x01, 0x02])),
    /unterminated indefinite-length CBOR map/,
  )
  assert.ok(
    Date.now() - started < 1000,
    "畸形输入必须快速失败（历史实现耗时数秒且分配上亿元素）",
  )
})

test("F-033: definite-length 头与剩余字节数做上界检查", () => {
  // 长度 0xffffffff 的数组，实际只有 0 字节（32 位拼接为负数 → invalid length）
  assert.throws(
    () => cborDecode(reader([0x9a, 0xff, 0xff, 0xff, 0xff])),
    /CBOR length exceeds input size|invalid CBOR length/,
  )
  // 长度 2 的数组只剩 1 字节
  assert.throws(
    () => cborDecode(reader([0x82, 0x01])),
    /CBOR length exceeds input size/,
  )
  // 长度 1 的 byte string 没有内容
  assert.throws(
    () => cborDecode(reader([0x41])),
    /CBOR length exceeds input size|unexpected end/,
  )
  // 读取头部时越界
  assert.throws(
    () => cborDecode(reader([0x19, 0x01])),
    /unexpected end of CBOR input|CBOR length exceeds input size/,
  )
  // 完全空输入
  assert.throws(
    () => cborDecode(reader([])),
    /unexpected end of CBOR input/,
  )
})

test("F-033: 合法 CBOR 仍正常解码", () => {
  assert.deepEqual(cborDecode(reader([0x83, 0x01, 0x02, 0x03])), [1, 2, 3])
  assert.deepEqual(cborDecode(reader([0x9f, 0x01, 0xff])), [1])
  assert.equal(cborDecode(reader([0x18, 0x64])), 100)
  assert.equal(cborDecode(reader([0x20])), -1)
  assert.deepEqual(
    cborDecode(reader([0xa1, 0x61, 0x61, 0x01])),
    { a: 1 },
  )
  assert.deepEqual(
    cborDecode(reader([0xbf, 0x61, 0x61, 0x02, 0xff])),
    { a: 2 },
  )
  assert.equal(cborDecode(reader([0x62, 0x68, 0x69])), "hi")
})
