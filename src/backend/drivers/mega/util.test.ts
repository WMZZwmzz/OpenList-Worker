import test from "node:test"
import assert from "node:assert/strict"
import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto"
import {
  MegaApiClient,
  aesCbcDecrypt,
  aesCbcEncrypt,
  aesCtrDecrypt,
  aesEcbDecrypt,
  aesEcbEncrypt,
  b64urlDecode,
  b64urlEncode,
  condenseMac,
  cbcMac,
  decryptAttributes,
  decryptNodeKey,
  decodeRsaPrivateKey,
  encryptAttributes,
  encryptNodeKey,
  MegaAes,
  megaChunkLayout,
  megaChunkSize,
  nodeAesKey,
  pickNodeKey,
  prepareKey,
  rsaDecrypt,
  splitKeyCandidates,
  stringhash,
  unmergeKeyMac,
} from "./util"

const ZERO_IV = Buffer.alloc(16)

function nodeAesCbcEncrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const c = createCipheriv("aes-128-cbc", key, ZERO_IV)
  c.setAutoPadding(false)
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]))
}
function nodeAesCbcDecrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const d = createDecipheriv("aes-128-cbc", key, ZERO_IV)
  d.setAutoPadding(false)
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(data)), d.final()]))
}

function megaAttrBlob(attrs: object, key: Uint8Array, withMac = false): string {
  const text = Buffer.from("MEGA" + JSON.stringify(attrs), "utf8")
  const padded = Buffer.alloc(Math.ceil(text.length / 16) * 16)
  text.copy(padded)
  const ct = nodeAesCbcEncrypt(padded, key)
  if (!withMac) return b64urlEncode(ct)
  // CBC-MAC over the ciphertext, folded to 8 bytes (MEGA SDK attribute MAC)
  const aes = new MegaAes(key)
  const state = cbcMac(ct, aes)
  const mac = new Uint8Array(8)
  for (let i = 0; i < 4; i++) {
    mac[i] = state[i] ^ state[i + 4]
    mac[i + 4] = state[i + 8] ^ state[i + 12]
  }
  return b64urlEncode(Uint8Array.from([...ct, ...mac]))
}

// ---------------------------------------------------------------------------

test("base64url helpers roundtrip", () => {
  const bytes = Uint8Array.from([0xfb, 0xff, 0x00, 0x01, 0xfe])
  const encoded = b64urlEncode(bytes)
  assert.equal(encoded, Buffer.from(bytes).toString("base64url"))
  assert.deepEqual(b64urlDecode(encoded), bytes)
  assert.deepEqual(b64urlDecode(""), new Uint8Array(0))
})

test("AES primitives match node:crypto", () => {
  const key = randomBytes(16)
  const data = randomBytes(48)
  assert.deepEqual(
    aesEcbEncrypt(new Uint8Array(data), key),
    new Uint8Array(
      (() => {
        const c = createCipheriv("aes-128-ecb", key, null).setAutoPadding(false)
        return Buffer.concat([c.update(data), c.final()])
      })(),
    ),
  )
  assert.deepEqual(aesEcbDecrypt(aesEcbEncrypt(new Uint8Array(data), key), key), new Uint8Array(data))
  assert.deepEqual(
    aesCbcEncrypt(new Uint8Array(data), key),
    nodeAesCbcEncrypt(new Uint8Array(data), key),
  )
  assert.deepEqual(
    aesCbcDecrypt(nodeAesCbcEncrypt(new Uint8Array(data), key), key),
    new Uint8Array(data),
  )
})

test("prepareKey matches the megajs reference", () => {
  // Reference values computed with an independent node:crypto implementation
  // of megajs' prepareKey (65536 AES-128-ECB rounds).
  assert.equal(Buffer.from(prepareKey("password123")).toString("hex"), "22f683851212b50a92114454fa542b99")
  assert.equal(Buffer.from(prepareKey("correct horse battery staple")).toString("hex"), "57d978ef82e99ea50ab00045e8614d7b")
  // empty password leaves the seed untouched
  assert.equal(Buffer.from(prepareKey("")).toString("hex"), "93c467e37db0c7a4d1be3f810152cb56")
})

test("stringhash matches the megajs reference", () => {
  const key = prepareKey("password123")
  assert.equal(Buffer.from(stringhash("test@example.com", key)).toString("hex"), "8cd537afb607acb0")
  assert.equal(Buffer.from(stringhash("ABC@X", key)).toString("hex"), "6757d3841f493f2f")
  // values are the XOR-folded, AES-mixed words (non-zero, 8 bytes)
  assert.equal(stringhash("x", key).length, 8)
})

test("node attribute decryption (no MAC, as written by megajs/mega.py)", () => {
  const nodeKey = randomBytes(16)
  const blob = megaAttrBlob({ n: "我的文件夹", t: 0 }, nodeAesKey(nodeKey))
  const attrs = decryptAttributes(blob, nodeKey)
  assert.equal(attrs?.n, "我的文件夹")

  // wrong key must not produce a bogus name
  assert.equal(decryptAttributes(blob, randomBytes(16)), null)
  assert.equal(decryptAttributes("", nodeKey), null)
  assert.equal(decryptAttributes("!!!", nodeKey), null)
})

test("node attribute decryption verifies the trailing 64-bit MAC", () => {
  const nodeKey = randomBytes(16)
  const blob = megaAttrBlob({ n: "with-mac" }, nodeAesKey(nodeKey), true)
  assert.equal(decryptAttributes(blob, nodeKey)?.n, "with-mac")

  const tampered = b64urlDecode(blob)
  tampered[tampered.length - 1] ^= 0xff
  assert.equal(decryptAttributes(b64urlEncode(tampered), nodeKey), null)

  const corruptedBody = b64urlDecode(blob)
  corruptedBody[0] ^= 0xff
  assert.equal(decryptAttributes(b64urlEncode(corruptedBody), nodeKey), null)
})

test("encryptAttributes is readable by the reference CBC implementation", () => {
  const folderKey = randomBytes(16)
  const blob = encryptAttributes({ n: "New Folder" }, folderKey)
  const plain = nodeAesCbcDecrypt(b64urlDecode(blob), nodeAesKey(folderKey))
  const text = Buffer.from(plain).toString("utf8").replace(/\u0000+$/, "")
  assert.equal(text, 'MEGA{"n":"New Folder"}')
  // and roundtrips through our own parser
  assert.equal(decryptAttributes(blob, folderKey)?.n, "New Folder")
})

test("file/folder node key handling", () => {
  const masterKey = randomBytes(16)
  const folderKey = randomBytes(16)
  const fileKey = randomBytes(32)

  const folderK = encKeyFor(folderKey, masterKey, "h1")
  assert.deepEqual(decryptNodeKey(b64urlDecode(pickNodeKey(folderK, "h1")!.key), masterKey, null, true), new Uint8Array(folderKey))

  // k strings may carry multiple "handle:key" segments (shared nodes)
  const shared = `${folderK}/${encKeyFor(fileKey, masterKey, "h2")}`
  const picked = pickNodeKey(shared, "h2")!
  assert.equal(picked.handle, "h2")
  assert.deepEqual(decryptNodeKey(b64urlDecode(picked.key), masterKey, null, false), new Uint8Array(fileKey))

  assert.deepEqual(splitKeyCandidates("abc").map((c) => c.handle), [undefined])
  assert.deepEqual(splitKeyCandidates("h:k/").map((c) => c.handle), ["h"])

  // unmergeKeyMac XORs the nonce half into the key half
  assert.deepEqual(
    unmergeKeyMac(fileKey).subarray(0, 16),
    Uint8Array.from(fileKey.subarray(0, 16).map((b, i) => b ^ fileKey[16 + i])),
  )
})

function encKeyFor(key: Uint8Array, masterKey: Uint8Array, handle: string): string {
  return encryptNodeKey(key, masterKey, handle)
}

test("RSA private key decode + raw decryption (csid)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwk = privateKey.export({ format: "jwk" }) as any
  const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"))
  const p = fromB64url(jwk.p)
  const q = fromB64url(jwk.q)
  const d = fromB64url(jwk.d)
  const mpi = (b: Uint8Array) => {
    const out = new Uint8Array(2 + b.length)
    const bits = b.length * 8
    out[0] = (bits >> 8) & 0xff
    out[1] = bits & 0xff
    out.set(b, 2)
    return out
  }
  const privk = Uint8Array.from([...mpi(p), ...mpi(q), ...mpi(d), ...mpi(p)])
  const decoded = decodeRsaPrivateKey(privk)!
  assert.ok(decoded.p > 0n && decoded.q > 0n && decoded.d > 0n)

  // csid = raw RSA encryption of the 43-char session id
  const sid = "q".repeat(20) + "Z7-_".repeat(5) + "abc"
  assert.equal(sid.length, 43)
  const pubJwk = publicKey.export({ format: "jwk" }) as any
  const n = BigInt("0x" + Buffer.from(pubJwk.n, "base64url").toString("hex"))
  const e = BigInt("0x" + Buffer.from(pubJwk.e, "base64url").toString("hex"))
  const m = BigInt("0x" + Buffer.from(sid, "utf8").toString("hex"))
  let c = 1n
  let base = m % n
  let exp = e
  while (exp > 0n) {
    if (exp & 1n) c = (c * base) % n
    base = (base * base) % n
    exp >>= 1n
  }
  const hex = c.toString(16).padStart(512, "0")
  const cipher = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)))
  const plain = rsaDecrypt(cipher, decoded)
  assert.equal(Buffer.from(plain).toString("utf8"), sid)
  assert.deepEqual(decodeRsaPrivateKey(new Uint8Array([0, 0])), null)
})

test("chunk layout matches Mega's 128KiB..1MiB progression", () => {
  assert.equal(megaChunkSize(0), 131072)
  assert.equal(megaChunkSize(7), 8 * 131072)
  assert.equal(megaChunkSize(8), 1048576)

  const layout = megaChunkLayout(1048576 + 131072 + 10)
  assert.deepEqual(layout.plainOffsets, [0, 131072, 393216, 786432])
  assert.deepEqual(layout.sizes, [131072, 262144, 393216, 393226])
  assert.equal(layout.cipherOffsets[1], 131072 + 8)
  assert.equal(layout.cipherOffsets[3], 786432 + 3 * 8)
})

test("AES-CTR chunk decryption matches node:crypto", async () => {
  const key = randomBytes(16)
  const nonce = randomBytes(16)
  const plain = randomBytes(131072 + 5)
  const counter = Buffer.alloc(16)
  nonce.copy(counter, 0, 0, 8)
  const c = createCipheriv("aes-128-ctr", key, counter)
  const cipher = new Uint8Array(Buffer.concat([c.update(plain), c.final()]))
  const out = await aesCtrDecrypt(cipher.subarray(0, 100), key, nonce, 0)
  assert.deepEqual(out, new Uint8Array(plain.subarray(0, 100)))

  // second chunk continues the counter at block 131072/16
  const offset = 131072 / 16
  const counter2 = Buffer.alloc(16)
  nonce.copy(counter2, 0, 0, 8)
  counter2.writeBigUInt64BE(BigInt(offset), 8)
  const c2 = createCipheriv("aes-128-ctr", key, counter2)
  const cipher2 = new Uint8Array(Buffer.concat([c2.update(plain.subarray(131072)), c2.final()]))
  const out2 = await aesCtrDecrypt(cipher2, key, nonce, offset)
  assert.deepEqual(out2, new Uint8Array(plain.subarray(131072)))
})

test("condenseMac folds chunk MACs into 8 bytes", () => {
  const key = randomBytes(16)
  const aes = new MegaAes(key)
  const macs = [randomBytes(16), randomBytes(16)]
  const out = condenseMac([new Uint8Array(macs[0]), new Uint8Array(macs[1])], aes)
  assert.equal(out.length, 8)
  // deterministic and not all-zero
  assert.deepEqual(condenseMac([new Uint8Array(macs[0]), new Uint8Array(macs[1])], aes), out)
  assert.notDeepEqual(out, new Uint8Array(8))
})

// ---------------------------------------------------------------------------
// login flow
// ---------------------------------------------------------------------------

test("init() performs Mega's real login and decrypts node names", async () => {
  const password = "password123"
  const pwKey = prepareKey(password)
  const masterKey = randomBytes(16)
  const rootKey = randomBytes(16)
  const folderKey = randomBytes(16)
  const fileKey = randomBytes(32)
  const email = "user@example.com"

  // RSA key for csid / privk
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwk = privateKey.export({ format: "jwk" }) as any
  const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"))
  const mpi = (b: Uint8Array) => {
    const out = new Uint8Array(2 + b.length)
    out[0] = (b.length * 8) >> 8
    out[1] = (b.length * 8) & 0xff
    out.set(b, 2)
    return out
  }
  const privkPlain = Uint8Array.from([
    ...mpi(fromB64url(jwk.p)),
    ...mpi(fromB64url(jwk.q)),
    ...mpi(fromB64url(jwk.d)),
    ...mpi(fromB64url(jwk.p)),
  ])
  const privk = b64urlEncode(aesEcbEncrypt(privkPlain, masterKey))

  // csid = raw RSA encryption of the 43-byte session id with the public key.
  const sidPlain = "A".repeat(20) + "Z7-_".repeat(5) + "abc"
  assert.equal(sidPlain.length, 43)
  const rsaPublicRaw = (message: Uint8Array): Uint8Array => {
    const pubJwk = privateKey.export({ format: "jwk" }) as any
    const n = BigInt("0x" + Buffer.from(pubJwk.n, "base64url").toString("hex"))
    const e = BigInt("0x" + Buffer.from(pubJwk.e, "base64url").toString("hex"))
    let m = 0n
    for (const b of message) m = (m << 8n) | BigInt(b)
    let c = 1n
    let base = m % n
    let exp = e
    while (exp > 0n) {
      if (exp & 1n) c = (c * base) % n
      base = (base * base) % n
      exp >>= 1n
    }
    const hex = c.toString(16).padStart(512, "0")
    return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))
  }
  const csid = b64urlEncode(rsaPublicRaw(Buffer.from(sidPlain, "utf8")))

  const requests: any[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body)
    requests.push(body[0])
    const action = body[0].a
    let payload: any
    if (action === "us0") payload = [{ v: 1 }]
    else if (action === "us")
      payload = [
        {
          k: `${email}:${b64urlEncode(aesEcbEncrypt(masterKey, pwKey))}`,
          privk,
          csid,
        },
      ]
    else if (action === "f")
      payload = [
        {
          f: [
            { h: "ROOT", t: 2, p: "", k: `ROOT:${b64urlEncode(aesEcbEncrypt(rootKey, masterKey))}`, a: megaAttrBlob({ n: "Root" }, nodeAesKey(rootKey)) },
            { h: "FOLD", t: 1, p: "ROOT", k: `FOLD:${b64urlEncode(aesEcbEncrypt(folderKey, masterKey))}`, a: megaAttrBlob({ n: "Docs" }, nodeAesKey(folderKey)) },
            { h: "FILE", t: 0, p: "FOLD", s: 42, k: `FILE:${b64urlEncode(aesEcbEncrypt(fileKey, masterKey))}`, a: megaAttrBlob({ n: "a.txt" }, nodeAesKey(fileKey)) },
          ],
        },
      ]
    else payload = [{ g: "https://gfs.example/download", s: 42 }]
    return new Response(JSON.stringify(payload), { status: 200 })
  }) as typeof fetch

  try {
    const client = new MegaApiClient({ email, password })
    await client.init()
    assert.equal(client.getRootId(), "ROOT")
    assert.deepEqual(
      client.getChildren("ROOT").map((n) => n.name),
      ["Docs"],
    )
    assert.deepEqual(
      client.getChildren("FOLD").map((n) => n.name),
      ["a.txt"],
    )
    const file = client.getNode("FILE")!
    assert.equal(file.name, "a.txt")
    assert.deepEqual(b64urlDecode(file.key!), new Uint8Array(fileKey))

    // the password really participates: uh == stringhash(email, prepareKey(pw))
    const us = requests.find((r) => r.a === "us")
    assert.equal(us.uh, b64urlEncode(stringhash(email, pwKey)))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("createFolder uploads a random key and encrypted attributes", async () => {
  const masterKey = randomBytes(16)
  const client = new MegaApiClient({ email: "a@b.c", password: "x" })
  ;(client as any).masterKey = masterKey
  ;(client as any).rootId = "ROOT"
  let sent: any = null
  ;(client as any).request = async (body: any[]) => {
    sent = body[0]
    return [{ f: [{ h: "NEWDIR" }] }]
  }
  ;(client as any).fetchNodes = async () => {}

  const created = await client.createFolder("Reports", "ROOT")
  assert.equal(created, "NEWDIR")
  assert.equal(sent.a, "p")
  assert.equal(sent.t, "ROOT")
  const node = sent.n[0]
  assert.equal(node.t, 1)
  // Mega node handles are generated by the client so that `k` can reference it.
  assert.match(node.h, /^[A-Za-z0-9_-]{8}$/)

  // k must be "<handle>:AES-ECB(folderKey, masterKey)" and must decrypt
  const [handle, encKey] = node.k.split(":")
  assert.equal(handle, node.h)
  const folderKey = aesEcbDecrypt(b64urlDecode(encKey), masterKey)
  assert.equal(folderKey.length, 16)
  assert.equal(decryptAttributes(node.a, folderKey)?.n, "Reports")

  // attributes must not be plaintext
  assert.ok(!Buffer.from(b64urlDecode(node.a)).toString("latin1").includes("Reports"))
})

// ---------------------------------------------------------------------------
// error handling / config (F-378, F-383) and proxy decryption (F-377)
// ---------------------------------------------------------------------------

test("request rejects command-level negative error codes (F-378)", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response("[-9]", { status: 200 })) as typeof fetch
  try {
    const client = new MegaApiClient({ email: "a@b.c", password: "x" })
    await assert.rejects(() => client.request([{ a: "d", n: "h" }]), /-9/)

    ;(client as any).nodes.set("h", {
      id: "h",
      name: "x",
      size: 0,
      is_dir: false,
      modified: "",
      type: 0,
    })
    await assert.rejects(() => client.deleteNode("h"), /-9/)
    // Local cache must only change after the API accepted the command.
    assert.ok((client as any).nodes.has("h"))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("deleteNode honours move_to_trash and root_folder_id works (F-383)", async () => {
  const client = new MegaApiClient({ email: "a@b.c", password: "x" })
  ;(client as any).trashId = "TRASH"
  ;(client as any).nodes.set("h", {
    id: "h",
    parent_id: "ROOT",
    name: "x",
    size: 0,
    is_dir: false,
    modified: "",
    type: 0,
  })
  const sent: any[] = []
  ;(client as any).request = async (body: any[]) => {
    sent.push(body[0])
    return [0]
  }

  await client.deleteNode("h", true)
  assert.deepEqual(sent[0], { a: "m", n: "h", t: "TRASH" })
  assert.equal((client as any).nodes.get("h").parent_id, "TRASH")

  await client.deleteNode("h", false)
  assert.deepEqual(sent[1], { a: "d", n: "h" })
  assert.equal((client as any).nodes.has("h"), false)

  const rooted = new MegaApiClient({
    email: "a@b.c",
    password: "x",
    root_folder_id: "SUBDIR",
  })
  ;(rooted as any).rootId = "ROOT"
  ;(rooted as any).nodes.set("SUBDIR", {
    id: "SUBDIR",
    name: "sub",
    size: 0,
    is_dir: true,
    modified: "",
    type: 1,
  })
  ;(rooted as any).applyConfiguredRoot()
  assert.equal(rooted.getRootId(), "SUBDIR")

  const missing = new MegaApiClient({
    email: "a@b.c",
    password: "x",
    root_folder_id: "NOPE",
  })
  assert.throws(() => (missing as any).applyConfiguredRoot(), /not found/)
})

test("createReadStream decrypts Mega ciphertext with chunk and meta MACs (F-377)", async () => {
  const plain = randomBytes(100)
  const aesKey = randomBytes(16)
  const nonce = randomBytes(8)
  const layout = megaChunkLayout(plain.length)
  const aes = new MegaAes(new Uint8Array(aesKey))
  const chunkBytes: Uint8Array[] = []
  const macStates: Uint8Array[] = []

  for (let i = 0; i < layout.sizes.length; i++) {
    const offset = layout.plainOffsets[i]
    const size = layout.sizes[i]
    const block = plain.subarray(offset, offset + size)
    const counter = Buffer.alloc(16)
    nonce.copy(counter, 0)
    counter.writeBigUInt64BE(BigInt(offset / 16), 8)
    const cipher = createCipheriv("aes-128-ctr", aesKey, counter)
    const ciphertext = Buffer.concat([
      cipher.update(block),
      cipher.final(),
    ])
    let state: Uint8Array = new Uint8Array(16)
    state.set(nonce, 0)
    state.set(nonce, 8)
    for (let off = 0; off < block.length; off += 16) {
      const padded = new Uint8Array(16)
      padded.set(block.subarray(off, off + 16))
      const x = new Uint8Array(16)
      for (let j = 0; j < 16; j++) x[j] = state[j] ^ padded[j]
      state = aes.encryptBlock(x)
    }
    macStates.push(state)
    chunkBytes.push(Uint8Array.from([...ciphertext, ...state.subarray(0, 8)]))
  }

  let condensed: Uint8Array = new Uint8Array(16)
  for (const state of macStates) {
    const x = new Uint8Array(16)
    for (let j = 0; j < 16; j++) x[j] = condensed[j] ^ state[j]
    condensed = aes.encryptBlock(x)
  }
  const metaMac = new Uint8Array(8)
  for (let i = 0; i < 4; i++) {
    metaMac[i] = condensed[i] ^ condensed[i + 4]
    metaMac[i + 4] = condensed[i + 8] ^ condensed[i + 12]
  }
  const merged = new Uint8Array(32)
  merged.set(nonce, 16)
  merged.set(metaMac, 24)
  for (let i = 0; i < 16; i++) merged[i] = aesKey[i] ^ merged[16 + i]

  const ciphertext = Uint8Array.from(chunkBytes.flatMap((c) => [...c]))
  const client = new MegaApiClient({ email: "a@b.c", password: "x" })
  ;(client as any).nodes.set("FILE", {
    id: "FILE",
    name: "f.bin",
    size: plain.length,
    is_dir: false,
    modified: "",
    type: 0,
    key: b64urlEncode(merged),
  })
  ;(client as any).request = async () => [
    { g: "https://gfs.example/file", s: plain.length },
  ]

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(ciphertext, { status: 200 })) as typeof fetch
  try {
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      const parts: Uint8Array[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) parts.push(value)
      }
      return Uint8Array.from(parts.flatMap((p) => [...p]))
    }
    assert.deepEqual(await collect(await client.createReadStream("FILE")), new Uint8Array(plain))
    // Ranged read must skip the first chunk and still return plaintext bytes.
    const ranged = await client.createReadStream("FILE", { start: 20, end: 49 })
    assert.deepEqual(await collect(ranged), new Uint8Array(plain.subarray(20, 50)))
  } finally {
    globalThis.fetch = originalFetch
  }
})
