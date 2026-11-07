import test from "node:test"
import assert from "node:assert/strict"
import * as openpgp from "openpgp"
import {
  ProtonDriveDriver,
  computeBlockOffsets,
  normalizeProtonDriveAddition,
} from "./driver"
import {
  toBase64,
  decryptArmoredText,
  decryptNodeHashKey,
  getNameHash,
} from "./crypto"
import { ProtonDriveClient } from "./util"

const MB = 1024 * 1024

function newDriver(): ProtonDriveDriver {
  const driver = new ProtonDriveDriver({
    email: "user@example.com",
    password: "secret",
  })
  ;(driver as any).mainShare = {
    ShareID: "share1",
    VolumeID: "vol1",
    RootLinkID: "root",
    Type: 1,
  }
  return driver
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
    }
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

test("computeBlockOffsets treats Block.Index as 1-based", () => {
  const first = computeBlockOffsets(
    [{ Index: 1 }, { Index: 2 }, { Index: 3 }],
    [],
    4 * MB,
  )
  // The first block always starts at offset 0 (the old code used Index*size).
  assert.deepEqual(first.offsets, [0, 4 * MB, 8 * MB])
  assert.equal(first.totalSize, 12 * MB)

  const withSizes = computeBlockOffsets(
    [{ Index: 3 }, { Index: 1 }, { Index: 2 }],
    [4 * MB, 4 * MB, 1 * MB],
    4 * MB,
  )
  assert.deepEqual(
    withSizes.blocks.map((b) => b.Index),
    [1, 2, 3],
  )
  assert.deepEqual(withSizes.offsets, [0, 4 * MB, 8 * MB])
  assert.equal(withSizes.totalSize, 9 * MB)
})

test("getRevisionBlocks paginates the revision detail endpoint", async () => {
  const driver = newDriver()
  const calls: { path: string; params?: any }[] = []
  const pageOne = Array.from({ length: 50 }, (_, i) => ({
    Index: i + 1,
    BareURL: `https://storage/block/${i + 1}`,
    Token: `token-${i + 1}`,
  }))
  const pageTwo = [
    { Index: 51, BareURL: "https://storage/block/51", Token: "token-51" },
    { Index: 52, BareURL: "https://storage/block/52", Token: "token-52" },
  ]
  ;(driver as any).client = {
    requestAPI: async (path: string, options: any = {}) => {
      calls.push({ path, params: options.params })
      if (path.endsWith("/revisions")) {
        // The list endpoint only returns revision *metadata* (no Blocks).
        return { Code: 1000, Revisions: [{ ID: "rev-1", State: 1, Size: 999 }] }
      }
      if (path.endsWith("/revisions/rev-1")) {
        return {
          Code: 1000,
          Revision: {
            ID: "rev-1",
            Blocks: options.params?.FromBlockIndex === "1" ? pageOne : pageTwo,
          },
        }
      }
      throw new Error(`unexpected path ${path}`)
    },
  }

  const blocks = await (driver as any).getRevisionBlocks("link-1")
  assert.equal(blocks.length, 52)
  assert.equal(blocks[0].Index, 1)
  assert.equal(blocks[51].Index, 52)
  assert.equal(calls.length, 3)
  assert.ok(calls[1].path.endsWith("/links/link-1/revisions/rev-1"))
  assert.equal(calls[1].params.FromBlockIndex, "1")
  assert.equal(calls[2].params.FromBlockIndex, "51")
  assert.ok(calls[2].params.PageSize)
})

test("downloadBlock authenticates with pm-storage-token", async () => {
  const driver = newDriver()
  const seen: any[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: any, init: any) => {
    seen.push(init)
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
  }) as typeof fetch
  try {
    const bytes = await (driver as any).downloadBlock(
      "https://storage.example/block/1",
      "storage-token",
    )
    assert.deepEqual(bytes, new Uint8Array([1, 2, 3]))
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers["pm-storage-token"], "storage-token")
  assert.equal(seen[0].headers.Authorization, undefined)
})

test("createReadStream decrypts blocks with 1-based offsets and ranges", async () => {  const { privateKey: armoredPriv, publicKey: armoredPub } =
    await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "t", email: "t@example.com" }],
    })
  const priv = await openpgp.readPrivateKey({ armoredKey: armoredPriv })
  const pub = await openpgp.readKey({ armoredKey: armoredPub })
  const sessionKey = await openpgp.generateSessionKey({ encryptionKeys: [pub] })

  // 3 blocks: 10 + 10 + 4 plaintext bytes
  const fileBytes = Uint8Array.from({ length: 24 }, (_, i) => i)
  const plainBlocks = [fileBytes.slice(0, 10), fileBytes.slice(10, 20), fileBytes.slice(20, 24)]
  const encryptedBlocks: Uint8Array[] = []
  for (const plain of plainBlocks) {
    const msg = await openpgp.createMessage({ binary: plain })
    encryptedBlocks.push(
      (await openpgp.encrypt({
        message: msg,
        sessionKey,
        format: "binary",
      })) as Uint8Array,
    )
  }
  const keyPacket = await openpgp.encryptSessionKey({
    data: sessionKey.data,
    algorithm: sessionKey.algorithm,
    encryptionKeys: [pub],
    format: "binary",
  })
  const contentKeyPacket = toBase64(keyPacket)

  const xattrJson = JSON.stringify({
    Common: { Size: 24, BlockSizes: [10, 10, 4] },
  })
  const xattrMsg = await openpgp.createMessage({
    binary: new TextEncoder().encode(xattrJson),
  })
  const xattr = toBase64(
    (await openpgp.encrypt({
      message: xattrMsg,
      encryptionKeys: [pub],
      format: "binary",
    })) as Uint8Array,
  )

  const driver = newDriver()
  ;(driver as any).resolveId = async () => "link-1"
  ;(driver as any).fetchLink = async () => ({
    LinkID: "link-1",
    Type: 1,
    XAttr: xattr,
    FileProperties: { ContentKeyPacket: contentKeyPacket },
  })
  ;(driver as any).getLinkKR = async () => [priv]
  ;(driver as any).client = {
    requestAPI: async (path: string) => {
      if (path.endsWith("/revisions")) {
        return { Code: 1000, Revisions: [{ ID: "rev-1", State: 1 }] }
      }
      return {
        Code: 1000,
        Revision: {
          ID: "rev-1",
          Blocks: encryptedBlocks.map((_, i) => ({
            Index: i + 1,
            BareURL: `https://storage/block/${i + 1}`,
            Token: `t${i + 1}`,
          })),
        },
      }
    },
  }
  const downloaded: string[] = []
  ;(driver as any).downloadBlock = async (url: string) => {
    downloaded.push(url)
    return encryptedBlocks[Number(url.split("/").pop()) - 1]
  }

  // Full download
  const full = await collect(await driver.createReadStream("/file.bin"))
  assert.deepEqual(full, fileBytes)

  // Range spanning the end of block 1 and the start of block 2
  const mid = await collect(
    await driver.createReadStream("/file.bin", { start: 5, end: 14 }),
  )
  assert.deepEqual(mid, fileBytes.slice(5, 15))

  // Range inside the last (shorter) block
  downloaded.length = 0
  const tail = await collect(
    await driver.createReadStream("/file.bin", { start: 21, end: 23 }),
  )
  assert.deepEqual(tail, fileBytes.slice(21, 24))
  // F-182: blocks before the requested range must not be downloaded.
  assert.deepEqual(downloaded, ["https://storage/block/3"])
})

test("normalizeProtonDriveAddition preserves password whitespace (F-184)", () => {
  const norm = normalizeProtonDriveAddition({
    email: "  user@example.com ",
    password: "  secret  ",
  })
  assert.equal(norm.email, "user@example.com")
  assert.equal(norm.password, "  secret  ")
})

test("2FA-stage requests send X-Pm-Uid without a bearer token (F-183)", () => {
  const client = new ProtonDriveClient({ email: "u@example.com", password: "p" })
  ;(client as any).uid = "uid-pending"
  const headers = (client as any).authHeaders() as Record<string, string>
  assert.equal(headers["X-Pm-Uid"], "uid-pending")
  assert.equal(headers.Authorization, undefined)

  client.setAuth("access", "refresh", "uid-final")
  const authed = (client as any).authHeaders() as Record<string, string>
  assert.equal(authed.Authorization, "Bearer access")
  assert.equal(authed["X-Pm-Uid"], "uid-final")
})

test("mkdir sends NodeHashKey, a real passphrase signature and HMAC name hash", async () => {
  const { privateKey: parentPrivArmored, publicKey: parentPubArmored } =
    await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "parent", email: "user@example.com" }],
    })
  const parentPriv = await openpgp.readPrivateKey({
    armoredKey: parentPrivArmored,
  })
  const parentPub = await openpgp.readKey({ armoredKey: parentPubArmored })
  const nodeHashKey = new Uint8Array(32).fill(5)

  const driver = newDriver()
  ;(driver as any).defaultAddrEmail = "user@example.com"
  ;(driver as any).resolveId = async () => "parent-link"
  ;(driver as any).getLinkKR = async () => [parentPriv]
  ;(driver as any).getNodeHashKey = async () => nodeHashKey
  ;(driver as any).getSigningKey = () => parentPriv
  let body: any = null
  ;(driver as any).client = {
    requestAPI: async (_path: string, opts: any) => {
      body = opts.body
      return { Code: 1000 }
    },
  }

  await driver.mkdir("/newdir", "/newdir")

  assert.ok(body, "mkdir must call createFolder")
  // Name hash is hex HMAC-SHA256(name, parent NodeHashKey).
  assert.equal(body.Hash, await getNameHash("newdir", nodeHashKey))
  assert.match(body.Hash, /^[0-9a-f]{64}$/)
  // NodeHashKey is present and decrypts to a fresh 32-byte hash key for the
  // new folder (not the parent's key, which only feeds the name HMAC).
  assert.ok(body.NodeHashKey)
  const createdHashKey = await decryptNodeHashKey(body.NodeHashKey, [
    parentPriv,
  ])
  assert.equal(createdHashKey.length, 32)
  assert.notDeepEqual(createdHashKey, nodeHashKey)
  // NodePassphraseSignature is a real detached signature over the passphrase.
  assert.match(body.NodePassphraseSignature, /-----BEGIN PGP SIGNATURE-----/)
  const passphrase = await decryptArmoredText(body.NodePassphrase, [parentPriv])
  const signature = await openpgp.readSignature({
    armoredSignature: body.NodePassphraseSignature,
  })
  const verification = await openpgp.verify({
    message: await openpgp.createMessage({ text: passphrase }),
    signature,
    verificationKeys: [parentPub],
  })
  await verification.signatures[0].verified
  // NodeKey is protected with that passphrase.
  const nodePriv = await openpgp.readPrivateKey({ armoredKey: body.NodeKey })
  await assert.doesNotReject(() =>
    openpgp.decryptKey({ privateKey: nodePriv, passphrase }),
  )
  assert.equal(body.SignatureAddress, "user@example.com")
})

test("write operations invalidate driver caches (F-181)", async () => {
  const driver = newDriver()
  const parent = { LinkID: "child", ParentLinkID: "parent-link" }
  ;(driver as any).linkCache.set("child", { LinkID: "child" })
  ;(driver as any).nodeKRcache.set("child", [])
  ;(driver as any).hashKeyCache.set("child", new Uint8Array(32))
  ;(driver as any).childrenCache.set("parent-link", [])
  ;(driver as any).idCache.set("/dir/child", "child")
  ;(driver as any).resolveId = async () => "child"
  ;(driver as any).fetchLink = async () => parent
  ;(driver as any).client = { requestAPI: async () => ({ Code: 1000 }) }

  await driver.remove("/dir/child", "/dir/child", ["child"])

  assert.equal((driver as any).childrenCache.has("parent-link"), false)
  assert.equal((driver as any).linkCache.has("child"), false)
  assert.equal((driver as any).nodeKRcache.has("child"), false)
  assert.equal((driver as any).hashKeyCache.has("child"), false)
  assert.equal((driver as any).idCache.has("/dir/child"), false)
})
