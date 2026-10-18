import { Hono } from "hono"
import { authUserFromReq } from "./auth"
import {
  listItems,
  getItem,
  putItem,
  removeItems,
} from "../internal/op/storage"
import { safeErrorMessage } from "../pkg/errs"
import {
  exceedsUploadLimit,
  overLimitResponse,
  readBodyBytesLimited,
} from "../pkg/body_limit"
import { canWrite, canRemove, getActualPath } from "../pkg/permission"
import { canAccess, getNearestMeta } from "../pkg/meta"

/**
 * S3 网关（简化版，挂载于 /s3/*）。
 *
 * 协议：支持 ListBuckets / GetObject / HeadObject / PutObject / DeleteObject，
 * 认证采用 Bearer token（与全局 token 一致）；完整 AWS SigV4 签名验证作为
 * 后续增强（Worker 环境 S3 网关性能受限，优先保证 API 契约一致）。
 *
 * URL 结构：/s3/{bucket}/{objectKey}，bucket 映射到存储挂载路径。
 *
 * 权限：与 /fs/* 走同一套原语——路径先按用户 base_path 映射（`..` 弹不出自己
 * 的根），写操作要求 WRITE_CONTENT，读操作套用 meta 的密码 / read_users。此前
 * 这里只判「有没有登录」，等于给任何普通账号开了一个绕过隔离的第二套文件接口。
 */

export const s3Router = new Hono()

function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function s3Error(code: string, message: string, status: number) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(message)}</Message></Error>`
  return new Response(xml, {
    status,
    headers: { "Content-Type": "application/xml", "x-amz-request-id": "-" },
  })
}

/** 从 pathname 剥离 /s3 前缀，解析 { bucket, key } */
function parseS3Path(c: any): { bucket: string; key: string } {
  const pathname = new URL(c.req.url).pathname
  const p = pathname.replace(/^\/s3\/?/, "")
  const parts = p.split("/").filter(Boolean)
  const bucket = parts[0] || ""
  const key = parts.slice(1).map(decodeURIComponent).join("/")
  return { bucket, key }
}

/** bucket 名 → 挂载路径（bucket 即存储挂载点的首段） */
function bucketToPath(bucket: string): string {
  if (!bucket) return "/"
  return "/" + bucket
}

async function authUser(c: any): Promise<any | null> {
  const auth = await authUserFromReq(c)
  return auth ? auth.user : null
}

/** bucket + objectKey → 用户的虚拟路径，并按其 base_path 收敛（越界的 .. 会被钳制） */
function s3VirtualPath(user: any, bucket: string, key: string): string {
  return getActualPath(user, `${bucketToPath(bucket)}/${key}`)
}

/** 读侧 meta 门禁：密码 / read_users 与 /fs/list、/fs/get 保持一致 */
async function isReadable(
  c: any,
  user: any,
  virtualPath: string,
): Promise<boolean> {
  try {
    const meta = await getNearestMeta(virtualPath, c.env)
    return canAccess(user, meta, virtualPath, "")
  } catch {
    return false
  }
}

const getCtx = (c: any, user?: any) => {
  // 与 /fs/*、/dav/* 一致：把请求身份交给存储层，套用 meta write_users
  const ctx: any = { env: c.env, user: user ?? null }
  try {
    const ec = c.executionCtx
    if (ec && typeof ec.waitUntil === "function") {
      ctx.waitUntil = (p: Promise<unknown>) => ec.waitUntil(p)
    }
  } catch {
    // 无 executionCtx：仅缺少 waitUntil
  }
  return ctx
}

// GET /s3/ → ListBuckets
s3Router.get("/", async (c) => {
  const user = await authUser(c)
  if (!user) return s3Error("AccessDenied", "Authentication required", 403)
  try {
    const res = await listItems(getActualPath(user, "/"), getCtx(c, user))
    const buckets = (res.content || [])
      .filter((it: any) => it.is_dir)
      .map(
        (it: any) =>
          `  <Bucket><Name>${xmlEscape(it.name)}</Name><CreationDate>${xmlEscape(it.modified || new Date().toISOString())}</CreationDate></Bucket>`,
      )
      .join("\n")
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner><ID>openlist</ID><DisplayName>openlist</DisplayName></Owner>
  <Buckets>
${buckets}
  </Buckets>
</ListAllMyBucketsResult>`
    return new Response(xml, {
      status: 200,
      headers: { "Content-Type": "application/xml" },
    })
  } catch (e: any) {
    return s3Error("InternalError", safeErrorMessage(e), 500)
  }
})

// GET /s3/{bucket}/{key} → GetObject
s3Router.get("/*", async (c) => {
  const user = await authUser(c)
  if (!user) return s3Error("AccessDenied", "Authentication required", 403)
  const { bucket, key } = parseS3Path(c)
  if (!bucket || !key) return s3Error("NoSuchKey", "NoSuchKey", 404)
  const virtualPath = s3VirtualPath(user, bucket, key)
  if (!(await isReadable(c, user, virtualPath)))
    return s3Error("AccessDenied", "Access denied", 403)
  try {
    const { item, rawUrl } = await getItem(virtualPath, getCtx(c, user))
    if (!item) return s3Error("NoSuchKey", "NoSuchKey", 404)
    if (item.is_dir) return s3Error("NoSuchKey", "NoSuchKey", 404)
    if (rawUrl) {
      return c.redirect(rawUrl, 302)
    }
    return s3Error("NoSuchKey", "NoSuchKey", 404)
  } catch (e: any) {
    return s3Error("NoSuchKey", safeErrorMessage(e), 404)
  }
})

// HEAD /s3/{bucket}/{key} → HeadObject
s3Router.on("HEAD", "/*", async (c) => {
  const user = await authUser(c)
  if (!user) return s3Error("AccessDenied", "Authentication required", 403)
  const { bucket, key } = parseS3Path(c)
  if (!bucket || !key) return s3Error("NoSuchKey", "NoSuchKey", 404)
  const headPath = s3VirtualPath(user, bucket, key)
  if (!(await isReadable(c, user, headPath)))
    return s3Error("AccessDenied", "Access denied", 403)
  try {
    const { item } = await getItem(headPath, getCtx(c, user))
    if (!item || item.is_dir) return s3Error("NoSuchKey", "NoSuchKey", 404)
    const headers: Record<string, string> = {
      "Content-Length": String(item.size || 0),
      "Content-Type": String(item.type || "application/octet-stream"),
      "Last-Modified": item.modified || new Date().toISOString(),
    }
    return new Response(null, { status: 200, headers })
  } catch {
    return s3Error("NoSuchKey", "NoSuchKey", 404)
  }
})

// PUT /s3/{bucket}/{key} → PutObject
s3Router.put("/*", async (c) => {
  const user = await authUser(c)
  if (!user) return s3Error("AccessDenied", "Authentication required", 403)
  const { bucket, key } = parseS3Path(c)
  if (!bucket || !key)
    return s3Error("InvalidArgument", "Invalid bucket/key", 400)
  if (!canWrite(user))
    return s3Error("AccessDenied", "Write permission required", 403)
  const putPath = s3VirtualPath(user, bucket, key)
  const earlyTooLarge = exceedsUploadLimit(c)
  if (earlyTooLarge !== null)
    return s3Error(
      "EntityTooLarge",
      `File too large (max ${earlyTooLarge} bytes)`,
      413,
    )
  try {
    const { bytes, tooLarge: bodyTooLarge } = await readBodyBytesLimited(c)
    if (bodyTooLarge !== null)
      return s3Error(
        "EntityTooLarge",
        `File too large (max ${bodyTooLarge} bytes)`,
        413,
      )
    const buffer = Buffer.from(bytes)
    const tooLarge = overLimitResponse(c, buffer.byteLength)
    if (tooLarge) return tooLarge
    await putItem(putPath, buffer, getCtx(c, user))
    return new Response(null, {
      status: 200,
      headers: { ETag: `"${Date.now().toString(16)}"` },
    })
  } catch (e: any) {
    return s3Error("InternalError", safeErrorMessage(e), 500)
  }
})

// DELETE /s3/{bucket}/{key} → DeleteObject
s3Router.delete("/*", async (c) => {
  const user = await authUser(c)
  if (!user) return s3Error("AccessDenied", "Authentication required", 403)
  const { bucket, key } = parseS3Path(c)
  if (!bucket || !key)
    return s3Error("InvalidArgument", "Invalid bucket/key", 400)
  if (!canRemove(user))
    return s3Error("AccessDenied", "Delete permission required", 403)
  // 先映射到用户根目录再拆 dir/name，删除才不可能落到别人的目录下
  const delPath = s3VirtualPath(user, bucket, key)
  const idx = delPath.lastIndexOf("/")
  const dir = idx > 0 ? delPath.slice(0, idx) : "/"
  const name = delPath.slice(idx + 1)
  if (!name) return s3Error("InvalidArgument", "Invalid bucket/key", 400)
  try {
    await removeItems(dir, [name], getCtx(c, user))
    return new Response(null, { status: 204 })
  } catch (e: any) {
    return s3Error("NoSuchKey", safeErrorMessage(e), 404)
  }
})
