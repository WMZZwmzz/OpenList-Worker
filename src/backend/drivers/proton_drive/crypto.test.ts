import test from "node:test"
import assert from "node:assert/strict"
import * as openpgp from "openpgp"
import {
  encryptText,
  encryptBinary,
  decryptArmoredText,
  decryptArmoredBinary,
  decryptNodeHashKey,
  unlockPrivateKey,
  decryptSessionKeyPacket,
  decryptXAttr,
  parseLegacyXAttr,
  decryptBinaryWithSessionKey,
  getNameHash,
  toBase64,
} from "./crypto"

test("filename encrypt/decrypt roundtrip (unicode)", async () => {
  const { privateKey: armoredPriv, publicKey: armoredPub } =
    await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "t", email: "t@example.com" }],
      passphrase: "pass",
    })
  const priv = await openpgp.readPrivateKey({ armoredKey: armoredPriv })
  const unlocked = await openpgp.decryptKey({ privateKey: priv, passphrase: "pass" })
  const pub = await openpgp.readKey({ armoredKey: armoredPub })

  const name = "我的文件 (副本).txt"
  const encrypted = await encryptText(name, [pub])
  const decrypted = await decryptArmoredText(encrypted, [unlocked])
  assert.equal(decrypted, name)
})

test("binary encrypt/decrypt roundtrip", async () => {
  const { privateKey: armoredPriv, publicKey: armoredPub } =
    await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "t", email: "t@example.com" }],
    })
  const priv = await openpgp.readPrivateKey({ armoredKey: armoredPriv })
  const pub = await openpgp.readKey({ armoredKey: armoredPub })

  const data = new Uint8Array([0, 1, 2, 3, 255, 254, 128])
  const msg = await openpgp.createMessage({ binary: data })
  const armored = await openpgp.encrypt({
    message: msg,
    encryptionKeys: pub,
    format: "armored",
  })
  const decrypted = await decryptArmoredBinary(armored, [priv])
  assert.deepEqual(decrypted, data)
})

test("session key decrypt + binary decrypt chain", async () => {
  const { privateKey: armoredPriv, publicKey: armoredPub } =
    await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "t", email: "t@example.com" }],
    })
  const priv = await openpgp.readPrivateKey({ armoredKey: armoredPriv })
  const pub = await openpgp.readKey({ armoredKey: armoredPub })

  const data = new Uint8Array([10, 20, 30, 40, 50])
  const msg = await openpgp.createMessage({ binary: data })
  const encrypted = await openpgp.encrypt({
    message: msg,
    encryptionKeys: pub,
    format: "binary",
  })
  const encMsg = await openpgp.readMessage({ binaryMessage: encrypted })
  const sessionKeys = await openpgp.decryptSessionKeys({
    message: encMsg,
    decryptionKeys: [priv],
  })
  assert.equal(sessionKeys.length, 1)
  const plain = await decryptBinaryWithSessionKey(
    encrypted,
    sessionKeys as unknown as openpgp.SessionKey[],
  )
  assert.deepEqual(plain, data)
})

test("unlockPrivateKey with wrong passphrase throws", async () => {
  const { privateKey: armoredPriv } = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: "t", email: "t@example.com" }],
    passphrase: "correct",
  })
  await assert.rejects(() => unlockPrivateKey(armoredPriv, "wrong"))
})

test("toBase64 matches btoa", () => {
  assert.equal(toBase64(new Uint8Array([0x48, 0x69])), btoa("Hi"))
})

test("decryptSessionKeyPacket accepts base64 binary ContentKeyPacket", async () => {
  const { privateKey: armoredPriv, publicKey: armoredPub } =
    await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "t", email: "t@example.com" }],
    })
  const priv = await openpgp.readPrivateKey({ armoredKey: armoredPriv })
  const pub = await openpgp.readKey({ armoredKey: armoredPub })

  // Proton's ContentKeyPacket is base64 of a *binary* PKESK packet, never armor.
  const armoredPacket = await openpgp.encryptSessionKey({
    data: new Uint8Array(32).fill(7),
    algorithm: "aes256",
    encryptionKeys: [pub],
    format: "armored",
  })
  const binaryPacket = await openpgp.encryptSessionKey({
    data: new Uint8Array(32).fill(7),
    algorithm: "aes256",
    encryptionKeys: [pub],
    format: "binary",
  })
  const base64Packet = toBase64(binaryPacket)
  assert.ok(!base64Packet.includes("-----BEGIN"))

  const fromBinary = await decryptSessionKeyPacket(base64Packet, [priv])
  assert.deepEqual(fromBinary.data, new Uint8Array(32).fill(7))
  // armored input is still tolerated (defensive compatibility)
  const fromArmored = await decryptSessionKeyPacket(armoredPacket as string, [priv])
  assert.deepEqual(fromArmored.data, new Uint8Array(32).fill(7))

  await assert.rejects(() => decryptSessionKeyPacket("", [priv]))
  await assert.rejects(() => decryptSessionKeyPacket(base64Packet, []))
})

test("decryptBinaryWithSessionKey decrypts Proton-style binary blocks", async () => {
  const { privateKey: armoredPriv, publicKey: armoredPub } =
    await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "t", email: "t@example.com" }],
    })
  const priv = await openpgp.readPrivateKey({ armoredKey: armoredPriv })
  const pub = await openpgp.readKey({ armoredKey: armoredPub })
  const sessionKey = await openpgp.generateSessionKey({ encryptionKeys: [pub] })

  // one "block": binary SEIPD message encrypted with the shared session key
  const plaintext = new TextEncoder().encode("block-bytes-0123456789")
  const msg = await openpgp.createMessage({ binary: plaintext })
  const ciphertext = (await openpgp.encrypt({
    message: msg,
    sessionKey,
    format: "binary",
  })) as Uint8Array

  const packet = await openpgp.encryptSessionKey({
    data: sessionKey.data,
    algorithm: sessionKey.algorithm,
    encryptionKeys: [pub],
    format: "binary",
  })
  const decryptedKey = await decryptSessionKeyPacket(toBase64(packet), [priv])
  const plain = await decryptBinaryWithSessionKey(ciphertext, [decryptedKey])
  assert.deepEqual(plain, plaintext)
})

test("parseLegacyXAttr reads Size (field 1) and BlockSizes (field 2)", () => {
  const varint = (v: number): number[] => {
    const out: number[] = []
    let n = v
    while (n >= 0x80) {
      out.push((n & 0x7f) | 0x80)
      n >>>= 7
    }
    out.push(n)
    return out
  }
  // field 1 varint = 9000, field 2 repeated (unpacked) [4000, 5000]
  const bytes = new Uint8Array([
    0x08, ...varint(9000),
    0x10, ...varint(4000),
    0x10, ...varint(5000),
  ])
  const parsed = parseLegacyXAttr(bytes)
  assert.equal(parsed.size, 9000)
  assert.deepEqual(parsed.blockSizes, [4000, 5000])

  // field 2 packed
  const packed = new Uint8Array([
    0x08, ...varint(300),
    0x12, 3, ...varint(100), ...varint(200),
  ])
  const parsedPacked = parseLegacyXAttr(packed)
  assert.equal(parsedPacked.size, 300)
  assert.deepEqual(parsedPacked.blockSizes, [100, 200])
  // truncated input must not throw
  assert.deepEqual(parseLegacyXAttr(new Uint8Array([0x08, 0x80])), {
    size: 0,
    blockSizes: [],
  })
})

test("decryptXAttr parses armored JSON XAttr (size + blockSizes in order)", async () => {
  const { privateKey: armoredPriv, publicKey: armoredPub } =
    await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "t", email: "t@example.com" }],
    })
  const priv = await openpgp.readPrivateKey({ armoredKey: armoredPriv })
  const pub = await openpgp.readKey({ armoredKey: armoredPub })

  const xattrJson = JSON.stringify({
    Common: {
      ModificationTime: "2024-01-01T00:00:00.000Z",
      Size: 9000000,
      BlockSizes: [4000000, 4000000, 1000000],
    },
  })
  // Proton stores XAttr as an *armored* PGP message (go-proton-api
  // NewPGPMessageFromArmored / WebClients armoredMessage).
  const armored = await encryptText(xattrJson, [pub])
  assert.ok(armored.startsWith("-----BEGIN PGP MESSAGE-----"))

  const info = await decryptXAttr(armored, [priv])
  assert.equal(info.size, 9000000)
  assert.deepEqual(info.blockSizes, [4000000, 4000000, 1000000])

  // Legacy base64-of-binary XAttr is still accepted.
  const binaryMsg = await openpgp.createMessage({
    binary: new TextEncoder().encode(xattrJson),
  })
  const binary = (await openpgp.encrypt({
    message: binaryMsg,
    encryptionKeys: [pub],
    format: "binary",
  })) as Uint8Array
  assert.equal((await decryptXAttr(toBase64(binary), [priv])).size, 9000000)

  // garbage / wrong key must degrade to zero instead of throwing
  assert.deepEqual(await decryptXAttr("", [priv]), { size: 0, blockSizes: [] })
  assert.deepEqual(await decryptXAttr(armored, []), {
    size: 0,
    blockSizes: [],
  })
})

test("decryptNodeHashKey unlocks an armored 32-byte hash key", async () => {
  const { privateKey: armoredPriv, publicKey: armoredPub } =
    await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "t", email: "t@example.com" }],
    })
  const priv = await openpgp.readPrivateKey({ armoredKey: armoredPriv })
  const pub = await openpgp.readKey({ armoredKey: armoredPub })

  const hashKey = new Uint8Array(32)
  for (let i = 0; i < 32; i++) hashKey[i] = i * 3
  const armored = await encryptBinary(hashKey, [pub])
  assert.deepEqual(await decryptNodeHashKey(armored, [priv]), hashKey)

  // 64-char hex payloads (older clients) are decoded as bytes.
  const hexKey = Array.from(hashKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  const hexArmored = await encryptBinary(new TextEncoder().encode(hexKey), [pub])
  assert.deepEqual(await decryptNodeHashKey(hexArmored, [priv]), hashKey)

  // Name hash uses that key and emits lowercase hex HMAC.
  assert.equal(
    await getNameHash("hello", new TextEncoder().encode("key")),
    "9307b3b915efb5171ff14d8cb55fbcc798c6c0ef1456d66ded1a6aa723a58b7b",
  )
})
