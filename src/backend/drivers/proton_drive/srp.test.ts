import test from "node:test"
import assert from "node:assert/strict"
import {
  bigIntToLittleEndian,
  computeSRPClientProof,
  expandHash,
  fromBase64,
  hashPassword,
  littleEndianToBigInt,
  modPow,
  proofsEqual,
  toBase64,
  verifyAndGetModulus,
  verifyCleartextModulus,
} from "./srp"
import { deriveSaltedKeyPass, getNameHash } from "./crypto"
import * as openpgp from "openpgp"

// ---------------------------------------------------------------------------
// Official Proton vectors
// ---------------------------------------------------------------------------

// Signed modulus used by ProtonMail/go-srp and the official clients' tests.
const VP_MODULUS =
  "W2z5HBi8RvsfYzZTS7qBaUxxPhsfHJFZpu3Kd6s1JafNrCCH9rfvPLrfuqocxWPgWDH2R8neK7PkNvjxto9TStuY5z7jAzWRvFWN9cQhAKkdWgy0JY6ywVn22+HFpF4cYesHrqFIKUPDMSSIlWjBVmEJZ/MusD44ZT29xcPrOqeZvwtCffKtGAIjLYPZIEbZKnDM1Dm3q2K/xS5h+xdhjnndhsrkwm9U9oyA2wxzSXFL+pdfj2fOdRwuR5nW0J2NFrq3kJjkRmpO/Genq1UW+TEknIWAb6VzJJJA244K/H8cnSx2+nSNZO3bbo6Ys228ruV9A8m6DhxmS+bihN3ttQ=="
const VP_MODULUS_CLEARSIGN = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA256

${VP_MODULUS}
-----BEGIN PGP SIGNATURE-----
Version: ProtonMail
Comment: https://protonmail.com

wl4EARYIABAFAlwB1j0JEDUFhcTpUY8mAAD8CgEAnsFnF4cF0uSHKkXa1GIa
GO86yMV4zDZEZcDSJo0fgr8A/AlupGN9EdHlsrZLmTA1vhIx+rOgxdEff28N
kvNM7qIK
=q6vu
-----END PGP SIGNATURE-----`

// expandHash("wat") from ProtonMail/pm-srp test/passwords.data.js
const WAT_EXPANDHASH =
  "RTA92yMl3CYKpJ02xwPx8WjaldSA7xt8EHYMmieSRrjSoCcAIEfPHtpod1GSF61ZDGnPCAplSiB8mwCr2Lqo14TaeiEn2ij8/eCDRjKdsVPNEgosHz3l3X+pYN+SZPufh5zYUozO72caY9knBkzpixGMWg/MZJQ+joyF3xKB5Rs4tczQ5q/TxgTcI2iNh7bixYtQ1v79aPeXoxv2nIbmytoMk6iVceZx02U2IUTcvAoNYs8iT80IGbtAlCQOkTWq5D2bGhZ8ZzGl1wh7RUbAOF8Z/lWVhaequE9Ph/XnAJuRqVGTc6nEd35nXAl0Y6PPT7d9J7JolJeao0qSfrdgWw=="

// hashPassword v4("hello", salt="\xbb\xa2p\xf5\xf3<\xb1\xd2\x87&", modulus=0^256)
const HASHED_RESULT4 =
  "rXQ+YNpiawfbpknPzzSMComqYCM+SFWqYXbOn/EiU7y2t2UOEsazegVe4Ov3Qtwb7OBBLRx64YnxZ53lKS4xaOxPg7avuonMuqIBAofEE8K3tOF/7lMbVJSkV1OQ57JXmZ1uvDPw/ZJVNebZCGxhb1CwhmmwydU8nY4+wnjSpEhq7NueadJLscBOpZHDQKS1MrZZ/r/xRfHqAln7+QqJFJX7iuGLvZ7cII20rB+fvKE77BCJnIyUKai1jZh6hvVQC0kkas3q4XGaFNBI68pajF4cfVD6WhqnDe3vWDL2tzQT5xAQlVaZtSVtEHfqu5wwLEszo3eK13SQtO2VDyZG5Q=="

const PM_SALT_BINARY = "\u00bb\u00a2p\u00f5\u00f3<\u00b1\u00d2\u0087&"

function latin1(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

function hexToBinaryString(hex: string): string {
  let bin = ""
  for (let i = 0; i < hex.length; i += 2) {
    bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
  }
  return bin
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

test("little-endian integer helpers", () => {
  // Proton treats every byte string as a little-endian integer.
  assert.equal(littleEndianToBigInt(new Uint8Array([0x01, 0x02, 0x03])), 0x030201n)
  assert.deepEqual(bigIntToLittleEndian(0x030201n, 3), new Uint8Array([1, 2, 3]))
  assert.deepEqual(
    bigIntToLittleEndian(0x030201n, 5),
    new Uint8Array([1, 2, 3, 0, 0]),
  )
  assert.equal(modPow(2n, 10n, 1000n), 24n)
  assert.equal(modPow(2n, 0n, 5n), 1n)
  assert.throws(() => bigIntToLittleEndian(0x100n, 1))
})

test("expandHash = 4 x SHA-512(input || counter)", async () => {
  const out = await expandHash(latin1("wat"))
  assert.equal(out.length, 256)
  assert.equal(toBase64(out), WAT_EXPANDHASH)
})

test("hashPassword v4 matches the official pm-srp vector", async () => {
  const modifier = new Uint8Array(256)
  const hashed = await hashPassword(4, "hello", latin1(PM_SALT_BINARY), "user1", modifier)
  assert.equal(hashed.length, 256)
  assert.equal(toBase64(hashed), HASHED_RESULT4)
  // v3 uses the same derivation as v4
  const hashed3 = await hashPassword(3, "hello", latin1(PM_SALT_BINARY), "user1", modifier)
  assert.equal(toBase64(hashed3), HASHED_RESULT4)
})

test("hashPassword v2 (legacy) uses the md5(username) bcrypt salt", async () => {
  const a = await hashPassword(2, "hello", new Uint8Array(0), "user.1", new Uint8Array(256))
  const b = await hashPassword(2, "hello", new Uint8Array(0), "user-1", new Uint8Array(256))
  // cleanUsername strips '.', '-', '_' and lowercases
  assert.deepEqual(a, b)
  const c = await hashPassword(2, "hello", new Uint8Array(0), "other", new Uint8Array(256))
  assert.notDeepEqual(a, c)
})

test("verifyAndGetModulus accepts Proton's real signed modulus", async () => {
  const modulus = await verifyAndGetModulus(VP_MODULUS_CLEARSIGN)
  assert.equal(modulus.length, 256)
  assert.deepEqual(modulus, fromBase64(VP_MODULUS))
})

test("verifyAndGetModulus rejects a tampered signature and raw base64", async () => {
  await assert.rejects(() => verifyAndGetModulus(VP_MODULUS))
  const tampered = VP_MODULUS_CLEARSIGN.replace(
    "wl4EARYIABAFAlwB1j0JEDUFhcTpUY8mAAD8CgEAnsFnF4cF0uSHKkXa1GIa",
    "wl4EARYIABAFAlwB1j0JEDUFhcTpUY8mAAD8CgEAnsFnF4cF0uSHKkXa1GIb",
  )
  await assert.rejects(() => verifyAndGetModulus(tampered))
})

test("verifyCleartextModulus works with an arbitrary signing key", async () => {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: "rsa",
    rsaBits: 2048,
    userIDs: [{ name: "t", email: "t@example.com" }],
  })
  const signingKey = await openpgp.readPrivateKey({ armoredKey: privateKey })
  const body = toBase64(new Uint8Array(256).fill(7))
  const cleartext = await openpgp.createCleartextMessage({ text: body })
  const signed = (await openpgp.sign({
    message: cleartext,
    signingKeys: [signingKey],
    format: "armored",
  })) as unknown as string

  const out = await verifyCleartextModulus(signed, publicKey)
  assert.deepEqual(out, new Uint8Array(256).fill(7))
  await assert.rejects(() => verifyCleartextModulus(signed, "not a key"))

  // Trailing data after the signature must invalidate the message.
  await assert.rejects(() => verifyCleartextModulus(signed + "\nextra", publicKey))
})

// ---------------------------------------------------------------------------
// SRP-6a end to end against a simulated Proton server
// ---------------------------------------------------------------------------

function leInt(value: bigint): Uint8Array {
  return bigIntToLittleEndian(value, 256)
}

test("client proof matches a server-side SRP-6a computation", async () => {
  const modulusBytes = fromBase64(VP_MODULUS)
  const N = littleEndianToBigInt(modulusBytes)
  const g = 2n
  const salt = fromBase64("yKlc5/CvObfoiw==")
  const username = "jakubqa"
  const password = "abc123"

  // Server side: verifier v = g^x
  const hashedPassword = await hashPassword(
    4,
    password,
    salt,
    username,
    modulusBytes,
  )
  const x = littleEndianToBigInt(hashedPassword)
  const v = modPow(g, x, N)

  // k = H(pad_le(g) | N)
  const k = littleEndianToBigInt(
    await expandHash(new Uint8Array([...leInt(g), ...modulusBytes])),
  )

  // server ephemeral B = k*v + g^b
  const b = 0x1234567890abcdefn * 7919n + 13n
  const B = (k * v + modPow(g, b, N)) % N
  const B_le = leInt(B)

  const info = {
    Modulus: VP_MODULUS_CLEARSIGN,
    ServerEphemeral: toBase64(B_le),
    Salt: toBase64(salt),
    Version: 4,
    SRPSession: "session-1",
  }

  const clientSecret = new Uint8Array(256)
  for (let i = 0; i < 256; i++) clientSecret[i] = (i * 7 + 3) & 0xff

  const proof = await computeSRPClientProof(username, password, info, {
    modulusBytes,
    clientSecret,
  })

  // Server side verification
  const A_le = fromBase64(proof.ClientEphemeral)
  const A = littleEndianToBigInt(A_le)
  const u = littleEndianToBigInt(
    await expandHash(Uint8Array.from([...A_le, ...B_le])),
  )
  const S_server = modPow((A * modPow(v, u, N)) % N, b, N)
  const S_le = leInt(S_server)
  const serverClientProof = await expandHash(
    Uint8Array.from([...A_le, ...B_le, ...S_le]),
  )
  assert.equal(proof.ClientProof, toBase64(serverClientProof))

  const serverProof = await expandHash(
    Uint8Array.from([...A_le, ...serverClientProof, ...S_le]),
  )
  assert.equal(proof.ExpectedServerProof, toBase64(serverProof))
  assert.equal(proof.SRPSession, "session-1")
  // A must be a valid group element serialized to 256 little-endian bytes
  assert.equal(A_le.length, 256)
})

test("client ephemeral is derived from the supplied client secret", async () => {
  const modulusBytes = fromBase64(VP_MODULUS)
  const N = littleEndianToBigInt(modulusBytes)
  const secret = new Uint8Array(256).fill(9)
  const proof = await computeSRPClientProof(
    "u",
    "p",
    {
      Modulus: VP_MODULUS_CLEARSIGN,
      ServerEphemeral: toBase64(leInt(12345n)),
      Salt: toBase64(new Uint8Array(16)),
      Version: 4,
      SRPSession: "s",
    },
    { modulusBytes, clientSecret: secret },
  )
  assert.equal(
    proof.ClientEphemeral,
    toBase64(bigIntToLittleEndian(modPow(2n, littleEndianToBigInt(secret), N), 256)),
  )
})

test("computeSRPClientProof refuses an unverified modulus", async () => {
  await assert.rejects(() =>
    computeSRPClientProof("u", "p", {
      Modulus: VP_MODULUS, // bare base64, not a cleartext signed message
      ServerEphemeral: toBase64(new Uint8Array(256).fill(1)),
      Salt: toBase64(new Uint8Array(16)),
      Version: 4,
      SRPSession: "s",
    }),
  )
})

test("computeSRPClientProof rejects B == 0", async () => {
  await assert.rejects(
    () =>
      computeSRPClientProof(
        "u",
        "p",
        {
          Modulus: VP_MODULUS_CLEARSIGN,
          ServerEphemeral: toBase64(new Uint8Array(256)),
          Salt: toBase64(new Uint8Array(16)),
          Version: 4,
          SRPSession: "s",
        },
        { modulusBytes: fromBase64(VP_MODULUS) },
      ),
    /out of bounds/,
  )
})

test("proofsEqual is constant-time-ish string comparison", () => {
  assert.equal(proofsEqual("abc", "abc"), true)
  assert.equal(proofsEqual("abc", "abd"), false)
  assert.equal(proofsEqual("abc", "abcd"), false)
  assert.equal(proofsEqual("", ""), false)
})

// ---------------------------------------------------------------------------
// key passphrase (unchanged behaviour, still needs a regression guard)
// ---------------------------------------------------------------------------

test("deriveSaltedKeyPass is deterministic and printable ASCII", () => {
  const salt = btoa("\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10")
  const a = deriveSaltedKeyPass("password", salt)
  const b = deriveSaltedKeyPass("password", salt)
  assert.equal(a, b)
  assert.match(a, /^[./A-Za-z0-9]{31}$/)
})

test("getNameHash = hex(HMAC-SHA256(name, parent NodeHashKey))", async () => {
  const hashKey = new TextEncoder().encode("key")
  const h = await getNameHash("hello", hashKey)
  assert.equal(
    h,
    "9307b3b915efb5171ff14d8cb55fbcc798c6c0ef1456d66ded1a6aa723a58b7b",
  )
  // unkeyed/empty keys must be rejected instead of silently hashing
  await assert.rejects(() => getNameHash("hello", new Uint8Array(0)))
})
