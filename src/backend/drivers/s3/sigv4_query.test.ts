import assert from "node:assert/strict"
import { test } from "node:test"
import { S3Client } from "./util"
import {
  getSigningKey,
  hmacSha256Hex,
  presignS3Url,
  sha256Hex,
  signS3Headers,
} from "./sigv4"

/**
 * F-148：SigV4 的 canonical query 用 RFC 3986（空格 → %20、字面 + → %2B），
 * 而 URLSearchParams 的 wire 序列化是 form 规则（空格 → "+"），两者不一致时
 * AWS S3 直接 403 SignatureDoesNotMatch（任何名字带空格的目录 prefix、
 * 带 disposition 的预签名直链都会命中）。
 *
 * 这里用「服务端视角」验证：从实际要发送的 wire URL 的原始 query 字节重算
 * canonical（botocore 对 S3 就是用原始字节，不解码再编码），再重建签名，
 * 必须与 URL/Authorization 里的签名完全一致。
 */

const REGION = "us-east-1"
const AK = "AKIAIOSFODNN7EXAMPLE"
const SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

/** 按收到的原始 query 字节构造 canonical（AWS 服务端视角） */
function wireCanonicalQuery(url: URL, excludeSignature = false): string {
  const raw = url.search.replace(/^\?/, "")
  if (!raw) return ""
  const pairs = raw.split("&").map((part) => {
    const eq = part.indexOf("=")
    return eq < 0
      ? ([part, ""] as [string, string])
      : ([part.slice(0, eq), part.slice(eq + 1)] as [string, string])
  })
  const filtered = pairs.filter(
    ([k]) => !(excludeSignature && k.toLowerCase() === "x-amz-signature"),
  )
  filtered.sort(([ak, av], [bk, bv]) => {
    if (ak !== bk) return ak < bk ? -1 : 1
    if (av === bv) return 0
    return av < bv ? -1 : 1
  })
  return filtered.map(([k, v]) => `${k}=${v}`).join("&")
}

async function expectedSignature(
  opts: {
    method: string
    canonicalUri: string
    canonicalQuery: string
    canonicalHeaders: string
    signedHeaders: string
    payloadHash: string
    amzDate: string
    dateStamp: string
    region?: string
  },
): Promise<string> {
  const region = opts.region || REGION
  const canonicalRequest = [
    opts.method,
    opts.canonicalUri,
    opts.canonicalQuery,
    opts.canonicalHeaders,
    opts.signedHeaders,
    opts.payloadHash,
  ].join("\n")
  const scope = `${opts.dateStamp}/${region}/s3/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    opts.amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n")
  const key = await getSigningKey(SK, opts.dateStamp, region, "s3")
  return await hmacSha256Hex(key, stringToSign)
}

/** 服务端视角校验预签名 URL */
async function assertPresignedUrlVerifies(wireUrl: string, label: string) {
  const url = new URL(wireUrl)
  assert.ok(
    !url.search.includes("+"),
    `${label}：wire query 不得出现 form 编码的 "+"：${url.search}`,
  )

  const signature = url.searchParams.get("X-Amz-Signature")
  assert.ok(signature, `${label}：预签名 URL 必须带 X-Amz-Signature`)

  const amzDate = url.searchParams.get("X-Amz-Date")!
  const credential = url.searchParams.get("X-Amz-Credential")!
  const scopeParts = credential.split("/")
  assert.equal(scopeParts.length, 5, `${label}：X-Amz-Credential 结构异常`)

  const expected = await expectedSignature({
    method: "GET",
    canonicalUri: url.pathname,
    canonicalQuery: wireCanonicalQuery(url, true),
    canonicalHeaders: `host:${url.host}\n`,
    signedHeaders: "host",
    payloadHash: "UNSIGNED-PAYLOAD",
    amzDate,
    dateStamp: scopeParts[1],
    region: scopeParts[2],
  })

  assert.equal(
    signature,
    expected,
    `${label}：按 wire URL 重算的签名与 URL 内签名不一致（服务端会 403）`,
  )
}

test("F-148：getUrl 的 query 按 RFC 3986 编码（空格 %20、字面 + %2B）", () => {
  const client = new S3Client({
    bucket: "mybucket",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    access_key_id: AK,
    secret_access_key: SK,
  })

  const url = client.getUrl("", { prefix: "my docs/", delimiter: "/" })
  assert.ok(
    url.includes("prefix=my%20docs%2F"),
    `prefix 中的空格必须编成 %20，实际：${url}`,
  )
  assert.ok(!url.includes("my+docs"), `不得出现 form 编码的 +，实际：${url}`)

  // 字面 "+" 必须编成 %2B（而不是被服务端当成空格）
  const plusUrl = client.getUrl("", { prefix: "a+b/" })
  assert.ok(
    plusUrl.includes("prefix=a%2Bb%2F"),
    `字面 + 必须编成 %2B，实际：${plusUrl}`,
  )
})

test("F-148：预签名 URL（含空格值）可被服务端重算校验通过", async () => {
  const base = "https://mybucket.s3.us-east-1.amazonaws.com/test.txt"

  // ① 普通预签名
  const plain = await presignS3Url({
    url: base,
    region: REGION,
    accessKeyId: AK,
    secretAccessKey: SK,
    expiresInSeconds: 3600,
    date: new Date("2026-08-22T12:30:45Z"),
  })
  await assertPresignedUrlVerifies(plain, "普通预签名")

  // ② 带 response-content-disposition（值里必然含空格，原实现 wire "+" vs 签名 "%20"）
  const withDisposition = await presignS3Url({
    url: base,
    region: REGION,
    accessKeyId: AK,
    secretAccessKey: SK,
    expiresInSeconds: 3600,
    date: new Date("2026-08-22T12:30:45Z"),
    customQueryParams: {
      "response-content-disposition": `attachment; filename="a b.txt"; filename*=UTF-8''a%20b.txt`,
    },
  })
  await assertPresignedUrlVerifies(withDisposition, "带 disposition 的预签名")
  assert.ok(
    withDisposition.includes("%20") && !withDisposition.includes("+"),
    `disposition 中的空格必须保持 %20，实际：${withDisposition}`,
  )
})

test("F-148：S3Client.getLink 的直链签名与 wire 一致", async () => {
  const client = new S3Client({
    bucket: "mybucket",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    access_key_id: AK,
    secret_access_key: SK,
  })

  const link = await client.getLink("my docs/a b.txt", "a b.txt", 4, "", false, false, true)
  await assertPresignedUrlVerifies(link.url, "getLink")
  assert.ok(
    link.url.includes("response-content-disposition=attachment%3B%20filename%3D"),
    `disposition 必须以 %20 编码空格，实际：${link.url}`,
  )
})

test("F-148：签名后的请求头与 wire URL 一致（signS3Headers）", async () => {
  const client = new S3Client({
    bucket: "mybucket",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    access_key_id: AK,
    secret_access_key: SK,
    force_path_style: true,
  })
  const wireUrl = client.getUrl("", { prefix: "my docs/", delimiter: "/" })
  const fixedDate = new Date("2026-08-22T12:30:45Z")

  const signed = await signS3Headers({
    method: "GET",
    url: wireUrl,
    region: REGION,
    accessKeyId: AK,
    secretAccessKey: SK,
    date: fixedDate,
  })

  const url = new URL(signed.url)
  assert.ok(!url.search.includes("+"), `wire query 不得含 "+"：${url.search}`)

  const auth = signed.headers["authorization"]
  const match = auth.match(
    /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/,
  )
  assert.ok(match, `Authorization 头格式异常：${auth}`)
  const [, credential, signedHeaderNames, signature] = match!
  const scopeParts = credential.split("/")

  const canonicalHeaders = signedHeaderNames
    .split(";")
    .map((name) => `${name}:${(signed.headers[name] || "").trim().replace(/\s+/g, " ")}\n`)
    .join("")

  const expected = await expectedSignature({
    method: "GET",
    canonicalUri: url.pathname,
    canonicalQuery: wireCanonicalQuery(url),
    canonicalHeaders,
    signedHeaders: signedHeaderNames,
    payloadHash: signed.headers["x-amz-content-sha256"],
    amzDate: signed.headers["x-amz-date"],
    dateStamp: scopeParts[1],
  })

  assert.equal(
    signature,
    expected,
    "Authorization 签名必须能由实际发送的 URL/头重算出来（否则服务端 403）",
  )
})
