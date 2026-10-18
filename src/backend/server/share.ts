import { Hono } from "hono"
import { getDb, saveDb } from "../internal/model/db"
import { adminAuthMiddleware, getUserFromContext } from "./middlewares"
import { can, PermissionBit, isAdmin, getActualPath } from "../pkg/permission"
import { decodePathFully, hasParentSegment } from "../pkg/path"
import { canAccess, getNearestMeta } from "../pkg/meta"

export const shareRouter = new Hono()

/**
 * 校验并清理分享路径。
 *
 * 旧实现只对字面 `..` 段报错，于是 `%2e%2e` 能原样入库；而读取时 resolvePath 会
 * 先做多重百分号解码再折叠 `..`，分享就被抬到创建者根目录之外，变成一个任何人
 * 都可读的公开链接。这里在判定前先取「解码视图」，与 resolvePath 对齐。
 */
function sanitizePath(p: string): string {
  const raw = p || ""
  const normalized = raw.replace(/\\/g, "/").replace(/\/+/g, "/")
  if (
    hasParentSegment(normalized) ||
    hasParentSegment(decodePathFully(raw).replace(/\\/g, "/"))
  ) {
    throw new Error("Path traversal segment '..' is not allowed")
  }
  const segments = normalized.split("/").filter((s) => s && s !== ".")
  return "/" + segments.join("/")
}

/** 分享路径必须落在创建者自己的可见范围内：先映射 base_path，再套 meta 读权限。 */
async function assertShareTargetsAccessible(
  user: any,
  paths: string[],
  env: any,
): Promise<string | null> {
  for (const p of paths) {
    const meta = await getNearestMeta(p, env)
    if (!canAccess(user, meta, p, "")) {
      return `No permission to share path: ${p}`
    }
  }
  return null
}

// 分享管理接口需要管理员权限（list/get/update/delete）
shareRouter.use("/list", adminAuthMiddleware)
shareRouter.use("/get", adminAuthMiddleware)
shareRouter.use("/update", adminAuthMiddleware)
shareRouter.use("/delete", adminAuthMiddleware)
shareRouter.use("/cancel", adminAuthMiddleware)
shareRouter.use("/enable", adminAuthMiddleware)
shareRouter.use("/disable", adminAuthMiddleware)

// List all shares (returns full data aligned with Go backend)
shareRouter.get("/list", async (c) => {
  const db = await getDb(c.env)
  const shares = db.shares || []
  return c.json({
    code: 200,
    message: "success",
    data: { content: shares, total: shares.length },
  })
})

// Get a single share
shareRouter.get("/get", async (c) => {
  const id = c.req.query("id") || ""
  const db = await getDb(c.env)
  const share = (db.shares || []).find((s: any) => s.id === id)
  if (!share) {
    return c.json({ code: 404, message: "share not found", data: null })
  }
  return c.json({ code: 200, message: "success", data: share })
})

// Create a new share (requires logged-in user with SHARE permission; admins always allowed)
shareRouter.post("/create", async (c) => {
  const user = await getUserFromContext(c)
  if (!user || user.disabled) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }

  // 检查分享权限位
  if (!isAdmin(user) && !can(user, PermissionBit.SHARE)) {
    return c.json({ code: 403, message: "Permission denied", data: null }, 403)
  }

  const body = await c.req.json().catch(() => ({}))
  const db = await getDb(c.env)

  // 校验并清理分享路径
  let files: string[] = []
  if (Array.isArray(body.files)) {
    try {
      files = body.files.map((f: string) => {
        const clean = sanitizePath(String(f))
        return isAdmin(user) ? clean : getActualPath(user, clean)
      })
    } catch (err: any) {
      return c.json(
        { code: 400, message: err.message || "Invalid file path", data: null },
        400,
      )
    }
    // 分享会把路径的读权限直接授予匿名访客，因此创建者自己必须能读到该路径：
    // 否则 meta 密码 / read_users 只需转手分享一次即失效。
    const denied = await assertShareTargetsAccessible(user, files, c.env)
    if (denied) {
      return c.json({ code: 403, message: denied, data: null }, 403)
    }
  }

  // 校验自定义 ID 格式
  const rawId = body.id ? String(body.id).trim() : ""
  if (rawId && !/^[a-zA-Z0-9_-]{1,64}$/.test(rawId)) {
    return c.json(
      {
        code: 400,
        message:
          "Invalid share id format (only alphanumeric, _ and - allowed, max 64 chars)",
        data: null,
      },
      400,
    )
  }

  // 自定义分享 ID 是独立权限位：未授予者只能使用随机 ID，避免短/可猜测的
  // 分享标识被用于撞库与定向枚举。
  if (rawId && !can(user, PermissionBit.CUSTOMIZE_SHARE_ID)) {
    return c.json(
      {
        code: 403,
        message: "Permission denied: CUSTOMIZE_SHARE_ID",
        data: null,
      },
      403,
    )
  }

  const shareId = rawId || generateShareId()

  if ((db.shares || []).some((s: any) => s.id === shareId)) {
    return c.json(
      {
        code: 400,
        message: "share id already exists",
        data: null,
      },
      400,
    )
  }

  const newShare = {
    id: shareId,
    new_id: body.new_id || shareId,
    // 对齐 Go CreateSharing：管理员恢复分享时可通过 creator/creator_role 字段
    // 保留原创建者，否则默认当前登录用户。
    creator: body.creator || user.username || "user",
    creator_role:
      body.creator_role !== undefined ? body.creator_role : (user.role ?? 1),
    accessed: body.accessed ?? 0,
    expires: body.expires || null,
    pwd: body.pwd || "",
    max_accessed: body.max_accessed ?? 0,
    disabled: body.disabled ?? false,
    order_by: body.order_by || "",
    order_direction: body.order_direction || "",
    extract_folder: body.extract_folder || "",
    files,
    remark: body.remark || "",
    readme: body.readme || "",
    header: body.header || "",
  }

  if (!db.shares) db.shares = []
  db.shares.push(newShare)
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: newShare })
})

/** Generate a random 16-char share id using Web Crypto (Workers-compatible) */
function generateShareId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "")
  return uuid.slice(0, 16)
}

// Update an existing share
shareRouter.post("/update", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const db = await getDb(c.env)

  if (!body.id) {
    return c.json({ code: 400, message: "share id is required", data: null })
  }

  const idx = (db.shares || []).findIndex((s: any) => s.id === body.id)
  if (idx === -1) {
    return c.json({ code: 404, message: "share not found", data: null })
  }

  // Support renaming via new_id (must not collide with another share)
  const newId =
    body.new_id && String(body.new_id).trim() !== ""
      ? String(body.new_id).trim()
      : body.id
  if (newId !== body.id) {
    const collision = (db.shares || []).some(
      (s: any) => s.id === newId && s.id !== body.id,
    )
    if (collision) {
      return c.json({
        code: 400,
        message: "share id already exists",
        data: null,
      })
    }
  }

  // 更新同样要过一遍清洗：分享路径最终会被 resolvePath 二次解码后折叠，
  // 脏数据一旦入库就等于把一个可解码成 `..` 的路径永久留在分享白名单里。
  let updatedFiles = db.shares[idx].files
  if (body.files !== undefined) {
    if (!Array.isArray(body.files)) {
      return c.json(
        { code: 400, message: "files must be an array", data: null },
        400,
      )
    }
    try {
      updatedFiles = body.files.map((f: string) => sanitizePath(String(f)))
    } catch (err: any) {
      return c.json(
        { code: 400, message: err.message || "Invalid file path", data: null },
        400,
      )
    }
  }

  db.shares[idx] = {
    ...db.shares[idx],
    id: newId,
    new_id: newId,
    expires: body.expires !== undefined ? body.expires : db.shares[idx].expires,
    pwd: body.pwd !== undefined ? body.pwd : db.shares[idx].pwd,
    max_accessed:
      body.max_accessed !== undefined
        ? body.max_accessed
        : db.shares[idx].max_accessed,
    disabled:
      body.disabled !== undefined ? body.disabled : db.shares[idx].disabled,
    order_by:
      body.order_by !== undefined ? body.order_by : db.shares[idx].order_by,
    order_direction:
      body.order_direction !== undefined
        ? body.order_direction
        : db.shares[idx].order_direction,
    extract_folder:
      body.extract_folder !== undefined
        ? body.extract_folder
        : db.shares[idx].extract_folder,
    files: body.files !== undefined ? body.files : db.shares[idx].files,
    remark: body.remark !== undefined ? body.remark : db.shares[idx].remark,
    readme: body.readme !== undefined ? body.readme : db.shares[idx].readme,
    header: body.header !== undefined ? body.header : db.shares[idx].header,
  }
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: null })
})

// Delete a share
shareRouter.post("/delete", async (c) => {
  const id = c.req.query("id") || ""
  const db = await getDb(c.env)
  if (!db.shares) db.shares = []
  db.shares = db.shares.filter((s: any) => s.id !== id)
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: null })
})

// Enable a share
shareRouter.post("/enable", async (c) => {
  const id = c.req.query("id") || ""
  const db = await getDb(c.env)
  const s = (db.shares || []).find((s: any) => s.id === id)
  if (s) {
    s.disabled = false
    await saveDb(db, c.env)
  }
  return c.json({ code: 200, message: "success", data: null })
})

// Disable a share
shareRouter.post("/disable", async (c) => {
  const id = c.req.query("id") || ""
  const db = await getDb(c.env)
  const s = (db.shares || []).find((s: any) => s.id === id)
  if (s) {
    s.disabled = true
    await saveDb(db, c.env)
  }
  return c.json({ code: 200, message: "success", data: null })
})
