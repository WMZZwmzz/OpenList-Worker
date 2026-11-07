// ProtonDrive cryptography helpers built on top of openpgp (v6).
//
// Proton's trust chain:
//   user private key  (unlocked with saltedKeyPass)
//     └─ address private keys (unlocked with token decrypted by user key,
//                              or directly by saltedKeyPass for legacy keys)
//           └─ share private key (unlocked with passphrase decrypted by addr key)
//                 └─ root node key  (unlocked with NodePassphrase decrypted by share key)
//                       └─ child node keys (unlocked with NodePassphrase decrypted by parent key)
//                             └─ file name / content session key
//
// NOTE: saltedKeyPass is the bcrypt(password, keySalt) digest (printable ASCII),
// so it can be safely passed to openpgp as a string passphrase.

import * as openpgp from "openpgp"
import bcrypt from "bcryptjs"

export type KeyRing = openpgp.PrivateKey[]

// bcrypt uses its own base64 alphabet.
const BCRYPT_CHARS =
  "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

function bytesToBcryptBase64(bytes: Uint8Array): string {
  let out = ""
  let bits = 0
  let acc = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += BCRYPT_CHARS[(acc >> bits) & 0x3f]
    }
  }
  if (bits > 0) out += BCRYPT_CHARS[(acc << (6 - bits)) & 0x3f]
  return out
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function toBase64(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * Derive the salted key passphrase used to unlock Proton private keys.
 * This is bcrypt(password, keySalt, cost=10); the raw 31-char bcrypt digest
 * (printable ASCII) is used as the OpenPGP passphrase string.
 */
export function deriveSaltedKeyPass(password: string, keySaltBase64: string): string {
  const saltBytes = fromBase64(keySaltBase64)
  const saltChars = bytesToBcryptBase64(saltBytes).padEnd(22, ".")
  const fullSalt = `$2a$10$${saltChars}`
  const fullHash = bcrypt.hashSync(password, fullSalt)
  // fullHash = $2a$10$<22 salt><31 digest>
  return fullHash.slice(fullSalt.length)
}

/** Unlock a single armored private key with a passphrase. */
export async function unlockPrivateKey(
  armoredKey: string,
  passphrase: string,
): Promise<openpgp.PrivateKey> {
  const key = await openpgp.readPrivateKey({ armoredKey })
  return openpgp.decryptKey({ privateKey: key, passphrase })
}

/** Read an armored public key. */
export async function readPublicKey(armoredKey: string): Promise<openpgp.PublicKey> {
  return openpgp.readKey({ armoredKey })
}

/** Decrypt an armored OpenPGP message into UTF-8 text using a keyring. */
export async function decryptArmoredText(
  armored: string,
  keyRing: KeyRing,
): Promise<string> {
  const message = await openpgp.readMessage({ armoredMessage: armored })
  const { data } = await openpgp.decrypt({
    message,
    decryptionKeys: keyRing,
    format: "utf8",
  })
  return data as string
}

/** Decrypt an armored OpenPGP message into bytes using a keyring. */
export async function decryptArmoredBinary(
  armored: string,
  keyRing: KeyRing,
): Promise<Uint8Array> {
  const message = await openpgp.readMessage({ armoredMessage: armored })
  const { data } = await openpgp.decrypt({
    message,
    decryptionKeys: keyRing,
    format: "binary",
  })
  return data as Uint8Array
}

/** Encrypt UTF-8 text into an armored OpenPGP message for the given keys. */
export async function encryptText(
  text: string,
  encryptionKeys: openpgp.Key[],
  signingKey?: openpgp.PrivateKey,
): Promise<string> {
  const message = await openpgp.createMessage({ text })
  return openpgp.encrypt({
    message,
    encryptionKeys,
    signingKeys: signingKey ? [signingKey] : undefined,
    format: "armored",
  }) as unknown as string
}

/** Encrypt raw bytes into an armored OpenPGP message for the given keys. */
export async function encryptBinary(
  bytes: Uint8Array,
  encryptionKeys: openpgp.Key[],
  signingKey?: openpgp.PrivateKey,
): Promise<string> {
  const message = await openpgp.createMessage({ binary: bytes })
  return openpgp.encrypt({
    message,
    encryptionKeys,
    signingKeys: signingKey ? [signingKey] : undefined,
    format: "armored",
  }) as unknown as string
}

/** Create an armored detached signature over UTF-8 text. */
export async function signDetachedText(
  text: string,
  signingKey: openpgp.PrivateKey,
): Promise<string> {
  const message = await openpgp.createMessage({ text })
  return openpgp.sign({
    message,
    signingKeys: [signingKey],
    detached: true,
    format: "armored",
  }) as unknown as string
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Proton name hash: hex(HMAC-SHA256(name, parentFolderHashKey)).
 *
 * The key is the parent folder's `FolderProperties.NodeHashKey` decrypted with
 * the parent node keyring (see go-proton-api Link.GetHashKey). The unkeyed
 * base64(SHA-256(name)) digest used previously is not a valid Proton hash.
 */
export async function getNameHash(
  name: string,
  hashKey: Uint8Array,
): Promise<string> {
  if (!hashKey || hashKey.length === 0) {
    throw new Error("Proton name hash requires the parent folder hash key")
  }
  const key = await crypto.subtle.importKey(
    "raw",
    hashKey as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(name),
  )
  return bytesToHex(new Uint8Array(mac))
}

/**
 * Decrypt a folder's `FolderProperties.NodeHashKey`.
 *
 * The API returns an armored OpenPGP message whose plaintext is the 32-byte
 * HMAC key. Some clients historically stored the token as a hex string, so a
 * 64-character hex payload is decoded as bytes defensively.
 */
export async function decryptNodeHashKey(
  armoredHashKey: string,
  keyRing: KeyRing,
): Promise<Uint8Array> {
  const plain = await decryptArmoredBinary(armoredHashKey, keyRing)
  const text = new TextDecoder().decode(plain).trim()
  if (/^[0-9a-fA-F]{64}$/.test(text)) return hexToBytes(text)
  return plain
}

/**
 * Decrypt a detached session key packet with a keyring.
 *
 * The API returns `FileProperties.ContentKeyPacket` as **base64 of a binary
 * OpenPGP message** (a PKESK packet), not as an armored message — go-proton-api
 * does `base64.StdEncoding.DecodeString` before decrypting. Armored input is
 * still accepted for defensive compatibility with hand-built packets.
 */
export async function decryptSessionKeyPacket(
  contentKeyPacketBase64: string,
  keyRing: KeyRing,
): Promise<openpgp.SessionKey> {
  if (!contentKeyPacketBase64) {
    throw new Error("empty content key packet")
  }
  const message = contentKeyPacketBase64.trimStart().startsWith("-----BEGIN")
    ? await openpgp.readMessage({ armoredMessage: contentKeyPacketBase64 })
    : await openpgp.readMessage({ binaryMessage: fromBase64(contentKeyPacketBase64) })
  const sessionKeys = await openpgp.decryptSessionKeys({
    message,
    decryptionKeys: keyRing,
  })
  if (!sessionKeys.length) {
    throw new Error("failed to decrypt session key")
  }
  return sessionKeys[0] as unknown as openpgp.SessionKey
}

/** Decrypt a binary OpenPGP message using an already-decrypted session key. */
export async function decryptBinaryWithSessionKey(
  binaryMessage: Uint8Array,
  sessionKeys: openpgp.SessionKey[],
): Promise<Uint8Array> {
  const message = await openpgp.readMessage({ binaryMessage })
  const { data } = await openpgp.decrypt({
    message,
    sessionKeys,
    format: "binary",
  })
  return data as Uint8Array
}

/** Generate a fresh random OpenPGP key pair (used for new node/content keys). */
export async function generateKeyPair(
  userIds: { name: string; email: string }[],
): Promise<{ privateKey: string; publicKey: string }> {
  return openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: userIds,
  })
}

/**
 * Decrypted extended attributes (XAttr).
 * `blockSizes` is the plaintext size of every encrypted block, in block order.
 */
export interface ProtonXAttr {
  size: number
  blockSizes: number[]
}

/**
 * Decrypt a link's XAttr and extract the plaintext file size and the per-block
 * plaintext sizes.
 *
 * Modern API responses carry an **armored** OpenPGP message (go-proton-api
 * `NewPGPMessageFromArmored`, WebClients `armoredMessage`); older/hand-built
 * fixtures may use base64 of a binary message. The decrypted payload is JSON
 * (`{"Common":{"Size":..,"BlockSizes":[..]}}`), in ascending block order; a
 * legacy protobuf FileSystemAttr is still accepted as a fallback. Any failure
 * degrades to `{size: 0, blockSizes: []}` so listing still works.
 */
export async function decryptXAttr(
  xattrBase64: string,
  keyRing: KeyRing,
): Promise<ProtonXAttr> {
  const empty: ProtonXAttr = { size: 0, blockSizes: [] }
  if (!xattrBase64) return empty
  let plain: Uint8Array
  try {
    const message = xattrBase64.trimStart().startsWith("-----BEGIN")
      ? await openpgp.readMessage({ armoredMessage: xattrBase64 })
      : await openpgp.readMessage({
          binaryMessage: fromBase64(xattrBase64),
        })
    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: keyRing,
      format: "binary",
    })
    plain = data as Uint8Array
  } catch {
    return empty
  }

  // Modern format: the decrypted payload is JSON.
  const text = new TextDecoder().decode(plain).replace(/\u0000+$/g, "").trim()
  if (text.startsWith("{")) {
    try {
      const json = JSON.parse(text) as {
        Common?: { Size?: number; BlockSizes?: number[] }
      }
      const size =
        typeof json.Common?.Size === "number" ? json.Common.Size : 0
      const raw = json.Common?.BlockSizes
      // BlockSizes are stored in ascending block order (index 1..n); the
      // official bridge accumulates them as-is when mapping offsets.
      const blockSizes =
        Array.isArray(raw) && raw.every((n) => typeof n === "number")
          ? [...raw]
          : []
      return { size, blockSizes }
    } catch {
      // fall through to the protobuf parser
    }
  }

  return parseLegacyXAttr(plain)
}

/** Backwards-compatible helper: only the decrypted size. */
export async function decryptXAttrSize(
  xattrBase64: string,
  keyRing: KeyRing,
): Promise<number> {
  return (await decryptXAttr(xattrBase64, keyRing)).size
}

/**
 * Minimal protobuf walker for the legacy FileSystemAttr message:
 *   field 1 (varint)              = Size
 *   field 2 (varint | packed)     = BlockSizes
 */
export function parseLegacyXAttr(bytes: Uint8Array): ProtonXAttr {
  const out: ProtonXAttr = { size: 0, blockSizes: [] }
  let i = 0

  const readVarint = (): bigint | null => {
    let value = 0n
    let shift = 0n
    while (i < bytes.length) {
      const b = bytes[i++]
      value |= BigInt(b & 0x7f) << shift
      if ((b & 0x80) === 0) return value
      shift += 7n
      if (shift > 63n) return null
    }
    return null
  }

  while (i < bytes.length) {
    const tagStart = i
    const tag = readVarint()
    if (tag === null || tag > 0xffffffffn) break
    const fieldNum = Number(tag >> 3n)
    const wireType = Number(tag & 0x07n)
    if (wireType === 0) {
      const value = readVarint()
      if (value === null) break
      if (fieldNum === 1) {
        if (out.size === 0) out.size = Number(value)
      } else if (fieldNum === 2) {
        out.blockSizes.push(Number(value))
      }
    } else if (wireType === 2) {
      const len = readVarint()
      if (len === null) break
      const end = i + Number(len)
      if (end > bytes.length) break
      if (fieldNum === 2) {
        // packed repeated int64
        while (i < end) {
          const v = readVarint()
          if (v === null) break
          out.blockSizes.push(Number(v))
        }
      }
      i = end
    } else if (wireType === 1) {
      i += 8
    } else if (wireType === 5) {
      i += 4
    } else {
      break
    }
    if (i <= tagStart) break
  }
  return out
}
