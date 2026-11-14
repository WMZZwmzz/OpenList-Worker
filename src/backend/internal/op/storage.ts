import { resolvePath, getDb, getSettings, saveDb } from "../model/db"
import { decodePathFully, encodeDownloadPath } from "../../pkg/path"
import {
  canWrite as canWriteMeta,
  getNearestMeta,
  type Meta,
} from "../../pkg/meta"
import { isWithinUserRoot, type UserPermissionObj } from "../../pkg/permission"
import { isSafeUrl } from "../../pkg/http"
import { canUseProxyEndpoint, normalizeExtList } from "../driver/proxy"
import { FileItem, StorageDriver, calcFileType } from "../driver/base"
import { Onedrive } from "../../drivers/onedrive/driver"
import { OnedriveAPP } from "../../drivers/onedrive_app/driver"
import { AliyundriveOpen } from "../../drivers/aliyundrive_open/driver"
import { GoogleDrive } from "../../drivers/google_drive/driver"
import { QuarkDriver } from "../../drivers/quark/driver"
import { DriverCloudreve } from "../../drivers/cloudreve_v4/driver"
import { DriverCloudreveV3 } from "../../drivers/cloudreve_v3/driver"
import { DriverOpenlist } from "../../drivers/openlist/driver"
import { DriverOpenlistShare } from "../../drivers/openlist_share/driver"
import { DriverTeldrive } from "../../drivers/teldrive/driver"
import { DriverMediafire } from "../../drivers/mediafire/driver"
import { DriverGithubReleases } from "../../drivers/github_releases/driver"
import { DriverCnbReleases } from "../../drivers/cnb_releases/driver"
import { DriverKodbox } from "../../drivers/kodbox/driver"
import { DriverIpfs } from "../../drivers/ipfs_api/driver"
import { DriverLenovoNasShare } from "../../drivers/lenovonas_share/driver"
import { DriverMisskey } from "../../drivers/misskey/driver"
import { DriverDoubao } from "../../drivers/doubao/driver"
import { DriverQuarkOpen } from "../../drivers/quark_open/driver"
import { DriverQuarkUcTv } from "../../drivers/quark_uc_tv/driver"
import { Driver123Open } from "../../drivers/123_open/driver"
import { DriverTeambition } from "../../drivers/teambition/driver"
import { DriverChaoXing } from "../../drivers/chaoxing/driver"
import { DriverGooglePhoto } from "../../drivers/google_photo/driver"
import { DriverFebBox } from "../../drivers/febbox/driver"
import { DriverDegoo } from "../../drivers/degoo/driver"
import { DriverNeteaseMusic } from "../../drivers/netease_music/driver"
import { DriverHalalCloudOpen } from "../../drivers/halalcloud_open/driver"
import { Pan123Driver } from "../../drivers/123pan/driver"
import {
  BaiduDriver,
  normalizeBaiduAddition,
} from "../../drivers/baidu_netdisk/driver"
import { DriverBaiduPhoto } from "../../drivers/baidu_photo/driver"
import { Pan115Driver } from "../../drivers/115open/driver"
import { GithubDriver } from "../../drivers/github/driver"
import {
  ThunderDriver,
  ThunderExpertDriver,
} from "../../drivers/thunder/driver"
import { LanzouDriver } from "../../drivers/lanzou/driver"
import { CtFileDriver } from "../../drivers/ctfile/driver"
import { Cloud189Driver } from "../../drivers/189/driver"
import { Driver189TV } from "../../drivers/189_tv/driver"
import { WebdavDriver } from "../../drivers/webdav/driver"
import { WoPanDriver, normalizeWoPanAddition } from "../../drivers/wopan/driver"
import { MoPanDriver } from "../../drivers/mopan/driver"
import { S3Driver, normalizeS3Addition } from "../../drivers/s3/driver"
import { R2Driver } from "../../drivers/r2/driver"
import {
  WeiyunDriver,
  normalizeWeiyunAddition,
} from "../../drivers/weiyun/driver"
import { PikPakDriver } from "../../drivers/pikpak/driver"
import { SeafileDriver } from "../../drivers/seafile/driver"
import { YandexDriver } from "../../drivers/yandex/driver"
import { TeraboxDriver } from "../../drivers/terabox/driver"
import { MediatrackDriver } from "../../drivers/mediatrack/driver"
import { AliasDriver } from "../../drivers/alias/driver"
import { DropboxDriver } from "../../drivers/dropbox/driver"
import { WpsDriver } from "../../drivers/wps/driver"
import { Yun139Driver } from "../../drivers/139/driver"
import { MegaDriver } from "../../drivers/mega/driver"
import { Pan115ShareDriver } from "../../drivers/115_share/driver"
import { Pan123ShareDriver } from "../../drivers/123_share/driver"
import { AliyundriveShareDriver } from "../../drivers/aliyundrive_share/driver"
import { OnedriveSharelinkDriver } from "../../drivers/onedrive_sharelink/driver"
import { PikPakShareDriver } from "../../drivers/pikpak_share/driver"
import { SMBDriver } from "../../drivers/smb/driver"
import { CryptDriver } from "../../drivers/crypt/driver"
import { VirtualDriver } from "../../drivers/virtual/driver"
import { AListV3Driver } from "../../drivers/alist_v3/driver"
import { UrlTreeDriver } from "../../drivers/url_tree/driver"
import { StrmDriver } from "../../drivers/strm/driver"
import { ChunkDriver } from "../../drivers/chunk/driver"
import { AzureBlobDriver } from "../../drivers/azure_blob/driver"
import { UssDriver } from "../../drivers/uss/driver"
import { AliDocDriver } from "../../drivers/alidoc/driver"
import { EmbyDriver } from "../../drivers/emby/driver"
import { BunnyStorageDriver } from "../../drivers/bunny_storage/driver"
import { CFImgBedDriver } from "../../drivers/cloudflare_imgbed/driver"
import { GuangYaPanDriver } from "../../drivers/guangyapan/driver"
import { AutoIndexDriver } from "../../drivers/autoindex/driver"
import { ProtonDriveDriver } from "../../drivers/proton_drive/driver"

// LocalDriver is not available in Cloudflare Workers (no fs module).
// When running in Node.js container mode, import dynamically on first use.
//
// 按 root_folder_path 分实例缓存：驱动需要知道存储根才能在 fs 落到磁盘前做
// realpath 越界校验（M-9），而每个 Local 存储的根都可能不同。
const _localDrivers = new Map<string, StorageDriver>()
async function getLocalDriver(rootFolder?: string): Promise<StorageDriver> {
  const key = typeof rootFolder === "string" ? rootFolder : ""
  const cached = _localDrivers.get(key)
  if (cached) return cached
  const { LocalDriver } = await import("../../drivers/local")
  const driver = new LocalDriver(rootFolder)
  _localDrivers.set(key, driver)
  return driver
}

async function getSFTPDriver(storageConfig: any): Promise<StorageDriver> {
  if (typeof process !== "undefined" && process.release?.name === "node") {
    const { SFTPDriver } = await import("../../drivers/sftp")
    const driver = new SFTPDriver(parseAddition(storageConfig))
    await driver.init?.()
    return driver
  }
  throw new Error(
    "SFTP storage driver requires Node.js runtime (raw TCP sockets not available in Cloudflare Workers)",
  )
}

async function getFTPDriver(storageConfig: any): Promise<StorageDriver> {
  if (typeof process !== "undefined" && process.release?.name === "node") {
    const { FTPDriver } = await import("../../drivers/ftp")
    const driver = new FTPDriver(parseAddition(storageConfig))
    await driver.init?.()
    return driver
  }
  throw new Error(
    "FTP storage driver requires Node.js runtime (raw TCP sockets not available in Cloudflare Workers)",
  )
}

const driverCache = new Map<string, StorageDriver>()
const driverInitCache = new Map<string, Promise<StorageDriver>>()
const cookiePersistenceCache = new Map<string, Promise<void>>()
const deferredTokenPersistence = new WeakSet<object>()

// M-8：驱动实例缓存容量上限。storage.modified 变化会产生新 key，旧条目若不清理，
// 长生命周期 isolate 中会无限累积。超出上限时按插入顺序淘汰最旧条目。
const MAX_DRIVER_CACHE = 100

function setDriverCache(key: string, driver: StorageDriver): void {
  if (driverCache.size >= MAX_DRIVER_CACHE) {
    const oldestKey = driverCache.keys().next().value
    if (oldestKey !== undefined) driverCache.delete(oldestKey)
  }
  driverCache.set(key, driver)
}

export interface StorageRequestContext {
  waitUntil?: (promise: Promise<unknown>) => void
  env?: any // ESA/Cloudflare env，用于请求级缓存复用
  /**
   * 发起本次操作的已认证用户。写入类 op 在带上 user 时会套用目录 meta 的
   * write_users 白名单；内部调用（管理员任务、迁移、驱动自调）不传即保持原语义。
   */
  user?: UserPermissionObj | null
  /**
   * F-405 残留收尾：客户端 IP（来自 pkg/client-ip，可能为 "unknown"）。
   * 驱动可选用它参与 CDN 防盗链签名（如 bunny_storage 的
   * cdn_token_include_ip）；不传或 "unknown" 时驱动保持无 IP 签名行为。
   */
  clientIp?: string
}

/**
 * meta.write_users 写入门禁。对齐 Go common.CanWrite：只有当某个覆盖该路径的
 * meta 显式配置了 write_users，且请求者不在名单内时才拒绝。
 * 放在 op 层是为了让 /fs/*、/dav/*、/s3/* 以及任何后续写入路径共用同一道闸，
 * 而不是依赖每个 handler 记得检查。
 */
async function assertMetaWritable(
  virtualPath: string,
  requestContext?: StorageRequestContext,
): Promise<void> {
  const user = requestContext?.user
  if (!user) return
  let meta: Meta | null = null
  try {
    meta = await getNearestMeta(virtualPath, requestContext?.env)
  } catch {
    meta = null
  }
  if (!canWriteMeta(user, meta, virtualPath)) {
    throw new Error("permission denied: not in write_users")
  }
}

/**
 * 租户根的第二道防线（D-1）。
 *
 * handler 已经把 base_path 套用进 virtualPath，但只要有任何一个入口忘了套用，
 * 写成 `dir + "/" + name` 的路径就可能越界。只要 requestContext 带了 user，就在
 * op 层统一复核一次，越出 base_path 直接拒绝；内部系统调用（不带 user）保持原
 * 语义。
 *
 * 注意：这**不能**替代 D-5（Alias 驱动把虚拟路径映射成全局 targetFullPath 后
 * 自调 op 层，那些内部调用不带 requestContext）。要彻底收口需要给 StorageDriver
 * 接口补用户上下文，属下一批。
 */
function assertWithinUserRoot(
  virtualPath: string,
  requestContext?: StorageRequestContext,
): void {
  const user = requestContext?.user
  if (!user) return
  if (!isWithinUserRoot(user, virtualPath)) {
    throw new Error("permission denied: path escapes the user base path")
  }
}

/**
 * 名字段（不是路径）的安全校验。
 *
 * 调用方会把它拼成 `dir + "/" + name` 再交给 resolvePath，而 resolvePath 对
 * 拼接结果做多重百分号解码。`%2e%2e%2f` 在字面视图里是合法文件名，解码后却是
 * `../`（D-1）。op 层不再信任 handler，统一在这里按解码视图拒绝分隔符与父目录段。
 */
function assertItemName(name: string): void {
  const raw = String(name ?? "")
  const decoded = decodePathFully(raw)
  if (
    !decoded ||
    decoded === "." ||
    /^\.+$/.test(decoded) ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  ) {
    throw new Error(`illegal file name '${raw}'`)
  }
}

/** 同一存储判定：优先用存储 id，退化到 mount_path + driver */
function assertSameStorage(src: any, dst: any): void {
  const a = src?.storage
  const b = dst?.storage
  if (!a || !b) return
  const same =
    a.id !== undefined && b.id !== undefined
      ? a.id === b.id
      : a.mount_path === b.mount_path && a.driver === b.driver
  if (!same) {
    throw new Error(
      "failed to move/copy: source and destination are on different storages",
    )
  }
}

export interface GetDriverOptions {
  deferTokenPersistence?: boolean
}

export async function getOrCreateDriver(
  cache: Map<string, Promise<StorageDriver>>,
  key: string,
  factory: () => Promise<StorageDriver>,
): Promise<StorageDriver> {
  const existing = cache.get(key)
  if (existing) return existing

  const pending = factory()
  cache.set(key, pending)
  try {
    return await pending
  } finally {
    // F-093：initCache 只承担「同一 key 的并发初始化去重」；pending settle 后
    // 无论成功失败都移除，避免 storage.modified 变化产生的旧 key（管理员每次
    // 保存存储都会产生一个）在长生命周期进程里无限累积。成功结果已由
    // setDriverCache 写入 driverCache，保留 resolved Promise 还会让被 M-8
    // 上限淘汰的驱动实例无法回收、也不会重新进 driverCache。
    // 在途调用方在 set 之前已拿到同一个 pending，去重语义不受影响。
    if (cache.get(key) === pending) cache.delete(key)
  }
}

function parseAddition(storageConfig?: any): any {
  const additionStr = storageConfig?.addition
  if (!additionStr) return {}
  return typeof additionStr === "string"
    ? JSON.parse(additionStr || "{}")
    : additionStr
}

function normalizeDriverName(driverName: string): string {
  return (driverName || "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * 驱动刷新凭据后的回写。
 *
 * F-090/F-271 重构：旧 createDriver 的每个 else-if 分支都内联一份
 * getDb → 查存储 → 合并 addition → saveDb，这里抽成一处。行为保持不变：
 * 找不到存储记录或持久化失败时只告警，不影响正在进行的请求。
 */
async function persistStorageAddition(
  storageConfig: any,
  logLabel: string,
  mutate: (addition: any) => void,
  options: {
    /** 日志里的凭据种类，如 "token" / "refresh_token" / "cookie" */
    what?: string
    /** 同步更新 admin 更新流程正在使用的 storageConfig.addition */
    syncInFlight?: boolean
    /** onedrive/139：admin 更新路径自己会保存，此处跳过 saveDb */
    respectDeferral?: boolean
    /** 写库前对 addition 做规范化（baidu / wopan / weiyun） */
    serialize?: (addition: any) => any
  } = {},
): Promise<void> {
  try {
    const db = await getDb()
    const st = (db.storages || []).find((s: any) => s.id === storageConfig?.id)
    if (!st) return
    const stAddition =
      typeof st.addition === "string"
        ? JSON.parse(st.addition || "{}")
        : st.addition || {}
    mutate(stAddition)
    st.addition = JSON.stringify(
      options.serialize ? options.serialize(stAddition) : stAddition,
    )
    if (options.syncInFlight) storageConfig.addition = st.addition
    if (options.respectDeferral && deferredTokenPersistence.has(storageConfig)) {
      return
    }
    await saveDb(db)
  } catch (e) {
    console.warn(
      `[${logLabel}] failed to persist ${options.what || "credentials"}:`,
      e,
    )
  }
}

/** 构造驱动；init 由 createDriver 统一调用（autoInit=false 的条目除外）。 */
type DriverFactory = (
  addition: any,
  storageConfig: any,
) => StorageDriver | Promise<StorageDriver>

export interface DriverRegistration {
  /**
   * 归一化（小写、仅 a-z0-9）后的可接受名称，第一个为规范名。
   *
   * 只允许精确匹配：不得再引入 startsWith/includes 之类的模糊分支。旧
   * createDriver 的模糊匹配造成过两次 P1 路由事故：
   *   - A5-1/F-271：`startsWith("115")` 抢走 "115open"/"115_share"，导致
   *     Pan115Driver 对自己的主名永远不可达；
   *   - F-090：`startsWith("onedrive")` / `startsWith("123")` 等把五个分享
   *     驱动分支吞成个人版驱动。
   */
  names: readonly string[]
  create: DriverFactory
  /**
   * create 之后是否调用 driver.init()，默认 true。
   * local/sftp/ftp 的 helper 内部已经完成初始化，故置 false，避免二次 init。
   */
  autoInit?: boolean
  /** init 抛错时打印的错误日志前缀（保留旧 onedrive 系的 console.error）。 */
  initErrorLog?: string
}

/**
 * 显式驱动注册表：规范名 + 精确别名 → 驱动构造器。
 *
 * 别名来源：旧 createDriver if-chain 中所有 `normDriver === "..."` 精确分支
 * （即当时真正生效的名字），以及 admin driverConfigs 暴露的模板名。
 * 旧的 startsWith/includes 模糊匹配全部删除；仅保留少数有明确含义的兼容
 * 别名（如 "gdrive"、"xunlei"、"dubox"），并在条目注释中说明。
 *
 * 分享驱动（F-090）作为独立条目注册，与个人版驱动互不遮蔽：
 *   115Share / 123PanShare / AliyundriveShare / OnedriveSharelink / PikPakShare
 */
const DRIVER_REGISTRY: readonly DriverRegistration[] = [
  // ---------- 本地 / 传统协议 ----------
  {
    // 本地磁盘：仅 Node 容器可用（Cloudflare Workers 无 fs）。按 root 分实例缓存。
    names: ["local"],
    create: (addition) => {
      if (typeof process === "undefined" || process.release?.name !== "node") {
        throw new Error(
          "Local storage driver requires Node.js runtime (not available in Cloudflare Workers)",
        )
      }
      // S-08（深度安全审查报告）：root_folder_path 为空时物理根退化为文件系统
      // 根——`GET /d/etc/passwd` 可读任意主机文件、有写权限的用户可写任意文件。
      // 对齐 Go 版 `required:"true"`：空根一律拒绝挂载，管理员必须显式指定目录。
      const localRoot =
        typeof addition?.root_folder_path === "string"
          ? addition.root_folder_path.trim()
          : ""
      if (!localRoot || localRoot === "/" || localRoot === "\\") {
        throw new Error(
          'Local storage requires a non-empty root_folder_path (mounting the filesystem root is rejected)',
        )
      }
      return getLocalDriver(localRoot)
    },
    autoInit: false,
  },
  {
    // SFTP：仅 Node 运行时可用；getSFTPDriver 内已 await init。
    names: ["sftp"],
    create: (_addition, storageConfig) => getSFTPDriver(storageConfig),
    autoInit: false,
  },
  {
    // FTP：仅 Node 运行时可用；getFTPDriver 内已 await init。
    names: ["ftp"],
    create: (_addition, storageConfig) => getFTPDriver(storageConfig),
    autoInit: false,
  },

  // ---------- OneDrive ----------
  {
    // OneDrive 个人版（Graph API）。别名：onedrive / onedrive_sb /
    // onedrive_business / onedrive_sharepoint。
    names: ["onedrive", "onedrivesb", "onedrivebusiness", "onedrivesharepoint"],
    create: (addition, storageConfig) =>
      new Onedrive(addition, async (refreshToken: string) => {
        await persistStorageAddition(
          storageConfig,
          "Onedrive",
          (stAddition) => {
            stAddition.refresh_token = refreshToken
          },
          {
            what: "refresh token",
            syncInFlight: true,
            respectDeferral: true,
          },
        )
      }),
    initErrorLog: "onedrive init failed:",
  },
  {
    // OneDrive APP（独立应用授权）。
    names: ["onedriveapp"],
    create: (addition) => new OnedriveAPP(addition),
    initErrorLog: "onedrive_app init failed:",
  },

  // ---------- 阿里云盘 ----------
  {
    // 阿里云盘 OAuth2 Open API。别名为旧精确分支保留；
    // "aliyundriveshare" 已移交给 AliyundriveShareDriver（F-090）。
    names: [
      "aliyundriveopen",
      "aliyundrive",
      "aliyun",
      "aliyundriveshare2open",
      "aliyundriveoauth2",
    ],
    // F-345：注册刷新令牌持久化回调（与 OneDrive 同一模式）。阿里盘 Open API
    // 的 refresh_token 是**一次性轮换**的——不回写的话，令牌在实例 A 刷新后，
    // 实例 B 的旧 refresh_token 立即失效，表现为多实例部署间歇性 401。
    create: (addition, storageConfig) =>
      new AliyundriveOpen(addition, async (refreshToken: string) => {
        await persistStorageAddition(
          storageConfig,
          "AliyundriveOpen",
          (stAddition) => {
            stAddition.refresh_token = refreshToken
          },
          {
            what: "refresh token",
            syncInFlight: true,
            respectDeferral: true,
          },
        )
      }),
  },

  // ---------- Google ----------
  {
    // Google Photos。
    names: ["googlephoto", "googlephotos", "gphoto"],
    create: (addition) => new DriverGooglePhoto(addition),
  },
  {
    // Google Drive。别名：google_drive / gdrive / google。
    names: ["googledrive", "gdrive", "google"],
    create: (addition) => new GoogleDrive(addition),
  },

  // ---------- 夸克 ----------
  {
    // 夸克网盘（Cookie）。别名：quark_uc / uc / quark_cookie。
    names: ["quark", "quarkuc", "uc", "quarkcookie"],
    create: (addition) => new QuarkDriver(addition),
  },
  {
    // 夸克开放平台。别名：quark_open / quark_oa。
    names: ["quarkopen", "quarkoa"],
    create: (addition) => new DriverQuarkOpen(addition),
  },
  {
    // 夸克 UC TV。别名：quark_uc_tv / quark_tv / uctv。
    names: ["quarkuctv", "quarktv", "uctv"],
    create: (addition) => new DriverQuarkUcTv(addition),
  },

  // ---------- 115 ----------
  {
    // 115 网盘（全部走 Pan115Driver，上游 #152 移除了已损坏的 legacy
    // drivers/115：旧实现 URL 路径重复且在驱动工厂里遮蔽本驱动）。
    // 别名 115cloud / 115netdisk 是旧精确分支就有的兼容名。
    names: ["115", "115open", "115pan", "115cloud", "115netdisk"],
    create: (addition, storageConfig) =>
      new Pan115Driver(addition, async (tokens) => {
        await persistStorageAddition(
          storageConfig,
          "115open",
          (stAddition) => {
            stAddition.access_token = tokens.access_token
            stAddition.refresh_token = tokens.refresh_token
          },
          { what: "token" },
        )
      }),
  },

  // ---------- Cloudreve / OpenList ----------
  {
    // Cloudreve V3。
    names: ["cloudrevev3", "cloudreve"],
    create: (addition, storageConfig) =>
      new DriverCloudreveV3(addition, async (cookie: string) => {
        await persistStorageAddition(
          storageConfig,
          "cloudreve",
          (stAddition) => {
            stAddition.cookie = cookie
          },
          { what: "cookie" },
        )
      }),
  },
  {
    // Cloudreve V4。
    names: ["cloudrevev4"],
    create: (addition) => new DriverCloudreve(addition),
  },
  {
    // OpenList 分享挂载。别名：openlist_share。
    names: ["openlistshare"],
    create: (addition) => new DriverOpenlistShare(addition),
  },
  {
    // OpenList 实例。
    names: ["openlist"],
    create: (addition) => new DriverOpenlist(addition),
  },

  // ---------- 其他网盘 ----------
  {
    names: ["teldrive"],
    create: (addition) => new DriverTeldrive(addition),
  },
  {
    names: ["mediafire"],
    create: (addition) => new DriverMediafire(addition),
  },
  {
    names: ["githubreleases"],
    create: (addition) => new DriverGithubReleases(addition),
  },
  {
    names: ["cnbreleases"],
    create: (addition) => new DriverCnbReleases(addition),
  },
  {
    // Kodbox。别名 "kodo" 历史上先于 S3 分支匹配，行为保持不变
    // （因此 S3 条目不再注册 "kodo"，避免注册表重复名）。
    names: ["kodbox", "kodo"],
    create: (addition) => new DriverKodbox(addition),
  },
  {
    // IPFS。别名：ipfs_api。
    names: ["ipfs", "ipfsapi"],
    create: (addition) => new DriverIpfs(addition),
  },
  {
    // 联想 NAS 分享。别名：lenovonas_share。
    names: ["lenovonasshare"],
    create: (addition) => new DriverLenovoNasShare(addition),
  },
  {
    names: ["misskey"],
    create: (addition) => new DriverMisskey(addition),
  },
  {
    // 豆包。别名：doubao_new / doubao_share。
    names: ["doubao", "doubaonew", "doubaoshare"],
    create: (addition) => new DriverDoubao(addition),
  },
  {
    names: ["123open", "123cloudopen"],
    create: (addition) => new Driver123Open(addition),
  },
  {
    // Teambition。别名 "tb"。
    names: ["teambition", "tb"],
    create: (addition) => new DriverTeambition(addition),
  },
  {
    // 网易云音乐。别名：netease / netease_cloud_music / netease_music。
    names: ["neteasemusic", "netease", "neteasecloudmusic"],
    create: (addition) => new DriverNeteaseMusic(addition),
  },
  {
    // 海拉云盘。别名：halalcloud_open / halalcloud_open_api。
    names: ["halalcloudopen", "halalcloudopenapi"],
    create: (addition, storageConfig) =>
      new DriverHalalCloudOpen(addition, async (refreshToken: string) => {
        await persistStorageAddition(
          storageConfig,
          "HalalCloud",
          (stAddition) => {
            stAddition.refresh_token = refreshToken
          },
          { what: "refresh_token" },
        )
      }),
  },
  {
    names: ["degoo"],
    create: (addition, storageConfig) =>
      new DriverDegoo(addition, async (tokens) => {
        await persistStorageAddition(
          storageConfig,
          "degoo",
          (stAddition) => {
            if (tokens.accessToken) stAddition.access_token = tokens.accessToken
            if (tokens.refreshToken)
              stAddition.refresh_token = tokens.refreshToken
          },
          { what: "tokens" },
        )
      }),
  },
  {
    // FebBox。别名 "febboxpan"。
    names: ["febbox", "febboxpan"],
    create: (addition, storageConfig) =>
      new DriverFebBox(addition, async (refreshToken: string) => {
        await persistStorageAddition(
          storageConfig,
          "febbox",
          (stAddition) => {
            stAddition.refresh_token = refreshToken
          },
          { what: "refresh_token" },
        )
      }),
  },
  {
    // 超星。别名：chaoxing_group_drive / chaoxing_group。
    names: ["chaoxing", "chaoxinggroupdrive", "chaoxinggroup"],
    create: (addition, storageConfig) =>
      new DriverChaoXing(addition, async (cookie: string) => {
        await persistStorageAddition(
          storageConfig,
          "chaoxing",
          (stAddition) => {
            stAddition.cookie = cookie
          },
          { what: "cookie" },
        )
      }),
  },
  {
    // 123 云盘（个人版）。别名 "123"。
    // "123PanShare"/"123panshare" 已移交给 Pan123ShareDriver（F-090），
    // 不再使用 startsWith("123") 模糊匹配。
    names: ["123pan", "123"],
    create: (addition, storageConfig) =>
      new Pan123Driver(addition, async (token: string) => {
        // 回写刷新后的 access_token，冷启动可跳过密码登录
        // （避免海外 IP 触发 123 风控）。
        await persistStorageAddition(
          storageConfig,
          "123Pan",
          (stAddition) => {
            stAddition.access_token = token
          },
          { what: "access_token" },
        )
      }),
  },
  {
    // 百度网盘相册。
    names: ["baiduphoto", "baiduphotos"],
    create: (addition) => new DriverBaiduPhoto(addition),
  },
  {
    // 百度网盘。别名：baidu / baidu_yun / baidu_share。
    names: ["baidunetdisk", "baidu", "baiduyun", "baidushare"],
    create: (addition, storageConfig) =>
      new BaiduDriver(addition, async (tokens) => {
        await persistStorageAddition(
          storageConfig,
          "baidu_netdisk",
          (stAddition) => {
            stAddition.access_token = tokens.access_token
            stAddition.refresh_token = tokens.refresh_token
          },
          { what: "token", serialize: normalizeBaiduAddition },
        )
      }),
  },
  {
    // GitHub API。
    names: ["github", "githubapi"],
    create: (addition) => new GithubDriver(addition),
  },
  {
    // 迅雷（专家版）。别名：thunder_browser_expert / thunder_x_expert。
    names: ["thunderexpert", "thunderbrowserexpert", "thunderxexpert"],
    create: (addition, storageConfig) =>
      new ThunderExpertDriver(addition, async (tokens) => {
        if (tokens.device_id) addition.device_id = tokens.device_id
        if (tokens.refresh_token) addition.refresh_token = tokens.refresh_token
        if (tokens.captcha_token) addition.captcha_token = tokens.captcha_token
        storageConfig.addition = JSON.stringify(addition)
        await persistStorageAddition(
          storageConfig,
          "thunderexpert",
          (stAddition) => {
            if (tokens.refresh_token)
              stAddition.refresh_token = tokens.refresh_token
            if (tokens.captcha_token)
              stAddition.captcha_token = tokens.captcha_token
            if (tokens.device_id) stAddition.device_id = tokens.device_id
          },
          { what: "token" },
        )
      }),
  },
  {
    // 迅雷。别名：xunlei / thunder_browser / thunder_x。
    names: ["thunder", "xunlei", "thunderbrowser", "thunderx"],
    create: (addition, storageConfig) =>
      new ThunderDriver(addition, async (tokens) => {
        if (tokens.device_id) addition.device_id = tokens.device_id
        if (tokens.refresh_token) addition.refresh_token = tokens.refresh_token
        if (tokens.captcha_token) addition.captcha_token = tokens.captcha_token
        storageConfig.addition = JSON.stringify(addition)
        await persistStorageAddition(
          storageConfig,
          "thunder",
          (stAddition) => {
            if (tokens.refresh_token)
              stAddition.refresh_token = tokens.refresh_token
            if (tokens.captcha_token)
              stAddition.captcha_token = tokens.captcha_token
            if (tokens.device_id) stAddition.device_id = tokens.device_id
          },
          { what: "token" },
        )
      }),
  },
  {
    // 蓝奏云。别名：lanzou_pan / ilanzou / lanzoui / lanzous。
    names: ["lanzou", "lanzoupan", "ilanzou", "lanzoui", "lanzous"],
    create: (addition, storageConfig) =>
      new LanzouDriver(addition, async (cookie) => {
        await persistStorageAddition(
          storageConfig,
          "Lanzou",
          (stAddition) => {
            stAddition.cookie = cookie
          },
          { what: "cookie" },
        )
      }),
  },
  {
    // 城通网盘。别名：ctfile_pan / ctfile_driver / 400gb。
    names: ["ctfile", "ctfilepan", "ctfiledriver", "400gb"],
    create: (addition) => new CtFileDriver(addition),
  },
  {
    // 天翼云盘（TV 版）。别名：cloud189_tv / 189_tv_cloud。
    names: ["189tv", "cloud189tv", "189tvcloud"],
    create: (addition, storageConfig) =>
      new Driver189TV(addition, async (accessToken: string) => {
        await persistStorageAddition(
          storageConfig,
          "189TV",
          (stAddition) => {
            stAddition.access_token = accessToken
          },
          { what: "access_token" },
        )
      }),
  },
  {
    // 天翼云盘。别名：189_cloud / cloud189 / ctyun / 189_pan /
    // 189_cloud_pc / 189_cloud_app。
    names: [
      "189",
      "189cloud",
      "cloud189",
      "ctyun",
      "189pan",
      "189cloudpc",
      "189cloudapp",
    ],
    create: (addition) => new Cloud189Driver(addition),
  },
  {
    // WebDAV。别名 "webdav_driver"。
    names: ["webdav", "webdavdriver"],
    create: (addition) => new WebdavDriver(addition),
  },
  {
    // Cloudflare R2。别名：cloudflare_r2 / cfr2 / r2_native。
    names: ["r2", "cloudflarer2", "cfr2", "r2native"],
    create: (addition) => new R2Driver(addition),
  },
  {
    // S3 兼容家族（r2 已由上一独立条目接管）。
    names: ["s3", "doge", "dogecloud", "minio", "ceph", "aws", "b2", "cos", "oss"],
    create: (addition, storageConfig) =>
      new S3Driver(addition, storageConfig.driver || "S3"),
  },
  {
    // 联通云盘。别名：unicom / unicom_cloud / woyun / china_unicom。
    names: ["wopan", "unicom", "unicomcloud", "woyun", "chinaunicom"],
    create: (addition, storageConfig) =>
      new WoPanDriver(addition, async (accessToken, refreshToken) => {
        await persistStorageAddition(
          storageConfig,
          "WoPan",
          (stAddition) => {
            stAddition.access_token = accessToken
            stAddition.refresh_token = refreshToken
          },
          { what: "tokens", serialize: normalizeWoPanAddition },
        )
      }),
  },
  {
    // 腾讯微云。别名：tencent_weiyun / tx_weiyun。
    names: ["weiyun", "tencentweiyun", "txweiyun"],
    create: (addition, storageConfig) =>
      new WeiyunDriver(addition, async (cookie) => {
        await persistStorageAddition(
          storageConfig,
          "WeiYun",
          (stAddition) => {
            stAddition.cookies = cookie
          },
          { what: "cookies", serialize: normalizeWeiyunAddition },
        )
      }),
  },
  {
    // PikPak 个人版。分享版独立注册在下方（F-090）。
    names: ["pikpak"],
    create: (addition, storageConfig) =>
      new PikPakDriver(addition, async (tokens) => {
        await persistStorageAddition(
          storageConfig,
          "PikPak",
          (stAddition) => {
            stAddition.refresh_token = tokens.refreshToken
            if (tokens.captchaToken) {
              stAddition.captcha_token = tokens.captchaToken
            }
          },
          { what: "tokens" },
        )
      }),
  },
  {
    names: ["seafile"],
    create: (addition, storageConfig) =>
      new SeafileDriver(addition, async (token) => {
        await persistStorageAddition(
          storageConfig,
          "Seafile",
          (stAddition) => {
            stAddition.token = token
          },
          { what: "token" },
        )
      }),
  },
  {
    // Yandex Disk。别名：yandex_disk / yandex_drive。
    names: ["yandex", "yandexdisk", "yandexdrive"],
    create: (addition, storageConfig) =>
      new YandexDriver(addition, async (tokens) => {
        await persistStorageAddition(
          storageConfig,
          "Yandex",
          (stAddition) => {
            stAddition.refresh_token = tokens.refreshToken
          },
          { what: "token" },
        )
      }),
  },
  {
    // Terabox。别名 "dubox"。
    names: ["terabox", "dubox"],
    create: (addition) => new TeraboxDriver(addition),
  },
  {
    // 115 分享（F-090：独立条目，不再被 startsWith("115") 截胡）。
    names: ["115share", "115sharelink"],
    create: (addition) => new Pan115ShareDriver(addition),
  },
  {
    // 123 分享（F-090：不再被 startsWith("123")/123panshare 个人分支截胡）。
    names: ["123share", "123panshare", "123link"],
    create: (addition) => new Pan123ShareDriver(addition),
  },
  {
    // 阿里云盘分享（F-090：不再被 includes("aliyun") 截胡）。
    names: ["aliyundriveshare", "aliyunshare", "alishare"],
    create: (addition) => new AliyundriveShareDriver(addition),
  },
  {
    // OneDrive 分享链接（F-090：不再被 startsWith("onedrive") 截胡）。
    names: ["onedrivesharelink", "onedriveshare", "sharepointshare"],
    create: (addition) => new OnedriveSharelinkDriver(addition),
  },
  {
    // PikPak 分享（F-090：不再被 includes("pikpak") 截胡）。
    names: ["pikpakshare"],
    create: (addition) => new PikPakShareDriver(addition),
  },
  {
    // MediaTrack。别名 "fenmiao"。
    names: ["mediatrack", "fenmiao"],
    create: (addition) => new MediatrackDriver(addition),
  },
  {
    names: ["alias"],
    create: (addition) => new AliasDriver(addition),
  },
  {
    names: ["dropbox"],
    create: (addition, storageConfig) =>
      new DropboxDriver(addition, async (tokens) => {
        await persistStorageAddition(
          storageConfig,
          "Dropbox",
          (stAddition) => {
            stAddition.access_token = tokens.accessToken
            stAddition.refresh_token = tokens.refreshToken
          },
          { what: "token" },
        )
      }),
  },
  {
    // WPS。别名 "kdocs"（旧实现靠 includes("kdocs") 命中）。
    names: ["wps", "kdocs"],
    create: (addition) => new WpsDriver(addition),
  },
  {
    // 移动云盘。别名：mobile_cloud / cmcc / china_mobile。
    names: ["mopan", "mobilecloud", "cmcc", "chinamobile"],
    create: (addition, storageConfig) =>
      new MoPanDriver(addition, async (deviceInfo, token) => {
        await persistStorageAddition(
          storageConfig,
          "MoPan",
          (stAddition) => {
            stAddition.device_info = deviceInfo
            // 去掉 Bearer 前缀后再入库
            stAddition.token = token.replace(/^Bearer\s+/i, "")
          },
          { what: "tokens" },
        )
      }),
  },
  {
    // 139 云盘。别名：139_yun / caiyun / hecaiyun。
    // 上游 #164/#190 同步：第二回调持久化登录状态（SMS 验证码登录 /
    // authorization + user_domain_id + mail_cookies + sms_code）。
    names: ["139", "139yun", "caiyun", "hecaiyun"],
    create: (addition, storageConfig) =>
      new Yun139Driver(
        addition,
        async (authorization) => {
          await persistStorageAddition(
            storageConfig,
            "139",
            (stAddition) => {
              stAddition.authorization = authorization
            },
            {
              what: "refreshed authorization",
              syncInFlight: true,
              respectDeferral: true,
            },
          )
        },
        async (state) => {
          await persistStorageAddition(
            storageConfig,
            "139",
            (stAddition) => {
              if (state.authorization)
                stAddition.authorization = state.authorization
              if (state.userDomainId) {
                stAddition.user_domain_id = state.userDomainId
              }
              stAddition.mail_cookies = state.mailCookies
              stAddition.sms_code = state.smsCode
            },
            {
              what: "login state",
              syncInFlight: true,
              respectDeferral: true,
            },
          )
        },
      ),
  },
  {
    // MEGA。别名 "mega_nz"。上游 #166 同步：会话持久化回调——冷启动用
    // 持久化的 sid/master key 恢复会话，跳过重新登录（也就跳过 Hashcash）。
    names: ["mega", "meganz"],
    create: (addition, storageConfig) =>
      new MegaDriver(addition, async (session) => {
        await persistStorageAddition(
          storageConfig,
          "Mega",
          (stAddition) => {
            if (
              stAddition.sid === session.sid &&
              stAddition.master_key === session.masterKey
            ) {
              return
            }
            stAddition.sid = session.sid
            stAddition.master_key = session.masterKey
          },
          {
            what: "persisted session",
            syncInFlight: true,
            respectDeferral: true,
          },
        )
      }),
  },
  {
    // SMB/CIFS。别名 "samba" / "cifs"。
    names: ["smb", "samba", "cifs"],
    create: (addition) => new SMBDriver(addition),
  },
  {
    names: ["crypt"],
    create: (addition) => new CryptDriver(addition),
  },
  {
    names: ["virtual"],
    create: (addition) => new VirtualDriver(addition),
  },
  {
    // AList V3/V2。别名 "alist" / "alist_v2"。
    names: ["alistv3", "alist", "alistv2"],
    create: (addition, storageConfig) =>
      new AListV3Driver(addition, async (token: string) => {
        await persistStorageAddition(
          storageConfig,
          "alist_v3",
          (stAddition) => {
            stAddition.token = token
          },
          { what: "token" },
        )
      }),
  },
  {
    // URL 树。别名 "urls_tree"。
    names: ["urltree", "urlstree"],
    create: (addition, storageConfig) =>
      new UrlTreeDriver(addition, async (urlStructure: string) => {
        await persistStorageAddition(
          storageConfig,
          "url_tree",
          (stAddition) => {
            stAddition.url_structure = urlStructure
          },
          { what: "structure" },
        )
      }),
  },
  {
    names: ["strm"],
    create: (addition) => new StrmDriver(addition),
  },
  {
    names: ["chunk"],
    create: (addition) => new ChunkDriver(addition),
  },
  {
    // Azure Blob。别名：azure / azblob。
    names: ["azureblob", "azure", "azblob"],
    create: (addition) => new AzureBlobDriver(addition),
  },
  {
    // 又拍云 USS。别名 "upyun"。
    names: ["uss", "upyun"],
    create: (addition) => new UssDriver(addition),
  },
  {
    // Nginx autoindex。别名 "nginx_autoindex"。
    names: ["autoindex", "nginxautoindex"],
    create: (addition) => new AutoIndexDriver(addition),
  },
  {
    // Proton Drive。别名 "proton"。
    names: ["protondrive", "proton"],
    create: (addition) => new ProtonDriveDriver(addition),
  },
  {
    // 阿里文档。别名 "dingtalk_doc"。
    names: ["alidoc", "dingtalkdoc"],
    create: (addition) => new AliDocDriver(addition),
  },
  {
    // Emby。别名 "jellyfin"。
    names: ["emby", "jellyfin"],
    create: (addition) => new EmbyDriver(addition),
  },
  {
    // Bunny Storage。别名：bunny_cdn / bunny。
    names: ["bunnystorage", "bunnycdn", "bunny"],
    create: (addition) => new BunnyStorageDriver(addition),
  },
  {
    // Cloudflare ImgBed。别名：cf_imgbed / cloudflare_image。
    names: ["cloudflareimgbed", "cfimgbed", "cloudflareimage"],
    create: (addition) => new CFImgBedDriver(addition),
  },
  {
    // 光雅盘。别名 "guangya"。
    // 上游 #142 语义：/admin/storage/update 以 deferTokenPersistence 初始化时，
    // 驱动回写的登录态（verification_id / captcha_token / send_code）必须以
    // **in-flight 提交的 addition** 为基底叠加（回读旧库值会把用户本次提交的
    // 配置项回退成旧值），交给 update 处理器的整单保存；非 defer 路径照常落库。
    names: ["guangyapan", "guangya"],
    create: (addition, storageConfig) =>
      new GuangYaPanDriver(addition, async (changes) => {
        try {
          if (
            storageConfig &&
            typeof storageConfig === "object" &&
            deferredTokenPersistence.has(storageConfig)
          ) {
            ;(storageConfig as any).addition = JSON.stringify({
              ...parseAddition(storageConfig),
              ...changes,
            })
            return
          }
          await persistStorageAddition(
            storageConfig,
            "GuangYaPan",
            (stAddition) => {
              // 合并需要持久化的字段（access_token/refresh_token/verification_id/
              // captcha_token/send_code 等），空串用于显式清除一次性字段
              Object.assign(stAddition, changes)
            },
            { what: "changes" },
          )
        } catch (e) {
          console.warn("[GuangYaPan] failed to persist changes:", e)
        }
      }),
  },
]

/** 归一化名称 → 注册项。注册表在模块加载时构建，重复名直接抛错（防止遮蔽回归）。 */
const driverNameIndex = new Map<string, DriverRegistration>()
for (const registration of DRIVER_REGISTRY) {
  for (const name of registration.names) {
    if (driverNameIndex.has(name)) {
      throw new Error(`duplicate driver name '${name}' in DRIVER_REGISTRY`)
    }
    driverNameIndex.set(name, registration)
  }
}

/**
 * 按名称精确解析驱动注册项（仅供测试/诊断；运行期走 createDriver）。
 */
export function findDriverRegistration(
  driverName: string,
): DriverRegistration | undefined {
  return driverNameIndex.get(normalizeDriverName(driverName))
}

/**
 * 创建并初始化存储驱动。
 *
 * F-090/F-271/A5-1：从顺序 if/else-if 链重写为显式注册表，只做归一化后的
 * 精确匹配。name 的规范化仍保持旧语义：小写 + 去掉所有非 a-z0-9 字符
 * （"115_share" → "115share"、"115Open" → "115open"）。
 */
export async function createDriver(
  driverName: string,
  storageConfig?: any,
): Promise<StorageDriver> {
  const normDriver = normalizeDriverName(driverName)

  // local/sftp/ftp 历史上允许不带 storageConfig（由环境/驱动默认值决定）。
  if (
    !storageConfig &&
    normDriver !== "local" &&
    normDriver !== "sftp" &&
    normDriver !== "ftp"
  ) {
    throw new Error(
      "failed get driver: storage config not found for driver " + driverName,
    )
  }

  const registration = driverNameIndex.get(normDriver)
  if (!registration) {
    throw new Error(
      "failed get driver: unsupported driver '" + driverName + "'",
    )
  }

  const driver = await registration.create(
    parseAddition(storageConfig),
    storageConfig,
  )
  if (registration.autoInit !== false) {
    try {
      await driver.init?.()
    } catch (e) {
      if (registration.initErrorLog) {
        console.error(registration.initErrorLog, e)
      }
      throw e
    }
  }
  return driver
}

export async function getDriver(
  driverName: string,
  storageConfig?: any,
  options: GetDriverOptions = {},
): Promise<StorageDriver> {
  const deferTokenPersistence = Boolean(
    options.deferTokenPersistence &&
    storageConfig &&
    typeof storageConfig === "object",
  )
  if (deferTokenPersistence) deferredTokenPersistence.add(storageConfig)

  try {
    const normDriver = normalizeDriverName(driverName)
    if (normDriver === "local") {
      return createDriver(driverName, storageConfig)
    }

    if (!storageConfig) {
      throw new Error(
        "failed get driver: storage config not found for driver " + driverName,
      )
    }

    const cacheKey = `${storageConfig.id}_${storageConfig.modified}`
    const cached = driverCache.get(cacheKey)
    if (cached) return cached

    return await getOrCreateDriver(driverInitCache, cacheKey, async () => {
      const ready = driverCache.get(cacheKey)
      if (ready) return ready
      const driver = await createDriver(driverName, storageConfig)
      setDriverCache(cacheKey, driver)
      return driver
    })
  } finally {
    if (deferTokenPersistence) deferredTokenPersistence.delete(storageConfig)
  }
}

function isCloud189Driver(driverName: string): boolean {
  const normDriver = (driverName || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  return (
    normDriver === "189" ||
    normDriver === "189cloud" ||
    normDriver === "cloud189" ||
    normDriver === "ctyun" ||
    normDriver === "189pan"
  )
}

export async function scheduleStoragePersistence(
  waitUntil: StorageRequestContext["waitUntil"],
  persistence: Promise<unknown>,
): Promise<void> {
  if (waitUntil) {
    try {
      waitUntil(persistence)
      return
    } catch {
      // Fall back to awaiting when the execution context is unavailable.
    }
  }
  await persistence
}

async function persistStorageCookie(
  storageConfig: any,
  cookie: string,
): Promise<void> {
  const storageId = String(storageConfig?.id || "")
  if (!storageId) return

  const previous = cookiePersistenceCache.get(storageId)
  const task = (previous || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const db = await getDb()
      const st = (db.storages || []).find(
        (candidate: any) => String(candidate.id) === storageId,
      )
      if (!st) return

      const stAddition =
        typeof st.addition === "string"
          ? JSON.parse(st.addition || "{}")
          : st.addition || {}
      if (
        stAddition.cookies !== undefined ||
        isWeiyunDriver(storageConfig?.driver)
      ) {
        stAddition.cookies = cookie
      } else {
        stAddition.cookie = cookie
      }
      st.addition = JSON.stringify(stAddition)
      if (String(storageConfig?.id) === storageId) {
        storageConfig.addition = st.addition
      }
      await saveDb(db)
    })

  cookiePersistenceCache.set(storageId, task)
  try {
    await task
  } finally {
    if (cookiePersistenceCache.get(storageId) === task) {
      cookiePersistenceCache.delete(storageId)
    }
  }
}

function isWeiyunDriver(driverName: string): boolean {
  const normDriver = (driverName || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  return (
    normDriver === "weiyun" ||
    normDriver === "tencentweiyun" ||
    normDriver === "txweiyun" ||
    normDriver.includes("weiyun")
  )
}

/**
 * 夸克系驱动。QuarkClient 的 request() 会从 Set-Cookie 轮换 __puus/__pus
 * （quark/util.ts），并通过 consumePendingCookie() 把新 cookie 交给 op 层。
 */
function isQuarkDriver(driverName: string): boolean {
  const normDriver = normalizeDriverName(driverName)
  return (
    normDriver === "quark" ||
    normDriver === "quarkuc" ||
    normDriver === "uc" ||
    normDriver === "quarkcookie"
  )
}

export async function flushPendingDriverState(
  driverName: string,
  storageConfig: any,
  driver: StorageDriver,
  requestContext?: StorageRequestContext,
): Promise<void> {
  // F-322：夸克加入处理名单。旧实现只认 189/weiyun，夸克轮换的
  // __puus/__pus 永远只活在内存里，无状态运行时上新 isolate 仍拿 DB 里的
  // 旧 cookie，全面 401 直到管理员重贴（对齐上游 op.MustSaveDriverStorage）。
  if (
    !isCloud189Driver(driverName) &&
    !isWeiyunDriver(driverName) &&
    !isQuarkDriver(driverName)
  ) {
    return
  }

  const consumePendingCookie = (
    driver as StorageDriver & {
      consumePendingCookie?: () => string | null
    }
  ).consumePendingCookie
  const cookie = consumePendingCookie?.call(driver)
  if (!cookie) return

  const persistence = persistStorageCookie(storageConfig, cookie).catch((e) => {
    console.warn(`[${driverName}] failed to persist cookie:`, e)
  })
  await scheduleStoragePersistence(requestContext?.waitUntil, persistence)
}

/**
 * fs 读操作的入口。
 *
 * 每次调用都直接回源驱动：既没有结果缓存，也没有跨请求/跨实例的调用合并，
 * 目录与元信息始终反映上游的最新状态。
 */
export async function listItems(
  virtualPath: string,
  requestContext?: StorageRequestContext,
): Promise<{ content: FileItem[]; provider: string; storage?: any }> {
  const resolved = await resolvePath(virtualPath, requestContext?.env)
  return listItemsResolved(resolved, virtualPath, requestContext)
}

async function listItemsResolved(
  resolved: Awaited<ReturnType<typeof resolvePath>>,
  virtualPath: string,
  requestContext?: StorageRequestContext,
): Promise<{ content: FileItem[]; provider: string; storage?: any }> {
  let items: FileItem[] = []
  let driverName = "Virtual"

  if (resolved.storage) {
    driverName = resolved.storage.driver
    try {
      const driver = await getDriver(driverName, resolved.storage)
      // Get raw items from driver
      try {
        items = await driver.list(virtualPath, resolved.physical!)
      } finally {
        await flushPendingDriverState(
          driverName,
          resolved.storage,
          driver,
          requestContext,
        )
      }
      if (resolved.storage.status !== "work") {
        resolved.storage.status = "work"
        const db = await getDb(requestContext?.env)
        const st = (db.storages || []).find(
          (s: any) => s.id === resolved.storage?.id,
        )
        if (st) {
          st.status = "work"
          await saveDb(db, requestContext?.env)
        }
      }
    } catch (e: any) {
      try {
        const db = await getDb(requestContext?.env)
        const st = (db.storages || []).find(
          (s: any) => s.id === resolved.storage?.id,
        )
        if (st) {
          st.status = e.message || String(e)
          await saveDb(db, requestContext?.env)
        }
      } catch (persistErr) {
        console.warn("Failed to persist storage status:", persistErr)
      }
      throw e
    }
  } else if (!resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }

  // Merge virtual child storage mounts if we are listing a directory that contains mount points
  const db = await getDb(requestContext?.env)
  const activeStorages = (db.storages || []).filter((s: any) => !s.disabled)
  const cleanListedPath = resolved.cleanPath

  // 挂载点顺序对齐 Go op.getStorageVirtualFilesByPath：
  //   Order 升序；Order 相同时按 MountPath 升序。
  // 此前直接沿用数据库数组顺序，后台存储编辑页里的「序号」因此完全不生效。
  const orderedStorages = [...activeStorages].sort((a: any, b: any) => {
    const orderA = Number(a.order) || 0
    const orderB = Number(b.order) || 0
    if (orderA !== orderB) return orderA - orderB
    const mountA = String(a.mount_path || "")
    const mountB = String(b.mount_path || "")
    return mountA < mountB ? -1 : mountA > mountB ? 1 : 0
  })

  orderedStorages.forEach((s: any) => {
    const mount =
      "/" + (s.mount_path || "").split("/").filter(Boolean).join("/")
    if (mount === cleanListedPath || mount === "/") return

    const prefix = cleanListedPath === "/" ? "/" : cleanListedPath + "/"
    if (mount.startsWith(prefix)) {
      const name = mount.slice(prefix.length).split("/").filter(Boolean)[0]
      if (name && !items.some((f) => f.name === name)) {
        items.push({
          name,
          size: 0,
          is_dir: true,
          modified: s.modified || new Date().toISOString(),
          sign: "",
          type: 1,
        })
      }
    }
  })

  // Ensure all items have calculated types
  items.forEach((item) => {
    if (!item.type) {
      item.type = calcFileType(item.name, item.is_dir)
    }
  })

  return { content: items, provider: driverName, storage: resolved.storage }
}

/**
 * raw_url 使用哪个端点前缀（`/api/p` 还是 `/api/d`）。
 *
 * Go 的 `/p` 在取链接前先跑 `canProxy()`，不通过直接 403 `proxy not allowed`；
 * `/d` 不受该限制（走 `ShouldProxy`）。因此 raw_url 必须与存储自身的代理配置匹配：
 * 拿 `/p` 去请求一个既没开 `web_proxy`、扩展名也不在 `proxy_types` / `text_types`
 * 里的存储，必然 403。
 *
 * 这是 #66 修复后暴露的第二个问题：文件列表走 `/d` 所以正常，而预览页的「下载」
 * 按钮与 `img/video` 的 src 用的是 raw_url（此前恒为 `/api/p`）。
 */
async function resolveRawUrlPrefix(
  storage: any,
  virtualPath: string,
): Promise<string> {
  try {
    const settings: Record<string, any> = await getSettings().catch(
      () => ({}) as Record<string, any>,
    )
    const allowProxy = canUseProxyEndpoint({
      storage,
      driver: storage?.driver || "",
      filename: virtualPath,
      proxyTypes: normalizeExtList(settings.proxy_types),
      textTypes: normalizeExtList(settings.text_types),
    })
    return allowProxy ? "/api/p" : "/api/d"
  } catch {
    // 设置读不到时保持旧行为（/p），由 rawRouter 给出最终结论
    return "/api/p"
  }
}

export async function getItem(
  virtualPath: string,
  requestContext?: StorageRequestContext,
): Promise<{ item: FileItem; provider: string; rawUrl: string }> {
  const resolved = await resolvePath(virtualPath, requestContext?.env)
  return getItemResolved(resolved, virtualPath, requestContext)
}

async function getItemResolved(
  resolved: Awaited<ReturnType<typeof resolvePath>>,
  virtualPath: string,
  requestContext?: StorageRequestContext,
): Promise<{ item: FileItem; provider: string; rawUrl: string }> {
  if (resolved.isVirtual) {
    const name = resolved.cleanPath.split("/").filter(Boolean).pop() || "root"
    return {
      item: {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
      },
      provider: "Virtual",
      rawUrl: "",
    }
  }

  if (resolved.storage && resolved.relative === "/") {
    const name = resolved.cleanPath.split("/").filter(Boolean).pop() || "root"
    const addition = parseAddition(resolved.storage)
    return {
      item: {
        name,
        size: 0,
        is_dir: true,
        modified: resolved.storage.modified || new Date().toISOString(),
        sign: String(addition.root_folder_id || ""),
        type: 1,
        raw_url: "",
      },
      provider: resolved.storage.driver,
      rawUrl: `${await resolveRawUrlPrefix(resolved.storage, virtualPath)}${encodeDownloadPath(virtualPath)}`,
    }
  }

  const driverName = resolved.storage ? resolved.storage.driver : "Local"
  const driver = await getDriver(driverName, resolved.storage)
  let item: FileItem
  try {
    // F-405：CDN 防盗链签名驱动（bunny_storage）需要客户端 IP 参与
    // token 计算；未提供时驱动按无 IP 行为签名，其它驱动忽略第三参。
    const clientIp = requestContext?.clientIp
    item =
      clientIp && clientIp !== "unknown"
        ? await driver.get(virtualPath, resolved.physical!, clientIp)
        : await driver.get(virtualPath, resolved.physical!)
  } finally {
    await flushPendingDriverState(
      driverName,
      resolved.storage,
      driver,
      requestContext,
    )
  }
  if (!item.type) {
    item.type = calcFileType(item.name, item.is_dir)
  }
  return {
    item,
    provider: driverName,
    // 端点前缀按 canProxy() 选（见 resolveRawUrlPrefix），路径必须逐段编码
    // （对齐 Go utils.EncodePath(path, true)）：raw_url 会被前端直接当 href/src
    // 使用，未编码的 `?`/`#` 会被截断、裸 `%` 会让服务端 decodeURIComponent 抛错
    // （见 pkg/path.encodeDownloadPath 注释）。
    rawUrl: `${await resolveRawUrlPrefix(resolved.storage, virtualPath)}${encodeDownloadPath(virtualPath)}`,
  }
}

export async function makeDirectory(
  virtualPath: string,
  requestContext?: StorageRequestContext,
): Promise<void> {
  await assertMetaWritable(virtualPath, requestContext)
  assertWithinUserRoot(virtualPath, requestContext)
  const resolved = await resolvePath(virtualPath, requestContext?.env)
  if (resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  try {
    await driver.mkdir(virtualPath, resolved.physical!)
  } finally {
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
      requestContext,
    )
  }
}

export async function renameItem(
  virtualPath: string,
  newName: string,
  requestContext?: StorageRequestContext,
): Promise<void> {
  await assertMetaWritable(virtualPath, requestContext)
  assertItemName(newName)
  assertWithinUserRoot(virtualPath, requestContext)
  // F-186：同名 rename 必须是 no-op。R2/S3 的 rename 是 copy-then-delete
  // （copyObject(src,dst) 后 delete(src)），src===dst 时先覆盖自身再把对象
  // 删掉；目录同名 rename 还会删光源前缀下的所有顶层对象。按 resolvePath
  // 的同一套解码视图比较，避免 `%20` 之类的编码差异绕过。
  const currentName = virtualPath.slice(virtualPath.lastIndexOf("/") + 1)
  if (decodePathFully(currentName) === decodePathFully(newName)) {
    return
  }
  const resolved = await resolvePath(virtualPath, requestContext?.env)
  if (resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  try {
    await driver.rename(virtualPath, resolved.physical!, newName)
  } finally {
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
      requestContext,
    )
  }
}

export async function removeItems(
  dir: string,
  names: string[],
  requestContext?: StorageRequestContext,
): Promise<void> {
  for (const name of names) {
    assertItemName(name)
    const itemVirtual = `${dir}/${name}`
    await assertMetaWritable(itemVirtual, requestContext)
    assertWithinUserRoot(itemVirtual, requestContext)
    const resolved = await resolvePath(itemVirtual, requestContext?.env)
    if (resolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    try {
      await driver.remove(itemVirtual, resolved.physical!, [name])
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
        requestContext,
      )
    }
  }
}

export async function moveItems(
  srcDir: string,
  dstDir: string,
  names: string[],
  requestContext?: StorageRequestContext,
): Promise<void> {
  // F-186：目标目录等于源目录时 move 必须是 no-op（WebDAV 同路径 MOVE、
  // 客户端重放都会命中）。R2/S3 的 move 同样是 copy-then-delete，
  // src===dst 会先覆盖自身再把对象删掉。尾部斜杠视为同一目录。
  const normalizeDir = (dir: string): string => {
    const decoded = decodePathFully(dir)
    return decoded.length > 1 ? decoded.replace(/\/+$/, "") : decoded
  }
  const sameDir = normalizeDir(srcDir) === normalizeDir(dstDir)
  for (const name of names) {
    assertItemName(name)
    if (sameDir) continue
    const srcVirtual = `${srcDir}/${name}`
    const dstVirtual = `${dstDir}/${name}`
    await assertMetaWritable(srcVirtual, requestContext)
    await assertMetaWritable(dstVirtual, requestContext)
    assertWithinUserRoot(srcVirtual, requestContext)
    assertWithinUserRoot(dstVirtual, requestContext)
    const srcResolved = await resolvePath(srcVirtual, requestContext?.env)
    const dstResolved = await resolvePath(dstVirtual, requestContext?.env)
    if (srcResolved.isVirtual || dstResolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    // 源与目标解析到不同存储时，绝不能把「目标的物理路径」交给「源存储的驱动」：
    // local 驱动会直接写到宿主机上的另一个位置，其它驱动则把别的存储的命名空间
    // 当成本驱动的路径。跨存储搬运需要下载+上传两条链路，这里不支持。
    assertSameStorage(srcResolved, dstResolved)

    const driver = await getDriver(
      srcResolved.storage!.driver,
      srcResolved.storage,
    )
    // F-186 加固（复核建议）：目录 move 进自身子树是 copy-then-delete 的另一个
    // 破坏性场景 —— R2/S3 的目录 move 是 copyDirRecursive 后 removeDirRecursive，
    // 目标落在源子树内时刚复制出的内容会被源前缀删除连带清掉。仅当目标解析路径
    // 落在源项路径之下才需要甄别：文件移动即使目标键在源键前缀下也无害（delete
    // 只删精确键），用 driver.get 探测源项是否为目录；探测失败不阻断（随后
    // driver.move 自身会报源不存在）。解析后同一路径（如「/a」与「/a/../a」，
    // 逃过上面的字面 sameDir 比较）按 no-op 跳过。
    if (dstResolved.cleanPath === srcResolved.cleanPath) continue
    if (dstResolved.cleanPath.startsWith(`${srcResolved.cleanPath}/`)) {
      let sourceIsDir = false
      try {
        const probe = await driver.get(srcVirtual, srcResolved.physical!)
        sourceIsDir = !!probe?.is_dir
      } catch {
        // 探测失败按非目录放行：真正的源缺失由 driver.move 报错
      }
      if (sourceIsDir) {
        throw new Error(
          "failed to move: cannot move a directory into its own subtree",
        )
      }
    }
    try {
      await driver.move(
        srcDir,
        dstDir,
        [name],
        srcResolved.physical!,
        dstResolved.physical!,
      )
    } finally {
      await flushPendingDriverState(
        srcResolved.storage!.driver,
        srcResolved.storage,
        driver,
        requestContext,
      )
    }
  }
}

export async function copyItems(
  srcDir: string,
  dstDir: string,
  names: string[],
  requestContext?: StorageRequestContext,
): Promise<void> {
  for (const name of names) {
    assertItemName(name)
    const srcVirtual = `${srcDir}/${name}`
    const dstVirtual = `${dstDir}/${name}`
    await assertMetaWritable(srcVirtual, requestContext)
    await assertMetaWritable(dstVirtual, requestContext)
    assertWithinUserRoot(srcVirtual, requestContext)
    assertWithinUserRoot(dstVirtual, requestContext)
    const srcResolved = await resolvePath(srcVirtual, requestContext?.env)
    const dstResolved = await resolvePath(dstVirtual, requestContext?.env)
    if (srcResolved.isVirtual || dstResolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    // 源与目标解析到不同存储时，绝不能把「目标的物理路径」交给「源存储的驱动」：
    // local 驱动会直接写到宿主机上的另一个位置，其它驱动则把别的存储的命名空间
    // 当成本驱动的路径。跨存储搬运需要下载+上传两条链路，这里不支持。
    assertSameStorage(srcResolved, dstResolved)

    const driver = await getDriver(
      srcResolved.storage!.driver,
      srcResolved.storage,
    )
    try {
      await driver.copy(
        srcDir,
        dstDir,
        [name],
        srcResolved.physical!,
        dstResolved.physical!,
      )
    } finally {
      await flushPendingDriverState(
        srcResolved.storage!.driver,
        srcResolved.storage,
        driver,
        requestContext,
      )
    }
  }
}

export async function putItem(
  virtualPath: string,
  // Uint8Array 而非 Node Buffer：ESA 等边缘运行时没有全局 Buffer（Issue #169）
  content: Uint8Array,
  requestContext?: StorageRequestContext,
): Promise<void> {
  await assertMetaWritable(virtualPath, requestContext)
  assertWithinUserRoot(virtualPath, requestContext)
  const resolved = await resolvePath(virtualPath, requestContext?.env)
  if (resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  try {
    await driver.put(virtualPath, resolved.physical!, content)
  } finally {
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
      requestContext,
    )
  }
}

/**
 * 媒体刮削读取文件内容的上限：任何一次读取都不得超过 32MB。
 *
 * 刮削只需要文件头（ID3/FLAC/图片头）或尾部（ID3v1 / ZIP 中央目录），
 * 但少数存储不支持 Range，会退化成整文件下载，因此必须有硬上限。
 */
export const MAX_MEDIA_READ_BYTES = 32 * 1024 * 1024

/** 本地存储的区间读取（Node 运行时；Worker 下 import 会失败并返回 null） */
async function readLocalRange(
  physicalPath: string,
  start: number,
  want: number,
): Promise<Uint8Array | null> {
  try {
    const fs = await import("node:fs/promises")
    const fh = await fs.open(physicalPath, "r")
    try {
      const size = (await fh.stat()).size
      if (start >= size) return new Uint8Array(0)
      const len = Math.min(want, size - start)
      const buf = new Uint8Array(len)
      const { bytesRead } = await fh.read(buf, 0, len, start)
      return buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/**
 * 读取 VFS 文件的指定区间（用于 ID3 标签、EPUB 封面、图片缩略图等）。
 *
 * 行为：
 *   1. 通过驱动换链拿到 raw_url，再带 `Range` 请求；
 *   2. 上游返回 206 时直接切片；
 *   3. 上游忽略 Range 返回 200 时，流式丢弃 `offset` 字节后最多读 `length` 字节，
 *      避免把整个大文件读进内存；
 *   4. 任何失败返回 null（刮削属于尽力而为，不应中断主流程）。
 */
export async function readFileRange(
  virtualPath: string,
  offset: number,
  length: number,
  requestContext?: StorageRequestContext,
): Promise<Uint8Array | null> {
  const start = Math.max(0, Math.floor(offset) || 0)
  const want = Math.min(
    MAX_MEDIA_READ_BYTES,
    Math.max(1, Math.floor(length) || 1),
  )
  let resolved: Awaited<ReturnType<typeof resolvePath>>
  try {
    resolved = await resolvePath(virtualPath, requestContext?.env)
  } catch {
    return null
  }
  if (resolved.isVirtual || !resolved.storage) return null

  let item: FileItem
  const driver = await getDriver(resolved.storage.driver, resolved.storage)
  try {
    item = await driver.get(virtualPath, resolved.physical!)
  } catch (e: any) {
    console.warn(`[op] read ${virtualPath} link failed:`, e?.message || e)
    return null
  } finally {
    await flushPendingDriverState(
      resolved.storage.driver,
      resolved.storage,
      driver,
      requestContext,
    )
  }
  if (!item?.raw_url) {
    // LocalDriver 没有 raw_url（本地文件不走 HTTP）。Node 运行时直接读区间，
    // 否则本地存储的音频/图片永远读不到标签与封面（PR #148 评审 #25）。
    if (resolved.storage.driver === "local") {
      return readLocalRange(resolved.physical!, start, want)
    }
    return null
  }

  const headers: Record<string, string> = {
    ...(item.raw_url_headers || {}),
    Range: `bytes=${start}-${start + want - 1}`,
  }
  try {
    // 手动跟随重定向：默认 fetch 会自动跳转，既绕过 SSRF 校验，也会把
    // raw_url_headers（Cookie/Authorization）原样带给第三方。每一跳都重新
    // 校验目标地址，跨域时丢弃凭据头（对齐 server/raw.ts 的 safeProxyFetch）。
    let currentUrl = item.raw_url
    let currentHeaders: Record<string, string> = { ...headers }
    let res: Response | null = null
    for (let hop = 0; hop < 5; hop++) {
      // 首跳地址来自管理员配置的驱动（可能是有意为之的内网存储），不做
      // SSRF 拦截；后续每一跳都必须重新校验，防止公网地址 302 到内网。
      if (hop > 0) {
        let safe = false
        try {
          safe = isSafeUrl(currentUrl)
        } catch {
          safe = false
        }
        if (!safe) return null
      }
      res = await fetch(currentUrl, {
        headers: currentHeaders,
        redirect: "manual",
      })
      if (res.status < 300 || res.status >= 400) break
      const loc = res.headers.get("location")
      if (!loc) return null
      let next: URL
      try {
        next = new URL(loc, currentUrl)
      } catch {
        return null
      }
      if (next.origin !== new URL(currentUrl).origin) {
        currentHeaders = { Range: currentHeaders.Range }
      }
      try {
        await res.body?.cancel()
      } catch {
        /* ignore */
      }
      currentUrl = next.toString()
    }
    if (!res) return null
    if (!res.ok && res.status !== 206) return null

    if (res.status === 206) {
      const buf = new Uint8Array(await res.arrayBuffer())
      return buf.subarray(0, Math.min(buf.length, want))
    }

    // 200：上游忽略了 Range（或本地文件驱动）。流式跳过 offset。
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer())
      return buf.subarray(start, start + want)
    }
    const reader = res.body.getReader()
    let skipped = 0
    const chunks: Uint8Array[] = []
    let received = 0
    try {
      while (received < want) {
        const { done, value } = await reader.read()
        if (done || !value) break
        let chunk = value
        if (skipped < start) {
          const drop = Math.min(chunk.length, start - skipped)
          skipped += drop
          chunk = chunk.subarray(drop)
          if (chunk.length === 0) continue
        }
        const take = Math.min(chunk.length, want - received)
        chunks.push(chunk.subarray(0, take))
        received += take
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
    }
    if (chunks.length === 0) return null
    const out = new Uint8Array(received)
    let pos = 0
    for (const c of chunks) {
      out.set(c, pos)
      pos += c.length
    }
    return out
  } catch (e: any) {
    console.warn(`[op] read ${virtualPath} range failed:`, e?.message || e)
    return null
  }
}
