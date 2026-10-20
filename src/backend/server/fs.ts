import { Hono } from "hono"
import {
  flushPendingDriverState,
  listItems,
  getItem,
  makeDirectory,
  renameItem,
  removeItems,
  moveItems,
  copyItems,
  putItem,
  getDriver,
} from "../internal/op/storage"
import { resolveShare, shareClientKey } from "../internal/op/share"
import { resolvePath } from "../internal/model/db"
import { AUTHED_USER_KEY, getUserFromContext } from "./middlewares"
import {
  can,
  canSeeHides,
  canWrite,
  canRename,
  canMove,
  canCopy,
  canRemove,
  getActualPath,
  isAdmin,
  PermissionBit,
} from "../pkg/permission"
import {
  getNearestMeta,
  canAccess,
  getReadme,
  getHeader,
  canWriteContentBypassUserPerms,
  isHidden,
  isSafeHidePattern,
  canWrite as canWriteMeta,
} from "../pkg/meta"
import type { Meta } from "../pkg/meta"
import {
  getSignPolicy,
  signDownloadPath,
  needDownloadSign,
  getSignExpiresIn,
} from "../pkg/sign"
import { safeErrorMessage } from "../pkg/errs"
import {
  exceedsUploadLimit,
  getUploadSizeLimit,
  overLimitResponse,
  readBodyBytesLimited,
  readFormDataLimited,
} from "../pkg/body_limit"
import {
  collapsePathSegments,
  decodePathFully,
  encodeDownloadPath,
  hasParentSegment,
  safeDecodeComponent,
} from "../pkg/path"
import { search } from "../internal/op/search"
import {
  getDisableIndex,
  resolveCacheExpiration,
} from "../internal/driver/storageopts"
import { parseZip, extractZipEntry, ZipArchive } from "../internal/archive/zip"
import { assertSafeUrl, getTrustedHosts, isBrowserUnsafeUrl } from "../pkg/http"
import { seedRouter } from "./seed"

/**
 * 该路径所属存储是否禁止目录列表（对齐 Go handles.FsList 的 DisableIndex 判断）。
 * 存储无法解析时返回 false，避免误伤虚拟目录。
 */
async function isStorageIndexDisabled(reqPath: string): Promise<boolean> {
  try {
    const resolved = await resolvePath(reqPath)
    if (!resolved?.storage) return false
    return getDisableIndex(resolved.storage)
  } catch {
    return false
  }
}
import {
  clampChunkSize,
  deleteSession,
  findReceivingSession,
  getSession,
  MAX_TOTAL_CHUNKS,
  MAX_UPLOAD_BYTES,
  MultipartSession,
  newUploadId,
  pruneSessions,
  putSession,
  snapshot as mpSnapshot,
} from "../internal/upload/multipart"

/** 分片上传会话的归属标识（upload_id 本身不是能力凭证） */
function uploadOwner(user: any): string {
  return `${user?.id ?? ""}:${user?.username ?? ""}`
}

function sessionBelongsTo(session: MultipartSession | undefined, user: any) {
  if (!session) return false
  if (!session.owner) return true
  return session.owner === uploadOwner(user)
}

export const fsRouter = new Hono()
fsRouter.route("/seed", seedRouter)

/**
 * 批量重命名单次处理的文件数上限。
 *
 * 正则本身的安全性由 pkg/meta 的 isSafeHidePattern 保证（拒绝 ReDoS 形状），
 * 这里限制的是「量」：超大目录下每个 rename 都是一次远程驱动调用，不限量
 * 就等于给一个 RENAME 权限请求无限期的执行时间。
 */
const REGEX_RENAME_MAX_FILES = 500

const getStorageRequestContext = (c: any) => {
  // 始终返回上下文对象：存储写入层要靠它拿到本次请求的已认证用户，才能套用
  // 目录 meta 的 write_users 白名单（旧实现在没有 executionCtx 时返回 undefined，
  // 于是 self-hosted 模式下所有 meta 写限制形同不存在）。
  let user: any = null
  try {
    user = c.get?.(AUTHED_USER_KEY) ?? null
  } catch {}
  const ctx: any = { env: c.env, user }
  try {
    const executionCtx = c.executionCtx
    if (executionCtx && typeof executionCtx.waitUntil === "function") {
      ctx.waitUntil = (promise: Promise<unknown>) =>
        executionCtx.waitUntil(promise)
    }
  } catch {
    // 无 executionCtx：仅缺少 waitUntil
  }
  return ctx
}

// ---- 写操作权限校验 ----
// 游客（未登录 / 无凭证 / token 无效）一律 403，普通用户需具备
// WRITE_CONTENT 权限位，管理员放行。修复「任何人可匿名上传/删除文件」
// 的安全漏洞，同时让 /fs/list 的 write 字段如实反映请求者身份。
const permissionDenied = (c: any) =>
  c.json({ code: 403, message: "Permission denied", data: null }, 403)

/**
 * 写路径的 meta.write_users 门禁。
 *
 * 存储 op 层（putItem/makeDirectory/...）已经统一套了这道闸，但分片上传、
 * 直传预签名、驱动 `other` 这类**绕过 op 层直接调用驱动**的入口必须自己补上，
 * 否则知道路径的用户可以绕开目录管理员配置的 write_users。
 */
async function metaWritable(
  c: any,
  user: any,
  virtualPath: string,
): Promise<boolean> {
  try {
    const meta = await getNearestMeta(virtualPath, c.env)
    return canWriteMeta(user, meta, virtualPath)
  } catch {
    // meta 读取失败时 fail-closed：写入比读取更危险，宁可拒绝
    return false
  }
}

/**
 * 分享浏览也必须服从目录 meta 的密码 / read_users。
 *
 * 创建分享时只能证明「创建者当时可读」，不能替代访问时的权限判定：分享创建后
 * 仍可能新增密码、收紧 read_users，或分享指向一个 meta 保护的父目录。这里用
 * 请求里的 password（与分享提取码共用同一字段）做校验，读不到就拒绝。
 */
async function canReadSharePath(
  c: any,
  user: any,
  virtualPath: string,
  password: string,
): Promise<boolean> {
  try {
    const meta = await getNearestMeta(virtualPath, c.env)
    return canAccess(user, meta, virtualPath, password)
  } catch {
    return false
  }
}

// ---- 上传大小限制（M-5）----
// 上限判定与 413 响应统一放在 pkg/body_limit.ts，供 /fs/*、/dav/*、/s3/* 共用。

// 分享请求错误统一出口：
// - 密码错误 → 403，前端据此弹出提取码输入框（State.NeedPassword）
// - 其他（不存在/禁用/过期/超次数/为空）→ 400，前端显示友好提示
const shareErrorResponse = (c: any, error?: string) => {
  const isWrongPassword = error === "wrong password"
  const msg = error || "share error"
  return c.json(
    {
      code: isWrongPassword ? 403 : 400,
      message: msg,
      data: null,
    },
    isWrongPassword ? 403 : 400,
  )
}

// GET sub-directories of a path (used by FolderTree in metas/storages editors)
fsRouter.post("/dirs", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const user = await getUserFromContext(c)
  const rawPath = body.path || "/"
  const isShare = rawPath.startsWith("/@s")
  if (!isShare && (!user || user.disabled)) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const requestContext = getStorageRequestContext(c)
  let reqPath = rawPath
  if (!body.force_root || !isAdmin(user)) {
    reqPath = getActualPath(user, reqPath)
  }
  try {
    // Share path support for completeness
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(
        reqPath,
        body.password || "",
        c.env,
        shareClientKey(c),
      )
      if (!shareRes.ok) {
        return shareErrorResponse(c, shareRes.error)
      }
      if (shareRes.virtualList) {
        const dirs = []
        for (const f of shareRes.share.files || []) {
          if (!(await canReadSharePath(c, user, f, body.password || "")))
            continue
          try {
            const { item } = await getItem(f, requestContext)
            if (item.is_dir) {
              const segs = String(f).split("/").filter(Boolean)
              dirs.push({
                name: segs[segs.length - 1] || f,
                modified: item.modified || new Date().toISOString(),
              })
            }
          } catch {
            // skip unlistable share items
          }
        }
        return c.json({ code: 200, message: "success", data: dirs })
      }
      if (
        !(await canReadSharePath(
          c,
          user,
          shareRes.realPath!,
          body.password || "",
        ))
      ) {
        return c.json(
          { code: 403, message: "Access denied", data: null },
          403,
        )
      }
      const { content } = await listItems(shareRes.realPath!, requestContext)
      const dirs = content
        .filter((item: any) => item.is_dir)
        .map((item: any) => ({
          name: item.name,
          modified: item.modified || new Date().toISOString(),
        }))
      return c.json({ code: 200, message: "success", data: dirs })
    }

    const { content } = await listItems(reqPath, requestContext)
    const dirs = content
      .filter((item: any) => item.is_dir)
      .map((item: any) => ({
        name: item.name,
        modified: item.modified || new Date().toISOString(),
      }))
    return c.json({ code: 200, message: "success", data: dirs })
  } catch (err: any) {
    return c.json({ code: 500, message: safeErrorMessage(err), data: null })
  }
})

fsRouter.post("/list", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const user = await getUserFromContext(c)
  const isShare = (body.path || "/").startsWith("/@s")
  if (!isShare && (!user || user.disabled)) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const requestContext = getStorageRequestContext(c)
  const reqPath = getActualPath(user, body.path || "/")
  const page = parseInt(body.page, 10) || 1
  const perPage = parseInt(body.per_page, 10) || 0

  const paginateItems = <T>(items: T[]) => {
    const total = items.length
    if (perPage <= 0) {
      return { content: items, total }
    }
    const pageNum = Math.max(1, page)
    const start = (pageNum - 1) * perPage
    const end = start + perPage
    return {
      content: items.slice(start, end),
      total,
    }
  }

  try {
    // Share path: /@s/{shareId}/...
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(
        reqPath,
        body.password || "",
        c.env,
        shareClientKey(c),
      )
      if (!shareRes.ok) {
        return shareErrorResponse(c, shareRes.error)
      }

      // Multi-file share root → virtual list of the shared items
      if (shareRes.virtualList) {
        const items = []
        for (const f of shareRes.share.files || []) {
          if (!(await canReadSharePath(c, user, f, body.password || "")))
            continue
          const segs = String(f).split("/").filter(Boolean)
          const name = segs[segs.length - 1] || f
          try {
            const { item } = await getItem(f, requestContext)
            items.push({
              name,
              size: item.size || 0,
              is_dir: !!item.is_dir,
              modified: item.modified || new Date().toISOString(),
              sign: "",
              thumb: item.thumb || "",
              type: item.type ?? 0,
            })
          } catch {
            // If getItem failed, probe by listing — a listable path is a folder
            try {
              await listItems(f, requestContext)
              items.push({
                name,
                size: 0,
                is_dir: true,
                modified: new Date().toISOString(),
                sign: "",
                thumb: "",
                type: 1,
              })
            } catch {
              items.push({
                name,
                size: 0,
                is_dir: false,
                modified: new Date().toISOString(),
                sign: "",
                thumb: "",
                type: 0,
              })
            }
          }
        }
        const { content, total } = paginateItems(items)
        return c.json({
          code: 200,
          message: "success",
          data: {
            content,
            total,
            readme: shareRes.share.readme || "",
            header: shareRes.share.header || "",
            write: false,
            write_content_bypass: false,
            provider: "Share",
          },
        })
      }

      // Mapped to a real path — fall through to normal listing
      if (
        !(await canReadSharePath(
          c,
          user,
          shareRes.realPath!,
          body.password || "",
        ))
      ) {
        return c.json(
          { code: 403, message: "Access denied", data: null },
          403,
        )
      }
      const { content, provider } = await listItems(
        shareRes.realPath!,
        requestContext,
      )
      const normalized = content.map((item: any) => ({
        name: item.name,
        size: item.size,
        is_dir: item.is_dir,
        created: item.created || item.modified || new Date().toISOString(),
        modified: item.modified || new Date().toISOString(),
        sign: item.sign || "",
        thumb: item.thumb || "",
        type: item.type ?? 0,
      }))
      const { content: pagedContent, total } = paginateItems(normalized)
      return c.json({
        code: 200,
        message: "success",
        data: {
          content: pagedContent,
          total,
          readme: shareRes.share.readme || "",
          header: shareRes.share.header || "",
          write: false,
          write_content_bypass: false,
          provider,
        },
      })
    }

    // 普通路径：应用 meta 权限（密码 + read_users + readme/header + hide 过滤）
    const meta = await getNearestMeta(reqPath, c.env)
    if (!canAccess(user, meta, reqPath, body.password || "")) {
      return c.json(
        {
          code: 403,
          message: "Access denied (wrong password or not in read_users)",
          data: null,
        },
        403,
      )
    }

    // disable_index（对齐 Go handles.FsList）：该存储禁止目录列表时，
    // 即使有读权限也不返回内容，避免分享单文件后被逐级浏览整个存储。
    if (await isStorageIndexDisabled(reqPath)) {
      return c.json(
        {
          code: 403,
          message: "Index is disabled for this storage",
          data: null,
        },
        403,
      )
    }

    const { content, provider, storage } = await listItems(
      reqPath,
      requestContext,
    )
    // write：用户写权限 + meta.write_users 白名单（对齐 Go common.CanWrite）
    const writable = canWrite(user) && canWriteMeta(user, meta, reqPath)
    const writeContentBypass = canWriteContentBypassUserPerms(meta, reqPath)
    // 下载签名（对齐 Go server/common.Sign + handles.isEncrypt）：
    //   目录不签名；sign_all（或 TS 扩展的 link_expiration）开启、
    //   或该目录被设了密码的 meta 覆盖时，为文件项签发 HMAC 签名。
    // 必须与 raw.ts 的 needDownloadSign 保持对称，否则直链会验签失败。
    // 注意：不能回退 item.sign —— sign 由本层统一签发，驱动不参与
    //（历史上 webdav/autoindex 驱动曾把远程路径/URL 塞进该字段）。
    const signPolicy = await getSignPolicy(c)
    // 必须与 raw.ts 的 needDownloadSign 完全对称：后者把「只有 read_users、
    // 没有密码」的 meta 也纳入必须签名，签发侧若只看密码/sign_all，合法用户
    // 拿不到 sign，下载反而 401。
    const signNeeded = await needDownloadSign(c, reqPath)
    const signExpiresIn = signNeeded
      ? signPolicy.expiresIn || (await getSignExpiresIn(c))
      : 0
    // Normalize each item to the full Obj shape expected by the frontend
    const normalized = await Promise.all(
      content
        // SEE_HIDES 权限位生效：持有者可见隐藏条目（对齐 Go 的 canSeeHides），
        // 其余请求者仍按 meta.hide 过滤
        .filter(
          (item: any) =>
            canSeeHides(user) || !isHidden(meta, reqPath, item.name),
        )
        .map(async (item: any) => {
          const fullPath = `${reqPath}/${item.name}`.replace(/\/{2,}/g, "/")
          const sign =
            !item.is_dir && signNeeded
              ? await signDownloadPath(c, fullPath, signExpiresIn)
              : ""
          // hashinfo / hash_info：从驱动透传哈希信息（Go ObjResp 字段）
          // 驱动不支持时为空字符串/空对象，保持与 Go 响应结构兼容
          const hashInfoStr: string =
            (item as any).hashinfo || (item as any).hash_info_str || ""
          const hashInfo: Record<string, string> = (item as any).hash_info || {}
          return {
            name: item.name,
            size: item.size,
            is_dir: item.is_dir,
            created: item.created || item.modified || new Date().toISOString(),
            modified: item.modified || new Date().toISOString(),
            sign,
            thumb: item.thumb || "",
            type: item.type ?? 0,
            hashinfo: hashInfoStr,
            hash_info: hashInfo,
          }
        }),
    )

    let storagePageSize = 0
    if (storage) {
      storagePageSize = parseInt(storage.page_size, 10) || 0
      if (!storagePageSize && storage.addition) {
        try {
          const addition =
            typeof storage.addition === "string"
              ? JSON.parse(storage.addition)
              : storage.addition
          storagePageSize = parseInt(addition?.page_size, 10) || 0
        } catch {}
      }
    }

    const effectivePerPage =
      perPage > 0 ? perPage : storagePageSize > 0 ? storagePageSize : 0
    const paginateStorageItems = <T>(items: T[]) => {
      const total = items.length
      if (effectivePerPage <= 0) {
        return { content: items, total }
      }
      const pageNum = Math.max(1, page)
      const start = (pageNum - 1) * effectivePerPage
      const end = start + effectivePerPage
      return {
        content: items.slice(start, end),
        total,
      }
    }

    // direct_upload_tools：从 storage 透传支持的直传工具列表（对齐 Go FsListResp）
    // storage 不支持时为空数组，保持与 Go 响应结构兼容
    const directUploadTools: string[] = (() => {
      if (!storage) return []
      const tools: string[] = []
      const driver = storage as any
      // S3 系列驱动支持 s3_presigned 直传
      if (
        /^(s3|minio|cos|oss|r2|b2|cloudflare_r2)/i.test(driver.driver || "")
      ) {
        tools.push("s3_presigned")
      }
      // 驱动自声明的 direct_upload_tools 字段（驱动扩展点）
      if (Array.isArray(driver.direct_upload_tools)) {
        for (const t of driver.direct_upload_tools) {
          if (!tools.includes(t)) tools.push(t)
        }
      }
      return tools
    })()

    const { content: pagedContent, total } = paginateStorageItems(normalized)
    // cache_expiration：由 custom_cache_policies 按路径覆盖后得出（分钟）。
    // 对齐 Go 的路径级缓存策略；前端/上层可据此决定该目录的列表缓存时长。
    const cacheExpiration = storage
      ? resolveCacheExpiration(storage, reqPath)
      : undefined
    return c.json({
      code: 200,
      message: "success",
      data: {
        content: pagedContent,
        total,
        readme: getReadme(meta, reqPath),
        header: getHeader(meta, reqPath),
        write: writable,
        write_content_bypass: writeContentBypass,
        provider,
        direct_upload_tools: directUploadTools,
        page_size: effectivePerPage > 0 ? effectivePerPage : undefined,
        cache_expiration: cacheExpiration,
      },
    })
  } catch (err: any) {
    return c.json({ code: 500, message: safeErrorMessage(err), data: null })
  }
})

fsRouter.post("/get", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const user = await getUserFromContext(c)
  const isShare = (body.path || "/").startsWith("/@s")
  if (!isShare && (!user || user.disabled)) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const requestContext = getStorageRequestContext(c)
  const reqPath = getActualPath(user, body.path || "/")
  try {
    // Share path: /@s/{shareId}/...
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(
        reqPath,
        body.password || "",
        c.env,
        shareClientKey(c),
      )
      if (!shareRes.ok) {
        return shareErrorResponse(c, shareRes.error)
      }

      // Multi-file share root: report as a virtual folder so the frontend lists it
      if (shareRes.virtualList) {
        const shareId = reqPath.split("/").filter(Boolean)[1] || "share"
        return c.json({
          code: 200,
          message: "success",
          data: {
            name: shareId,
            size: 0,
            is_dir: true,
            modified: new Date().toISOString(),
            sign: "",
            thumb: "",
            type: 1,
            raw_url: "",
            readme: shareRes.share.readme || "",
            header: shareRes.share.header || "",
            provider: "Share",
            related: [],
            write: false,
            write_content_bypass: false,
          },
        })
      }

      // Mapped to a real path — get with share-aware raw_url (/sd/{shareId}...)
      const shareId = reqPath.split("/").filter(Boolean)[1] || ""
      if (
        !(await canReadSharePath(
          c,
          user,
          shareRes.realPath!,
          body.password || "",
        ))
      ) {
        return c.json(
          { code: 403, message: "Access denied", data: null },
          403,
        )
      }
      const { item, provider } = await getItem(
        shareRes.realPath!,
        requestContext,
      )
      const subPath = reqPath.replace(/^\/@s\/[^/]+/, "")
      return c.json({
        code: 200,
        message: "success",
        data: {
          name: item.name,
          size: item.size,
          is_dir: item.is_dir,
          created:
            (item as any).created || item.modified || new Date().toISOString(),
          modified: item.modified,
          sign: item.sign || "",
          thumb: (item as any).thumb || "",
          type: item.type ?? 0,
          raw_url: `/api/sd/${shareId}${subPath}`,
          readme: shareRes.share.readme || "",
          header: shareRes.share.header || "",
          provider,
          related: [],
          write: false,
          write_content_bypass: false,
        },
      })
    }

    // 普通路径：应用 meta 权限（密码 + read_users + readme/header）
    const meta = await getNearestMeta(reqPath, c.env)
    if (!canAccess(user, meta, reqPath, body.password || "")) {
      return c.json(
        {
          code: 403,
          message: "Access denied (wrong password or not in read_users)",
          data: null,
        },
        403,
      )
    }

    const { item, provider, rawUrl } = await getItem(reqPath, requestContext)
    // 与 /fs/list 同源逻辑，见上方注释
    const signPolicy = await getSignPolicy(c)
    const signNeeded = await needDownloadSign(c, reqPath)
    const sign =
      !item.is_dir && signNeeded
        ? await signDownloadPath(
            c,
            reqPath,
            signPolicy.expiresIn || (await getSignExpiresIn(c)),
          )
        : ""
    // raw_url 必须自带签名（Issue #66）。
    //
    // 前端把本接口的 raw_url 直接当下载地址使用：预览页的「下载」按钮就是
    // <a href={raw_url}>（pages/home/previews/download.tsx），图片/视频预览也
    // 直接把它塞进 <img>/<video> 的 src，都不会再自己拼 ?sign=。而 raw_url
    // 指向的是需要验签的 /p 或 /d 端点（前缀由 getItem 按 canProxy() 选定）：
    // sign_all、存储级 enable_sign、密码 meta 覆盖任一命中时，缺签名一律
    // 401 "sign verify failed"——外部表现就是「预览页能正常打开，一点下载就 401」。
    //
    // 对齐 Go server/handles/fsread.go FsGet：
    //   if isEncrypt(meta, reqPath) || setting.GetBool(conf.SignAll) {
    //       query = "?sign=" + sign.Sign(reqPath)
    //   }
    //   rawURL = fmt.Sprintf("%s/p%s%s", common.GetApiUrl(c), ..., query)
    const rawUrlWithSign =
      sign && rawUrl && !/[?&]sign=/.test(rawUrl)
        ? `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}sign=${sign}`
        : rawUrl
    // 驱动返回的 raw_url 会直接进浏览器（<img>/<a>）：AutoIndex/第三方网盘
    // 的远端 href 若指向本机/云元数据，不能原样下发。RFC1918 内网仍放行，
    // 避免误伤局域网存储；服务端下载路径另有 assertSafeUrl 全量拦截。
    const browserRawUrl =
      rawUrlWithSign && isBrowserUnsafeUrl(rawUrlWithSign)
        ? ""
        : rawUrlWithSign
    const writable = canWrite(user) && canWriteMeta(user, meta, reqPath)
    const writeContentBypass = canWriteContentBypassUserPerms(meta, reqPath)

    // Related：查找同目录中文件名前缀相同的文件（字幕 .srt/.ass/.vtt、NFO 等）
    // 对齐 Go server/handles/fsread.go getRelated 逻辑：
    //   stem = 去掉最后一个扩展名的文件名；related = 同目录中 stem 相同的其他文件
    let related: any[] = []
    if (!item.is_dir) {
      try {
        const parentPath = reqPath.includes("/")
          ? reqPath.slice(0, reqPath.lastIndexOf("/")) || "/"
          : "/"
        const stem = item.name.includes(".")
          ? item.name.slice(0, item.name.lastIndexOf("."))
          : item.name
        const { content: siblings } = await listItems(
          parentPath,
          requestContext,
        )
        related = siblings
          .filter((s: any) => {
            if (s.name === item.name || s.is_dir) return false
            const sStem = s.name.includes(".")
              ? s.name.slice(0, s.name.lastIndexOf("."))
              : s.name
            return sStem === stem
          })
          .map((s: any) => ({
            name: s.name,
            size: s.size,
            is_dir: false,
            modified: s.modified || new Date().toISOString(),
            sign: "",
            thumb: (s as any).thumb || "",
            type: s.type ?? 0,
          }))
      } catch {
        // 获取关联文件失败不影响主文件响应
        related = []
      }
    }

    return c.json({
      code: 200,
      message: "success",
      data: {
        name: item.name,
        size: item.size,
        is_dir: item.is_dir,
        created:
          (item as any).created || item.modified || new Date().toISOString(),
        modified: item.modified,
        sign,
        thumb: (item as any).thumb || "",
        type: item.type ?? 0,
        raw_url: browserRawUrl,
        readme: getReadme(meta, reqPath),
        header: getHeader(meta, reqPath),
        provider,
        related,
        write: writable,
        write_content_bypass: writeContentBypass,
      },
    })
  } catch (err: any) {
    return c.json({ code: 500, message: safeErrorMessage(err), data: null })
  }
})

function validateFileName(name: any): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Invalid or empty file name")
  }
  const clean = name.trim()
  if (
    clean === "." ||
    clean === ".." ||
    clean.includes("/") ||
    clean.includes("\\") ||
    clean.includes("\0")
  ) {
    throw new Error(`Illegal file name '${clean}'`)
  }
  // 只挡字面 `..`/`/` 不够：文件名随后会经 resolvePath 多重解码，
  // `%2e%2e`、`%2f` 这类写法解码后才变成穿越段，必须在入口就按解码视图拒绝。
  const decoded = decodePathFully(clean)
  if (
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  ) {
    throw new Error(
      `Illegal file name (decodes to a path separator): '${clean}'`,
    )
  }
  if (hasParentSegment(decoded)) {
    throw new Error(`Illegal file name (decodes to '..'): '${clean}'`)
  }
  return clean
}

function validateDirPath(p: any): string {
  if (typeof p !== "string") {
    throw new Error("Path must be a string")
  }
  if (p.includes("\0")) {
    throw new Error("Path contains illegal null byte")
  }
  return p
}

/**
 * child 是否等于 root 或位于 root 之下（纯字符串判定，两侧均为已规范化的
 * 虚拟路径、无尾部斜杠）。用于递归类端点把「驱动返回的条目名」拼进路径后
 * 再做一次兜底检查。
 */
function isSameOrInside(child: string, root: string): boolean {
  const base =
    root.length > 1 && root.endsWith("/") ? root.replace(/\/+$/, "") : root
  if (child === base) return true
  if (base === "/") return child.startsWith("/")
  return child.startsWith(base + "/")
}

fsRouter.post("/mkdir", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const body = await c.req.json().catch(() => ({}))
  const rawPath = body.path || "/"
  try {
    validateDirPath(rawPath)
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const reqPath = getActualPath(user, rawPath)
  const requestContext = getStorageRequestContext(c)
  try {
    await makeDirectory(reqPath, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/rename", async (c) => {
  const user = await getUserFromContext(c)
  if (!canRename(user)) return permissionDenied(c)
  const { path: oldPath, name: newName } = await c.req.json().catch(() => ({}))
  let cleanName = ""
  try {
    validateDirPath(oldPath || "/")
    cleanName = validateFileName(newName)
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const requestContext = getStorageRequestContext(c)
  try {
    const actualOldPath = getActualPath(user, oldPath || "/")
    await renameItem(actualOldPath, cleanName, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/remove", async (c) => {
  const user = await getUserFromContext(c)
  if (!canRemove(user)) return permissionDenied(c)
  const { dir, names } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(names) || names.length === 0) {
    return c.json(
      {
        code: 400,
        message: "Parameter 'names' must be a non-empty array",
        data: null,
      },
      400,
    )
  }
  let cleanNames: string[] = []
  try {
    validateDirPath(dir || "/")
    cleanNames = names.map((n: string) => validateFileName(n))
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const requestContext = getStorageRequestContext(c)
  try {
    const actualDir = getActualPath(user, dir || "/")
    await removeItems(actualDir, cleanNames, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/move", async (c) => {
  const user = await getUserFromContext(c)
  if (!canMove(user)) return permissionDenied(c)
  const { src_dir, dst_dir, names } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(names) || names.length === 0) {
    return c.json(
      {
        code: 400,
        message: "Parameter 'names' must be a non-empty array",
        data: null,
      },
      400,
    )
  }
  let cleanNames: string[] = []
  try {
    validateDirPath(src_dir || "/")
    validateDirPath(dst_dir || "/")
    cleanNames = names.map((n: string) => validateFileName(n))
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const requestContext = getStorageRequestContext(c)
  try {
    const actualSrcDir = getActualPath(user, src_dir || "/")
    const actualDstDir = getActualPath(user, dst_dir || "/")
    await moveItems(actualSrcDir, actualDstDir, cleanNames, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/copy", async (c) => {
  const user = await getUserFromContext(c)
  if (!canCopy(user)) return permissionDenied(c)
  const { src_dir, dst_dir, names } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(names) || names.length === 0) {
    return c.json(
      {
        code: 400,
        message: "Parameter 'names' must be a non-empty array",
        data: null,
      },
      400,
    )
  }
  let cleanNames: string[] = []
  try {
    validateDirPath(src_dir || "/")
    validateDirPath(dst_dir || "/")
    cleanNames = names.map((n: string) => validateFileName(n))
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const requestContext = getStorageRequestContext(c)
  try {
    const actualSrcDir = getActualPath(user, src_dir || "/")
    const actualDstDir = getActualPath(user, dst_dir || "/")
    await copyItems(actualSrcDir, actualDstDir, cleanNames, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.put("/put", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  // L-12：畸形百分号编码返回 400，而不是让 decodeURIComponent 抛成 500
  const rawPath = safeDecodeComponent(c.req.header("File-Path") || "")
  if (rawPath === null) {
    return c.json(
      { code: 400, message: "Bad Request: malformed path encoding", data: null },
      400,
    )
  }
  if (!rawPath.trim()) {
    return c.json(
      { code: 400, message: "Missing File-Path header", data: null },
      400,
    )
  }
  try {
    validateDirPath(rawPath)
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const reqPath = getActualPath(user, rawPath)
  const requestContext = getStorageRequestContext(c)
  const tooLarge = exceedsUploadLimit(c)
  if (tooLarge !== null) {
    return c.json(
      {
        code: 413,
        message: `File too large (max ${tooLarge} bytes)`,
        data: null,
      },
      413,
    )
  }
  try {
    const { bytes, tooLarge: bodyTooLarge } = await readBodyBytesLimited(c)
    if (bodyTooLarge !== null)
      return overLimitResponse(c, bodyTooLarge + 1, false)
    const buffer = Buffer.from(bytes)
    const over = overLimitResponse(c, buffer.byteLength, false)
    if (over) return over
    await putItem(reqPath, buffer, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.put("/form", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  // L-12：畸形百分号编码返回 400，而不是让 decodeURIComponent 抛成 500
  const rawPath = safeDecodeComponent(c.req.header("File-Path") || "")
  if (rawPath === null) {
    return c.json(
      { code: 400, message: "Bad Request: malformed path encoding", data: null },
      400,
    )
  }
  if (!rawPath.trim()) {
    return c.json(
      { code: 400, message: "Missing File-Path header", data: null },
      400,
    )
  }
  try {
    validateDirPath(rawPath)
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  const reqPath = getActualPath(user, rawPath)
  const requestContext = getStorageRequestContext(c)
  const tooLarge = exceedsUploadLimit(c)
  if (tooLarge !== null) {
    return c.json(
      {
        code: 413,
        message: `File too large (max ${tooLarge} bytes)`,
        data: null,
      },
      413,
    )
  }
  try {
    const { form, tooLarge: formTooLarge } = await readFormDataLimited(c)
    if (formTooLarge !== null)
      return overLimitResponse(c, formTooLarge + 1, false)
    if (!form) throw new Error("invalid form data")
    const file = form.get("file")
    if (!file || typeof file === "string") {
      return c.json({
        code: 400,
        message: "missing file in form data",
        data: null,
      })
    }
    const buffer = Buffer.from(await (file as File).arrayBuffer())
    const over = overLimitResponse(c, buffer.byteLength, false)
    if (over) return over
    await putItem(reqPath, buffer, requestContext)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

// ---- 分片会话上传：解决大文件整体缓冲导致的卡死/OOM ----
// 流程：POST /fs/upload/create 建会话 → PUT /fs/upload/part 逐片上传
//      → POST /fs/upload/complete 收尾。每片是独立 HTTP 请求，Worker
//      内存占用恒定，不受 CF Workers 请求体/内存上限约束。

fsRouter.post("/upload/create", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const {
    path: rawPath,
    file_name,
    size,
    md5,
  } = await c.req.json().catch(() => ({}))
  // 根目录上传时调用方可能传 ""，归一化为 "/"
  const dirPath = getActualPath(user, rawPath || "/")
  const requestContext = getStorageRequestContext(c)
  if (!(await metaWritable(c, user, dirPath))) return permissionDenied(c)
  if (!file_name) {
    return c.json({
      code: 400,
      message: "path and file_name are required",
      data: null,
    })
  }
  // L-14：file_name 会被驱动直接拼进对象 key / 分片键名。各驱动自己怎么兜底不可控，
  // 入口必须先过一遍 validateFileName（拒绝 `..`、`/`、`\`、NUL 以及解码后变成
  // 分隔符的写法），与 /fs/get_direct_upload_info 保持一致。
  let safeUploadName: string
  try {
    safeUploadName = validateFileName(file_name)
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  try {
    const resolved = await resolvePath(dirPath)
    if (resolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).createUploadSession !== "function") {
      // 当前存储不支持分片会话上传：返回 null，前端自动回退到流式上传
      return c.json({ code: 200, message: "success", data: null })
    }
    let info
    try {
      info = await (driver as any).createUploadSession(
        dirPath,
        resolved.physical!,
        safeUploadName,
        Number(size) || 0,
        md5 || "",
      )
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    return c.json({ code: 200, message: "success", data: info })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.put("/upload/part", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const session = c.req.header("X-Upload-Session") || ""
  const partNumber = parseInt(c.req.header("X-Part-Number") || "0", 10)
  const rawDirPath = safeDecodeComponent(c.req.header("Upload-Path") || "")
  if (rawDirPath === null) {
    return c.json(
      { code: 400, message: "Bad Request: malformed path encoding", data: null },
      400,
    )
  }
  const dirPath = getActualPath(user, rawDirPath)
  const requestContext = getStorageRequestContext(c)
  if (!(await metaWritable(c, user, dirPath))) return permissionDenied(c)
  if (!session || !(partNumber >= 1) || !dirPath) {
    return c.json({
      code: 400,
      message: "missing X-Upload-Session / X-Part-Number / Upload-Path",
      data: null,
    })
  }
  const tooLarge = exceedsUploadLimit(c, true)
  if (tooLarge !== null) {
    return c.json(
      {
        code: 413,
        message: `Part too large (max ${tooLarge} bytes)`,
        data: null,
      },
      413,
    )
  }
  try {
    const resolved = await resolvePath(dirPath)
    if (resolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).uploadPart !== "function") {
      throw new Error("storage does not support chunked upload")
    }
    const { bytes, tooLarge: bodyTooLarge } = await readBodyBytesLimited(c, true)
    if (bodyTooLarge !== null)
      return overLimitResponse(c, bodyTooLarge + 1, true)
    const buffer = Buffer.from(bytes)
    const overPart = overLimitResponse(c, buffer.byteLength, true)
    if (overPart) return overPart
    let result
    try {
      result = await (driver as any).uploadPart(session, partNumber, buffer)
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    return c.json({ code: 200, message: "success", data: result ?? null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/upload/complete", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const {
    path: rawPath,
    session,
    partMd5s,
  } = await c.req.json().catch(() => ({}))
  // 根目录上传时调用方可能传 ""，归一化为 "/"
  const dirPath = getActualPath(user, rawPath || "/")
  const requestContext = getStorageRequestContext(c)
  if (!(await metaWritable(c, user, dirPath))) return permissionDenied(c)
  if (!session) {
    return c.json({
      code: 400,
      message: "path and session are required",
      data: null,
    })
  }
  try {
    const resolved = await resolvePath(dirPath)
    if (resolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).completeUploadSession !== "function") {
      throw new Error("storage does not support chunked upload")
    }
    try {
      await (driver as any).completeUploadSession(session, partMd5s)
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null })
  }
})

fsRouter.post("/add_offline_download", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const { path: rawPath, urls } = await c.req.json().catch(() => ({}))
  const reqPath = getActualPath(user, rawPath || "/")
  if (!urls || urls.length === 0) {
    return c.json({ code: 400, message: "No URLs provided" })
  }

  return c.json(
    {
      code: 501,
      message:
        "capability unavailable: this runtime has no durable offline-download adapter; use /fs/seed/offline_download with an approved source and a streaming-capable target driver",
      data: { path: reqPath, accepted: 0 },
    },
    501,
  )
})

fsRouter.post("/search", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const body = await c.req.json().catch(() => ({}))
  const parentPath = getActualPath(user, body.parent || "/")
  try {
    const result = await search(
      {
        parent: parentPath,
        keywords: body.keywords || "",
        scope: body.scope !== undefined ? parseInt(body.scope, 10) : 0,
        page: body.page ? parseInt(body.page, 10) : 1,
        per_page: body.per_page ? parseInt(body.per_page, 10) : 30,
        // 搜索走的是 listItems，不经过 /fs/list 的 meta 检查，必须在这里补上，
        // 否则密码目录、read_users 与 hide 规则都会被搜索结果绕过。
        isVisible: async (dir, item) => {
          const p = dir === "/" ? `/${item.name}` : `${dir}/${item.name}`
          const meta = await getNearestMeta(p, c.env).catch(() => null)
          if (!canAccess(user, meta, p, "")) return false
          if (canSeeHides(user)) return true
          return !isHidden(meta, dir, item.name)
        },
      },
      c.env,
    )
    return c.json({ code: 200, message: "success", data: result })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.post("/other", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const body = await c.req.json().catch(() => ({}))
  const reqPath = getActualPath(user, body.path || "/")
  const method = body.method
  if (!method) {
    return c.json(
      { code: 400, message: "Missing required parameter 'method'", data: null },
      400,
    )
  }
  // FIX(H-8): `other` is a driver-specific privileged entry point. S3 uses it
  // to mint presigned direct-upload URLs (s3/driver.ts:371-378), which is a
  // write — it must obey the same gate as /fs/put. Without this, a guest could
  // obtain a direct-upload URL and bypass the upload permission check.
  if (!canWrite(user)) return permissionDenied(c)
  if (!(await metaWritable(c, user, reqPath))) return permissionDenied(c)
  try {
    const resolved = await resolvePath(reqPath)
    if (resolved.isVirtual || !resolved.storage) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage.driver, resolved.storage)
    if (typeof (driver as any).other === "function") {
      const data = await (driver as any).other(method, resolved.relative, body)
      return c.json({ code: 200, message: "success", data })
    }
    return c.json(
      {
        code: 500,
        message: `Driver '${resolved.storage.driver}' does not support other method '${method}'`,
        data: null,
      },
      500,
    )
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- batch_rename / regex_rename（与 Go server/handles/fsbatch.go 对齐）----

fsRouter.post("/batch_rename", async (c) => {
  const user = await getUserFromContext(c)
  if (!canRename(user)) return permissionDenied(c)
  const { src_dir, rename_objects } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(rename_objects) || rename_objects.length === 0) {
    return c.json(
      { code: 400, message: "rename_objects is required", data: null },
      400,
    )
  }
  const dirPath = getActualPath(user, src_dir || "/")
  const requestContext = getStorageRequestContext(c)
  try {
    for (const obj of rename_objects) {
      const srcName = obj?.src_name
      const newName = obj?.new_name
      if (!srcName || !newName) continue
      // src_name 与 new_name 一样是用户输入：只校验目标名会让 `../../x` 通过
      // dirPath 拼接后落到别人的目录下
      validateFileName(srcName)
      validateFileName(newName)
      const fullPath = `${dirPath}/${srcName}`.replace(/\/{2,}/g, "/")
      await renameItem(fullPath, newName, requestContext)
    }
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.post("/regex_rename", async (c) => {
  const user = await getUserFromContext(c)
  if (!canRename(user)) return permissionDenied(c)
  const { src_dir, src_name_regex, new_name_regex } = await c.req
    .json()
    .catch(() => ({}))
  if (!src_name_regex) {
    return c.json(
      { code: 400, message: "src_name_regex is required", data: null },
      400,
    )
  }
  // 用户可控正则直接 new RegExp 是 ReDoS 入口：`(a+)+$` 在 30 字符的文件名上
  // 就能把一个 isolate 的 CPU 打满（RENAME 权限即可触发）。复用 meta.hide 那套
  // 灾难性回溯形状检测（长度上限 256、嵌套量词、反向引用、重叠分支、无界量词数）。
  if (typeof src_name_regex !== "string" || !isSafeHidePattern(src_name_regex)) {
    return c.json(
      {
        code: 400,
        message: "src_name_regex is rejected as unsafe (too long or ReDoS-prone)",
        data: null,
      },
      400,
    )
  }
  if (
    new_name_regex !== undefined &&
    new_name_regex !== null &&
    typeof new_name_regex !== "string"
  ) {
    return c.json(
      { code: 400, message: "new_name_regex must be a string", data: null },
      400,
    )
  }
  const dirPath = getActualPath(user, src_dir || "/")
  const requestContext = getStorageRequestContext(c)
  try {
    const srcRegex = new RegExp(src_name_regex)
    const { content } = await listItems(dirPath, requestContext)
    // 单次处理数量上限：即便正则本身是安全的，超大目录下逐个 rename 也足以
    // 把请求拖到超时（驱动侧每个 rename 都是一次远程调用）。
    let renamed = 0
    for (const item of content) {
      if (renamed >= REGEX_RENAME_MAX_FILES) {
        return c.json(
          {
            code: 400,
            message: `Too many matches; at most ${REGEX_RENAME_MAX_FILES} files per request`,
            data: null,
          },
          400,
        )
      }
      if (!item.is_dir && srcRegex.test(item.name)) {
        const newName = item.name.replace(srcRegex, new_name_regex || "")
        // item.name 来自驱动（可能是攻击者可控的 WebDAV/AutoIndex 存储），
        // 与 newName 一样必须先校验再拼路径。
        validateFileName(item.name)
        validateFileName(newName)
        const fullPath = `${dirPath}/${item.name}`.replace(/\/{2,}/g, "/")
        await renameItem(fullPath, newName, requestContext)
        renamed++
      }
    }
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- recursive_move（与 Go FsRecursiveMove 对齐：递归枚举文件后扁平移动到 dst_dir）----

fsRouter.post("/recursive_move", async (c) => {
  const user = await getUserFromContext(c)
  if (!canMove(user)) return permissionDenied(c)
  const { src_dir, dst_dir, conflict_policy } = await c.req
    .json()
    .catch(() => ({}))
  const srcPath = getActualPath(user, src_dir || "/")
  const dstPath = getActualPath(user, dst_dir || "/")
  const policy = conflict_policy || "overwrite"
  const requestContext = getStorageRequestContext(c)
  try {
    // 预取目标目录现有文件名（用于 cancel/skip 冲突策略）
    let existing = new Set<string>()
    if (policy !== "overwrite") {
      const dst = await listItems(dstPath, requestContext)
      existing = new Set(dst.content.map((f) => f.name))
    }
    const queue: string[] = [srcPath]
    let count = 0
    while (queue.length > 0) {
      const dir = queue.shift()!
      const { content } = await listItems(dir, requestContext)
      for (const item of content) {
        // 条目名由驱动返回（WebDAV / AutoIndex / url_tree 这些存储的内容受
        // 攻击者控制），`../..` 会让队列路径折叠后越出 src_dir 甚至 base_path，
        // 进而把文件移动到别人的目录。同文件其它端点都过了 validateFileName，
        // 唯独这两个递归端点漏了。
        validateFileName(item.name)
        if (item.is_dir) {
          const child = `${dir}/${item.name}`.replace(/\/{2,}/g, "/")
          // 纵深防御：递归目标必须仍在本次请求的源目录之内
          if (!isSameOrInside(child, srcPath)) continue
          queue.push(child)
        } else {
          if (existing.has(item.name)) {
            if (policy === "cancel") {
              return c.json(
                {
                  code: 403,
                  message: `file [${item.name}] exists`,
                  data: null,
                },
                403,
              )
            }
            if (policy === "skip") continue
          }
          if (policy !== "overwrite") existing.add(item.name)
          await moveItems(dir, dstPath, [item.name], requestContext)
          count++
        }
      }
    }
    return c.json({
      code: 200,
      message: `Successfully moved ${count} files`,
      data: null,
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- remove_empty_directory（与 Go FsRemoveEmptyDirectory 对齐）----

fsRouter.post("/remove_empty_directory", async (c) => {
  const user = await getUserFromContext(c)
  if (!canRemove(user)) return permissionDenied(c)
  const { src_dir } = await c.req.json().catch(() => ({}))
  const srcPath = getActualPath(user, src_dir || "/")
  const requestContext = getStorageRequestContext(c)
  try {
    const removeEmptyDirs = async (dir: string): Promise<void> => {
      const { content } = await listItems(dir, requestContext)
      for (const item of content) {
        if (item.is_dir) {
          // 同 recursive_move：驱动返回的条目名必须先校验，否则 `../..` 会让
          // 递归路径折叠到上级目录，随后被当作「空目录」删掉。
          validateFileName(item.name)
          const child = `${dir}/${item.name}`.replace(/\/{2,}/g, "/")
          if (!isSameOrInside(child, srcPath)) continue
          await removeEmptyDirs(child)
        }
      }
      if (dir === srcPath) return // 不删除根目录本身
      const after = await listItems(dir, requestContext)
      if (after.content.length === 0) {
        // 用最后一段分隔符派生 parent/name（不再靠 split("/") 后拼回字符串），
        // 并对 name 复校验一次：删除动作本身不可逆，不能带上可疑段。
        const slash = dir.lastIndexOf("/")
        const parent = slash <= 0 ? "/" : dir.slice(0, slash)
        const name = dir.slice(slash + 1)
        validateFileName(name)
        await removeItems(parent, [name], requestContext)
      }
    }
    await removeEmptyDirs(srcPath)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- link（与 Go Link 对齐，admin 权限，返回真实直链）----

fsRouter.post("/link", async (c) => {
  const user = await getUserFromContext(c)
  if (!isAdmin(user)) return permissionDenied(c)
  const { path } = await c.req.json().catch(() => ({}))
  const reqPath = getActualPath(user, path || "/")
  const requestContext = getStorageRequestContext(c)
  try {
    const resolved = await resolvePath(reqPath)
    if (resolved.isVirtual || !resolved.storage) {
      return c.json(
        { code: 500, message: "storage not found", data: null },
        500,
      )
    }
    const driver = await getDriver(resolved.storage.driver, resolved.storage)
    try {
      const item = await driver.get(reqPath, resolved.physical ?? "/")
      if (item && item.raw_url) {
        return c.json({
          code: 200,
          message: "success",
          data: { url: item.raw_url },
        })
      }
    } finally {
      await flushPendingDriverState(
        resolved.storage.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    // 无直链（如本地/加密驱动）：返回代理下载地址。
    //
    // 对齐 Go server/handles/fsmanage.go Link：
    //   fmt.Sprintf("%s/p%s?d&sign=%s", GetApiUrl(c), EncodePath(rawPath, true), sign.Sign(rawPath))
    // 即路径逐段编码 + **无条件**带签名（Go 不看 needSign；这里同样补齐，
    // 否则在 sign_all / enable_sign / 密码 meta 生效时复制出来的链接必然 401）。
    // 「?d」（强制 attachment 下载）TS 侧无对应语义，故不追加。
    const sign = await signDownloadPath(c, reqPath, await getSignExpiresIn(c))
    return c.json({
      code: 200,
      message: "success",
      data: {
        url: `/api/p${encodeDownloadPath(reqPath)}?sign=${encodeURIComponent(sign)}`,
      },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- get_direct_upload_info（与 Go FsGetDirectUploadInfo 对齐）----

fsRouter.post("/get_direct_upload_info", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)
  const { path, file_name, file_size } = await c.req.json().catch(() => ({}))
  const reqPath = getActualPath(user, path || "/")
  if (!(await metaWritable(c, user, reqPath))) return permissionDenied(c)
  // file_name 会被驱动直接拼进对象 key 并参与预签名（S3 的 getKey 只剥前导
  // 斜杠，不折叠 `..`）：不校验就能签出目标目录之外的 PUT URL。
  let safeFileName: string
  try {
    safeFileName = validateFileName(file_name)
  } catch (e: any) {
    return c.json({ code: 400, message: e.message, data: null }, 400)
  }
  try {
    const resolved = await resolvePath(reqPath)
    if (resolved.isVirtual || !resolved.storage) {
      return c.json({ code: 200, message: "success", data: null })
    }
    const driver = await getDriver(resolved.storage.driver, resolved.storage)
    const d = driver as any
    // 优先使用驱动的直传能力
    if (typeof d.getDirectUploadInfo === "function") {
      const info = await d.getDirectUploadInfo(
        resolved.relative,
        safeFileName,
        file_size,
      )
      return c.json({ code: 200, message: "success", data: info })
    }
    // 回退到 other("direct_upload") / other("get_direct_upload_info")
    if (typeof d.other === "function") {
      for (const m of ["direct_upload", "get_direct_upload_info"]) {
        try {
          const info = await d.other(m, resolved.relative, {
            file_name: safeFileName,
            file_size,
          })
          if (info) return c.json({ code: 200, message: "success", data: info })
        } catch {
          // 尝试下一个 method
        }
      }
    }
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

// ---- Multipart 分片上传（与官方前端 multipart.ts API 契约对齐）----
// 服务层会话管理器：/fs/multipart/init | chunk | complete | status
// 内部桥接到驱动层 createUploadSession / uploadPart / completeUploadSession。

function splitUploadPath(uploadPath: string): { dir: string; name: string } {
  const clean = uploadPath.startsWith("/") ? uploadPath : "/" + uploadPath
  const parts = clean.split("/").filter(Boolean)
  const name = parts.pop() || ""
  const dir = "/" + parts.join("/")
  return { dir, name }
}

fsRouter.post("/multipart/init", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)

  const rawPath = safeDecodeComponent(c.req.header("File-Path") || "")
  if (rawPath === null) {
    return c.json(
      { code: 400, message: "Bad Request: malformed path encoding", data: null },
      400,
    )
  }
  const size = parseInt(c.req.header("X-File-Size") || "0", 10)
  const rawChunk = parseInt(c.req.header("X-Chunk-Size") || "0", 10)
  const md5 = c.req.header("X-File-Md5") || ""

  if (!rawPath.trim() || size <= 0) {
    return c.json(
      {
        code: 400,
        message: "Missing File-Path / X-File-Size header",
        data: null,
      },
      400,
    )
  }
  // X-File-Size 完全由客户端控制：不设上限就会用它决定 partMd5s / received 的
  // 分配规模与 snapshot() 的线性扫描长度。
  if (size > MAX_UPLOAD_BYTES) {
    return c.json(
      {
        code: 413,
        message: `file size exceeds the limit (${MAX_UPLOAD_BYTES} bytes)`,
        data: null,
      },
      413,
    )
  }
  pruneSessions()

  const { dir, name } = splitUploadPath(rawPath)
  const actualDir = getActualPath(user, dir)
  const requestContext = getStorageRequestContext(c)
  if (!(await metaWritable(c, user, actualDir))) return permissionDenied(c)

  try {
    const resolved = await resolvePath(actualDir)
    if (resolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).createUploadSession !== "function") {
      // 存储不支持分片：返回 data:null，前端自动回退到流式上传
      return c.json({ code: 200, message: "success", data: null })
    }

    const chunkSize = clampChunkSize(rawChunk)
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize))
    if (totalChunks > MAX_TOTAL_CHUNKS) {
      return c.json(
        {
          code: 400,
          message: `too many chunks (${totalChunks}), increase X-Chunk-Size`,
          data: null,
        },
        400,
      )
    }

    // 断点续传：同 path+size 且同一发起者的未完成会话才复用
    let session: MultipartSession
    let resumed = false
    const owner = uploadOwner(user)
    const existing = findReceivingSession(rawPath, size, owner)
    if (existing) {
      session = existing
      resumed = true
    } else {
      const info = await (driver as any).createUploadSession(
        actualDir,
        resolved.physical!,
        name,
        size,
        md5,
      )
      session = {
        upload_id: newUploadId(),
        state: "receiving",
        attempt: 0,
        path: rawPath,
        size,
        owner,
        chunk_size: chunkSize,
        total_chunks: totalChunks,
        received: new Set<number>(),
        driver_session: info?.session || "",
        partMd5s: new Array(totalChunks).fill(undefined),
        storage_driver: resolved.storage!.driver,
        created_at: Date.now(),
      }
      // 秒传：驱动返回 reuse 标记
      if (info?.reuse) {
        session.state = "completed"
        session.received = new Set(
          Array.from({ length: totalChunks }, (_, i) => i),
        )
      }
      putSession(session)
    }
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
      requestContext,
    )
    return c.json({
      code: 200,
      message: "success",
      data: { ...mpSnapshot(session), resumed },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.put("/multipart/chunk", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)

  const uploadId = c.req.header("X-Upload-Id") || ""
  const chunkIndex = parseInt(c.req.header("X-Chunk-Index") || "-1", 10)
  const session = uploadId ? getSession(uploadId) : undefined

  if (!session) {
    return c.json(
      { code: 404, message: "upload session not found", data: null },
      404,
    )
  }
  if (!sessionBelongsTo(session, user)) return permissionDenied(c)
  if (chunkIndex < 0 || chunkIndex >= session.total_chunks) {
    return c.json(
      { code: 400, message: "invalid X-Chunk-Index", data: null },
      400,
    )
  }

  // 幂等：已收分片直接返回当前快照
  if (session.received.has(chunkIndex)) {
    return c.json({ code: 200, message: "success", data: mpSnapshot(session) })
  }

  const tooLarge = exceedsUploadLimit(c, true)
  if (tooLarge !== null) {
    return c.json(
      {
        code: 413,
        message: `Part too large (max ${tooLarge} bytes)`,
        data: null,
      },
      413,
    )
  }

  const requestContext = getStorageRequestContext(c)
  const actualDir = getActualPath(user, splitUploadPath(session.path).dir)
  if (!(await metaWritable(c, user, actualDir))) return permissionDenied(c)
  try {
    const resolved = await resolvePath(actualDir)
    if (resolved.isVirtual)
      throw new Error("failed get storage: storage not found")
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).uploadPart !== "function") {
      throw new Error("storage does not support chunked upload")
    }
    const { bytes, tooLarge: bodyTooLarge } = await readBodyBytesLimited(c, true)
    if (bodyTooLarge !== null)
      return overLimitResponse(c, bodyTooLarge + 1, true)
    const buffer = Buffer.from(bytes)
    const overPart = overLimitResponse(c, buffer.byteLength, true)
    if (overPart) return overPart
    let result
    try {
      result = await (driver as any).uploadPart(
        session.driver_session,
        chunkIndex + 1,
        buffer,
      )
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    session.received.add(chunkIndex)
    if (result?.partMd5) session.partMd5s[chunkIndex] = result.partMd5
    putSession(session)
    return c.json({ code: 200, message: "success", data: mpSnapshot(session) })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.post("/multipart/complete", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user)) return permissionDenied(c)

  const uploadId = c.req.header("X-Upload-Id") || ""
  const session = uploadId ? getSession(uploadId) : undefined
  if (!session) {
    return c.json(
      { code: 404, message: "upload session not found", data: null },
      404,
    )
  }
  if (!sessionBelongsTo(session, user)) return permissionDenied(c)
  if (session.state === "completed") {
    return c.json({ code: 200, message: "success", data: mpSnapshot(session) })
  }

  const requestContext = getStorageRequestContext(c)
  const actualDir = getActualPath(user, splitUploadPath(session.path).dir)
  if (!(await metaWritable(c, user, actualDir))) return permissionDenied(c)
  try {
    const resolved = await resolvePath(actualDir)
    if (resolved.isVirtual)
      throw new Error("failed get storage: storage not found")
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    if (typeof (driver as any).completeUploadSession !== "function") {
      throw new Error("storage does not support chunked upload")
    }
    try {
      await (driver as any).completeUploadSession(
        session.driver_session,
        session.partMd5s.filter((x) => x !== undefined),
      )
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
    session.state = "completed"
    putSession(session)
    deleteSession(session.upload_id)
    return c.json({ code: 200, message: "success", data: mpSnapshot(session) })
  } catch (e: any) {
    session.state = "failed_permanent"
    session.error = safeErrorMessage(e)
    putSession(session)
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.get("/multipart/status", async (c) => {
  const user = await getUserFromContext(c)
  // 先鉴权再查会话：否则匿名请求可以从 404/200 的差异里探测 upload_id 是否存在
  if (!user || user.disabled) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const uploadId = c.req.query("upload_id") || ""
  const session = uploadId ? getSession(uploadId) : undefined
  if (!session) {
    return c.json(
      { code: 404, message: "upload session not found", data: null },
      404,
    )
  }
  // 上传进度里含目标路径与文件大小，属于发起者的信息
  if (!sessionBelongsTo(session, user)) return permissionDenied(c)
  return c.json({ code: 200, message: "success", data: mpSnapshot(session) })
})

// ---- 归档（Archive）----
// ZIP（Store/Deflate）：Worker 内置 DecompressionStream，完整支持。
// tar/tar.gz/tgz/tar.bz2/tar.xz：需要对应解压实现，当前运行时若无
//   原生支持则返回 501（能力不足，非请求错误），前端可据此提示用户。
// 7z/rar：Worker 运行时无原生解析库，明确返回 501。
// 归档内容在内存中解析，受 Worker 内存限制，适合中小型归档。

type ArchiveFormat =
  | "zip"
  | "tar"
  | "tar.gz"
  | "tar.bz2"
  | "tar.xz"
  | "7z"
  | "rar"

function detectArchiveFormat(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase()
  if (lower.endsWith(".zip")) return "zip"
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz"
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "tar.bz2"
  if (lower.endsWith(".tar.xz") || lower.endsWith(".txz")) return "tar.xz"
  if (lower.endsWith(".tar")) return "tar"
  if (lower.endsWith(".7z")) return "7z"
  if (lower.endsWith(".rar")) return "rar"
  return null
}

/** 当前运行时实际可解析的格式（ZIP 始终可用；其他格式按需扩展） */
function isNativelySupported(fmt: ArchiveFormat): boolean {
  return fmt === "zip"
}

/**
 * 归档读取门禁：READ_ARCHIVES 权限位 + 覆盖归档文件所在路径的 meta 可读。
 * 此前 /fs/archive/* 只判「登录了没有」，既不看权限位，也不看 meta 密码，
 * 等于给任何账号（含游客）开了一条读取受保护归档内容的旁路。
 */
async function canReadArchive(c: any, user: any, virtualPath: string) {
  if (!can(user, PermissionBit.READ_ARCHIVES)) return false
  const actual = getActualPath(user, virtualPath)
  const meta = await getNearestMeta(actual, c.env).catch(() => null)
  return canAccess(user, meta, actual, "")
}

/** 归档下载允许的最大跳数与体积（整份进内存解析，必须设上限） */
const ARCHIVE_MAX_REDIRECTS = 5
const ARCHIVE_MAX_BYTES = 200 * 1024 * 1024
/** 单条目与整次解压的上限：压缩包体积小不代表解压后小（zip bomb）。 */
const ARCHIVE_MAX_ENTRY_BYTES = 64 * 1024 * 1024
const ARCHIVE_MAX_TOTAL_BYTES = 256 * 1024 * 1024

/** 下载归档文件字节（复用驱动 get() 的 raw_url + SSRF 防护） */
async function fetchArchiveBytes(
  c: any,
  user: any,
  virtualPath: string,
): Promise<ArrayBuffer> {
  const actual = getActualPath(user, virtualPath)
  const resolved = await resolvePath(actual)
  if (resolved.isVirtual)
    throw new Error("failed get storage: storage not found")
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  let item: any
  try {
    // L-8：必须传**实际的**挂载路径（actual），与上面 resolvePath / 鉴权用的
    // 路径同源。此前传的是用户原始输入 virtualPath：当用户带 base_path 或
    // 编码差异时，驱动拿到的路径与实际存储位置不一致（部分驱动会因此返回
    // 错误条目的 raw_url，甚至绕过 meta 判定的那一份路径）。
    item = await driver.get(actual, resolved.physical!)
  } finally {
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
      getStorageRequestContext(c),
    )
  }
  if (!item || !item.raw_url) {
    throw new Error("archive driver did not return download link")
  }
  // 管理员配置的受信存储 endpoint host（内网自建 S3/WebDAV/MinIO）+ 全局
  // 环境变量 SSRF_ALLOWED_HOSTS 加入白名单
  const trustedHosts = getTrustedHosts(resolved.storage?.addition, c.env)
  // 归档要整份读进内存解析，所以每一跳都得重新校验：raw_url 本身过了
  // assertSafeUrl 不代表它 3xx 之后的落点也安全（默认 redirect:follow 会把
  // 请求直接带到内网/元数据地址）。同时按上限拒绝超大归档，避免解压即 OOM。
  const maxBytes = ARCHIVE_MAX_BYTES
  let url: string = item.raw_url
  const headers: Record<string, string> = { ...(item.raw_url_headers || {}) }
  let resp: Response | null = null
  for (let hop = 0; hop < ARCHIVE_MAX_REDIRECTS; hop++) {
    assertSafeUrl(url, "Archive download", trustedHosts)
    const r = await fetch(url, { headers, redirect: "manual" })
    const location = r.headers.get("location")
    if (r.status >= 300 && r.status < 400 && location) {
      try {
        const prevUrl = new URL(url)
        const nextUrl = new URL(location, prevUrl)
        // 跨源跳转：驱动注入的鉴权头不再随请求外带。这里必须比较「跳转前」和
        // 「跳转后」的 origin——原实现先把 url 覆盖再与自身比较，条件恒为 false，
        // Authorization/Cookie 会被原样带到第三方主机。
        if (nextUrl.origin !== prevUrl.origin) {
          for (const k of Object.keys(headers)) delete headers[k]
        }
        url = nextUrl.toString()
      } catch {
        throw new Error("archive download: invalid redirect target")
      }
      continue
    }
    resp = r
    break
  }
  if (!resp) throw new Error("archive download: too many redirects")
  if (!resp.ok) throw new Error(`archive download failed: HTTP ${resp.status}`)
  const declared = Number(resp.headers.get("content-length") || "0")
  if (declared > 0 && declared > maxBytes) {
    throw new Error(`archive too large (${declared} bytes)`)
  }
  const buf = await resp.arrayBuffer()
  if (buf.byteLength > maxBytes) {
    throw new Error(`archive too large (${buf.byteLength} bytes)`)
  }
  return buf
}

/** 将扁平条目构建为树形结构（对齐 Go ArchiveContentResp） */
function buildArchiveTree(archive: ZipArchive): any[] {
  const root: any[] = []
  const dirMap = new Map<string, any>()

  for (const e of archive.entries) {
    const parts = e.name.split("/").filter(Boolean)
    if (parts.length === 0) continue

    let current = root
    let currentPath = ""
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`

      if (isLast) {
        current.push({
          name: part,
          size: e.size,
          is_dir: false,
          modified: e.modified || new Date().toISOString(),
          type: calcFileTypeSafe(part, false),
          children: [] as any[],
        })
      } else {
        let dir = dirMap.get(currentPath)
        if (!dir) {
          dir = {
            name: part,
            size: 0,
            is_dir: true,
            modified: e.modified || new Date().toISOString(),
            type: 1,
            children: [] as any[],
          }
          dirMap.set(currentPath, dir)
          current.push(dir)
        }
        current = dir.children
      }
    }
  }
  return root
}

function calcFileTypeSafe(name: string, isDir: boolean): number {
  const ext = name.split(".").pop()?.toLowerCase() || ""
  if (isDir) return 1
  const video = ["mp4", "mkv", "webm", "avi", "mov", "flv", "m3u8"]
  const audio = ["mp3", "flac", "wav", "aac", "ogg", "m4a"]
  const image = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"]
  const text = [
    "txt",
    "md",
    "json",
    "js",
    "ts",
    "css",
    "html",
    "xml",
    "yml",
    "log",
  ]
  if (video.includes(ext)) return 2
  if (audio.includes(ext)) return 3
  if (image.includes(ext)) return 4
  if (text.includes(ext)) return 5
  return 6
}

fsRouter.post("/archive/meta", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled)
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  const body = await c.req.json().catch(() => ({}))
  const path = String(body.path || c.req.query("path") || "").trim()
  if (!path)
    return c.json({ code: 400, message: "path is required", data: null }, 400)
  if (!(await canReadArchive(c, user, path)))
    return c.json({ code: 403, message: "Permission denied", data: null }, 403)
  const fmt = detectArchiveFormat(path)
  if (!fmt) {
    return c.json(
      { code: 400, message: "unrecognized archive format", data: null },
      400,
    )
  }
  if (!isNativelySupported(fmt)) {
    return c.json(
      {
        code: 501,
        message: `archive format '${fmt}' is recognized but not supported in this runtime (Worker supports ZIP only); use the Go backend for ${fmt} archives`,
        data: null,
      },
      501,
    )
  }
  try {
    const bytes = await fetchArchiveBytes(c, user, path)
    const archive = parseZip(bytes)
    const tree = buildArchiveTree(archive)
    return c.json({
      code: 200,
      message: "success",
      data: {
        comment: "",
        encrypted: false,
        content: tree,
        raw_url: "",
        sign: "",
      },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.post("/archive/list", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled)
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  const body = await c.req.json().catch(() => ({}))
  const path = String(body.path || c.req.query("path") || "").trim()
  const innerPath = String(body.inner_path || "")
    .trim()
    .replace(/\/+/g, "/")
  if (!path)
    return c.json({ code: 400, message: "path is required", data: null }, 400)
  if (!(await canReadArchive(c, user, path)))
    return c.json({ code: 403, message: "Permission denied", data: null }, 403)
  const fmtList = detectArchiveFormat(path)
  if (!fmtList) {
    return c.json(
      { code: 400, message: "unrecognized archive format", data: null },
      400,
    )
  }
  if (!isNativelySupported(fmtList)) {
    return c.json(
      {
        code: 501,
        message: `archive format '${fmtList}' is recognized but not supported in this runtime; use the Go backend for ${fmtList} archives`,
        data: null,
      },
      501,
    )
  }
  try {
    const bytes = await fetchArchiveBytes(c, user, path)
    const archive = parseZip(bytes)
    const prefix = innerPath ? innerPath.replace(/^\/+|\/+$/g, "") + "/" : ""
    const items = archive.entries
      .filter((e) => {
        if (!prefix) return !e.name.includes("/")
        return e.name.startsWith(prefix) && e.name !== prefix.slice(0, -1)
      })
      .map((e) => {
        const rel = prefix ? e.name.slice(prefix.length) : e.name
        return {
          name: rel.split("/")[0],
          size: e.size,
          is_dir: false,
          modified: e.modified || new Date().toISOString(),
          type: calcFileTypeSafe(rel.split("/")[0], false),
        }
      })
    // 去重（扁平列表）
    const seen = new Set<string>()
    const content = items.filter((it) => {
      if (seen.has(it.name)) return false
      seen.add(it.name)
      return true
    })
    return c.json({
      code: 200,
      message: "success",
      data: { content, total: content.length },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})

fsRouter.post("/archive/decompress", async (c) => {
  const user = await getUserFromContext(c)
  if (!canWrite(user) || !can(user, PermissionBit.DECOMPRESS))
    return c.json({ code: 403, message: "Permission denied", data: null }, 403)
  const body = await c.req.json().catch(() => ({}))
  const srcDir = String(body.src_dir || "").trim()
  const dstDir = String(body.dst_dir || "").trim()
  const names: string[] = Array.isArray(body.name)
    ? body.name
    : body.name
      ? [String(body.name)]
      : []
  const innerPath = String(body.inner_path || "")
    .trim()
    .replace(/\/+/g, "/")
  if (!names.length || !dstDir) {
    return c.json(
      { code: 400, message: "src_dir/dst_dir/name are required", data: null },
      400,
    )
  }
  // dst_dir 必须和其它写接口一样先映射到用户自己的根目录：此前它被原样拼进
  // putItem，等于让带 base_path 的用户把压缩包解到别人目录下。
  const actualDst = getActualPath(user, dstDir)
  try {
    let count = 0
    let extractedTotal = 0
    for (const name of names) {
      const safeName = validateFileName(name)
      const srcPath = srcDir ? `${srcDir}/${safeName}` : `/${safeName}`
      if (!(await canReadArchive(c, user, srcPath)))
        return c.json(
          { code: 403, message: "Permission denied", data: null },
          403,
        )
      const fmtDecomp = detectArchiveFormat(safeName)
      if (!fmtDecomp || !isNativelySupported(fmtDecomp)) {
        return c.json(
          {
            code: 400,
            message: `unsupported archive format: ${name} (only ZIP is supported)`,
            data: null,
          },
          400,
        )
      }
      const bytes = await fetchArchiveBytes(c, user, srcPath)
      const archive = parseZip(bytes)
      const prefix = innerPath ? innerPath.replace(/^\/+|\/+$/g, "") + "/" : ""
      for (const entry of archive.entries) {
        if (prefix && !entry.name.startsWith(prefix)) continue
        const rel = prefix ? entry.name.slice(prefix.length) : entry.name
        if (!rel || rel.endsWith("/")) continue
        // ZIP 条目名完全由归档作者控制（zip slip）：必须先按 resolvePath 的口径
        // 解码（`%2e%2e`、反斜杠、3 个以上点）再折叠 `..`，只保留相对路径——否则
        // 未解码的条目名会原样进入 putItem，再由 resolvePath 解码成越界段。
        const safeRel = collapsePathSegments(decodePathFully(rel), 0).join("/")
        if (!safeRel) continue
        const targetPath = `${actualDst.replace(/\/+$/, "")}/${safeRel}`
        const content = await extractZipEntry(
          bytes,
          entry,
          ARCHIVE_MAX_ENTRY_BYTES,
        )
        extractedTotal += content.byteLength
        if (extractedTotal > ARCHIVE_MAX_TOTAL_BYTES) {
          return c.json(
            {
              code: 413,
              message: `archive expands beyond the ${ARCHIVE_MAX_TOTAL_BYTES}-byte extraction limit`,
              data: null,
            },
            413,
          )
        }
        await putItem(
          targetPath,
          Buffer.from(content),
          getStorageRequestContext(c),
        )
        count++
      }
    }
    return c.json({
      code: 200,
      message: "success",
      data: { task: null, count },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), data: null }, 500)
  }
})
