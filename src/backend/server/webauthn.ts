import { Hono } from "hono"
import { sign } from "hono/jwt"
import { getDb, saveDb } from "../internal/model/db"
import { getJwtSecret, requireAuthenticatedUser } from "./middlewares"
import { issueOtpPendingToken } from "./auth"
import { hmacSha256 } from "../pkg/crypto"
import { JWT_ISSUER, JWT_AUDIENCE } from "../pkg/permission"

/**
 * WebAuthn / Passkey 登录。
 *
 * 契约对齐 Go（go-webauthn）：
 *  - begin_login / finish_login（discoverable login 支持 username 可选）
 *  - begin_registration / finish_registration（需已登录）
 *  - delete_authn / getcredentials
 * session 数据 JSON 序列化 + base64 后经 `session` header 回传（无状态，Worker 友好）。
 *
 * 纯 Web Crypto 手写：CBOR 解码（attestationObject + COSE key）、ES256/RS256
 * 签名验证、rpIdHash 与 challenge 校验。无外部依赖。
 */

export const webauthnRouter = new Hono()

// ---------- base64url ----------
function b64urlEncode(buf: Uint8Array): string {
  let s = ""
  for (const b of buf) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/")
  const b64 = pad.padEnd(Math.ceil(pad.length / 4) * 4, "=")
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function b64Encode(buf: Uint8Array): string {
  let s = ""
  for (const b of buf) s += String.fromCharCode(b)
  return btoa(s)
}
function b64Decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---------- CBOR 解码（最小实现，支持主要类型 0-6 与不定长数组/map）----------
interface CborReader {
  u8: Uint8Array
  i: number
}
function cborDecode(r: CborReader): any {
  const b = r.u8[r.i++]
  const major = b >> 5
  const minor = b & 0x1f
  let value = minor
  if (minor === 24) value = r.u8[r.i++]
  else if (minor === 25) {
    value = (r.u8[r.i] << 8) | r.u8[r.i + 1]
    r.i += 2
  } else if (minor === 26) {
    value =
      (r.u8[r.i] << 24) |
      (r.u8[r.i + 1] << 16) |
      (r.u8[r.i + 2] << 8) |
      r.u8[r.i + 3]
    r.i += 4
  } else if (minor === 27) {
    let v = 0n
    for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(r.u8[r.i++])
    value = Number(v)
  } else if (minor === 31) {
    // indefinite length
    if (major === 4) {
      const arr: any[] = []
      while (r.u8[r.i] !== 0xff) arr.push(cborDecode(r))
      r.i++ // skip break
      return arr
    } else if (major === 5) {
      const obj: Record<string, any> = {}
      while (r.u8[r.i] !== 0xff) {
        const k = cborDecode(r)
        const v = cborDecode(r)
        obj[String(k)] = v
      }
      r.i++ // skip break
      return obj
    }
  }
  switch (major) {
    case 0:
      return value // uint
    case 1:
      return -1 - value // nint
    case 2: {
      // bytes
      const out = r.u8.slice(r.i, r.i + value)
      r.i += value
      return out
    }
    case 3: {
      // string
      const out = new TextDecoder().decode(r.u8.slice(r.i, r.i + value))
      r.i += value
      return out
    }
    case 4: {
      // array
      const arr: any[] = []
      for (let k = 0; k < value; k++) arr.push(cborDecode(r))
      return arr
    }
    case 5: {
      // map
      const obj: Record<string, any> = {}
      for (let k = 0; k < value; k++) {
        const key = cborDecode(r)
        const val = cborDecode(r)
        obj[String(key)] = val
      }
      return obj
    }
    default:
      throw new Error(`unsupported CBOR major type ${major}`)
  }
}

// ---------- COSE key → CryptoKey ----------
async function coseToCryptoKey(cose: Record<string, any>): Promise<CryptoKey> {
  const kty = cose[1]
  const alg = cose[3]
  if (kty === 2) {
    // EC2
    const crv = cose[-1]
    const x = cose[-2] // Uint8Array
    const y = cose[-3]
    if (crv !== 1) throw new Error("unsupported EC curve (only P-256)")
    const jwk: JsonWebKey = {
      kty: "EC",
      crv: "P-256",
      x: b64urlEncode(new Uint8Array(x)),
      y: b64urlEncode(new Uint8Array(y)),
    }
    const name = alg === -7 ? "ECDSA" : "ECDSA"
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name, namedCurve: "P-256" },
      false,
      ["verify"],
    )
  }
  if (kty === 3) {
    // RSA
    const n = cose[-1]
    const e = cose[-2]
    const jwk: JsonWebKey = {
      kty: "RSA",
      n: b64urlEncode(new Uint8Array(n)),
      e: b64urlEncode(new Uint8Array(e)),
    }
    const name = alg === -257 ? "RSASSA-PKCS1-v1_5" : "RSASSA-PKCS1-v1_5"
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name, hash: "SHA-256" },
      false,
      ["verify"],
    )
  }
  throw new Error(`unsupported COSE kty ${kty}`)
}

/** 解析 attestationObject（CBOR），返回 { authData, publicKey, aaguid, credentialId } */
async function parseAttestation(attObj: Uint8Array): Promise<{
  authData: Uint8Array
  publicKey: CryptoKey
  aaguid: Uint8Array
  credentialId: Uint8Array
  signCount: number
  flags: number
}> {
  const reader: CborReader = { u8: attObj, i: 0 }
  const root = cborDecode(reader)
  const authData: Uint8Array = root.authData
  const attStmt = root.attStmt || {}

  const rpIdHash = authData.slice(0, 32)
  const flags = authData[32]
  const signCount =
    (authData[33] << 24) |
    (authData[34] << 16) |
    (authData[35] << 8) |
    authData[36]

  if (!(flags & 0x40)) throw new Error("attestedCredentialData not present")
  let offset = 37
  const aaguid = authData.slice(offset, offset + 16)
  offset += 16
  const credIdLen = (authData[offset] << 8) | authData[offset + 1]
  offset += 2
  const credentialId = authData.slice(offset, offset + credIdLen)
  offset += credIdLen

  // credentialPublicKey 是 CBOR COSE key，单独解码
  const keyReader: CborReader = { u8: authData.slice(offset), i: 0 }
  const cose = cborDecode(keyReader)
  const publicKey = await coseToCryptoKey(cose)

  return { authData, publicKey, aaguid, credentialId, signCount, flags }
}

// ---------- 设置 / 工具 ----------
function getBoolSetting(db: any, key: string): boolean {
  const item = (db.settings || []).find((s: any) => s.key === key)
  const v = item?.value
  return v === "true" || v === "1"
}
function getStrSetting(db: any, key: string, def = ""): string {
  const item = (db.settings || []).find((s: any) => s.key === key)
  return item?.value ? String(item.value) : def
}

function rpIdOf(c: any, db: any): string {
  // 不再回退 Host：Host 可由反向代理/客户端影响，攻击者可借此把 challenge
  // 绑到另一个 RP。必须显式配置 webauthn_rp_id 或 WEBAUTHN_RP_ID。
  const explicit =
    getStrSetting(db, "webauthn_rp_id") ||
    String(c?.env?.WEBAUTHN_RP_ID || "").trim()
  return explicit
}

function rpIdMissing(c: any) {
  return c.json(
    {
      code: 400,
      message:
        "WebAuthn RP ID is not configured; set webauthn_rp_id or WEBAUTHN_RP_ID",
      data: null,
    },
    400,
  )
}

function newChallenge(): Uint8Array {
  const c = new Uint8Array(32)
  crypto.getRandomValues(c)
  return c
}

/**
 * clientDataJSON.origin 必须与 rpId 同一主机：否则在攻击者域名上完成的认证
 * 可以被搬到本站来用（认证跨源重放）。安卓等无 host 的来源格式无方可比对，放行。
 */
function originMatchesRp(origin: unknown, rpId: string): boolean {
  const o = String(origin ?? "")
  if (!o) return false
  if (o.startsWith("android:")) return true
  try {
    return new URL(o).hostname.toLowerCase() === String(rpId).toLowerCase()
  } catch {
    return false
  }
}

interface SessionData {
  challenge: string
  userId?: string
  username?: string
  allowedCredentials?: { id: string; type: string }[]
  userVerification: string
}

/**
 * 本实例签发过的 challenge 登记表 + 共享存储（KV）。
 *
 * session 头是一段客户端可自造的 base64 JSON：finish_* 里「clientDataJSON.challenge
 * 与 blob 里的 challenge 相等」这条校验，攻击者自己造一个 blob 就能满足，等于没有
 * 校验。登记表把 challenge 锚定到「确实由服务端发出过」。
 *
 * M-6：原实现在登记表为空时**直接放行**（`issuedChallenges.size === 0` 返回 true），
 * 理由是「冷启动 / 跨实例时无从核对」。代价是：新实例上任何一个自造 challenge 都
 * 能通过，截获一次 finish_login 请求即可重放拿新 token。现在改为：
 *   1. 签发时同时写入 KV（带 TTL），跨实例/冷启动也能核对；
 *   2. 校验时先内存、再 KV，**两边都查不到一律拒绝**（fail-closed）。
 */
const issuedChallenges = new Map<string, number>()
const CHALLENGE_TTL_MS = 5 * 60 * 1000
const CHALLENGE_KV_PREFIX = "wa_challenge:"

async function challengeKv(c: any): Promise<any | null> {
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(c?.env)
    if (kvInfo.mode === "none" || !kvInfo.binding) return null
    return kvInfo
  } catch {
    return null
  }
}

async function readKvValue(kvInfo: any, key: string): Promise<any> {
  try {
    const val = await kvInfo.binding.get(key, "text")
    return val && typeof val.text === "function" ? await val.text() : val
  } catch {
    return await kvInfo.binding.get(key)
  }
}

function pruneIssuedChallenges(now: number): void {
  for (const [k, exp] of issuedChallenges) {
    if (exp <= now) issuedChallenges.delete(k)
  }
}

function rememberChallenge(challenge?: string, c?: any): void {
  if (!challenge) return
  const now = Date.now()
  pruneIssuedChallenges(now)
  issuedChallenges.set(challenge, now + CHALLENGE_TTL_MS)
  // 写 KV 是尽力而为：失败不影响本实例内的校验，只是跨实例会退化为 fail-closed
  void (async () => {
    const kvInfo = await challengeKv(c)
    if (!kvInfo) return
    try {
      if (typeof kvInfo.binding.put === "function") {
        await kvInfo.binding.put(CHALLENGE_KV_PREFIX + challenge, "1", {
          expirationTtl: Math.ceil(CHALLENGE_TTL_MS / 1000),
        })
      } else if (typeof kvInfo.binding.set === "function") {
        await kvInfo.binding.set(CHALLENGE_KV_PREFIX + challenge, "1")
      }
    } catch {}
  })()
}

/** 单次消费：内存命中即删；否则查 KV 并删除。两边都没有 → false（fail-closed）。 */
async function consumeIssuedChallenge(
  challenge: string | undefined,
  c: any,
): Promise<boolean> {
  if (!challenge) return false
  const now = Date.now()
  const exp = issuedChallenges.get(challenge)
  if (exp !== undefined) {
    issuedChallenges.delete(challenge)
    return exp > now
  }
  const kvInfo = await challengeKv(c)
  if (!kvInfo) return false
  const key = CHALLENGE_KV_PREFIX + challenge
  try {
    const val = await readKvValue(kvInfo, key)
    if (val === null || val === undefined || val === "") return false
    if (typeof kvInfo.binding.delete === "function") {
      await kvInfo.binding.delete(key)
    }
    return true
  } catch {
    return false
  }
}

function sessionToB64(sd: SessionData, c: any): Promise<string> {
  rememberChallenge(sd.challenge, c)
  return signSessionPayload(b64Encode(new TextEncoder().encode(JSON.stringify(sd))), c)
}

async function signSessionPayload(payload: string, c: any): Promise<string> {
  const secret = await getJwtSecret(c)
  const key = await hmacSha256("openlist-webauthn-session-v1", secret)
  const sig = await hmacSha256(payload, key)
  return `${payload}.${sig}`
}

async function sessionFromB64(s: string, c: any): Promise<SessionData> {
  const dot = s.lastIndexOf(".")
  if (dot <= 0) throw new Error("invalid session format")
  const payload = s.slice(0, dot)
  const signature = s.slice(dot + 1)
  const secret = await getJwtSecret(c)
  const key = await hmacSha256("openlist-webauthn-session-v1", secret)
  const expected = await hmacSha256(payload, key)
  if (!constantTimeEqual(signature, expected)) {
    throw new Error("invalid session signature")
  }
  return JSON.parse(new TextDecoder().decode(b64Decode(payload)))
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function generateToken(user: any, c: any): Promise<string> {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    jti:
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : b64urlEncode(newChallenge()),
    // M-3：token 版本号（改密 / 关 2FA 后旧 token 立即失效）
    epoch: Number(user.token_epoch ?? 0) || 0,
  }
  const secret = await getJwtSecret(c)
  return await sign(payload, secret)
}

function getUserCredentials(user: any): any[] {
  return user.webauthn_credentials || []
}

// ---------- 端点 ----------

// POST /api/authn/webauthn_begin_login?username=xx
webauthnRouter.post("/webauthn_begin_login", async (c) => {
  const db = await getDb(c.env)
  if (!getBoolSetting(db, "webauthn_login_enabled")) {
    return c.json(
      { code: 403, message: "WebAuthn is not enabled", data: null },
      403,
    )
  }
  const username = c.req.query("username") || ""
  const rpId = rpIdOf(c, db)
  if (!rpId) return rpIdMissing(c)
  const challenge = newChallenge()
  const sd: SessionData = {
    challenge: b64urlEncode(challenge),
    userVerification: "preferred",
  }

  let allowCredentials: { id: string; type: string }[] | undefined
  if (username) {
    const user = (db.users || []).find((u: any) => u.username === username)
    if (!user) {
      return c.json({ code: 400, message: "user not found", data: null }, 400)
    }
    sd.userId = String(user.id)
    sd.username = username
    allowCredentials = getUserCredentials(user).map((cred: any) => ({
      id:
        typeof cred.id === "string"
          ? cred.id
          : b64urlEncode(new Uint8Array(cred.id)),
      type: "public-key",
    }))
    sd.allowedCredentials = allowCredentials
  }

  const options: any = {
    challenge: sd.challenge,
    rpId,
    userVerification: sd.userVerification,
  }
  if (allowCredentials && allowCredentials.length > 0) {
    options.allowCredentials = allowCredentials
  }

  return c.json({
    code: 200,
    message: "success",
    data: { options, session: await sessionToB64(sd, c) },
  })
})

// POST /api/authn/webauthn_finish_login?username=xx  (header: session)
webauthnRouter.post("/webauthn_finish_login", async (c) => {
  const db = await getDb(c.env)
  if (!getBoolSetting(db, "webauthn_login_enabled")) {
    return c.json(
      { code: 403, message: "WebAuthn is not enabled", data: null },
      403,
    )
  }
  const sessionHeader = c.req.header("session") || c.req.header("Session") || ""
  let sd: SessionData
  try {
    sd = await sessionFromB64(sessionHeader, c)
  } catch {
    return c.json({ code: 400, message: "invalid session", data: null }, 400)
  }
  const body = await c.req.json().catch(() => ({}))
  const rpId = rpIdOf(c, db)
  if (!rpId) return rpIdMissing(c)

  try {
    // 1. 解析 clientDataJSON，校验 challenge
    const rawId = b64urlDecode(body.id || "")
    const clientDataJSON = JSON.parse(
      new TextDecoder().decode(
        b64urlDecode(body.response?.clientDataJSON || ""),
      ),
    )
    if (clientDataJSON.challenge !== sd.challenge) {
      return c.json(
        { code: 400, message: "challenge mismatch", data: null },
        400,
      )
    }
    if (!(await consumeIssuedChallenge(sd.challenge, c))) {
      return c.json(
        {
          code: 400,
          message: "session not issued by this instance or already used",
          data: null,
        },
        400,
      )
    }
    if (clientDataJSON.type !== "webauthn.get") {
      return c.json(
        { code: 400, message: "invalid ceremony type", data: null },
        400,
      )
    }
    if (!originMatchesRp(clientDataJSON.origin, rpId)) {
      return c.json({ code: 400, message: "origin mismatch", data: null }, 400)
    }

    // 2. 解析 authenticatorData
    const authData = b64urlDecode(body.response?.authenticatorData || "")
    if (authData.length < 37) throw new Error("invalid authenticatorData")
    const rpIdHash = authData.slice(0, 32)
    const expectedRpHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
    )
    if (b64urlEncode(rpIdHash) !== b64urlEncode(expectedRpHash)) {
      return c.json(
        { code: 400, message: "rpId hash mismatch", data: null },
        400,
      )
    }

    // 3. 找到对应用户与 credential
    const username = c.req.query("username") || sd.username || ""
    let user = username
      ? (db.users || []).find((u: any) => u.username === username)
      : null
    let credential: any
    if (user) {
      credential = getUserCredentials(user).find((cred: any) => {
        const cid =
          typeof cred.id === "string"
            ? cred.id
            : b64urlEncode(new Uint8Array(cred.id))
        return cid === body.id
      })
    } else {
      // discoverable login：通过 userHandle 找到用户
      const userHandle = b64urlDecode(body.response?.userHandle || "")
      if (userHandle.length) {
        const userId = new TextDecoder().decode(userHandle)
        user = (db.users || []).find((u: any) => String(u.id) === userId)
        if (user) {
          credential = getUserCredentials(user).find((cred: any) => {
            const cid =
              typeof cred.id === "string"
                ? cred.id
                : b64urlEncode(new Uint8Array(cred.id))
            return cid === body.id
          })
        }
      }
    }
    if (!user || !credential) {
      return c.json(
        { code: 400, message: "credential not found", data: null },
        400,
      )
    }

    // M-6：begin_login 已经给出 allowCredentials 白名单（该用户名下的凭据集合），
    // finish 时必须校验，否则这份白名单形同虚设。
    if (
      Array.isArray(sd.allowedCredentials) &&
      sd.allowedCredentials.length > 0 &&
      !sd.allowedCredentials.some((cred: any) => cred && cred.id === body.id)
    ) {
      return c.json(
        { code: 400, message: "credential not in allowCredentials", data: null },
        400,
      )
    }

    // 4. 验证签名（credential 存储 JWK 公钥）
    const jwk = credential.publicKey
    if (!jwk) {
      return c.json(
        { code: 400, message: "credential missing public key", data: null },
        400,
      )
    }
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      jwk.kty === "RSA"
        ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
        : { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    const sig = b64urlDecode(body.response?.signature || "")
    const clientDataHash = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        b64urlDecode(
          body.response?.clientDataJSON || "",
        ) as unknown as BufferSource,
      ),
    )
    const signedData = new Uint8Array(authData.length + clientDataHash.length)
    signedData.set(authData, 0)
    signedData.set(clientDataHash, authData.length)

    const verifyAlg =
      jwk.kty === "RSA"
        ? { name: "RSASSA-PKCS1-v1_5" }
        : { name: "ECDSA", hash: "SHA-256" }
    const valid = await crypto.subtle
      .verify(
        verifyAlg as any,
        publicKey,
        sig as unknown as BufferSource,
        signedData as unknown as BufferSource,
      )
      .catch(() => false)
    if (!valid) {
      return c.json(
        { code: 400, message: "signature verification failed", data: null },
        400,
      )
    }

    // 5. 更新 signCount（防重放）
    const signCount =
      (authData[33] << 24) |
      (authData[34] << 16) |
      (authData[35] << 8) |
      authData[36]
    // M-6：原实现是 `signCount !== 0 && signCount <= credential.sign_count`，
    // 于是 signCount 恒为 0 的 authenticator（部分平台 Passkey）上重放检测完全
    // 失效——截获一次 finish_login 请求可以反复换新 token。现在：
    //   - 历史计数 > 0 而本次为 0 → 一律拒绝（计数器不能倒退）；
    //   - 历史与本次都为 0 → 该 authenticator 不支持计数器，只能依赖
    //     challenge 单次消费（已改为 KV 持久化 + fail-closed）兜底。
    const storedSignCount = Number(credential.sign_count ?? 0) || 0
    if (storedSignCount > 0 && signCount === 0) {
      return c.json(
        {
          code: 400,
          message: "signCount regressed to zero (possible cloned authenticator)",
          data: null,
        },
        400,
      )
    }
    if (signCount !== 0 && storedSignCount !== 0 && signCount <= storedSignCount) {
      return c.json(
        { code: 400, message: "stale signCount (possible replay)", data: null },
        400,
      )
    }
    credential.sign_count = signCount
    await saveDb(db, c.env)

    // 凭据有效但账号已被禁用时不得签发 token：finish_login 的其余分支都判了
    // disabled，唯独这里漏了，封禁会被 WebAuthn 绕过。
    if (user.disabled) {
      return c.json(
        { code: 403, message: "account is disabled", data: null },
        403,
      )
    }

    // 2FA（H-2）：账号开了 TOTP 时不得直接发完整令牌 —— 否则一枚已注册的
    // Passkey 就是一个绕开 6 位验证码的永久后门。只发 5 分钟待兑换令牌，
    // 由 POST /api/auth/otp/login 校验 TOTP / 恢复码后才换发会话令牌。
    if (user.otp_secret) {
      const pending = await issueOtpPendingToken(user, c)
      return c.json({
        code: 200,
        message: "otp required",
        data: { otp_required: true, token: pending },
      })
    }

    const token = await generateToken(user, c)
    return c.json({ code: 200, message: "success", data: { token } })
  } catch (e: any) {
    return c.json(
      { code: 400, message: e.message || "WebAuthn login failed", data: null },
      400,
    )
  }
})

// POST /api/authn/webauthn_begin_registration (需已登录)
webauthnRouter.post("/webauthn_begin_registration", async (c) => {
  const db = await getDb(c.env)
  if (!getBoolSetting(db, "webauthn_login_enabled")) {
    return c.json(
      { code: 403, message: "WebAuthn is not enabled", data: null },
      403,
    )
  }
  // 凭据管理端点必须真实登录：guest 回退会让匿名者给 guest 注册 Passkey（M-1）
  const user = await requireAuthenticatedUser(c)
  if (!user || user.disabled || user.id === undefined) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const rpId = rpIdOf(c, db)
  if (!rpId) return rpIdMissing(c)
  const challenge = newChallenge()
  const userIdBytes = new TextEncoder().encode(String(user.id))
  const sd: SessionData = {
    challenge: b64urlEncode(challenge),
    userId: String(user.id),
    username: user.username,
    userVerification: "preferred",
  }

  const existing = getUserCredentials(user).map((cred: any) => ({
    id:
      typeof cred.id === "string"
        ? cred.id
        : b64urlEncode(new Uint8Array(cred.id)),
    type: "public-key",
  }))

  const options: any = {
    challenge: sd.challenge,
    rp: { name: getStrSetting(db, "site_title", "OpenList"), id: rpId },
    user: {
      id: b64urlEncode(userIdBytes),
      name: user.username,
      displayName: user.username,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    timeout: 60000,
    authenticatorSelection: {
      userVerification: sd.userVerification,
      residentKey: "preferred",
    },
    attestation: "none",
  }
  if (existing.length > 0) options.excludeCredentials = existing

  return c.json({
    code: 200,
    message: "success",
    data: { options, session: await sessionToB64(sd, c) },
  })
})

// POST /api/authn/webauthn_finish_registration (需已登录，header: Session)
webauthnRouter.post("/webauthn_finish_registration", async (c) => {
  const db = await getDb(c.env)
  if (!getBoolSetting(db, "webauthn_login_enabled")) {
    return c.json(
      { code: 403, message: "WebAuthn is not enabled", data: null },
      403,
    )
  }
  // 凭据管理端点必须真实登录：guest 回退会让匿名者给 guest 注册 Passkey（M-1）
  const user = await requireAuthenticatedUser(c)
  if (!user || user.disabled || user.id === undefined) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const sessionHeader = c.req.header("Session") || c.req.header("session") || ""
  let sd: SessionData
  try {
    sd = await sessionFromB64(sessionHeader, c)
  } catch {
    return c.json({ code: 400, message: "invalid session", data: null }, 400)
  }
  const body = await c.req.json().catch(() => ({}))
  const rpId = rpIdOf(c, db)
  if (!rpId) return rpIdMissing(c)

  try {
    // 1. 校验 clientDataJSON challenge
    const clientDataJSON = JSON.parse(
      new TextDecoder().decode(
        b64urlDecode(body.response?.clientDataJSON || ""),
      ),
    )
    if (clientDataJSON.challenge !== sd.challenge) {
      return c.json(
        { code: 400, message: "challenge mismatch", data: null },
        400,
      )
    }
    if (!(await consumeIssuedChallenge(sd.challenge, c))) {
      return c.json(
        {
          code: 400,
          message: "session not issued by this instance or already used",
          data: null,
        },
        400,
      )
    }
    if (clientDataJSON.type !== "webauthn.create") {
      return c.json(
        { code: 400, message: "invalid ceremony type", data: null },
        400,
      )
    }
    if (!originMatchesRp(clientDataJSON.origin, rpId)) {
      return c.json({ code: 400, message: "origin mismatch", data: null }, 400)
    }

    // 2. 解析 attestationObject
    const attObj = b64urlDecode(body.response?.attestationObject || "")
    const { authData, publicKey, aaguid, credentialId, signCount } =
      await parseAttestation(attObj)

    // 注册时同样要核对 rpIdHash：attestation 里的前 32 字节必须是本站 rpId 的
    // SHA-256，否则别的 relying party 上产出的凭据可以被绑进本账号。
    const expectedRegRpHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
    )
    if (
      b64urlEncode(authData.slice(0, 32)) !== b64urlEncode(expectedRegRpHash)
    ) {
      return c.json(
        { code: 400, message: "rpId hash mismatch", data: null },
        400,
      )
    }

    // 3. 保存 credential（JWK 公钥，便于 finish_login 时重建 CryptoKey）
    // 客户端的 id 必须与 attestation 里的 credentialId 一致：否则可以把
    // authenticator 产出的公钥存到一个由客户端指定的 cred id 下，后续登录
    // 用另一枚凭据做混淆。
    if (body.id) {
      const claimedId = b64urlDecode(String(body.id))
      if (b64urlEncode(claimedId) !== b64urlEncode(credentialId)) {
        return c.json(
          { code: 400, message: "credential id mismatch", data: null },
          400,
        )
      }
    }
    const rawId = b64urlEncode(credentialId)
    const credRecord = {
      id: rawId,
      publicKey: await crypto.subtle.exportKey("jwk", publicKey),
      aaguid: b64urlEncode(aaguid),
      sign_count: signCount,
      created_at: new Date().toISOString(),
    }
    const webauthnUser = user as any
    if (!webauthnUser.webauthn_credentials)
      webauthnUser.webauthn_credentials = []
    webauthnUser.webauthn_credentials.push(credRecord)
    await saveDb(db, c.env)

    return c.json({ code: 200, message: "Registered Successfully", data: null })
  } catch (e: any) {
    return c.json(
      { code: 400, message: e.message || "registration failed", data: null },
      400,
    )
  }
})

// POST /api/authn/delete_authn (需已登录，body: {id})
webauthnRouter.post("/delete_authn", async (c) => {
  // 凭据管理端点必须真实登录：guest 回退会让匿名者给 guest 注册 Passkey（M-1）
  const user = await requireAuthenticatedUser(c)
  if (!user || user.disabled || user.id === undefined) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const body = await c.req.json().catch(() => ({}))
  const id = body.id || ""
  const db = await getDb(c.env)
  const target = (db.users || []).find((u: any) => u.id === user.id)
  if (!target)
    return c.json({ code: 404, message: "user not found", data: null }, 404)
  const before = (target.webauthn_credentials || []).length
  target.webauthn_credentials = (target.webauthn_credentials || []).filter(
    (cred: any) => cred.id !== id,
  )
  if (target.webauthn_credentials.length === before) {
    return c.json(
      { code: 404, message: "credential not found", data: null },
      404,
    )
  }
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "Deleted Successfully", data: null })
})

// GET /api/authn/getcredentials (需已登录)
webauthnRouter.get("/getcredentials", async (c) => {
  // 凭据管理端点必须真实登录：guest 回退会让匿名者给 guest 注册 Passkey（M-1）
  const user = await requireAuthenticatedUser(c)
  if (!user || user.disabled || user.id === undefined) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const creds = getUserCredentials(user).map((cred: any) => ({
    id: cred.id,
    fingerprint: cred.aaguid || "",
  }))
  return c.json({ code: 200, message: "success", data: creds })
})
