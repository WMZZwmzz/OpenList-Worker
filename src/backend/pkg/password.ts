/* =====================================================================
 * 密码哈希模块 (Password Hashing)
 *
 * 存储方案（S-03 渐进迁移后的新格式）：
 *   `$olpbkdf2-sha256$<iterations>$<saltHex>$<dkHex>`
 *   dk = PBKDF2-SHA256(StaticHash(pwd), salt, iterations, 256bit)
 *   —— 第一层仍对齐 Go StaticHash（/login/hash 通道兼容），第二层由
 *   单轮 SHA-256 升级为 PBKDF2 慢哈希，库泄露后的离线爆破成本提高约
 *   10⁵ 倍。迭代数取 100_000：与本项目 config 加密的 PBKDF2 一致，是
 *   Cloudflare Workers CPU 预算内可承受的上限（报告建议的 210k 在
 *   free tier 会超时）。
 *
 * 历史格式（读兼容，登录成功后自动迁移到新格式，见 auth.ts 登录钩子）：
 *   - Go 兼容双层 SHA256：PwdHash = sha256(`${StaticHash(pwd)}-${salt}`)，
 *     对齐 OpenList/internal/model/user.go；
 *   - 单层 sha256（无 salt 字段，早期 TSWorker）：password 直接等于 StaticHash(pwd)。
 *
 * 存储字段：user.password（新格式串或 64 位 hex）+ user.salt（16 位随机，
 * 仍会写入以保持 Go 导出兼容；新格式的盐内嵌在 password 串里）。
 * ===================================================================== */

export const STATIC_HASH_SALT = "https://github.com/alist-org/alist"

/** S-03：PBKDF2 迭代数（新格式写入值） */
export const PBKDF2_PASSWORD_ITERATIONS = 100000

const PBKDF2_PASSWORD_PREFIX = "$olpbkdf2-sha256$"

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  )
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** 明文 -> 传输用静态哈希（对应 Go StaticHash） */
export async function staticHash(plain: string): Promise<string> {
  return sha256Hex(`${plain}-${STATIC_HASH_SALT}`)
}

/** 静态哈希 + 用户盐 -> 最终存储值（对应 Go HashPwd，历史格式） */
export async function saltedHash(
  staticHex: string,
  salt: string,
): Promise<string> {
  return sha256Hex(`${staticHex}-${salt}`)
}

/** 明文 + 用户盐 -> 最终存储值（对应 Go TwoHashPwd / SetPassword，历史格式） */
export async function twoStepHash(
  plain: string,
  salt: string,
): Promise<string> {
  return saltedHash(await staticHash(plain), salt)
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** 是否为 S-03 PBKDF2 新格式存储值 */
export function isPbkdf2PasswordFormat(value: string): boolean {
  return String(value || "").startsWith(PBKDF2_PASSWORD_PREFIX)
}

/**
 * PBKDF2 慢哈希（新格式核心）：以 StaticHash(pwd) 为密钥材料派生 256bit。
 */
async function pbkdf2Hex(
  secret: string,
  saltHex: string,
  iterations: number,
): Promise<string> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations },
    baseKey,
    256,
  )
  return bytesToHex(new Uint8Array(bits))
}

/**
 * 生成 S-03 新格式存储值：`$olpbkdf2-sha256$<iter>$<saltHex>$<dkHex>`。
 * saltHex 省略时生成 16 字节随机盐。
 */
export async function pbkdf2PasswordHash(
  plain: string,
  saltHex?: string,
): Promise<string> {
  return pbkdf2PasswordHashFromStatic(await staticHash(plain), saltHex)
}

/**
 * 同上，但直接以 StaticHash(pwd)（/login/hash 通道的输入）为密钥材料 ——
 * 该通道拿不到明文，迁移时无需明文。
 */
export async function pbkdf2PasswordHashFromStatic(
  staticHex: string,
  saltHex?: string,
): Promise<string> {
  const salt =
    saltHex || bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const dk = await pbkdf2Hex(staticHex, salt, PBKDF2_PASSWORD_ITERATIONS)
  return `${PBKDF2_PASSWORD_PREFIX}${PBKDF2_PASSWORD_ITERATIONS}$${salt}$${dk}`
}

/**
 * 校验 S-03 新格式存储值。`staticHex` 为前端 /login/hash 通道提交的
 * StaticHash(pwd)（与历史验证入口同源）。非新格式返回 null（交由历史路径）。
 */
export async function verifyPbkdf2Password(
  stored: string,
  staticHex: string,
): Promise<boolean | null> {
  if (!isPbkdf2PasswordFormat(stored)) return null
  const parts = stored.slice(PBKDF2_PASSWORD_PREFIX.length).split("$")
  if (parts.length !== 3) return false
  const iterations = Number(parts[0])
  const salt = parts[1]
  const expect = parts[2]
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > 10_000_000 ||
    !/^[0-9a-f]+$/i.test(salt) ||
    salt.length < 16 ||
    !/^[0-9a-f]{64}$/i.test(expect)
  ) {
    return false
  }
  const dk = await pbkdf2Hex(staticHex, salt, iterations)
  return constantTimeEqualHex(dk.toLowerCase(), expect.toLowerCase())
}

/** 生成用户盐（16 位 [A-Za-z0-9]，对应 Go random.String(16)） */
export function generateSalt(length: number = 16): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length]
  return out
}

/** 是否为 64 位 hex（双层/单层 SHA256 存储值均符合） */
export function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(String(value || ""))
}

/**
 * 统一写入口令（对应 Go User.SetPassword）：
 * 写入 S-03 PBKDF2 新格式（盐内嵌）。user.salt 仍生成并保留（历史数据比对
 * 与 Go 导出兼容）。调用方负责 saveDb 持久化。
 */
export async function setUserPassword(user: any, plain: string): Promise<void> {
  user.salt = generateSalt()
  user.password = await pbkdf2PasswordHash(plain)
  user.pwd_update_at = new Date().toISOString()
}

/**
 * 密码时间戳指纹（对齐 Go common.UserClaims.PwdTS 及其比对逻辑）。
 *
 * 安全不变量：JWT 只证明「签发那一刻身份合法」，不证明「现在仍然合法」。
 * 密码一旦被修改，所有既有令牌必须立即失效 —— Go 在每次请求里都拿令牌中的
 * PwdTS 与数据库当前值比对。历史缺陷：TS 的 JWT 只携带 {id, username, role}，
 * 改密后旧令牌在有效期内（7 天）继续可用，除非用户显式登出。
 *
 * 取值为空字符串（旧数据/未设置）时两侧一致，视为相等，不影响历史账号。
 */
export function passwordStampOf(user: any): string {
  return String(user?.pwd_update_at ?? "")
}

/** 校验令牌内的密码指纹是否与数据库当前值一致 */
export function isPasswordStampValid(payload: any, user: any): boolean {
  return String(payload?.pwd_ts ?? "") === passwordStampOf(user)
}

/**
 * 定长十六进制摘要的逐字节比较。`===` 会在第一个不同字符处短路，
 * 时序差可被用来逐字节还原期望哈希。
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ---- 工具函数（与存储无关） ----

/**
 * 使用 CSPRNG 生成 [0, maxExclusive) 的均匀随机整数（rejection sampling 消除 modulo bias）
 */
function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) throw new Error("maxExclusive must be > 0")
  if (maxExclusive === 1) return 0
  const limit = 256 - (256 % maxExclusive)
  const buf = new Uint8Array(1)
  let r = 0
  do {
    crypto.getRandomValues(buf)
    r = buf[0]
  } while (r >= limit)
  return r % maxExclusive
}

/**
 * 生成随机密码（用于临时密码、重置密码等）
 * @param length 密码长度（默认 16，最小 4）
 */
export function generateRandomPassword(length: number = 16): string {
  if (!Number.isInteger(length) || length < 4) {
    throw new Error("Password length must be an integer of at least 4")
  }
  const lowercase = "abcdefghijklmnopqrstuvwxyz"
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  const numbers = "0123456789"
  const symbols = "!@#$%^&*()-_=+[]{}|;:,.<>?"
  const all = lowercase + uppercase + numbers + symbols

  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)

  const chars: string[] = []
  // 保证四类字符各至少一个
  chars.push(lowercase[bytes[0] % lowercase.length])
  chars.push(uppercase[bytes[1] % uppercase.length])
  chars.push(numbers[bytes[2] % numbers.length])
  chars.push(symbols[bytes[3] % symbols.length])
  for (let i = 4; i < length; i++) {
    chars.push(all[bytes[i] % all.length])
  }

  // Fisher-Yates 洗牌
  for (let i = chars.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1)
    const tmp = chars[i]
    chars[i] = chars[j]
    chars[j] = tmp
  }
  return chars.join("")
}

/**
 * 验证密码强度
 * @returns { score: 0-4, feedback, isStrong }
 */
export function checkPasswordStrength(password: string): {
  score: number
  feedback: string[]
  isStrong: boolean
} {
  const feedback: string[] = []
  let score = 0

  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (password.length < 8)
    feedback.push("Password should be at least 8 characters")

  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) {
    score++
  } else {
    feedback.push("Include both lowercase and uppercase letters")
  }

  if (/[0-9]/.test(password)) {
    score++
  } else {
    feedback.push("Include at least one number")
  }

  if (/[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/.test(password)) {
    score++
  } else {
    feedback.push("Include at least one special character")
  }

  const weakPatterns = [
    /^password/i,
    /^123456/,
    /^qwerty/i,
    /^admin/i,
    /^letmein/i,
  ]
  for (const pattern of weakPatterns) {
    if (pattern.test(password)) {
      score = Math.max(0, score - 2)
      feedback.push("Avoid common passwords")
      break
    }
  }

  return { score: Math.min(4, score), feedback, isStrong: score >= 3 }
}
