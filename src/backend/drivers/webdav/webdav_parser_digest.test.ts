import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import {
  computeDigestAuth,
  parseDigestChallenge,
  parseMultistatusXml,
} from "./util"

/** 构造一个最简 multistatus response（可指定 href / displayname / 是否集合） */
function responseBlock(opts: {
  href: string
  displayname?: string
  isDir?: boolean
}): string {
  return `<d:response>
  <d:href>${opts.href}</d:href>
  <d:propstat>
    <d:prop>
      ${opts.isDir ? "<d:resourcetype><d:collection/></d:resourcetype>" : "<d:resourcetype/>"}
      ${opts.displayname !== undefined ? `<d:displayname>${opts.displayname}</d:displayname>` : ""}
      <d:getcontentlength>10</d:getcontentlength>
      <d:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</d:getlastmodified>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`
}

function multistatus(...blocks: string[]): string {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${blocks.join("\n")}</d:multistatus>`
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex")
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

test("F-239：displayname / href 的 XML 实体必须解码", () => {
  const xml = multistatus(
    responseBlock({ href: "/dav/a%26b.txt", displayname: "a&amp;b.txt" }),
  )
  const { items } = parseMultistatusXml(xml, "/dav")
  assert.equal(items.length, 1)
  assert.equal(items[0].name, "a&b.txt")
  assert.equal(items[0].path, "/dav/a&b.txt")
})

test("F-239：实体只解码一次（&amp;lt; 不得变成 <）", () => {
  const xml = multistatus(
    responseBlock({ href: "/dav/x", displayname: "a&amp;lt;b.txt" }),
  )
  const { items } = parseMultistatusXml(xml, "/dav")
  assert.equal(items[0].name, "a&lt;b.txt")
})

test("F-241：displayname 为纯路径时回退 href basename", () => {
  const xml = multistatus(
    responseBlock({ href: "/dav/file.txt", displayname: "/dav/file.txt" }),
  )
  const { items } = parseMultistatusXml(xml, "/dav")
  assert.equal(items[0].name, "file.txt")
})

test("F-240：target 为根（归一为空串）时不得吞掉第一个子项", () => {
  const xml = multistatus(
    responseBlock({ href: "/dav/child1.txt" }),
    responseBlock({ href: "/dav/child2.txt" }),
  )
  const { self, items } = parseMultistatusXml(xml, "/")
  assert.equal(self, undefined)
  assert.deepEqual(
    items.map((i) => i.name),
    ["child1.txt", "child2.txt"],
  )
})

test("F-240：target 非空时仍能正确识别目录自身", () => {
  const xml = multistatus(
    responseBlock({ href: "/dav/sub/", isDir: true }),
    responseBlock({ href: "/dav/sub/a.txt" }),
  )
  const { self, items } = parseMultistatusXml(xml, "/dav/sub")
  assert.equal(self?.isFolder, true)
  assert.deepEqual(
    items.map((i) => i.name),
    ["a.txt"],
  )
})

test("F-237：SHA-256 Digest 必须用 SHA-256 计算 ha1/ha2/response", () => {
  const challenge = parseDigestChallenge(
    'Digest realm="x", nonce="abc123", qop="auth", algorithm=SHA-256',
  )
  assert.equal(challenge.algorithm, "SHA-256")
  const header = computeDigestAuth(
    challenge,
    "u",
    "p",
    "PROPFIND",
    "/dav",
    1,
  )
  const response = /response="([0-9a-f]+)"/.exec(header)![1]
  const nc = "00000001"
  const cnonce = /cnonce="([^"]+)"/.exec(header)![1]
  const ha1 = sha256("u:x:p")
  const ha2 = sha256("PROPFIND:/dav")
  assert.equal(response, sha256(`${ha1}:abc123:${nc}:${cnonce}:auth:${ha2}`))
  assert.ok(header.includes("algorithm=SHA-256"))
  assert.ok(header.includes("qop=auth"))
})

test("F-237：不支持的 Digest 算法必须显式报错（不再发空 ha1 的 MD5）", () => {
  const challenge = parseDigestChallenge(
    'Digest realm="x", nonce="n", qop="auth", algorithm=SHA-512-256',
  )
  assert.throws(
    () => computeDigestAuth(challenge, "u", "p", "GET", "/dav"),
    /Unsupported Digest algorithm/i,
  )
})

test("F-238：引号内的逗号不切分，键名不区分大小写", () => {
  const challenge = parseDigestChallenge(
    'Digest Realm="My Realm, Admin", NONCE="abc", QOP="auth", Algorithm=MD5',
  )
  assert.equal(challenge.realm, "My Realm, Admin")
  assert.equal(challenge.nonce, "abc")
  assert.equal(challenge.qop, "auth")
  assert.equal(challenge.algorithm, "MD5")
  const header = computeDigestAuth(challenge, "u", "p", "GET", "/dav")
  assert.ok(header.includes('realm="My Realm, Admin"'))
})

test("F-238：qop 列表选择 auth；仅有 auth-int 时显式报错", () => {
  const chosen = parseDigestChallenge(
    'Digest realm="x", nonce="n", qop="auth-int,auth"',
  )
  const header = computeDigestAuth(chosen, "u", "p", "GET", "/dav")
  assert.ok(header.includes("qop=auth,"), header)
  const ha1 = md5("u:x:p")
  const ha2 = md5("GET:/dav")
  const nc = "00000001"
  const cnonce = /cnonce="([^"]+)"/.exec(header)![1]
  assert.equal(
    /response="([0-9a-f]+)"/.exec(header)![1],
    md5(`${ha1}:n:${nc}:${cnonce}:auth:${ha2}`),
  )

  const authIntOnly = parseDigestChallenge(
    'Digest realm="x", nonce="n", qop="auth-int"',
  )
  assert.throws(
    () => computeDigestAuth(authIntOnly, "u", "p", "GET", "/dav"),
    /Unsupported Digest qop/i,
  )
})
