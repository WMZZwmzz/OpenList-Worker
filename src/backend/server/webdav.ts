import { Hono } from "hono"
import { authUserFromReq, getOrInitUsers, verifyUserPassword } from "./auth"
import { AUTHED_USER_KEY } from "./middlewares"
import { getDb } from "../internal/model/db"
import {
  can,
  canSeeHides,
  canWrite,
  getActualPath,
  PermissionBit,
} from "../pkg/permission"
import {
  canAccess,
  canWrite as canWriteMeta,
  getNearestMeta,
  isHidden,
} from "../pkg/meta"
import {
  listItems,
  getItem,
  putItem,
  makeDirectory,
  removeItems,
  moveItems,
  copyItems,
} from "../internal/op/storage"
import { buildWebDavPropfindResponse } from "../internal/webdav/webdav"
import { safeErrorMessage } from "../pkg/errs"
import {
  getUploadSizeLimit,
  readBodyBytesLimited,
} from "../pkg/body_limit"
import { encodeDownloadPath } from "../pkg/path"

/**
 * WebDAV 协议服务（挂载于 /dav/*）。
 *
 * 认证：Basic Auth（用户名/密码）或 Bearer token（全局 token）。
 * 权限：WEBDAV_READ（读/列目录）与 WEBDAV_MANAGE（写/删/移动/复制）按位校验；
 * 此外与 /fs/* 共用同一套路径与 meta 原语——请求路径先按用户 base_path 映射
 * （`..` 弹不出自己的根目录），读套 meta 密码 / read_users，写套 write_users。
 * 支持方法：OPTIONS / PROPFIND / GET / HEAD / PUT / MKCOL / DELETE / MOVE / COPY。
 */

export const webdavRouter = new Hono()

const getStorageRequestContext = (c: any, user?: any) => {
  // 同 /fs/*：始终带上 env 与用户，存储层才能套用 meta write_users
  let resolvedUser = user ?? null
  if (!resolvedUser) {
    try {
      resolvedUser = c.get?.(AUTHED_USER_KEY) ?? null
    } catch {}
  }
  const ctx: any = { env: c.env, user: resolvedUser }
  try {
    const executionCtx = c.executionCtx
    if (executionCtx && typeof executionCtx.waitUntil === "function") {
      ctx.waitUntil = (p: Promise<unknown>) => executionCtx.waitUntil(p)
    }
  } catch {
    // 无 executionCtx：仅缺少 waitUntil
  }
  return ctx
}

/** Basic Auth 或 Bearer token 认证，返回用户对象（未认证返回 null） */
async function webdavAuth(c: any): Promise<any> {
  const authHeader = c.req.header("Authorization") || ""
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.substring(6).trim())
      const idx = decoded.indexOf(":")
      if (idx < 0) return null
      const username = decoded.substring(0, idx)
      const password = decoded.substring(idx + 1)
      const { users } = await getOrInitUsers(c.env)
      const user = users.find(
        (u: any) => u.username === username && !u.disabled,
      )
      if (!user) return null
      // 空口令只放行 guest 账号（且游客未被关闭）：安装初始的 admin 同样是空
      // 口令占位，早先「任何空口令账号 + 空密码即通过」等于给未初始化的部署
      // 开了一条免密管理员通道。
      if (!user.password) {
        if (username !== "guest" || password !== "") return null
        const db = await getDb(c.env)
        const allowGuest = (db.settings || []).find(
          (s: any) => s.key === "allow_guest",
        )
        if (allowGuest && String(allowGuest.value ?? "true") === "false")
          return null
        return user
      }
      if (await verifyUserPassword(user, password)) return user
      return null
    } catch {
      return null
    }
  }
  if (authHeader.startsWith("Bearer ")) {
    const auth = await authUserFromReq(c)
    return auth ? auth.user : null
  }
  return null
}

/** 从 URL pathname 中剥离 /dav 前缀，得到虚拟文件路径 */
function davPathOf(c: any): string {
  const pathname = new URL(c.req.url).pathname
  let p = pathname.replace(/^\/dav/, "")
  if (!p) p = "/"
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

/** 拆分虚拟路径为 { dir, name } */
function splitPath(p: string): { dir: string; name: string } {
  const clean = p.startsWith("/") ? p : "/" + p
  const parts = clean.split("/").filter(Boolean)
  const name = parts.pop() || ""
  const dir = "/" + parts.join("/")
  return { dir, name }
}

/** Destination 头 → 剥离 /dav 前缀后的虚拟路径（MOVE / COPY 目标） */
function davDestination(c: any): string {
  const destRaw = c.req.header("Destination") || ""
  try {
    return (
      decodeURIComponent(new URL(destRaw, c.req.url).pathname).replace(
        /^\/dav/,
        "",
      ) || "/"
    )
  } catch {
    return destRaw
  }
}

webdavRouter.all("/*", async (c) => {
  const user = await webdavAuth(c)
  if (!user) {
    return c.text("Unauthorized", 401, {
      "WWW-Authenticate": 'Basic realm="OpenList"',
    })
  }
  const canRead = can(user, PermissionBit.WEBDAV_READ)
  const canManage = can(user, PermissionBit.WEBDAV_MANAGE)
  if (!canRead && !canManage) {
    return c.text("Forbidden", 403)
  }

  const method = c.req.method.toUpperCase()
  const davPath = davPathOf(c)
  // 存储侧真正使用的路径：映射到用户自己的根目录。davPath 仍用于回给客户端的
  // href / 下载链接，避免把 base_path 泄露进 WebDAV 客户端的视图。
  const realPath = getActualPath(user, davPath)
  const metaAt = (p: string) => getNearestMeta(p, c.env).catch(() => null)
  const readable = async (p: string) => canAccess(user, await metaAt(p), p, "")
  const writable = async (p: string) => canWriteMeta(user, await metaAt(p), p)
  const ctx = getStorageRequestContext(c, user)

  try {
    switch (method) {
      case "OPTIONS": {
        c.header("DAV", "1, 2")
        c.header(
          "Allow",
          "OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY",
        )
        c.header("MS-Author-Via", "DAV")
        return c.body(null, 200)
      }

      case "PROPFIND": {
        if (!canRead) return c.text("Forbidden", 403)
        const meta = await metaAt(realPath)
        if (!canAccess(user, meta, realPath, ""))
          return c.text("Forbidden", 403)
        const depth = c.req.header("Depth") || "1"
        const res = await listItems(realPath, ctx)
        const items = (res.content || [])
          .filter(
            (it: any) =>
              canSeeHides(user) || !isHidden(meta, realPath, it.name),
          )
          .map((it: any) => ({
            name: it.name,
            size: it.size || 0,
            isFolder: !!it.is_dir,
            modified: it.modified || new Date().toISOString(),
          }))
        const href =
          davPath === "/"
            ? "/"
            : davPath.endsWith("/")
              ? davPath
              : davPath + "/"
        const xml = buildWebDavPropfindResponse(href, items)
        return c.body(xml, depth === "0" ? 207 : 207, {
          "Content-Type": "application/xml; charset=utf-8",
        })
      }

      case "GET":
      case "HEAD": {
        if (!canRead) return c.text("Forbidden", 403)
        if (!(await readable(realPath))) return c.text("Forbidden", 403)
        const { item, rawUrl } = await getItem(realPath, ctx)
        if (!item) return c.text("Not found", 404)
        if (item.is_dir) return c.text("Is a directory", 400)
        // 重定向到 rawRouter 实际下载；rawRouter 已处理所有驱动的下载协议
        // （proxy/redirect/stream + Range + SSRF 防护）。
        //
        // 端点前缀（/p 还是 /d）与路径编码都由 getItem 决定（见
        // op/storage.ts resolveRawUrlPrefix）：/p 受 Go canProxy() 限制，未开启
        // 代理的存储会 403 proxy not allowed，因此不能在这里硬编码 /p。
        // 回退链接必须用映射后的 realPath：/api/d 不做 base_path 映射，若这里给
        // 客户端可见的 davPath，带 base_path 的用户会跳到一个解析不到的路径。
        return c.redirect(
          rawUrl || `/api/d${encodeDownloadPath(realPath)}`,
          302,
        )
      }

      case "PUT": {
        if (!canManage || !canWrite(user)) return c.text("Forbidden", 403)
        if (!(await writable(realPath))) return c.text("Forbidden", 403)
        const limit = getUploadSizeLimit(c)
        const declared = parseInt(c.req.header("Content-Length") || "0", 10)
        if (declared > limit) return c.text("Request Entity Too Large", 413)
        const { bytes, tooLarge: bodyTooLarge } =
          await readBodyBytesLimited(c)
        if (bodyTooLarge !== null)
          return c.text("Request Entity Too Large", 413)
        const buffer = Buffer.from(bytes)
        // 无 Content-Length（分块传输）时按实际读到的字节数判限
        if (buffer.byteLength > limit)
          return c.text("Request Entity Too Large", 413)
        await putItem(realPath, buffer, ctx)
        return c.body(null, 201)
      }

      case "MKCOL": {
        if (!canManage || !canWrite(user)) return c.text("Forbidden", 403)
        if (!(await writable(realPath))) return c.text("Forbidden", 403)
        await makeDirectory(realPath, ctx)
        return c.body(null, 201)
      }

      case "DELETE": {
        if (!canManage || !canWrite(user)) return c.text("Forbidden", 403)
        if (!(await writable(realPath))) return c.text("Forbidden", 403)
        const { dir, name } = splitPath(realPath)
        await removeItems(dir, [name], ctx)
        return c.body(null, 204)
      }

      case "MOVE": {
        if (!canManage || !canWrite(user)) return c.text("Forbidden", 403)
        const dstPath = getActualPath(user, davDestination(c))
        if (!(await writable(realPath)) || !(await writable(dstPath)))
          return c.text("Forbidden", 403)
        const src = splitPath(realPath)
        const dst = splitPath(dstPath)
        await moveItems(src.dir, dst.dir, [src.name], ctx)
        return c.body(null, 201)
      }

      case "COPY": {
        if (!canManage || !canWrite(user)) return c.text("Forbidden", 403)
        const dstPath = getActualPath(user, davDestination(c))
        if (!(await writable(realPath)) || !(await writable(dstPath)))
          return c.text("Forbidden", 403)
        const src = splitPath(realPath)
        const dst = splitPath(dstPath)
        await copyItems(src.dir, dst.dir, [src.name], ctx)
        return c.body(null, 201)
      }

      case "LOCK":
      case "UNLOCK":
        // 简化实现：声明不支持锁，客户端通常可继续无锁操作
        return c.text("Locking not supported", 405)

      default:
        return c.text("Method Not Allowed", 405)
    }
  } catch (e: any) {
    const msg = safeErrorMessage(e)
    if (msg.includes("not found") || msg.includes("storage not found")) {
      return c.text("Not Found", 404)
    }
    return c.text(msg, 500)
  }
})
