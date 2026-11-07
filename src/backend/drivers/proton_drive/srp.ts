// Proton SRP-6a client (auth v3/v4).
//
// This is a faithful port of @protontech/crypto (src/srp/srp.ts + passwords.ts +
// utils/modulus.ts) and ProtonMail/pm-srp. Proton made three drastic changes on
// top of "textbook" SRP-6a, and every one of them changes the wire values:
//
//  1. Every SRP integer is serialized LITTLE-ENDIAN. `N`, `A`, `B`, `S`, `u`
//     and the bcrypt-derived `x` are all converted with
//     littleEndianArrayToBigInteger(arr) = uint8ArrayToBigInt(arr.reverse()).
//  2. The hash function is not SHA-256 but `expandHash` = SHA-512(input || [0])
//     || SHA-512(input || [1]) || ... || SHA-512(input || [3]) => 256 bytes.
//     It is used for k, u, the bcrypt password expansion and both proofs.
//  3. The client proof is `H(A | B | S)` (three segments, no RFC 5054 prefix)
//     and the server also returns a proof `H(A | M | S)` that must be checked.
//
// The modulus is delivered by /auth/v4/info as a PGP *cleartext signed*
// message; it must be verified against Proton's built-in SRP modulus key
// before it is used.

import bcrypt from "bcryptjs"
import * as openpgp from "openpgp"

/** Proton's SRP modulus signing key (public, baked into every official client). */
export const SRP_MODULUS_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

xjMEXAHLgxYJKwYBBAHaRw8BAQdAFurWXXwjTemqjD7CXjXVyKf0of7n9Ctm
L8v9enkzggHNEnByb3RvbkBzcnAubW9kdWx1c8J3BBAWCgApBQJcAcuDBgsJ
BwgDAgkQNQWFxOlRjyYEFQgKAgMWAgECGQECGwMCHgEAAPGRAP9sauJsW12U
MnTQUZpsbJb53d0Wv55mZIIiJL2XulpWPQD/V6NglBd96lZKBmInSXX/kXat
Sv+y0io+LR8i2+jV+AbOOARcAcuDEgorBgEEAZdVAQUBAQdAeJHUz1c9+KfE
kSIgcBRE3WuXC4oj5a2/U3oASExGDW4DAQgHwmEEGBYIABMFAlwBy4MJEDUF
hcTpUY8mAhsMAAD/XQD8DxNI6E78meodQI+wLsrKLeHn32iLvUqJbVDhfWSU
WO4BAMcm1u02t4VKw++ttECPt+HUgPUq5pqQWe5Q2cW4TMsE
=Y4Mw
-----END PGP PUBLIC KEY BLOCK-----`

export const SRP_LEN = 2048 / 8 // 256 bytes: fixed modulus / ephemeral size
export const SRP_BCRYPT_PREFIX = "$2y$10$"

// bcrypt uses its own base64 alphabet.
const BCRYPT_CHARS =
  "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// ---------- byte helpers ----------

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }
  return out
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function toBase64(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Parse a byte array as a little-endian unsigned integer (Proton convention). */
export function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let hex = "0x"
  for (let i = bytes.length - 1; i >= 0; i--) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }
  return BigInt(hex)
}

/** Serialize an unsigned integer into `length` little-endian bytes. */
export function bigIntToLittleEndian(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let v = value
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v !== 0n) throw new Error("integer does not fit in output length")
  return out
}

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n
  let result = 1n
  let b = ((base % mod) + mod) % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return result
}

function mod(a: bigint, m: bigint): bigint {
  const r = a % m
  return r < 0n ? r + m : r
}

async function sha512(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-512", data as unknown as BufferSource),
  )
}

async function md5(data: Uint8Array): Promise<Uint8Array> {
  // Only used by legacy auth versions (v0/v1/v2) for the bcrypt salt.
  const { createHash } = await import("node:crypto")
  return new Uint8Array(createHash("md5").update(Buffer.from(data)).digest())
}

/** Proton's hash: 4 x SHA-512(input || counter), 256 bytes total. */
export async function expandHash(input: Uint8Array): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for (let i = 0; i < 4; i++) {
    parts.push(await sha512(concatBytes(input, new Uint8Array([i]))))
  }
  return concatBytes(...parts)
}

/** bcrypt-base64 encoding of the first `maxBytes` bytes (Proton salt format). */
export function bcryptEncodeBase64(bytes: Uint8Array, maxBytes = 16): string {
  let out = ""
  let bits = 0
  let acc = 0
  const len = Math.min(maxBytes, bytes.length)
  for (let i = 0; i < len; i++) {
    acc = (acc << 8) | bytes[i]
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += BCRYPT_CHARS[(acc >> bits) & 0x3f]
    }
  }
  if (bits > 0) out += BCRYPT_CHARS[(acc << (6 - bits)) & 0x3f]
  return out
}

function binaryStringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function cleanUsername(name = ""): string {
  return name.replace(/[.\-_]/g, "").toLowerCase()
}

// ---------- password hashing ----------

async function formatHash(
  password: string,
  bcryptSalt: string,
  modulus: Uint8Array,
): Promise<Uint8Array> {
  // NOTE: the *whole* 60-character "$2y$10$..." string is hashed, not the
  // 23-byte digest.
  const unexpanded = bcrypt.hashSync(password, SRP_BCRYPT_PREFIX + bcryptSalt)
  return expandHash(concatBytes(binaryStringToBytes(unexpanded), modulus))
}

async function hashPasswordLegacy(
  password: string,
  username: string,
  modulus: Uint8Array,
): Promise<Uint8Array> {
  const saltHex = Array.from(await md5(utf8(username.toLowerCase())))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return formatHash(password, saltHex, modulus)
}

/**
 * Derive the SRP "hashed password" (x) for the given auth version.
 *
 * - v3/v4: bcrypt(password, "$2y$10$" + b64(salt_bytes || "proton")[0:16]),
 *          then expandHash(bcrypt_ascii || modulus).
 * - v2:    bcrypt salt = md5(cleanUsername(username)) hex.
 * - v1:    bcrypt salt = md5(username) hex.
 * - v0:    password is pre-hashed with SHA-512 + base64, then v1.
 *
 * `salt` is the raw salt bytes (already base64-decoded) for v3+.
 */
export async function hashPassword(
  version: number,
  password: string,
  salt: Uint8Array | string,
  username = "",
  modulus: Uint8Array = new Uint8Array(SRP_LEN),
): Promise<Uint8Array> {
  if (version >= 3) {
    const saltBytes =
      typeof salt === "string" ? binaryStringToBytes(salt) : salt
    const saltBinary = concatBytes(saltBytes, utf8("proton"))
    const bcryptSalt = bcryptEncodeBase64(saltBinary, 16)
    return formatHash(password, bcryptSalt, modulus)
  }
  if (version === 2) {
    return hashPasswordLegacy(password, cleanUsername(username), modulus)
  }
  if (version === 1) {
    return hashPasswordLegacy(password, username, modulus)
  }
  if (version === 0) {
    const digest = await sha512(utf8(username.toLowerCase() + password))
    const prehashed = toBase64(digest)
    return hashPasswordLegacy(prehashed, username, modulus)
  }
  throw new Error("unsupported auth version")
}

// ---------- modulus verification ----------

/**
 * Verify a PGP cleartext-signed SRP modulus and return its 256 raw bytes.
 * Throws if the signature is not valid for `armoredPublicKey`.
 */
export async function verifyCleartextModulus(
  modulusCleartext: string,
  armoredPublicKey: string,
): Promise<Uint8Array> {
  // Reject smuggled content after the signature block (go-srp does the same).
  const endMarker = "-----END PGP SIGNATURE-----"
  const endIndex = modulusCleartext.indexOf(endMarker)
  if (endIndex < 0) throw new Error("SRP modulus is not a signed message")
  if (modulusCleartext.slice(endIndex + endMarker.length).trim() !== "") {
    throw new Error("unexpected data after the SRP modulus signature")
  }
  const publicKey = await openpgp.readKey({ armoredKey: armoredPublicKey })
  const cleartext = await openpgp.readCleartextMessage({
    cleartextMessage: modulusCleartext,
  })
  const { signatures } = await openpgp.verify({
    message: cleartext,
    verificationKeys: [publicKey],
  })
  if (!signatures.length) throw new Error("SRP modulus is not signed")
  for (const signature of signatures) {
    await signature.verified // rejects when the signature is invalid
  }
  const text = (cleartext.getText() || "").replace(/\s+/g, "")
  if (!text) throw new Error("SRP modulus is empty")
  return fromBase64(text)
}

/**
 * Verify the modulus from /auth/v4/info against Proton's built-in SRP key.
 * This is a hard requirement of the protocol: an unverified modulus lets the
 * server pick a group the client does not validate.
 */
export async function verifyAndGetModulus(modulus: string): Promise<Uint8Array> {
  try {
    return await verifyCleartextModulus(modulus, SRP_MODULUS_KEY)
  } catch (e: any) {
    throw new Error(`unable to verify SRP modulus: ${e?.message || e}`)
  }
}

// ---------- SRP-6a ----------

export interface SRPAuthInfo {
  /** PGP cleartext-signed modulus (NOT raw base64) */
  Modulus: string
  ServerEphemeral: string // base64, little-endian integer
  Salt: string // base64
  Version: number
  SRPSession: string
  Username?: string
}

export interface SRPClientProof {
  ClientEphemeral: string // base64
  ClientProof: string // base64
  SRPSession: string
  /** H(A | M | S) — must match the server's ServerProof. */
  ExpectedServerProof: string // base64
}

export interface SRPProofOptions {
  /** Deterministic 256-byte client secret (tests only). */
  clientSecret?: Uint8Array
  /** Override the modulus bytes (tests only, skips PGP verification). */
  modulusBytes?: Uint8Array
}

const MAX_VALUE_ITERATIONS = 1000

/**
 * Compute the client SRP-6a proofs for Proton's auth v3/v4 handshake.
 */
export async function computeSRPClientProof(
  username: string,
  password: string,
  info: SRPAuthInfo,
  options: SRPProofOptions = {},
): Promise<SRPClientProof> {
  const version = info.Version ?? 4
  const modulusBytes = options.modulusBytes ?? (await verifyAndGetModulus(info.Modulus))
  if (modulusBytes.length !== SRP_LEN) {
    throw new Error("SRP modulus has incorrect size")
  }

  const N = littleEndianToBigInt(modulusBytes)
  const serverEphemeralBytes = fromBase64(info.ServerEphemeral)
  const B = littleEndianToBigInt(serverEphemeralBytes)
  if (B === 0n) throw new Error("SRP server ephemeral is out of bounds")

  const saltBytes = fromBase64(info.Salt)
  const hashedPassword = await hashPassword(
    version,
    password,
    saltBytes,
    info.Username || username,
    modulusBytes,
  )
  const x = littleEndianToBigInt(hashedPassword)

  const generator = 2n
  const k = littleEndianToBigInt(
    await expandHash(
      concatBytes(bigIntToLittleEndian(generator, SRP_LEN), modulusBytes),
    ),
  )

  // g^x mod N and k*g^x mod N
  const gx = modPow(generator, x, N)
  const kgx = mod(gx * mod(k, N), N)
  const base = mod(B - kgx, N)

  const prove = async (secretBytes: Uint8Array) => {
    const a = littleEndianToBigInt(secretBytes)
    const A = modPow(generator, a, N)
    if (A === 0n) return null
    const aLe = bigIntToLittleEndian(A, SRP_LEN)
    const u = littleEndianToBigInt(
      await expandHash(concatBytes(aLe, serverEphemeralBytes)),
    )
    if (u === 0n) return null
    // S = (B - k*g^x) ^ (u*x + a) mod N, exponent reduced mod N-1
    const S = modPow(base, mod(u * x + a, N - 1n), N)
    const sLe = bigIntToLittleEndian(S, SRP_LEN)
    const clientProof = await expandHash(
      concatBytes(aLe, serverEphemeralBytes, sLe),
    )
    // Server must answer with H(A | M | S).
    const expectedServerProof = await expandHash(
      concatBytes(aLe, clientProof, sLe),
    )
    return {
      clientEphemeral: aLe,
      clientProof,
      expectedServerProof,
    }
  }

  if (options.clientSecret) {
    if (options.clientSecret.length !== SRP_LEN) {
      throw new Error("client secret must be 256 bytes")
    }
    const proofs = await prove(options.clientSecret)
    if (!proofs) throw new Error("invalid client secret")
    return {
      ClientEphemeral: toBase64(proofs.clientEphemeral),
      ClientProof: toBase64(proofs.clientProof),
      SRPSession: info.SRPSession,
      ExpectedServerProof: toBase64(proofs.expectedServerProof),
    }
  }

  for (let i = 0; i < MAX_VALUE_ITERATIONS; i++) {
    const random = crypto.getRandomValues(new Uint8Array(SRP_LEN))
    const proofs = await prove(random)
    if (proofs) {
      return {
        ClientEphemeral: toBase64(proofs.clientEphemeral),
        ClientProof: toBase64(proofs.clientProof),
        SRPSession: info.SRPSession,
        ExpectedServerProof: toBase64(proofs.expectedServerProof),
      }
    }
  }
  throw new Error("could not find safe SRP parameters")
}

/** Constant-time comparison of two base64 proof strings. */
export function proofsEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export { cleanUsername }
