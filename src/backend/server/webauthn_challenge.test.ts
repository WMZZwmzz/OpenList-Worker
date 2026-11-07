import assert from "node:assert/strict"
import test from "node:test"
import {
  __resetDbCacheForTest,
  readPersistedSecret,
  writePersistedSecret,
} from "../internal/model/db"
import { consumeChallenge, issueChallenge } from "./webauthn"

// 与 webauthn.ts 的 CHALLENGE_PREFIX 保持一致（该常量未导出）。
const CHALLENGE_PREFIX = "openlist_wa_chal_"

const sessionOf = () => ({
  challenge: "f036-challenge-value",
  userVerification: "preferred",
})

/**
 * F-036 回归：WebAuthn 挑战是双写的（进程内 localChallenges + 持久化后端），
 * 历史实现的「单次消费」是双写单删——本地命中只删本地、命中持久化只清持久化，
 * 同一挑战最多可被消费两次（一份 assertion 换两枚 JWT）。消费必须把两份都清掉。
 */
test("F-036: 本地命中消费时必须同时作废持久化副本", async () => {
  __resetDbCacheForTest()
  const c: any = { env: {} }
  const id = await issueChallenge(c, sessionOf())

  const first = await consumeChallenge(c, id)
  assert.ok(first, "第一次消费应取到会话数据")
  assert.equal(first!.challenge, "f036-challenge-value")

  // 历史缺陷：本地命中只删本地，持久化副本仍在 —— 第二次消费还能取到数据
  const second = await consumeChallenge(c, id)
  assert.equal(second, null, "第二次消费必须失败（挑战单次使用）")

  const persisted = await readPersistedSecret(c.env, CHALLENGE_PREFIX + id)
  assert.equal(persisted, null, "持久化副本必须一并作废")
})

test("F-036: 走持久化路径消费时也只允许消费一次", async () => {
  __resetDbCacheForTest()
  const c: any = { env: {} }
  // 模拟另一实例签发的挑战：本进程 localChallenges 没有副本，只能走持久化路径
  const id = "f036-persisted-only-id"
  await writePersistedSecret(
    c.env,
    CHALLENGE_PREFIX + id,
    JSON.stringify({ ...sessionOf(), exp: Date.now() + 60_000 }),
  )

  const first = await consumeChallenge(c, id)
  assert.ok(first, "持久化副本应能取到会话数据")

  // 消费即作废：无论后续校验是否通过，同一挑战不能再换一枚 JWT
  const second = await consumeChallenge(c, id)
  assert.equal(second, null, "持久化路径消费后必须作废")
  const persisted = await readPersistedSecret(c.env, CHALLENGE_PREFIX + id)
  assert.equal(persisted, null, "持久化副本必须被清空")
})
