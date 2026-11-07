import { Hono } from "hono"
import { sign } from "hono/jwt"
import { getDb, saveDb } from "../internal/model/db"
import { getJwtSecret } from "./middlewares"
import { generateRandomPassword, issueOtpPendingToken } from "./auth"
import { clientIpFromContext } from "../pkg/client-ip"
import { setUserPassword, passwordStampOf } from "../pkg/password"
import { JWT_ISSUER, JWT_AUDIENCE } from "../pkg/permission"
import { assertSafeUrl } from "../pkg/http"

/**
 * SSO 登录（OAuth2 授权码流 + OIDC）。
 *
 * 支持平台：Github / Microsoft / Google / Dingtalk / Casdoor / OIDC。
 * 纯 fetch + Web Crypto 实现，无外部依赖（OIDC discovery 手写，不验证
 * id_token 签名——code 已通过 client_secret 交换，且走 userinfo 端点，
 * 身份可信）。
 *
 * 两种模式：
 *  - 默认（弹窗）：回调后 postMessage 回传 { token | sso_id } 给 opener 并关闭。
 *  - 兼容模式：redirect 到 /@login?token=... 或 /@manage?sso_id=...。
 */

export const ssoRouter = new Hono()

const STATE_EXPIRE_MS = 5 * 60 * 1000
/** 本地 state 表容量上限：未消费的记录必须有界（F-035）。 */
const STATE_MAX_ENTRIES = 1000
/**
 * 持久化键前缀。OAuth state 必须能跨实例校验：/sso 的 302 与 sso_callback 在
 * 无会话亲和的运行时（CF Workers / EdgeOne）经常落到不同 isolate，只存内存会
 * 表现为「SSO 登录间歇性 400 incorrect or expired state」（F-035）。
 */
const STATE_KV_PREFIX = "openlist_sso_state_"
interface StateRecord {
  ip: string
  exp: number
  /** OIDC 的 nonce：回调时必须与 id_token 里的 nonce 一致（M-5） */
  nonce?: string
}
const stateStore = new Map<string, StateRecord>()

/** 过期条目与超量条目清扫（按插入顺序淘汰最旧），长期驻留进程也不会无界增长。 */
function pruneStateStore(now = Date.now()): void {
  for (const [k, v] of stateStore) {
    if (v.exp <= now) stateStore.delete(k)
  }
  while (stateStore.size > STATE_MAX_ENTRIES) {
    const oldest = stateStore.keys().next().value
    if (oldest === undefined) break
    stateStore.delete(oldest)
  }
}

/** best-effort 写持久化副本；无持久化后端时退化为单实例内存语义。 */
async function persistState(
  env: any,
  key: string,
  rec: StateRecord,
): Promise<void> {
  try {
    const { writePersistedSecret } = await import("../internal/model/db")
    await writePersistedSecret(env, STATE_KV_PREFIX + key, JSON.stringify(rec))
  } catch {
    // 无持久化后端
  }
}

/** 消费即删：无论命中的是内存还是持久化副本，两份都要清掉。 */
async function clearPersistedState(env: any, key: string): Promise<void> {
  try {
    const { writePersistedSecret } = await import("../internal/model/db")
    await writePersistedSecret(env, STATE_KV_PREFIX + key, "")
  } catch {
    // 无持久化后端
  }
}

function getSetting(db: any, key: string, def = ""): string {
  const item = (db.settings || []).find((s: any) => s.key === key)
  if (!item || item.value === undefined || item.value === null) return def
  return String(item.value)
}

function getBool(db: any, key: string): boolean {
  const v = getSetting(db, key, "false")
  return v === "true" || v === "1"
}

function randomHex(bytes = 16): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

function clientIpOf(c: any): string {
  return clientIpFromContext(c)
}

// M-4：state 的 HttpOnly 双提交 cookie。值即 state 本身（128-bit 随机），
// SameSite=Lax 允许 IdP 的顶层 GET 重定向回调携带它，跨站表单/带不上。
const SSO_STATE_COOKIE = "ol_sso_state"

function setSsoStateCookie(c: any, state: string): void {
  try {
    c.cookie(SSO_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 300, // 与 STATE_EXPIRE_MS 对齐
      secure: String(new URL(c.req.url).protocol) === "https:",
    })
  } catch {
    // 极端运行时（无 cookie API）退化为仅 IP 绑定，不阻断登录流程
  }
}

/**
 * M-4：回调侧的双提交校验。浏览器流程必然先经 /api/auth/sso 种下 cookie，
 * 因此「拿别人的回调 URL 来打」的请求缺少匹配 cookie，直接拒绝。
 * 仅当请求方看起来不是浏览器（无任何 Cookie 头）时放行并依赖 IP 绑定——
 * 兼容 curl / 无 cookie 环境的正常自测，同时攻击者伪造的跨会话回调
 * （浏览器发起）仍会被拦住。
 */
function verifySsoStateCookie(c: any, state: string): boolean {
  try {
    const cookieHeader = c.req.header("Cookie")
    if (!cookieHeader) return true // 非浏览器客户端：退回 IP 绑定
    const hit = String(cookieHeader)
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${SSO_STATE_COOKIE}=`))
    if (!hit) return true // 无本 cookie 的旧标签页：退回 IP 绑定
    return hit.slice(SSO_STATE_COOKIE.length + 1) === state
  } catch {
    return true
  }
}

function apiOrigin(c: any): string {
  try {
    return new URL(c.req.url).origin
  } catch {
    return "http://localhost"
  }
}

async function generateState(
  env: any,
  clientId: string,
  ip: string,
  nonce?: string,
): Promise<string> {
  const state = randomHex(16)
  const rec: StateRecord = {
    ip,
    exp: Date.now() + STATE_EXPIRE_MS,
    nonce,
  }
  const key = `${clientId}_${state}`
  pruneStateStore()
  stateStore.set(key, rec)
  // 双写：本实例立即可用 + 其它实例/后续请求可经持久化后端校验
  await persistState(env, key, rec)
  return state
}

/**
 * 单次消费：无论校验成功与否都删除记录（内存 + 持久化两份），防止 state 重放。
 */
async function consumeState(
  env: any,
  clientId: string,
  ip: string,
  state: string,
): Promise<StateRecord | null> {
  // generateState 用 randomHex(16) 签发 32 位小写 hex。形状不符的 state 不可能是
  // 本服务签发的，直接拒绝可以避免任意伪造 state 触发两次存储往返（放大面）。
  if (!/^[0-9a-f]{32}$/.test(state)) return null
  const key = `${clientId}_${state}`
  let rec = stateStore.get(key)
  if (rec) {
    // 内存命中：读取即删除
    stateStore.delete(key)
  } else {
    // 内存未命中：可能是另一实例签发的 state，读持久化副本
    try {
      const { readPersistedSecret } = await import("../internal/model/db")
      const raw = await readPersistedSecret(env, STATE_KV_PREFIX + key)
      if (raw) {
        const parsed = JSON.parse(String(raw))
        if (parsed && typeof parsed.exp === "number") rec = parsed
      }
    } catch {
      rec = undefined
    }
  }
  if (rec) {
    // 两份存储一起作废（命中哪一份都不能留下另一份供重放）
    await clearPersistedState(env, key)
  }
  stateStore.delete(key)
  if (!rec) return null
  if (rec.ip !== ip || !(Number(rec.exp) > Date.now())) return null
  return rec
}

async function verifyState(
  env: any,
  clientId: string,
  ip: string,
  state: string,
): Promise<boolean> {
  return (await consumeState(env, clientId, ip, state)) !== null
}

/** 平台预设端点 */
interface PlatformDef {
  authUrl: string
  tokenUrl: string
  userUrl: string
  scope: string
  authField: string
  idField: string
  usernameField: string
  extraAuth?: Record<string, string>
  extraForm?: Record<string, string>
  tokenStyle?: "form" | "json" // Dingtalk 用 JSON
}

function platformDef(
  platform: string,
  ssoLoginUrl: string,
  ssoTokenUrl: string,
  ssoUserinfoUrl: string,
  ssoScopes: string,
): PlatformDef | null {
  switch (platform) {
    case "Github":
      return {
        authUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        userUrl: "https://api.github.com/user",
        scope: ssoScopes || "read:user",
        authField: "code",
        idField: "id",
        usernameField: "login",
      }
    case "Microsoft":
      return {
        authUrl:
          "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        userUrl: "https://graph.microsoft.com/v1.0/me",
        scope: ssoScopes || "user.read",
        authField: "code",
        idField: "id",
        usernameField: "displayName",
        extraAuth: { response_mode: "query" },
        extraForm: { grant_type: "authorization_code" },
      }
    case "Google":
      return {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
        scope: ssoScopes || "https://www.googleapis.com/auth/userinfo.profile",
        authField: "code",
        idField: "id",
        usernameField: "name",
        extraForm: { grant_type: "authorization_code" },
      }
    case "Dingtalk":
      return {
        authUrl: "https://login.dingtalk.com/oauth2/auth",
        tokenUrl: "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
        userUrl: "https://api.dingtalk.com/v1.0/contact/users/me",
        scope: ssoScopes || "openid",
        authField: "authCode",
        idField: "unionId",
        usernameField: "nick",
        extraAuth: { prompt: "consent" },
        tokenStyle: "json",
      }
    case "Casdoor":
      return {
        authUrl:
          (ssoLoginUrl || "").replace(/\/login\/oauth\/authorize$/, "") +
          "/login/oauth/authorize",
        tokenUrl:
          (ssoTokenUrl || "").replace(
            /\/api\/login\/oauth\/access_token$/,
            "",
          ) + "/api/login/oauth/access_token",
        userUrl:
          (ssoUserinfoUrl || "").replace(/\/api\/userinfo$/, "") +
          "/api/userinfo",
        scope: ssoScopes || "profile",
        authField: "code",
        idField: "sub",
        usernameField: "preferred_username",
        extraForm: { grant_type: "authorization_code" },
      }
    case "OIDC":
      return null // 走 discovery，单独处理
    default:
      return null
  }
}

/** OIDC discovery：获取授权/令牌/userinfo 端点 */
function assertSsoUrl(url: string, c: any): void {
  const allowHosts = String(c?.env?.SSRF_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  assertSafeUrl(url, "SSO endpoint", allowHosts)
}

async function oidcDiscovery(
  discoveryUrl: string,
  c: any,
): Promise<{
  authUrl: string
  tokenUrl: string
  userUrl: string
  jwksUri: string
  issuer: string
}> {
  const url = discoveryUrl.endsWith("/.well-known/openid-configuration")
    ? discoveryUrl
    : discoveryUrl.replace(/\/+$/, "") + "/.well-known/openid-configuration"
  assertSsoUrl(url, c)
  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "manual",
  })
  if (resp.status >= 300 && resp.status < 400) {
    throw new Error("OIDC discovery must not redirect")
  }
  if (!resp.ok) throw new Error(`OIDC discovery failed: HTTP ${resp.status}`)
  const doc: any = await resp.json()
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error("OIDC discovery returned incomplete metadata")
  }
  // discovery 文档本身也可能被投毒：它给出的端点同样要过 SSRF 断言。
  assertSsoUrl(doc.authorization_endpoint, c)
  assertSsoUrl(doc.token_endpoint, c)
  if (doc.userinfo_endpoint) assertSsoUrl(doc.userinfo_endpoint, c)
  if (doc.jwks_uri) assertSsoUrl(doc.jwks_uri, c)
  return {
    authUrl: doc.authorization_endpoint,
    tokenUrl: doc.token_endpoint,
    userUrl: doc.userinfo_endpoint || "",
    jwksUri: typeof doc.jwks_uri === "string" ? doc.jwks_uri : "",
    issuer: typeof doc.issuer === "string" ? doc.issuer : "",
  }
}

/** 生成 JWT token（与 /auth/login 一致） */
async function generateToken(user: any, c: any): Promise<string> {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    // 密码指纹（对齐 Go PwdTS）：改密后旧令牌立即失效
    pwd_ts: passwordStampOf(user),
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    jti:
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : generateRandomPassword(),
    // M-3：token 版本号（改密 / 关 2FA 后旧 token 立即失效）
    epoch: Number(user.token_epoch ?? 0) || 0,
  }
  const secret = await getJwtSecret(c)
  return await sign(payload, secret)
}

/** SSO 自动注册 */
async function autoRegister(
  db: any,
  username: string,
  ssoId: string,
  env?: any,
): Promise<any> {
  let uname = username || ssoId
  if (db.users.some((u: any) => u.username === uname)) {
    uname = `${uname}_${ssoId}`
  }
  const id = db.users.length
    ? Math.max(...db.users.map((u: any) => Number(u.id) || 0)) + 1
    : 1
  // L-12（2026-10-30 审查）：新 SSO 用户的默认目录/权限来自管理员设置
  // （sso_default_dir / sso_default_permission），而不是写死全站根目录——
  // 否则每个 SSO 自动注册用户默认获得全站根目录读权限。
  const defaultDir = getSetting(db, "sso_default_dir", "/") || "/"
  const defaultPerm = parseInt(getSetting(db, "sso_default_permission", "0"), 10) || 0
  const user: any = {
    id,
    username: uname,
    password: "",
    role: 0,
    permission: defaultPerm,
    base_path: defaultDir,
    disabled: false,
    sso_id: ssoId,
    allow_ldap: false,
    pwd_update_at: new Date().toISOString(),
  }
  // SSO 用户不通过本地口令登录，但仍以双层哈希存储随机口令，避免存明文
  await setUserPassword(user, generateRandomPassword())
  db.users.push(user)
  // L-4：必须透传请求 env。此前传 `db.env`（通常 undefined），只能靠模块级
  // globalEnvCtx 兜底——并发/多环境场景下会写到错误的后端。
  await saveDb(db, env)
  return user
}

function postMessageHtml(field: string, value: string): string {
  // 同时转义反斜杠与引号：只处理 < > 时，含 `"` 的值可以提前闭合字符串字面量，
  // 在这个「由本应用同源提供」的页面里注入任意脚本。
  const safe = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
  return `<!DOCTYPE html>
<head></head>
<body>
<script>
window.opener.postMessage({"${field}":"${safe}"}, window.location.origin)
window.close()
</script>
</body>`
}

/**
 * 同源 postMessage 回传任意 JSON 载荷（用于 2FA 待兑换流程：opener 需要同时
 * 拿到 `otp_required` 标记与待兑换令牌）。
 *
 * 转义 `<`/`>`/`&` 与行分隔符，避免载荷内容提前闭合 <script> 或破坏 JS 字面量。
 */
function postMessageJson(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  return `<!DOCTYPE html>
<head></head>
<body>
<script>
window.opener.postMessage(${json}, window.location.origin)
window.close()
</script>
</body>`
}

// GET /api/auth/sso?method=sso_get_token | get_sso_id
ssoRouter.get("/sso", async (c) => {
  const db = await getDb(c.env)
  if (!getBool(db, "sso_login_enabled")) {
    return c.json(
      { code: 403, message: "Single sign-on is not enabled", data: null },
      403,
    )
  }
  const method = c.req.query("method") || ""
  if (!method) {
    return c.json({ code: 400, message: "no method provided", data: null }, 400)
  }
  const platform = getSetting(db, "sso_login_platform")
  const clientId = getSetting(db, "sso_client_id")
  const useCompat = getBool(db, "sso_compatibility_mode")
  const redirectUri = useCompat
    ? `${apiOrigin(c)}/api/auth/${method}`
    : `${apiOrigin(c)}/api/auth/sso_callback?method=${method}`

  const ssoLoginUrl = getSetting(db, "sso_login_url")
  const ssoTokenUrl = getSetting(db, "sso_token_url")
  const ssoUserinfoUrl = getSetting(db, "sso_userinfo_url")
  const ssoScopes = getSetting(db, "sso_scopes")
  const discoveryUrl = getSetting(db, "sso_oidc_discovery_url")

  try {
    if (platform === "OIDC") {
      const ep = await oidcDiscovery(discoveryUrl || ssoLoginUrl, c)
      // M-5：带上 nonce 并在回调时校验，防止 id_token 被替换/重放
      const nonce = randomHex(16)
      const state = await generateState(c.env, clientId, clientIpOf(c), nonce)
      // M-4：state 再绑定一份 HttpOnly 双提交 cookie。IP 绑定在未设
      // TRUST_PROXY_HEADERS=1 的部署上（所有客户端 ip 恒为 "unknown"）会完全
      // 失效——攻击者把自己的回调 URL 发给已登录受害者即可完成「绑定攻击者
      // 身份」。cookie 由本响应种下，回调时必须与 state 一致：受害者的浏览器
      // 没有攻击者那次签发的 cookie，跨会话回调必然失败。
      setSsoStateCookie(c, state)
      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: ssoScopes || "openid profile",
        state,
        nonce,
      })
      return c.redirect(`${ep.authUrl}?${params.toString()}`, 302)
    }

    const def = platformDef(
      platform,
      ssoLoginUrl,
      ssoTokenUrl,
      ssoUserinfoUrl,
      ssoScopes,
    )
    if (!def) {
      return c.json({ code: 400, message: "invalid platform", data: null }, 400)
    }
    const state = await generateState(c.env, clientId, clientIpOf(c))
    // M-4：同上，所有平台统一双提交绑定。
    setSsoStateCookie(c, state)
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: def.scope,
      // 所有平台都要带 state：少了它，攻击者可以诱导已登录浏览器完成一次
      // 「登录到攻击者账号」的绑定（login CSRF）。OIDC 分支已有同样处理。
      state,
    })
    for (const [k, v] of Object.entries(def.extraAuth || {})) params.set(k, v)
    return c.redirect(`${def.authUrl}?${params.toString()}`, 302)
  } catch (e: any) {
    return c.json(
      { code: 400, message: e.message || "SSO error", data: null },
      400,
    )
  }
})

// GET /api/auth/sso_callback?method=...&code=...
ssoRouter.get("/sso_callback", async (c) => {
  const db = await getDb(c.env)
  if (!getBool(db, "sso_login_enabled")) {
    return c.text("Single sign-on is not enabled", 403)
  }
  const method = c.req.query("method") || ""
  if (method !== "get_sso_id" && method !== "sso_get_token") {
    return c.text("invalid request", 400)
  }
  const platform = getSetting(db, "sso_login_platform")
  const clientId = getSetting(db, "sso_client_id")
  const clientSecret = getSetting(db, "sso_client_secret")
  const useCompat = getBool(db, "sso_compatibility_mode")
  const redirectUri = useCompat
    ? `${apiOrigin(c)}/api/auth/${method}`
    : `${apiOrigin(c)}/api/auth/sso_callback?method=${method}`

  const ssoLoginUrl = getSetting(db, "sso_login_url")
  const ssoTokenUrl = getSetting(db, "sso_token_url")
  const ssoUserinfoUrl = getSetting(db, "sso_userinfo_url")
  const ssoScopes = getSetting(db, "sso_scopes")
  const discoveryUrl = getSetting(db, "sso_oidc_discovery_url")

  try {
    // state 校验前置到所有平台共用：consumeState 是单次消费的（校验即删除），
    // 因此 OIDC 分支不再重复校验。缺少这一步的非 OIDC 平台可被用于登录 CSRF。
    // 返回值里还带着 OIDC 的 nonce，供下面校验 id_token（M-5）。
    const reqState = c.req.query("state") || ""
    const stateRec = await consumeState(
      c.env,
      clientId,
      clientIpOf(c),
      reqState,
    )
    if (!stateRec) {
      return c.text("incorrect or expired state parameter", 400)
    }
    // M-4：双提交 cookie 校验（签发时种下的 HttpOnly cookie 必须与 state 一致；
    // 无 cookie 的非浏览器客户端退回 IP 绑定）。
    if (!verifySsoStateCookie(c, reqState)) {
      return c.text("state cookie mismatch", 400)
    }

    let tokenUrl: string
    let userUrl: string
    let idField: string
    let usernameField: string
    let scope: string
    let accessToken: string
    let userInfo: any

    if (platform === "OIDC") {
      const ep = await oidcDiscovery(discoveryUrl || ssoLoginUrl, c)
      tokenUrl = ep.tokenUrl
      userUrl = ep.userUrl
      const jwksUri = ep.jwksUri
      idField = "sub"
      usernameField = "preferred_username"
      scope = ssoScopes || "openid profile"
      const code = c.req.query("code") || ""
      assertSsoUrl(tokenUrl, c)
      const tokenResp = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          scope,
        }).toString(),
      })
      const tokenData: any = await tokenResp.json().catch(() => ({}))
      accessToken = tokenData.access_token
      if (!accessToken) throw new Error("no access_token in token response")
      // M-5：id_token 做 payload 校验（iss / aud / exp / nonce）。S-10：id_token
      // 一旦被用作身份来源（sub），必须先用 discovery 给出的 jwks_uri 验签
      // （仅 RS256，其余算法 fail-closed）；身份完全来自 userinfo 端点的场景
      // 不依赖 id_token，无需验签。
      const idTokenOpts = {
        clientId,
        issuer: ep.issuer,
        nonce: stateRec.nonce,
      }
      if (userUrl) {
        assertSsoUrl(userUrl, c)
        const uResp = await fetch(userUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        })
        userInfo = await uResp.json().catch(() => ({}))
        const name =
          userInfo?.preferred_username ||
          userInfo?.name ||
          userInfo?.nickname ||
          ""
        if (!userInfo?.sub && !name) {
          // 回退：解析 id_token payload 的 name 字段。sub 会成为本地身份，
          // 必须先过 JWKS 验签（fail-closed：IdP 未给 jwks_uri 时拒绝）。
          const idToken = tokenData.id_token
          if (idToken) {
            await verifyIdTokenRs256(idToken, jwksUri, c)
            const payload = validateIdTokenClaims(idToken, idTokenOpts)
            userInfo = userInfo || {}
            userInfo.sub = userInfo.sub || payload?.sub
            userInfo.name =
              name || payload?.name || payload?.preferred_username || ""
          }
        }
        if (name) userInfo.name = name
      } else {
        const idToken = tokenData.id_token
        if (!idToken) throw new Error("no id_token and no userinfo endpoint")
        // S-10：没有 userinfo 端点时身份完全来自 id_token，验签是硬性前提。
        await verifyIdTokenRs256(idToken, jwksUri, c)
        userInfo = validateIdTokenClaims(idToken, idTokenOpts) || {}
        userInfo.sub = userInfo.sub || userInfo.name || ""
      }
    } else {
      const def = platformDef(
        platform,
        ssoLoginUrl,
        ssoTokenUrl,
        ssoUserinfoUrl,
        ssoScopes,
      )
      if (!def) return c.text("invalid platform", 400)
      tokenUrl = def.tokenUrl
      userUrl = def.userUrl
      idField = def.idField
      usernameField = def.usernameField
      scope = def.scope

      const code = c.req.query(def.authField) || ""
      if (!code) return c.text("No code provided", 400)

      let tokenResp: Response
      assertSsoUrl(tokenUrl, c)
      if (def.tokenStyle === "json") {
        // Dingtalk
        tokenResp = await fetch(tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            clientId,
            clientSecret,
            code,
            grantType: "authorization_code",
          }),
        })
      } else {
        const form: Record<string, string> = {
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          scope,
          ...(def.extraForm || {}),
        }
        tokenResp = await fetch(tokenUrl, {
          method: "POST",
          headers: { Accept: "application/json" },
          body: new URLSearchParams(form).toString(),
        })
      }
      const tokenData: any = await tokenResp.json().catch(() => ({}))
      accessToken = tokenData.access_token || tokenData.accessToken
      if (!accessToken) {
        throw new Error(
          `token exchange failed: ${tokenData.error || tokenResp.status}`,
        )
      }

      const headers: Record<string, string> = { Accept: "application/json" }
      if (platform === "Dingtalk") {        headers["x-acs-dingtalk-access-token"] = accessToken
      } else {
        headers["Authorization"] = `Bearer ${accessToken}`
      }
      assertSsoUrl(userUrl, c)
      const uResp = await fetch(userUrl, { headers })
      userInfo = await uResp.json().catch(() => ({}))
    }

    const userID = String(
      userInfo?.id ?? userInfo?.sub ?? userInfo?.[idField] ?? "",
    )
    if (!userID || userID === "0") {
      return c.text("cannot get user id from SSO provider", 400)
    }

    if (method === "get_sso_id") {
      if (useCompat) {
        return c.redirect(
          `${apiOrigin(c)}/@manage?sso_id=${encodeURIComponent(userID)}`,
          302,
        )
      }
      return c.html(postMessageHtml("sso_id", userID))
    }

    // sso_get_token
    let user = (db.users || []).find((u: any) => u.sso_id === userID)
    if (!user) {
      const autoReg = getBool(db, "sso_auto_register")
      if (!autoReg) {
        return c.text("user not found and auto register is disabled", 400)
      }
      const username = String(
        userInfo?.login ?? userInfo?.[usernameField] ?? userInfo?.name ?? "",
      )
      user = await autoRegister(db, username || userID, userID, c.env)
    }
    // 禁用账号不得借 SSO 拿到新 token（登录侧同样拒绝），否则封禁可被绕过。
    if (user.disabled) {
      return c.text("account is disabled", 403)
    }

    // 2FA（H-2）：账号开了 TOTP 时，SSO 这一路不能直接发完整令牌——否则
    // 「IdP 侧一个会话 + 一次回调」就绕过了 6 位验证码。改为只发 5 分钟的
    // 待兑换令牌，前端拿到 otp_required 后向 POST /api/auth/otp/login 兑换。
    if (user.otp_secret) {
      const pending = await issueOtpPendingToken(user, c)
      if (useCompat) {
        // 兼容模式沿用「令牌放 URL」的既有契约（M-5 的 URL 契约改造已按决策
        // 跳过）：pending 令牌 5 分钟过期、且不兑换 TOTP 就拿不到任何业务权限。
        return c.redirect(
          `${apiOrigin(c)}/@login?otp_required=1&token=${encodeURIComponent(pending)}`,
          302,
        )
      }
      return c.html(postMessageJson({ otp_required: true, token: pending }))
    }

    const token = await generateToken(user, c)
    if (useCompat) {
      // M-5（**部分修复**）：兼容模式默认仍把完整 JWT 放进 URL —— 改动这一点
      // 会直接打断现有前端的 `/@login?token=` 契约，按决策跳过。
      //
      // 需要收紧时设置 SSO_COMPAT_EXCHANGE_CODE=1：改为 60 秒、单次消费的
      // 兑换码，由 GET /api/auth/sso_exchange?code=... 换回 token，令牌本身
      // 不再进浏览器历史 / Referer / 反代访问日志。
      if (!useCompatExchangeCode(c)) {
        return c.redirect(
          `${apiOrigin(c)}/@login?token=${encodeURIComponent(token)}`,
          302,
        )
      }
      const code = await issueSsoExchangeCode(c, { token })
      return c.redirect(
        `${apiOrigin(c)}/@login?code=${encodeURIComponent(code)}`,
        302,
      )
    }
    return c.html(postMessageHtml("token", token))
  } catch (e: any) {
    return c.text(e.message || "SSO error", 500)
  }
})

/** 解析 JWT payload（仅解码，不验证签名——OIDC 下 code 已交换） */
function parseJwtPayload(token: string): any {
  try {
    const parts = token.split(".")
    if (parts.length < 2) return null
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")
    const decoded = atob(padded)
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

// ---------------- M-5：SSO 兼容模式的一次性兑换码 ----------------
//
// 兼容模式原先直接把完整 JWT 拼进 `/@login?token=...`：令牌会进浏览器历史、
// Referer 头、以及所有中间反代的访问日志。这里改为 60 秒、单次消费的兑换码，
// 由 GET /api/auth/sso_exchange?code=... 换回令牌。

const SSO_EXCHANGE_PREFIX = "sso_exchange:"
const SSO_EXCHANGE_TTL_SEC = 60
const SSO_EXCHANGE_TTL_MS = SSO_EXCHANGE_TTL_SEC * 1000
const ssoExchangeCodes = new Map<string, { exp: number; payload: any }>()

/**
 * 兼容模式是否走一次性兑换码（M-5，默认关闭）。
 *
 * 关闭时保持既有契约 `/@login?token=<jwt>`（现有前端依赖它）；打开后改为
 * `/@login?code=<60 秒单次码>`，需前端改调 `GET /api/auth/sso_exchange`。
 */
function useCompatExchangeCode(c: any): boolean {
  const env = c?.env || {}
  const raw =
    env.SSO_COMPAT_EXCHANGE_CODE ??
    (typeof process !== "undefined"
      ? process.env?.SSO_COMPAT_EXCHANGE_CODE
      : "")
  return raw === "1" || raw === "true"
}

// F-034 后 ssoKv 不再需要：兑换码与 state 均走统一持久化后端。

async function issueSsoExchangeCode(
  c: any,
  payload: { token: string; otp_required?: boolean },
): Promise<string> {
  const code = randomHex(24)
  const now = Date.now()
  if (ssoExchangeCodes.size > 1024) {
    for (const [k, v] of ssoExchangeCodes) {
      if (v.exp <= now) ssoExchangeCodes.delete(k)
    }
  }
  ssoExchangeCodes.set(code, { exp: now + SSO_EXCHANGE_TTL_MS, payload })
  // F-034：持久化走 readPersistedSecret/writePersistedSecret 同一后端解析
  // （D1/MySQL/DO/KV/Blob 全支持）。旧实现直接调 getKvBinding().binding.put，
  // 在 cfkv REST（mode:"api"）部署上 binding 是纯数据对象，写入被 typeof
  // 守卫静默跳过，多实例兑换必然失败。持久化层无 TTL，过期判断放 payload.exp，
  // 消费方负责失效判定与清理。
  try {
    const { writePersistedSecret } = await import("../internal/model/db")
    await writePersistedSecret(
      c?.env,
      SSO_EXCHANGE_PREFIX + code,
      JSON.stringify({ ...payload, exp: now + SSO_EXCHANGE_TTL_MS }),
    )
  } catch {
    // 持久化写失败时本实例的内存记录仍然有效
  }
  return code
}

async function consumeSsoExchangeCode(
  c: any,
  code: string,
): Promise<any | null> {
  if (!code) return null
  const mem = ssoExchangeCodes.get(code)
  if (mem) {
    ssoExchangeCodes.delete(code)
    return mem.exp > Date.now() ? mem.payload : null
  }
  try {
    const { readPersistedSecret, writePersistedSecret } = await import(
      "../internal/model/db"
    )
    const key = SSO_EXCHANGE_PREFIX + code
    const raw = await readPersistedSecret(c?.env, key)
    if (!raw) return null
    // 持久化层没有 delete API：写空串即表示「已消费/不存在」（与登录失败
    // 计数的清理语义一致，见 auth.ts clearPersistedLoginFailure）。
    await writePersistedSecret(c?.env, key, "")
    const parsed = JSON.parse(raw)
    const exp = Number(parsed?.exp)
    if (!Number.isFinite(exp) || exp <= Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

// GET /api/auth/sso_exchange?code=...  →  { token, otp_required? }
ssoRouter.get("/sso_exchange", async (c) => {
  const payload = await consumeSsoExchangeCode(c, c.req.query("code") || "")
  if (!payload) {
    return c.json(
      { code: 400, message: "invalid or expired code", data: null },
      400,
    )
  }
  return c.json({ code: 200, message: "success", data: payload })
})

/** base64url → Uint8Array（无填充容忍）。显式 ArrayBuffer 泛型以满足 BufferSource。 */
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * S-10：用 discovery 文档给出的 jwks_uri 对 id_token 做 RS256 验签。
 *
 * 背景：无 userinfo 端点的 OIDC 部署里，id_token 的 sub 就是登录身份，
 * 只做 claims 校验等于接受「IdP 配置被污染即可伪造任意 sub」。本函数
 * fail-closed：
 *   - jwks_uri 缺失 / JWKS 拉取失败 / 无匹配密钥 / 验签失败 → 抛错；
 *   - 仅接受 RS256（alg 混淆面直接排除）；ES256 等其他算法需扩展后再放行。
 * 每次登录拉取一次 JWKS（SSO 登录频率低，不做缓存，避免复杂化失效逻辑）。
 */
async function verifyIdTokenRs256(
  idToken: string,
  jwksUri: string,
  c: any,
): Promise<void> {
  if (!jwksUri) {
    throw new Error(
      "id_token signature verification unavailable: OIDC discovery returned no jwks_uri",
    )
  }
  const parts = idToken.split(".")
  if (parts.length !== 3) throw new Error("id_token is not a JWS")
  let header: any
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])))
  } catch {
    throw new Error("id_token header is not valid JSON")
  }
  if (header?.alg !== "RS256") {
    throw new Error(`id_token alg ${header?.alg} not allowed (RS256 only)`)
  }
  assertSsoUrl(jwksUri, c)
  const resp = await fetch(jwksUri, {
    headers: { Accept: "application/json" },
    redirect: "manual",
  })
  if (resp.status >= 300 && resp.status < 400) {
    throw new Error("JWKS endpoint must not redirect")
  }
  if (!resp.ok) throw new Error(`JWKS fetch failed: HTTP ${resp.status}`)
  const jwks: any = await resp.json().catch(() => null)
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : []
  const candidates = keys.filter(
    (k: any) =>
      k?.kty === "RSA" &&
      typeof k?.n === "string" &&
      typeof k?.e === "string" &&
      (!k.use || k.use === "sig"),
  )
  const kid = typeof header.kid === "string" ? header.kid : ""
  const jwk =
    (kid ? candidates.find((k: any) => k.kid === kid) : undefined) ||
    (candidates.length === 1 ? candidates[0] : undefined)
  if (!jwk) throw new Error("no matching JWKS key for id_token")
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  )
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  )
  if (!ok) throw new Error("id_token signature verification failed")
}

/**
 * 校验 id_token 的 payload（M-5）：iss / aud / exp 必查，本次授权请求带了
 * nonce 时再校验 nonce。S-10 后签名验证由 verifyIdTokenRs256 负责（需要
 * discovery 给出的 jwks_uri），本函数只做 claims 层校验。
 *
 * 校验失败直接抛错——调用方已在外层 try 中把错误转成 500/400。
 */
function validateIdTokenClaims(
  idToken: string,
  opts: { clientId: string; issuer?: string; nonce?: string },
): any {
  const payload = parseJwtPayload(idToken)
  if (!payload) throw new Error("id_token is not a valid JWT")
  const nowSec = Math.floor(Date.now() / 1000)
  const skew = 60
  const exp = Number(payload.exp)
  if (!Number.isFinite(exp)) throw new Error("id_token missing exp")
  if (exp + skew < nowSec) throw new Error("id_token expired")

  const aud = payload.aud
  const audList = Array.isArray(aud)
    ? aud.map((a: any) => String(a))
    : aud
      ? [String(aud)]
      : []
  if (audList.length === 0) throw new Error("id_token missing aud")
  if (opts.clientId && !audList.includes(String(opts.clientId))) {
    throw new Error("id_token audience mismatch")
  }
  if (opts.issuer && String(payload.iss || "") !== String(opts.issuer)) {
    throw new Error("id_token issuer mismatch")
  }
  if (opts.nonce && String(payload.nonce || "") !== String(opts.nonce)) {
    throw new Error("id_token nonce mismatch")
  }
  return payload
}
