import CryptoJS from "crypto-js"
import { generateTOTPToken } from "../../pkg/totp"
import { randomInt } from "../rand"
import { MegaAddition, MegaNodeItem } from "./types"

// ---------------------------------------------------------------------------
// Mega client-side crypto.
//
// Key facts (matching megajs / MEGA SDK / go-mega):
//  - all integers and AES inputs are handled as big-endian byte strings;
//  - `prepare_key` = 65536 AES-128-ECB rounds over 16-byte password chunks;
//  - `stringhash(s, key)` = XOR fold of the string into 16 bytes, 16384 AES
//    rounds, then words 0 and 2 (8 bytes);
//  - node keys `k` are AES-ECB encrypted with the master key and are 16 bytes
//    (folders) or 32 bytes (files: AES key || CTR nonce/meta-MAC);
//  - node attributes `a` are AES-CBC (zero IV) encrypted `MEGA{"n":...}`;
//  - file data is AES-CTR (8-byte nonce + 64-bit counter) in chunks of
//    128KiB..1MiB, each chunk followed by an 8-byte MAC, with a meta-MAC in the
//    file key.
// ---------------------------------------------------------------------------

// ---------- base64url / word helpers ----------

export function b64ToWords(s: string): CryptoJS.lib.WordArray {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "")
  while (b64.length % 4 !== 0) {
    b64 += "="
  }
  return CryptoJS.enc.Base64.parse(b64)
}

export function wordsToB64(words: CryptoJS.lib.WordArray): string {
  return CryptoJS.enc.Base64.stringify(words)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

export function strToWords(s: string): CryptoJS.lib.WordArray {
  return CryptoJS.enc.Utf8.parse(s)
}

export function b64urlDecode(s: string): Uint8Array {
  return wordsToBytes(b64ToWords(s))
}

export function b64urlEncode(bytes: Uint8Array): string {
  return wordsToB64(bytesToWords(bytes))
}

function bytesToWords(bytes: Uint8Array): CryptoJS.lib.WordArray {
  const words: number[] = []
  for (let i = 0; i < bytes.length; i += 4) {
    words.push(
      (((bytes[i] || 0) << 24) |
        ((bytes[i + 1] || 0) << 16) |
        ((bytes[i + 2] || 0) << 8) |
        (bytes[i + 3] || 0)) |
        0,
    )
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length)
}

function wordsToBytes(words: CryptoJS.lib.WordArray): Uint8Array {
  const out = new Uint8Array(words.sigBytes)
  for (let i = 0; i < words.sigBytes; i++) {
    out[i] = (words.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff
  }
  return out
}

export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }
  return out
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ (b[i] || 0)
  return out
}

// ---------- AES (CryptoJS low level; works on Node, workers and browsers) ----------

const AES_CFG = {
  mode: CryptoJS.mode.ECB,
  padding: CryptoJS.pad.NoPadding,
}

/** AES-128 ECB block cipher with the key schedule computed once. */
export class MegaAes {
  private encryptor: any
  private decryptor: any

  constructor(private key: Uint8Array) {
    if (key.length !== 16) throw new Error("Mega AES key must be 16 bytes")
    const keyWA = bytesToWords(key)
    this.encryptor = CryptoJS.algo.AES.createEncryptor(keyWA, AES_CFG as any)
    this.decryptor = CryptoJS.algo.AES.createDecryptor(keyWA, AES_CFG as any)
  }

  encryptBlock(block: Uint8Array): Uint8Array {
    const words = Array.from(bytesToWords(block).words)
    while (words.length < 4) words.push(0)
    this.encryptor.encryptBlock(words, 0)
    return this.wordsTo16(words)
  }

  decryptBlock(block: Uint8Array): Uint8Array {
    const words = Array.from(bytesToWords(block).words)
    while (words.length < 4) words.push(0)
    this.decryptor.decryptBlock(words, 0)
    return this.wordsTo16(words)
  }

  private wordsTo16(words: number[]): Uint8Array {
    const out = new Uint8Array(16)
    for (let i = 0; i < 4; i++) {
      out[i * 4] = (words[i] >>> 24) & 0xff
      out[i * 4 + 1] = (words[i] >>> 16) & 0xff
      out[i * 4 + 2] = (words[i] >>> 8) & 0xff
      out[i * 4 + 3] = words[i] & 0xff
    }
    return out
  }
}

export function aesEcbEncrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const aes = new MegaAes(key)
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i += 16) {
    const enc = aes.encryptBlock(padBlock(data.subarray(i, i + 16)))
    out.set(enc.subarray(0, Math.min(16, data.length - i)), i)
  }
  return out
}

export function aesEcbDecrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const aes = new MegaAes(key)
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i += 16) {
    const dec = aes.decryptBlock(padBlock(data.subarray(i, i + 16)))
    out.set(dec.subarray(0, Math.min(16, data.length - i)), i)
  }
  return out
}

/** AES-CBC with a zero IV (Mega uses no PKCS#7 padding; callers pad). */
export function aesCbcEncrypt(data: Uint8Array, key: Uint8Array, iv?: Uint8Array): Uint8Array {
  const aes = new MegaAes(key)
  const out = new Uint8Array(data.length)
  // `slice()` preserves the (possibly SharedArrayBuffer-backed) input type.
  let prev: Uint8Array = iv ? iv.slice(0, 16) : new Uint8Array(16)
  for (let i = 0; i < data.length; i += 16) {
    const block = xorBytes(padBlock(data.subarray(i, i + 16)), prev)
    const enc: Uint8Array = aes.encryptBlock(block)
    out.set(enc.subarray(0, Math.min(16, data.length - i)), i)
    prev = enc
  }
  return out
}

export function aesCbcDecrypt(data: Uint8Array, key: Uint8Array, iv?: Uint8Array): Uint8Array {
  const aes = new MegaAes(key)
  const out = new Uint8Array(data.length)
  let prev: Uint8Array = iv ? iv.slice(0, 16) : new Uint8Array(16)
  for (let i = 0; i < data.length; i += 16) {
    const chunk = padBlock(data.subarray(i, i + 16))
    const dec: Uint8Array = xorBytes(aes.decryptBlock(chunk), prev)
    out.set(dec.subarray(0, Math.min(16, data.length - i)), i)
    prev = chunk
  }
  return out
}

function padBlock(block: Uint8Array): Uint8Array {
  if (block.length === 16) return block
  const out = new Uint8Array(16)
  out.set(block)
  return out
}

/**
 * CBC-MAC over 16-byte blocks (zero padded). Mega uses it for attribute blobs
 * and for the per-chunk / meta MAC of file data.
 */
export function cbcMac(data: Uint8Array, aes: MegaAes, initialState?: Uint8Array): Uint8Array {
  let state: Uint8Array = initialState ? initialState.slice(0, 16) : new Uint8Array(16)
  for (let i = 0; i < data.length; i += 16) {
    state = aes.encryptBlock(xorBytes(padBlock(data.subarray(i, i + 16)), state))
  }
  return state
}

/** Mega's MAC condensing: fold every chunk MAC into one 8-byte value. */
export function condenseMac(chunkMacs: Uint8Array[], aes: MegaAes): Uint8Array {
  let mac: Uint8Array = new Uint8Array(16)
  for (const item of chunkMacs) {
    mac = aes.encryptBlock(xorBytes(mac, item))
  }
  const out = new Uint8Array(8)
  for (let i = 0; i < 4; i++) {
    out[i] = mac[i] ^ mac[i + 4]
    out[i + 4] = mac[i + 8] ^ mac[i + 12]
  }
  return out
}

// ---------- Mega password / string hashing ----------

const PREPARE_KEY_SEED = new Uint8Array([
  0x93, 0xc4, 0x67, 0xe3, 0x7d, 0xb0, 0xc7, 0xa4, 0xd1, 0xbe, 0x3f, 0x81,
  0x01, 0x52, 0xcb, 0x56,
])

/**
 * mega's prepare_key: 65536 rounds of AES-128-ECB over the 16-byte chunks of
 * the password, applied to a fixed seed. Returns the 16-byte password key.
 */
export function prepareKey(password: string): Uint8Array {
  const passwordBytes = utf8Bytes(password)
  let pkey: Uint8Array = PREPARE_KEY_SEED.slice()
  let aesCache: MegaAes | null = null
  let aesKeyBytes: Uint8Array | null = null
  for (let round = 0; round < 0x10000; round++) {
    for (let j = 0; j < passwordBytes.length; j += 16) {
      const key = new Uint8Array(16)
      for (let i = 0; i < 16; i++) {
        if (i + j < passwordBytes.length) key[i] = passwordBytes[i + j]
      }
      // The key schedule only changes when the password chunk changes.
      if (!aesCache || !aesKeyBytes || !bytesEqual(aesKeyBytes, key)) {
        aesCache = new MegaAes(key)
        aesKeyBytes = key
      }
      pkey = aesCache.encryptBlock(pkey)
    }
  }
  return pkey
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * mega's stringhash: XOR the string's big-endian words into 16 bytes, run 16384
 * AES rounds, and return words 0 and 2 (8 bytes).
 */
export function stringhash(s: string, key: Uint8Array): Uint8Array {
  const data = utf8Bytes(s)
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4)
  padded.set(data)
  const h = new Uint8Array(16)
  for (let i = 0; i < padded.length; i += 4) {
    const word = ((padded[i] << 24) | (padded[i + 1] << 16) | (padded[i + 2] << 8) | padded[i + 3]) >>> 0
    const idx = (i / 4) & 3
    const cur = ((h[idx * 4] << 24) | (h[idx * 4 + 1] << 16) | (h[idx * 4 + 2] << 8) | h[idx * 4 + 3]) >>> 0
    const next = (cur ^ word) >>> 0
    h[idx * 4] = (next >>> 24) & 0xff
    h[idx * 4 + 1] = (next >>> 16) & 0xff
    h[idx * 4 + 2] = (next >>> 8) & 0xff
    h[idx * 4 + 3] = next & 0xff
  }
  const aes = new MegaAes(key)
  let hash: Uint8Array = h
  for (let i = 0; i < 0x4000; i++) hash = aes.encryptBlock(hash)
  return concatBytes(hash.subarray(0, 4), hash.subarray(8, 12))
}

// ---------- RSA (login: csid) ----------

export interface MegaRsaKey {
  p: bigint
  q: bigint
  d: bigint
  u: bigint
}

/** Decode Mega's MPI-encoded RSA private key (p, q, d, u). */
export function decodeRsaPrivateKey(bytes: Uint8Array): MegaRsaKey | null {
  const values: bigint[] = []
  let rest = bytes
  for (let i = 0; i < 4; i++) {
    if (rest.length < 2) return null
    const len = (((rest[0] << 8) | rest[1]) + 7) >> 3
    if (len + 2 > rest.length) return null
    let value = 0n
    for (let j = 0; j < len; j++) value = (value << 8n) | BigInt(rest[2 + j])
    values.push(value)
    rest = rest.subarray(2 + len)
  }
  return { p: values[0], q: values[1], d: values[2], u: values[3] }
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return result
}

function bigIntToBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array([0])
  let hex = value.toString(16)
  if (hex.length % 2) hex = "0" + hex
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** Raw (unpadded) RSA decryption, as used by Mega for `csid`. */
export function rsaDecrypt(ciphertext: Uint8Array, key: MegaRsaKey): Uint8Array {
  let c = 0n
  for (const b of ciphertext) c = (c << 8n) | BigInt(b)
  const n = key.p * key.q
  const m = modPow(c, key.d, n)
  return bigIntToBytes(m)
}

// ---------- node keys and attributes ----------

export interface MegaKeyCandidate {
  handle?: string
  key: string
}

/** Split a node `k` value into `handle:key` candidates. */
export function splitKeyCandidates(k: string): MegaKeyCandidate[] {
  return k
    .split("/")
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(":")
      if (idx < 0) return { key: part }
      return { handle: part.slice(0, idx), key: part.slice(idx + 1) }
    })
}

/** Pick the key candidate that belongs to `handle` (see mega.js loadMetadata). */
export function pickNodeKey(
  k: string,
  handle: string,
): MegaKeyCandidate | null {
  const candidates = splitKeyCandidates(k)
  const exact = candidates.find((c) => c.handle === handle)
  if (exact) return exact
  const plain = candidates.find((c) => !c.handle)
  if (plain) return plain
  return candidates[0] || null
}

/**
 * Decrypt a node key with the master key.
 * 16 bytes = folder key, 32 bytes = file key (AES key || nonce/meta-MAC).
 * RSA-encrypted keys (shared nodes) are decrypted with the private key.
 */
export function decryptNodeKey(
  encrypted: Uint8Array,
  masterKey: Uint8Array,
  rsaKey?: MegaRsaKey | null,
  isDirectory = false,
): Uint8Array {
  if (encrypted.length <= 32) {
    return aesEcbDecrypt(encrypted, masterKey)
  }
  if (!rsaKey) throw new Error("node key is RSA encrypted and no private key")
  return rsaDecrypt(encrypted, rsaKey).subarray(0, isDirectory ? 16 : 32)
}

/** Mega folds the file key and the nonce: AES key = key[0:16] ^ key[16:32]. */
export function unmergeKeyMac(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(key.length)
  out.set(key)
  for (let i = 0; i < 16 && i + 16 < key.length; i++) {
    out[i] = key[i] ^ key[i + 16]
  }
  return out
}

/** Derive the AES key used for attributes / file data from a node key. */
export function nodeAesKey(nodeKey: Uint8Array): Uint8Array {
  return unmergeKeyMac(nodeKey).subarray(0, 16)
}

export interface MegaAttributes {
  n?: string
  [k: string]: unknown
}

/**
 * Decrypt a node attribute blob: base64url(AES-CBC-zeroIV("MEGA"+json)).
 * When the blob carries a trailing 64-bit CBC-MAC (length % 16 === 8), the MAC
 * is verified before the plaintext is parsed.
 */
export function decryptAttributes(
  attrB64: string,
  nodeKey: Uint8Array,
): MegaAttributes | null {
  if (!attrB64) return null
  let raw = b64urlDecode(attrB64)
  if (!raw.length || raw.length % 4 !== 0) return null
  const aes = new MegaAes(nodeAesKey(nodeKey))

  let ciphertext = raw
  if (raw.length % 16 === 8) {
    // Blob with an appended 8-byte MAC: verify it before trusting the data.
    ciphertext = raw.subarray(0, raw.length - 8)
    const mac = cbcMac(ciphertext, aes)
    const folded = new Uint8Array(8)
    for (let i = 0; i < 4; i++) {
      folded[i] = mac[i] ^ mac[i + 4]
      folded[i + 4] = mac[i + 8] ^ mac[i + 12]
    }
    if (!bytesEqual(folded, raw.subarray(raw.length - 8))) return null
  }
  if (ciphertext.length % 16 !== 0) return null

  const plain = aesCbcDecrypt(ciphertext, nodeAesKey(nodeKey))
  let end = 0
  while (end < plain.length && plain[end] !== 0) end++
  const text = new TextDecoder().decode(plain.subarray(0, end))
  if (!text.startsWith("MEGA{")) return null
  try {
    return JSON.parse(text.slice(4)) as MegaAttributes
  } catch {
    return null
  }
}

/**
 * Encrypt a node attribute blob the way the official clients do:
 * AES-CBC(zero IV) over the zero-padded `MEGA{...}` text, base64url encoded.
 * No MAC is appended — megajs / mega.py / go-mega all write blobs this way and
 * other clients must be able to read the folder we create.
 */
export function encryptAttributes(
  attributes: MegaAttributes,
  nodeKey: Uint8Array,
): string {
  const text = utf8Bytes("MEGA" + JSON.stringify(attributes))
  const padded = new Uint8Array(Math.ceil(text.length / 16) * 16)
  padded.set(text)
  const ciphertext = aesCbcEncrypt(padded, nodeAesKey(nodeKey))
  return b64urlEncode(ciphertext)
}

/** Build the `k` value for a freshly created node: `handle:base64url(...)`. */
export function encryptNodeKey(
  nodeKey: Uint8Array,
  masterKey: Uint8Array,
  handle: string,
): string {
  return `${handle}:${b64urlEncode(aesEcbEncrypt(nodeKey, masterKey))}`
}

// ---------- file chunk layout / CTR decryption ----------

/** Mega chunk sizes: 128KiB..1MiB for the first 8 chunks, then 1MiB. */
export function megaChunkSize(index: number): number {
  const i = index + 1
  return i <= 8 ? i * 131072 : 1048576
}

export interface MegaChunkLayout {
  /** plaintext offset of every chunk */
  plainOffsets: number[]
  /** ciphertext offset of every chunk (plaintext + 8-byte MAC per chunk) */
  cipherOffsets: number[]
  sizes: number[]
}

/** Compute the chunk layout of a file of `size` bytes. */
export function megaChunkLayout(size: number): MegaChunkLayout {
  const plainOffsets: number[] = []
  const cipherOffsets: number[] = []
  const sizes: number[] = []
  let plain = 0
  let cipher = 0
  let index = 0
  do {
    const full = megaChunkSize(index)
    const chunk = size > 0 ? Math.min(full, size - plain) : full
    plainOffsets.push(plain)
    cipherOffsets.push(cipher)
    sizes.push(Math.max(chunk, 0))
    plain += chunk
    cipher += chunk + 8
    index++
  } while (size > 0 && plain < size)
  return { plainOffsets, cipherOffsets, sizes }
}

/** AES-CTR keystream XOR: nonce (8 bytes) || 64-bit big-endian block counter. */
export async function aesCtrDecrypt(
  data: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  blockIndex: number,
): Promise<Uint8Array> {
  const counter = new Uint8Array(16)
  counter.set(nonce.subarray(0, 8), 0)
  let v = BigInt(blockIndex)
  for (let i = 15; i >= 8; i--) {
    counter[i] = Number(v & 0xffn)
    v >>= 8n
  }
  const keyMat = await crypto.subtle.importKey(
    "raw",
    key as any,
    { name: "AES-CTR" },
    false,
    ["encrypt"],
  )
  const out = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: counter as any, length: 64 },
    keyMat,
    data as any,
  )
  return new Uint8Array(out)
}

// ---------- API client ----------

interface MegaLoginResponse {
  k?: string
  csid?: string
  privk?: string
  tsid?: string
  sid?: string
}

export interface MegaDownloadInfo {
  url: string
  size: number
  key: Uint8Array
}

export class MegaApiClient {
  private addition: MegaAddition
  private sid = ""
  // S-04 同类清单：会话序号初始值改用 CSPRNG（原 Math.random）。
  private seq = randomInt(0x10000000)
  private masterKey: Uint8Array | null = null
  private rsaKey: MegaRsaKey | null = null
  private nodes: Map<string, MegaNodeItem> = new Map()
  private rootId = ""
  private trashId = ""

  constructor(addition: MegaAddition) {
    this.addition = addition
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) % 0x10000000
    return this.seq
  }

  async request<T = any>(body: any[]): Promise<T> {
    const seq = this.nextSeq()
    let url = `https://g.api.mega.co.nz/cs?id=${seq}`
    if (this.sid) {
      url += `&sid=${this.sid}`
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      throw new Error(`Mega API HTTP error: ${res.status}`)
    }

    const json = (await res.json()) as any
    // Mega returns command-level errors as negative numbers inside the
    // response array (e.g. [-9] ENOENT, [-11]/[-16] permission errors). A
    // zero/number element means success for that command. Rejecting here
    // prevents write operations from reporting a silent success.
    if (Array.isArray(json)) {
      for (const item of json) {
        if (typeof item === "number" && item < 0) {
          throw new Error(`Mega API error code: ${item}`)
        }
      }
    } else if (typeof json === "number" && json < 0) {
      throw new Error(`Mega API error code: ${json}`)
    }
    return json as T
  }

  /**
   * Real Mega login:
   *  1. `us0` → account version (v1 = prepare_key, v2 = PBKDF2-SHA512);
   *  2. `uh` = derived password hash (base64url);
   *  3. `us` → {k, csid, privk}; master key = AES-ECB-dec(k, pw key),
   *     privk = AES-ECB-dec(privk, master key);
   *  4. sid = base64url(RSA-dec(csid, privk)[0:43]).
   */
  async init(): Promise<void> {
    if (!this.addition.email || !this.addition.password) {
      throw new Error("Mega email and password are required")
    }
    const email = this.addition.email.toLowerCase()
    const password = this.addition.password

    const versionResp = await this.request<any[]>([{ a: "us0", user: email }])
    const version = (versionResp[0] || {}) as { v?: number; s?: string }

    let aesKey: Uint8Array
    let userHash: string
    if (version.v === 2) {
      if (!version.s) throw new Error("Mega login: missing PBKDF2 salt")
      const salt = b64urlDecode(version.s)
      const bits = await derivePbkdf2(password, salt)
      aesKey = bits.subarray(0, 16)
      userHash = b64urlEncode(bits.subarray(16, 32))
    } else {
      const prepared = prepareKey(password)
      aesKey = prepared
      userHash = b64urlEncode(stringhash(email, prepared))
    }

    const loginRequest: Record<string, unknown> = {
      a: "us",
      user: email,
      uh: userHash,
    }
    // two_fa_code wins; otherwise derive the current TOTP from two_fa_secret
    // (matching OpenList's mega driver behaviour).
    let mfaCode = (this.addition.two_fa_code || "").trim()
    if (!mfaCode && this.addition.two_fa_secret) {
      try {
        mfaCode = generateTOTPToken(this.addition.two_fa_secret.trim())
      } catch {
        // invalid/absent secret: proceed without an MFA field
      }
    }
    if (mfaCode) {
      loginRequest.mfa = mfaCode
    }
    const res = await this.request<any[]>([loginRequest])
    const authResp = (res[0] || {}) as MegaLoginResponse
    if (!authResp.k) {
      throw new Error("Mega authentication failed: no master key returned")
    }

    this.masterKey = aesEcbDecrypt(
      b64urlDecode(stripHandle(authResp.k)),
      aesKey,
    )
    if (authResp.privk) {
      const privkPlain = aesEcbDecrypt(
        b64urlDecode(stripHandle(authResp.privk)),
        this.masterKey,
      )
      this.rsaKey = decodeRsaPrivateKey(privkPlain)
    }
    if (authResp.csid && this.rsaKey) {
      const sid = rsaDecrypt(b64urlDecode(stripHandle(authResp.csid)), this.rsaKey)
      this.sid = b64urlEncode(sid.subarray(0, 43))
    } else if (authResp.tsid) {
      this.sid = authResp.tsid
    }
    if (!this.sid) throw new Error("Mega authentication failed: no session id")

    await this.fetchNodes()
    this.applyConfiguredRoot()
  }

  /**
   * Honour `root_folder_id`: mount an existing folder handle instead of the
   * account root. The handle must reference a folder from the fetched tree.
   */
  private applyConfiguredRoot(): void {
    const configured = (this.addition.root_folder_id || "").trim()
    if (!configured || configured === "root") return
    const node = this.nodes.get(configured)
    if (!node) throw new Error(`Mega: root_folder_id ${configured} not found`)
    if (!node.is_dir) throw new Error(`Mega: root_folder_id ${configured} is not a folder`)
    this.rootId = configured
  }

  getMasterKey(): Uint8Array | null {
    return this.masterKey
  }

  async fetchNodes(): Promise<void> {
    if (!this.sid) return

    const res = await this.request<any[]>([{ a: "f", c: 1 }])
    const filesResp = res[0]
    if (filesResp?.f && Array.isArray(filesResp.f)) {
      this.nodes.clear()
      for (const node of filesResp.f) {
        // Node type: 0=file, 1=folder, 2=root, 3=inbox, 4=trash
        const isDir =
          node.t === 1 || node.t === 2 || node.t === 3 || node.t === 4
        if (node.t === 2) {
          this.rootId = node.h
        }
        if (node.t === 4) {
          this.trashId = node.h
        }

        const item: MegaNodeItem = {
          id: node.h,
          parent_id: node.p,
          name: "unnamed",
          size: node.s || 0,
          is_dir: isDir,
          modified: node.ts
            ? new Date(node.ts * 1000).toISOString()
            : new Date().toISOString(),
          type: node.t,
          key: node.k,
        }

        // Decrypt the node key first: attributes can only be read with it.
        try {
          const candidate = node.k ? pickNodeKey(node.k, node.h) : null
          if (candidate && this.masterKey) {
            const nodeKey = decryptNodeKey(
              b64urlDecode(candidate.key),
              this.masterKey,
              this.rsaKey,
              isDir,
            )
            item.key = b64urlEncode(nodeKey)
            const attrs = decryptAttributes(node.a, nodeKey)
            if (attrs?.n) item.name = attrs.n
            else item.name = node.h
          } else {
            item.name = node.h
          }
        } catch {
          item.name = node.h
        }

        this.nodes.set(node.h, item)
      }
    }
  }

  getChildren(parentId?: string): MegaNodeItem[] {
    const targetParent = parentId || this.rootId
    const result: MegaNodeItem[] = []
    for (const node of this.nodes.values()) {
      if (node.parent_id === targetParent) {
        result.push(node)
      }
    }
    return result
  }

  getNode(handle: string): MegaNodeItem | undefined {
    return this.nodes.get(handle)
  }

  getRootId(): string {
    return this.rootId
  }

  /** Raw (still encrypted) download URL + the decrypted file key. */
  async getDownloadInfo(handle: string): Promise<MegaDownloadInfo> {
    const node = this.nodes.get(handle)
    if (!node) throw new Error(`Mega node not found: ${handle}`)
    if (node.is_dir) throw new Error("Mega: cannot download a folder")
    const res = await this.request<any[]>([{ a: "g", g: 1, n: handle }])
    const data = res[0]
    if (!data || typeof data.g !== "string") {
      throw new Error(`Failed to get download URL for node ${handle}`)
    }
    const key = node.key ? b64urlDecode(node.key) : new Uint8Array(0)
    if (key.length !== 32) {
      throw new Error(`Mega: node ${handle} has no usable file key`)
    }
    return { url: data.g, size: Number(data.s ?? node.size) || node.size, key }
  }

  /**
   * Stream a file with client-side decryption (AES-CTR + chunk MACs).
   * The returned link is Mega ciphertext, so the driver never exposes it.
   */
  async createReadStream(
    handle: string,
    options?: { start?: number; end?: number },
  ): Promise<ReadableStream<Uint8Array>> {
    const info = await this.getDownloadInfo(handle)
    const aesKey = nodeAesKey(info.key)
    const nonce = info.key.subarray(16, 32)
    const expectedMac = info.key.subarray(24, 32)
    const size = info.size
    const layout = megaChunkLayout(size)

    const start = Math.max(0, options?.start ?? 0)
    const end =
      options?.end ?? (size > 0 ? size - 1 : Number.MAX_SAFE_INTEGER)

    // Locate the chunk that contains `start`.
    let firstChunk = 0
    if (start > 0) {
      while (
        firstChunk < layout.sizes.length - 1 &&
        layout.plainOffsets[firstChunk] + layout.sizes[firstChunk] <= start
      ) {
        firstChunk++
      }
    }

    let url = info.url
    if (firstChunk > 0) {
      const sep = url.includes("?") ? "&" : "?"
      url = `${url}${sep}start=${layout.cipherOffsets[firstChunk]}`
    }

    // MAC verification requires the whole stream starting at chunk 0.
    const verifyMac = firstChunk === 0
    const aes = new MegaAes(aesKey)
    const chunkMacs: Uint8Array[] = []
    let macState: Uint8Array = concatBytes(nonce.subarray(0, 8), nonce.subarray(0, 8))

    const res = await fetch(url)
    if (!res.ok || !res.body) {
      throw new Error(`Mega download failed: ${res.status}`)
    }
    const reader = res.body.getReader()

    let pending: Uint8Array = new Uint8Array(0)
    let chunkIndex = firstChunk
    let plainPos = layout.plainOffsets[firstChunk] || 0
    let position = start
    let eof = false
    let done = false

    const pullOne = async (): Promise<Uint8Array | null> => {
      for (;;) {
        if (done) return null
        const expectedPlain = layout.sizes[chunkIndex] ?? 0
        const need =
          chunkIndex === layout.sizes.length - 1 ? 8 + expectedPlain : 8 + expectedPlain
        if (pending.length < need) {
          const { done: streamDone, value } = await reader.read()
          if (value && value.length) {
            pending = concatBytes(pending, value)
          }
          if (streamDone) eof = true
          if (!eof) continue
          // Last chunk may be shorter than the layout predicted (size unknown).
          if (pending.length === 0) {
            done = true
            return null
          }
        }

        const available = pending.length
        let ctLen: number
        if (eof && available < need) {
          if (available <= 8) {
            throw new Error("Mega download: truncated trailing chunk")
          }
          ctLen = available
        } else {
          ctLen = need
        }

        const chunk = pending.subarray(0, ctLen)
        pending = pending.subarray(ctLen)
        const ciphertext = chunk.subarray(0, ctLen - 8)
        const mac = chunk.subarray(ctLen - 8)

        const plain = await aesCtrDecrypt(
          ciphertext,
          aesKey,
          nonce,
          plainPos / 16,
        )

        // Per-chunk MAC over the plaintext (final partial block zero padded).
        macState = cbcMac(plain, aes, macState)
        if (!bytesEqual(macState.subarray(0, 8), mac)) {
          if (verifyMac) throw new Error("Mega download: MAC verification failed")
        }
        chunkMacs.push(macState)
        macState = concatBytes(nonce.subarray(0, 8), nonce.subarray(0, 8))

        chunkIndex++
        const chunkStart = plainPos
        plainPos += plain.length
        if (chunkIndex >= layout.sizes.length) done = true

        const from = Math.max(position, chunkStart)
        const to = Math.min(end, chunkStart + plain.length - 1)
        if (from <= to) {
          position = to + 1
          return plain.slice(from - chunkStart, to - chunkStart + 1)
        }
        if (position > end) {
          done = true
          return null
        }
      }
    }

    const finalize = () => {
      if (verifyMac && chunkMacs.length && size > 0) {
        const mac = condenseMac(chunkMacs, aes)
        if (!bytesEqual(mac, expectedMac)) {
          throw new Error("Mega download: file MAC verification failed")
        }
      }
    }

    const self = this
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const out = await pullOne()
          if (out === null) {
            finalize()
            try {
              await reader.cancel()
            } catch {
              // ignore
            }
            controller.close()
            return
          }
          controller.enqueue(out)
        } catch (e: any) {
          controller.error(e)
        }
      },
      async cancel() {
        try {
          await reader.cancel()
        } catch {
          // ignore
        }
      },
    })
  }

  /**
   * @deprecated Mega download URLs only serve AES ciphertext. Returning one as
   * a user-facing link is exactly the F-377 defect; downloads must go through
   * `createReadStream`, which decrypts and verifies the file.
   */
  async getDownloadLink(_handle: string): Promise<string> {
    throw new Error(
      "Mega download URLs are ciphertext; use createReadStream for decrypted data",
    )
  }

  async createFolder(name: string, parentId?: string): Promise<string> {
    const pid = parentId || this.rootId
    if (!this.masterKey) throw new Error("Mega client is not logged in")

    // Fresh random 16-byte folder key, attribute blob encrypted with it and
    // the key itself encrypted with the master key.
    const folderKey = crypto.getRandomValues(new Uint8Array(16))
    const attrB64 = encryptAttributes({ n: name }, folderKey)
    const handle = b64urlEncode(crypto.getRandomValues(new Uint8Array(6)))

    const res = await this.request<any[]>([
      {
        a: "p",
        t: pid,
        n: [
          {
            h: handle,
            t: 1,
            a: attrB64,
            k: encryptNodeKey(folderKey, this.masterKey, handle),
          },
        ],
      },
    ])
    const createdHandle = res[0]?.f?.[0]?.h
    if (!createdHandle) {
      throw new Error("Mega: createFolder did not return a node handle")
    }
    await this.fetchNodes()
    return createdHandle
  }

  /**
   * Delete a node. With `moveToTrash` the node is moved into the rubbish bin
   * (`a:"m"` to the trash handle); otherwise it is permanently removed with
   * `a:"d"`. Local caches are only touched after the API accepted the command.
   */
  async deleteNode(handle: string, moveToTrash = true): Promise<void> {
    if (moveToTrash && this.trashId && handle !== this.trashId) {
      await this.request<any[]>([{ a: "m", n: handle, t: this.trashId }])
      const node = this.nodes.get(handle)
      if (node) node.parent_id = this.trashId
      return
    }
    await this.request<any[]>([{ a: "d", n: handle }])
    const removeLocal = (id: string) => {
      this.nodes.delete(id)
      for (const child of [...this.nodes.values()]) {
        if (child.parent_id === id) removeLocal(child.id)
      }
    }
    removeLocal(handle)
  }

  async moveNode(handle: string, targetParentId: string): Promise<void> {
    await this.request<any[]>([{ a: "m", n: handle, t: targetParentId }])
    const node = this.nodes.get(handle)
    if (node) {
      node.parent_id = targetParentId
    }
  }

  async getQuota(): Promise<{ total: number; used: number }> {
    const res = await this.request<any[]>([{ a: "uq", strg: 1 }])
    const data = res[0]
    return {
      total: data?.mstrg || 0,
      used: data?.cstrg || 0,
    }
  }
}

/** Strip a `handle:` prefix (base64url never contains ':'). */
function stripHandle(value: string): string {
  const idx = value.indexOf(":")
  return idx < 0 ? value : value.slice(idx + 1)
}

/** PBKDF2-SHA512 (100000 rounds) for Mega account version 2. */
async function derivePbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(password) as any,
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as any,
      iterations: 100000,
      hash: "SHA-512",
    },
    baseKey,
    256,
  )
  return new Uint8Array(bits)
}
