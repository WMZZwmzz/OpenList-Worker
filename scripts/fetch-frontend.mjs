/**
 * 从官方前端 OpenList-Frontend 获取构建产物 (dist/)。
 *
 * OpenListNext(TSWorker) 后端不再维护内嵌前端源码，前端统一由官方仓库
 * OpenList-Frontend 提供（通过 backend 字段在运行时探测 GO/TS 模式）。
 *
 * 产物来源优先级（高 -> 低）：
 *   1. FRONTEND_DIST 环境变量：已构建好的 dist 目录路径（最快，CI 缓存场景）
 *   2. FRONTEND_REPO 环境变量：本地官方前端仓库路径（自动 install + build）
 *   3. 同级目录 ../OpenList-Frontend（monorepo 布局，自动探测，自动 install + build）
 *   4. 默认：下载 npm 上【已发布】且兼容 Worker 初始化协议的 dist（版本取
 *      registry 的 latest，可用 FRONTEND_VERSION 固定）
 *   5. 发布版尚未包含 Worker 初始化协议，或 FRONTEND_BUILD_FROM_SOURCE=1：
 *      从 Git 克隆前端 main 分支并现构建
 *
 * 为什么默认取「已发布 dist」而不是「克隆 main 现构建」：
 *   前端产物是内容哈希文件名（/assets/index-XXXX.js），而 CDN（jsdelivr /
 *   unpkg / npmmirror）提供的正是 npm 包里那一份 dist。若本地从 main 现构建，
 *   哈希与 CDN 上的不一致，ASSET_URLS 的「路径 A」（下发本地 index.html +
 *   CDN 资产，见 src/backend/server/assets.ts）HEAD 探测必然失败，只能退化到
 *   拉 CDN 的 index.html；而 npmmirror 等镜像禁止访问 .html（451），于是 CDN
 *   完全用不了。取已发布 dist 可让两边哈希天然同源：路径 A 命中，npmmirror
 *   可用（等价 Go Release 版行为）。同时 stampFrontendVersion 会把该版本号写进
 *   index.html，使 ASSET_URLS 的 $version 正好解析到这份 dist 对应的版本。
 *
 * 已发布包可能落后于 Worker 后端。只有同时包含 /public/init_status 与 /@init
 * 的产物才可使用；否则全新部署会只请求会被 503 拦截的 /public/settings，既不
 * 显示初始化向导也无法创建管理员。遇到这种版本会自动改为构建前端 main。
 *
 * 用法：
 *   FRONTEND_DIST=/path/to/dist node scripts/fetch-frontend.mjs
 *   FRONTEND_REPO=../OpenList-Frontend node scripts/fetch-frontend.mjs
 *   FRONTEND_VERSION=4.2.6 node scripts/fetch-frontend.mjs
 *   FRONTEND_BUILD_FROM_SOURCE=1 node scripts/fetch-frontend.mjs
 *   FRONTEND_GIT_SHA=<40位commit> node scripts/fetch-frontend.mjs   # 源码构建固定 commit
 *   node scripts/fetch-frontend.mjs
 *
 * 完整性（详见「下载物完整性校验」一节）：npm tarball 用 registry 的
 * dist.integrity/shasum，i18n 用 GitHub Release asset.digest；都可用
 * FRONTEND_SHA512 / I18N_SHA256 显式固定，拿不到锚点即中断（ALLOW_UNVERIFIED=1 降级）。
 */

import { execSync, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 始终以仓库根目录为基准（无论从哪个 cwd 调用）
const ROOT = path.resolve(__dirname, "..")
const DEST = path.join(ROOT, "dist")

// ── OpenList Moe 主题（构建期注入，详见 theme/openlist-moe/UPSTREAM.md）────
const THEME_DIR = path.join(ROOT, "theme", "openlist-moe")
const THEME_ASSETS = ["OpenList-Moe.min.css", "OpenList-Moe.min.js"]
// 本站覆盖样式（非上游产物）：加载在主题 CSS 之后，用于微调面包屑/提示卡等表现
const SITE_CSS = "site-overrides.css"
// 界面字体 → dist 根目录同源提供（[源目录, 文件名]）：
//   Zen Maru Gothic Medium：SIL OFL 1.1，只裁了拉丁子集。
//   loli-cjk：汉字子集，取自 Heiti TC Light（SinoType/Apple 专有字体）的改版副本，
//     授权不可再分发 —— 由站点所有者知情后决定随本仓库提供，不要把它当作可自由
//     转用的资源。重新裁切：
//       python -m fontTools.subset loli.ttf \
//         --unicodes=U+3000-303F,U+4E00-9FFF,U+FE30-FE4F,U+FF01-FF65,U+FFE0-FFE6 \
//         --flavor=woff2 --layout-features='*' --output-file=loli-cjk.woff2
const FONT_ASSETS = [
  ["zenmarugothic", "ZenMaruGothic-Medium.woff2"],
  ["loli-cjk", "loli-cjk.woff2"],
]
// 官方前端 index.html 自带的占位注释（上游 Go 版在此处做运行时替换）。
// 注入时保留注释本身，后续若实现运行时 customize_head 注入仍能定位锚点。
const MARK_HEAD = "<!-- customize head -->"
const MARK_BODY = "<!-- customize body -->"
// 主题强调色兜底值（OpenList 默认主色 #1890ff → "24 144 255"，见
// src/backend/internal/model/db.ts 的 main_color 默认项）。
const THEME_COLOR_RGB = "24 144 255"

const OFFICIAL_REPO_URL =
  process.env.FRONTEND_GIT_URL ||
  "https://github.com/OpenListTeam/OpenList-Frontend.git"
const OFFICIAL_REPO_REF = process.env.FRONTEND_GIT_REF || "main"
// 源码构建固定到不可变 commit（生产/CI 建议设置）。留空则按浮动分支克隆并告警。
const OFFICIAL_REPO_SHA = (process.env.FRONTEND_GIT_SHA || "").trim()

// 已发布 dist 的来源（默认路径）。ASSET_URLS 指向的 CDN 提供的正是这份 npm
// 包内容，取它才能保证内容哈希与 CDN 同源（见文件头说明）。
const REGISTRY_URL =
  process.env.FRONTEND_REGISTRY || "https://registry.npmjs.org"
const PKG_NAME =
  process.env.FRONTEND_PKG || "@openlist-frontend/openlist-frontend"

// 多语言翻译包：官方前端仓库不提交非英文翻译（由 Crowdin 维护），随 release 发布。
// 直接 pnpm build 只会得到英文界面，因此 CF/EO 构建时需在此拉取后再构建。
const I18N_TAR_URL =
  process.env.I18N_URL ||
  "https://github.com/OpenListTeam/OpenList-Frontend/releases/download/edge/i18n.tar.gz"

function run(cmd, opts = {}) {
  console.log(`  > ${cmd}`)
  execSync(cmd, { stdio: "inherit", shell: true, ...opts })
}

/**
 * 不经过 shell 的参数数组形式执行：凡参数里含外部输入（env 变量、registry 返回
 * 的 tarball URL、仓库地址/分支）都必须走这里，否则 `"$(...)"` 之类在双引号内
 * 仍会被 shell 展开执行（SEC-018）。
 */
function runArgv(file, args, opts = {}) {
  console.log(`  > ${file} ${args.join(" ")}`)
  execFileSync(file, args, { stdio: "inherit", ...opts })
}

/** 同 runArgv，但取回 stdout（用于 rev-parse 这类需要读结果的调用） */
function captureArgv(file, args, opts = {}) {
  return execFileSync(file, args, { encoding: "utf-8", ...opts })
}

/**
 * 即便走 argv，以 `-` 开头的值仍会被 git/curl 当成选项解析（例如
 * `FRONTEND_GIT_REF=--upload-pack=...`），所以外部传入的 ref/url 还要过白名单。
 */
function assertSafeGitRef(ref) {
  if (
    typeof ref !== "string" ||
    ref.startsWith("-") ||
    !/^[A-Za-z0-9._/-]{1,200}$/.test(ref)
  ) {
    throw new Error(`unsafe FRONTEND_GIT_REF: ${JSON.stringify(ref)}`)
  }
}

/** 只接受 hex commit，排除一切可被 git 解析成 ref/选项的写法 */
function assertSafeGitSha(sha) {
  if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error(`unsafe FRONTEND_GIT_SHA: ${JSON.stringify(sha)}`)
  }
}

function assertSafeGitUrl(url) {
  if (
    typeof url !== "string" ||
    url.startsWith("-") ||
    !/^(https?:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url)
  ) {
    throw new Error(`unsafe FRONTEND_REPO_URL: ${JSON.stringify(url)}`)
  }
}

function assertHttpUrl(url, what) {
  if (typeof url !== "string" || !/^https?:\/\/[^\s]+$/.test(url)) {
    throw new Error(`unsafe ${what}: ${JSON.stringify(url)}`)
  }
}

// ── 下载物完整性校验（SEC-046）───────────────────────────────────────────────
//
// 这两个 tarball 的字节流决定最终产物里跑的是谁写的 JS，而两条链路原本都只做
// 「下载 → 解包」，一步到位：registry 的 dist.tarball 与 GitHub Release 资源都被
// 当成不可信输入（镜像站被投毒 / CDN 缓存污染 / 传输被改写时无人发现）。
//
// 锚点选择：
//   - npm：用同一次 registry 元数据响应里的 dist.integrity(SRI sha512) 或
//     dist.shasum(sha1)。元数据是 JSON、tarball 是二进制，两者走不同链路，
//     能挡住「tarball 被换掉但元数据没同步」这一类攻击，也是 npm 客户端的做法。
//   - i18n：GitHub Release API 的 asset.digest（形如 "sha256/<hex>"）。
// 校验失败一律中断构建；拿不到锚点时同样中断，除非显式设 ALLOW_UNVERIFIED=1
// （与 I18N_OPTIONAL 同一套「默认失败、降级需显式声明」的约定）。

function hashFile(file, algo) {
  const h = createHash(algo)
  h.update(fs.readFileSync(file))
  return h
}

function unverifiedAllowed() {
  return process.env.ALLOW_UNVERIFIED === "1"
}

/** SRI（sha512-<base64>）或 hex 摘要；返回 null 表示元数据里没有可用锚点 */
function matchesSri(file, sri) {
  const m = /^(sha512|sha384|sha256)-([^=]+)$/.exec(String(sri || ""))
  if (!m) return false
  const b64 = hashFile(file, m[1]).digest("base64")
  return b64 === m[2]
}

/**
 * 按锚点顺序校验下载物：值形如 `sha512-<base64>` 走 SRI 比较，否则按 a.algo 做
 * hex 比较。锚点存在但不匹配 = 投毒或链路污染，直接抛错；一个锚点都拿不到时
 * 同样中断，除非显式 ALLOW_UNVERIFIED=1。
 */
function verifyOrThrow(file, anchors, what) {
  for (const a of anchors) {
    const value = String(a.value || "").trim()
    if (!value) continue
    if (/^sha\d+-/.test(value)) {
      if (matchesSri(file, value)) {
        console.log(
          `  [integrity] ${what} 校验通过（${value.split("-")[0]} SRI）`,
        )
        return
      }
      throw new Error(
        `[integrity] ${what} 摘要不匹配（期望 SRI ${value}）—— 下载内容与元数据不一致，拒绝解包`,
      )
    }
    const hex = hashFile(file, a.algo).digest("hex")
    if (hex === value.toLowerCase()) {
      console.log(`  [integrity] ${what} 校验通过（${a.algo}）`)
      return
    }
    throw new Error(
      `[integrity] ${what} 摘要不匹配（${a.algo} 期望 ${value}，实际 ${hex}）—— 拒绝解包`,
    )
  }
  if (unverifiedAllowed()) {
    console.warn(
      `  [integrity] ${what} 无可用的摘要锚点，ALLOW_UNVERIFIED=1，已降级继续`,
    )
    return
  }
  throw new Error(
    `[integrity] ${what} 拿不到摘要锚点（registry dist.integrity/shasum 或 Release asset.digest 均缺失），已中断构建。确认来源可信可设 ALLOW_UNVERIFIED=1`,
  )
}

/** GitHub Release 资源摘要：GET api.github.com/repos/<o>/<r>/releases/tags/<tag> */
async function githubAssetDigest(url, fileName) {
  const m =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/releases\/download\/([^/\s]+)\/([^/?#\s]+)/.exec(
      String(url || ""),
    )
  if (!m) return ""
  const [, owner, repo, tag, asset] = m
  if (asset !== fileName) return ""
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "openlist-tsworker-fetch-frontend",
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { headers, signal: AbortSignal.timeout(30_000) },
    )
    if (!res.ok) return ""
    const data = await res.json()
    const hit = (data?.assets || []).find((a) => a?.name === fileName)
    const digest = String(hit?.digest || "")
    const dm = /^sha256\/([0-9a-f]{64})$/i.exec(digest)
    return dm ? dm[1] : ""
  } catch {
    return ""
  }
}

function detectPackageManager(dir) {
  return fs.existsSync(path.join(dir, "pnpm-lock.yaml")) ? "pnpm" : "npm"
}

/**
 * 目标仓库锁定了独立的 pnpm 版本（packageManager 字段，如前端仓库 pnpm@11.24.0），
 * 用 npx 按精确版本执行。
 *
 * 不走 corepack：旧版 Node（如 EdgeOne 构建环境的 22.11.0）自带的 corepack
 * 内置 npm 签名密钥已过期（2025-04 registry 密钥轮换），`corepack pnpm` 会报
 * "Cannot find matching keyid" 直接失败；npx 只经 npm 下载，无此问题。
 */
function resolvePmCommand(dir, pm) {
  if (pm !== "pnpm") return { file: pm, args: [] }
  let pinned
  try {
    pinned = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf-8"),
    ).packageManager
  } catch {
    return { file: pm, args: [] }
  }
  // packageManager 来自被克隆仓库，是不可信输入。只接受严格的 pnpm 版本号，
  // 且以 argv 形式交给 npx（不经过 shell）；否则回退到 PATH 里的 pnpm。
  if (
    typeof pinned === "string" &&
    /^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinned)
  ) {
    return { file: "npx", args: ["-y", pinned] }
  }
  return { file: pm, args: [] }
}

function requireDist(src) {
  if (!fs.existsSync(path.join(src, "index.html"))) {
    throw new Error(`Frontend dist missing index.html: ${src}`)
  }
}

/**
 * 已构建前端是否包含 Worker 首次初始化协议。
 *
 * Vite 会保留路由和 API 路径字符串，因此无需执行或反编译 bundle。两项必须
 * 同时存在：init_status 负责识别空数据库，/@init 才能渲染创建管理员的向导。
 */
function supportsWorkerSetup(src) {
  let hasStatus = false
  let hasRoute = false
  const pending = [src]
  while (pending.length > 0 && (!hasStatus || !hasRoute)) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(full)
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const code = fs.readFileSync(full, "utf-8")
        hasStatus ||= code.includes("/public/init_status")
        hasRoute ||= code.includes("/@init")
      }
    }
  }
  return hasStatus && hasRoute
}

function replaceDist(src) {
  console.log(`  Copying frontend dist: ${src} -> ${DEST}`)
  fs.rmSync(DEST, { recursive: true, force: true })
  fs.cpSync(src, DEST, { recursive: true })
  copyManifestToRoot()
  stampFrontendVersion(src)
  patchManifestCredentials()
  applyTheme()
  console.log(`✓ Frontend dist ready (${DEST})`)
}

/**
 * 解压用的 tar 命令。
 *
 * Windows 上不能直接用 PATH 里的 tar：脚本常在 Git Bash 环境下执行，execSync 会
 * 继承其 PATH 而命中 Git 自带的 GNU tar，GNU tar 把 `C:\...` 里的 `C:` 当成远程
 * 主机名（`Cannot connect to C: resolve failed`），解压静默失败 —— 表现就是语言包
 * 没落地、产物悄悄变成纯英文界面。Win10+ 自带的 System32\tar.exe 是 bsdtar，能正确
 * 处理 Windows 绝对路径，故显式指定它。
 */
function tarBin() {
  if (process.platform === "win32") {
    const sys = process.env.SystemRoot || "C:\\Windows"
    const bsdtar = path.join(sys, "System32", "tar.exe")
    if (fs.existsSync(bsdtar)) return `"${bsdtar}"`
  }
  return "tar"
}

/** src/lang 下除英文外还解出了哪些语言目录 */
function extraLangs(langDir) {
  if (!fs.existsSync(langDir)) return []
  return fs
    .readdirSync(langDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "en")
    .map((d) => d.name)
}

/**
 * 把 dist/static/manifest.json 复制到 dist/manifest.json。
 *
 * 为什么：官方前端 #162（2025-08-08）把 index.html 的 manifest 引用从
 * /static/manifest.json 改成 /manifest.json —— 这是配合 Go 版后端的改动
 * （OpenList server/router.go:36 用动态路由 g.GET("/manifest.json", ...)
 * 生成 manifest），但 dist 里文件仍停留在 /static/manifest.json。纯静态
 * /Worker 部署没有这条路由，/manifest.json 要么落到 SPA 兜底（返回 text/html，
 * PWA 解析失败），要么在 EdgeOne 预览域这类平台鉴权后面直接 401。
 * 运行期 assetsRouter 的 /manifest.json -> /static/manifest.json 302 只是
 * Worker 场景的兜底；静态直出（EdgeOne Pages）根本不经过 Worker，必须在
 * 构建期把文件补到链接指向的位置。
 */
function copyManifestToRoot() {
  const src = path.join(DEST, "static", "manifest.json")
  const dest = path.join(DEST, "manifest.json")
  try {
    if (!fs.existsSync(src) || fs.existsSync(dest)) return
    fs.copyFileSync(src, dest)
    console.log("  Copied static/manifest.json -> manifest.json (frontend #162)")
  } catch (err) {
    console.warn(
      `  [fetch-frontend] copy manifest.json skipped: ${err?.message || err}`,
    )
  }
}

/**
 * 给 dist/index.html 的 <link rel="manifest"> 补 crossorigin="use-credentials"。
 *
 * 为什么：Chromium 对 PWA manifest 的请求默认【不带任何凭证】——同域 Cookie
 * 也不带（Google Web Fundamentals 明确记载）。EdgeOne Pages 预览域名
 * （*.edgeone.cool）等平台的访问控制依赖 Cookie 鉴权（eo_time），于是出现
 * 「站点其它资源全部正常，唯独 /manifest.json 401 Authorization Required」。
 * 补上该属性让浏览器以 include 模式携带 Cookie；同源请求没有 CORS 副作用，
 * 在无需鉴权的平台上也无害。
 */
function patchManifestCredentials() {
  const idx = path.join(DEST, "index.html")
  try {
    if (!fs.existsSync(idx)) return
    let html = fs.readFileSync(idx, "utf-8")
    if (!/rel=["']manifest["']/i.test(html)) return
    let changed = false
    html = html.replace(
      /<link\b([^>]*)>/gi,
      (full, attrs) => {
        if (!/rel=["']manifest["']/i.test(attrs)) return full
        if (/\bcrossorigin\b/i.test(attrs)) return full
        changed = true
        // 自闭合 /> 的斜杠不属于属性，摘出来还原到闭合符
        const selfClose = /\/\s*$/.test(attrs)
        const clean = attrs
        .replace(/\/\s*$/, "")
        .replace(/\s+$/, "")
        return `<link${clean} crossorigin="use-credentials"${selfClose ? " />" : ">"}`
      },
    )
    if (changed) {
      fs.writeFileSync(idx, html)
      console.log(
        "  Patched manifest link with crossorigin=use-credentials in dist/index.html",
      )
    }
  } catch (err) {
    console.warn(
      `  [fetch-frontend] patch manifest credentials skipped: ${err?.message || err}`,
    )
  }
}

/**
 * 构建期戳：把前端版本号写入 dist/index.html 的 <meta name="frontend-version">。
 *
 * 运行时 ASSET_URLS 的 $version 占位符优先从这里取值——版本与本次构建的 dist
 * 同源产生，保证 CDN 地址指向的版本与实际部署的前端一致（否则哈希资产会 404）。
 * 前端仓库不存在（如仅提供预构建 dist）时跳过，运行时回退 latest。
 */
function stampFrontendVersion(src) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(path.resolve(src, ".."), "package.json"),
        "utf-8",
      ),
    )
    // 只信任官方前端包的版本号：FRONTEND_DIST 可能指向任意目录，
    // 误读（例如 worker 自身 package.json 的 4.2.3）会戳出错误的 CDN 版本。
    if (!/openlist-frontend/i.test(pkg?.name || "")) return
    const version = pkg?.version
    if (!version) return
    const idx = path.join(DEST, "index.html")
    let html = fs.readFileSync(idx, "utf-8")
    if (/name=["']frontend-version["']/.test(html)) return
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1>\n    <meta name="frontend-version" content="${version}">`,
    )
    fs.writeFileSync(idx, html)
    console.log(`  Stamped frontend-version ${version} into dist/index.html`)
  } catch (err) {
    console.warn(
      `  [fetch-frontend] stamp frontend-version skipped: ${err?.message || err}`,
    )
  }
}

/**
 * 把 OpenList Moe 主题产物拷进 dist 并注入 dist/index.html。
 *
 * 为什么在构建期做，而不是走后台的「自定义头部 / 自定义内容」设置：
 *   1. Worker 版没有实现上游 Go 的占位符运行时替换（那两个设置项目前只是被
 *      /api/public/settings 回显，写进去不会生效）；
 *   2. 实测 `/` 与 SPA 深链由静态资源层直接吐出 index.html（响应带 ETag /
 *      CF-Cache-Status，且没有 Worker 注入的任何响应头），请求根本不进 Worker，
 *      运行时替换在首页上不可靠；
 *   3. 首页 HTML 不受 CSP 约束（`Content-Security-Policy` 只在 setupRouter 里
 *      设置，而它挂在 /api 下），外链脚本会被浏览器直接执行 —— 把主题的可用性
 *      与代码完整性押在第三方 GitHub 镜像站上并不划算，故同源托管。
 * 三者共同决定了：产物同源 + 构建期写进 HTML，是唯一在所有平台都成立的做法。
 *
 * 换行统一用 \n：build-edge.mjs 会把 dist/index.html 内联进提交到仓库的
 * cloud-functions 产物，插入 CRLF 会让该产物在 Windows / Linux 间来回抖动。
 */
function applyTheme() {
  if (process.env.THEME_MOE === "off") {
    console.log("  [theme] THEME_MOE=off，跳过 OpenList Moe 注入")
    return
  }

  const htmlPath = path.join(DEST, "index.html")
  const html = fs.readFileSync(htmlPath, "utf-8")
  if (html.includes(THEME_ASSETS[0])) {
    console.log("  [theme] index.html 已包含 OpenList Moe，跳过注入")
    return
  }
  // 占位符缺失说明上游前端产物结构变了。宁可构建失败，也不要产出一个
  // 「以为装了主题、实际静默没装」的产物。
  for (const mark of [MARK_HEAD, MARK_BODY]) {
    if (!html.includes(mark)) {
      throw new Error(
        `[theme] dist/index.html 缺少占位符 ${mark}，无法注入 OpenList Moe（上游前端结构变更？如不需要主题请设 THEME_MOE=off）`,
      )
    }
  }
  const files = [
    ...THEME_ASSETS.map((f) => [path.join(THEME_DIR, f), f]),
    ...FONT_ASSETS.map(([dir, f]) => [path.join(ROOT, "theme", dir, f), f]),
    [path.join(ROOT, "theme", SITE_CSS), SITE_CSS],
  ]
  for (const [from, name] of files) {
    if (!fs.existsSync(from)) {
      throw new Error(`[theme] 缺少主题样式文件: ${from}`)
    }
    // 放 dist 根目录（单段路径）：/theme/xxx.css 这类两段路径会被
    // src/backend/server/assets.ts 的 /:folder/:filepath* 在配置了 ASSET_URLS
    // 时 302 到 CDN，导致主题样式丢失。
    fs.copyFileSync(from, path.join(DEST, name))
  }

  // --moe-color-theme 兜底：上游 JS 由 window.OPENLIST_CONFIG.main_color 推导该
  // 变量，而只有 Go 后端会在输出 index.html 时填这个字段。实测本仓库下它为空，
  // 上游 JS 抛 TypeError（documentElement 上不会留下行内变量），CSS 里所有
  // rgb(var(--moe-color-theme)/…) 的强调色随之失效，故在 :root 给一个静态默认值。
  // 反过来不能把 main_color 烤进 index.html —— 前端 getMainColor() 优先读该字段，
  // 烤死会让后台「主色调」设置失效。
  const head =
    `${MARK_HEAD}\n` +
    `    <link rel="stylesheet" href="/${THEME_ASSETS[0]}">\n` +
    `    <style>:root{--moe-color-theme:${THEME_COLOR_RGB}}</style>\n` +
    // 覆盖样式必须排在主题 CSS 之后才能在级联中胜出
    `    <link rel="stylesheet" href="/${SITE_CSS}">`
  const body = `${MARK_BODY}\n    <script src="/${THEME_ASSETS[1]}"></script>`

  fs.writeFileSync(
    htmlPath,
    html.replace(MARK_HEAD, head).replace(MARK_BODY, body),
    "utf-8",
  )
  console.log("  [theme] OpenList Moe 已注入（无备案信息）")
}

/**
 * 拉取官方前端发布的多语言翻译包，解压到前端仓库 src/lang/ 后运行
 * i18n.mjs 补齐 entry.ts 与缺失翻译，保证构建产物包含完整多语言。
 *
 * 失败即中断构建（不再静默回退英文）：语言包走 GitHub Release 资源，网络抖动
 * 会让下载悄悄失败，而英文产物照常构建成功 —— 部署后表现为线上中文站点突然
 * 变英文，且没有任何报错线索。确需英文产物时显式设 I18N_OPTIONAL=1。
 *
 * 摘要锚点优先级：I18N_SHA256（显式固定）> GitHub Release asset.digest。
 * 解包前校验；摘要不匹配直接抛错，不走重试/降级。
 */
async function fetchI18n(repo) {
  const langDir = path.join(repo, "src", "lang")
  const optional = process.env.I18N_OPTIONAL === "1"
  const bail = (why) => {
    const msg = `[fetch-frontend] ${why} 产物将是纯英文界面 —— 直接部署会把线上中文站点切成英文。确认要英文构建请显式设 I18N_OPTIONAL=1`
    if (optional) {
      console.warn(`  ${msg}（I18N_OPTIONAL=1，已降级继续）`)
      return
    }
    throw new Error(msg)
  }

  if (!fs.existsSync(langDir)) return bail("前端仓库缺少 src/lang 目录，")

  const tmpTar = path.join(os.tmpdir(), `openlist-i18n-${process.pid}.tar.gz`)
  const assetName = decodeURIComponent(
    String(I18N_TAR_URL).split("/").pop().split(/[?#]/)[0] || "i18n.tar.gz",
  )
  const anchor =
    process.env.I18N_SHA256 || (await githubAssetDigest(I18N_TAR_URL, assetName))
  const isIntegrityError = (err) =>
    String(err?.message || err).startsWith("[integrity]")
  const fetchOnce = () => {
    assertHttpUrl(I18N_TAR_URL, "I18N_URL")
    runArgv("curl", ["-fL", "--retry", "3", "-o", tmpTar, I18N_TAR_URL])
    verifyOrThrow(tmpTar, [{ algo: "sha256", kind: "hex", value: anchor }], `i18n ${assetName}`)
    runArgv(tarBin(), ["-xzf", tmpTar, "-C", langDir])
  }
  console.log(`  Fetching i18n translations: ${I18N_TAR_URL}`)
  try {
    fetchOnce()
  } catch (err) {
    if (isIntegrityError(err)) throw err
    // 语言包走 GitHub Release 资源，网络抖动很常见，重试一次再判定失败
    console.warn(
      `  [fetch-frontend] i18n fetch failed, retrying once: ${err?.message || err}`,
    )
    try {
      fetchOnce()
    } catch (err2) {
      if (isIntegrityError(err2)) throw err2
      /* 交由下面的落地检查统一报错 */
    }
  } finally {
    fs.rmSync(tmpTar, { force: true })
  }

  // 落地检查：下载"没报错"但没解出任何语言目录，同样是英文产物
  const langs = extraLangs(langDir)
  if (langs.length === 0) return bail("未解出任何非英文语言包，")
  console.log(`  [fetch-frontend] i18n ready: ${langs.join(", ")}`)

  // 补齐 entry.ts 与缺失翻译（与前端 build.sh 一致）
  run(`node ./scripts/i18n.mjs`, { cwd: repo })
}

/** 在本地前端仓库中 install + build，并取 dist 产物 */
async function buildLocalRepo(repo) {
  const abs = path.resolve(repo)
  if (!fs.existsSync(path.join(abs, "package.json"))) {
    throw new Error(`Directory is not a frontend repo: ${abs}`)
  }
  const pm = detectPackageManager(abs)
  const cmd = resolvePmCommand(abs, pm)
  const install = (extra = []) =>
    runArgv(cmd.file, [...cmd.args, "install", ...extra], { cwd: abs })
  try {
    install()
  } catch (err) {
    // `--trust-lockfile` 会关闭 pnpm 的供应链复核，不能默认自动回退；
    // 必须由构建方显式设置 ALLOW_TRUST_LOCKFILE=1 承担风险。
    if (process.env.ALLOW_TRUST_LOCKFILE !== "1") throw err
    // 重试一次并加 --trust-lockfile：pnpm 11 默认对 lockfile 逐项重跑
    // minimumReleaseAge / trustPolicy 供应链复核，registry manifest 缺少
    // 平台子包时会误报（如 @crowdin/cli-*-arm64）。lockfile 来自刚克隆的
    // 官方前端仓库（HTTPS + 官方分支），属于可信来源，跳过复核安全。
    console.warn(
      "  [fetch-frontend] install failed; ALLOW_TRUST_LOCKFILE=1 set, retrying once with --trust-lockfile (supply-chain re-verification disabled)...",
    )
    install(["--trust-lockfile"])
  }
  await fetchI18n(abs)
  // 关键修复：前后端默认同源部署，官方前端 VITE_API_URL 的语义是「API 服务器
  // 基础 URL」，正确值为 "/"（同源，config.ts 会转成 location.origin）。若外部
  // 环境（如 EdgeOne 控制台环境变量）误设 VITE_API_URL=/api，官方前端会拼成
  // baseURL=/api/api，导致 API 请求双前缀、落到 SPA 兜底返回 HTML。
  // 这里构建前端时强制覆盖为 "/"，杜绝外部污染。
  runArgv(cmd.file, [...cmd.args, "run", "build"], {
    cwd: abs,
    env: { ...process.env, VITE_API_URL: "/" },
  })
  replaceDist(path.join(abs, "dist"))
}

/**
 * 下载 npm 上【已发布】的前端 dist。
 *
 * 版本取 FRONTEND_VERSION，未设置时取 registry 的 latest dist-tag。tarball 里
 * 只解出 package/dist 与 package/package.json —— 后者供 stampFrontendVersion
 * 读出真实发布版本号（解出 LICENSE/README 没有意义）。
 *
 * 失败时直接抛错终止构建，不静默回退到「克隆 main 现构建」：那条路产出的哈希
 * 与 CDN 不一致，会让 ASSET_URLS 的路径 A 悄悄失效（npmmirror 直接不可用）。
 * 确实需要现构建时显式设置 FRONTEND_BUILD_FROM_SOURCE=1。
 */
async function fetchPublishedDist() {
  console.log(`  Querying registry: ${REGISTRY_URL} (${PKG_NAME})`)
  const res = await fetch(`${REGISTRY_URL}/${PKG_NAME}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(`registry metadata request failed: HTTP ${res.status}`)
  }
  const meta = await res.json()
  const version = process.env.FRONTEND_VERSION || meta?.["dist-tags"]?.latest
  if (!version) {
    throw new Error(
      `cannot determine version: no dist-tags.latest for ${PKG_NAME}`,
    )
  }
  const tarball = meta?.versions?.[version]?.dist?.tarball
  if (!tarball) {
    throw new Error(`version ${version} is not published for ${PKG_NAME}`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-frontend-npm-"))
  const tgz = path.join(tmp, "pkg.tgz")
  try {
    console.log(`  Downloading published dist: ${PKG_NAME}@${version}`)
    // tarball 地址来自 registry 响应，属于外部输入：走 argv + 协议白名单
    assertHttpUrl(tarball, "registry tarball URL")
    runArgv("curl", ["-fL", "--retry", "3", "-o", tgz, tarball])
    // 解包前校验摘要：锚点取同一次元数据响应的 dist.integrity(SRI)/dist.shasum，
    // 也可用 FRONTEND_SHA512 显式固定（CI 里把版本与摘要一起钉死）。
    const distMeta = meta?.versions?.[version]?.dist || {}
    verifyOrThrow(
      tgz,
      [
        {
          algo: "sha512",
          kind: "hex-or-sri",
          value: process.env.FRONTEND_SHA512 || distMeta.integrity,
        },
        { algo: "sha1", kind: "hex", value: distMeta.shasum },
      ],
      `${PKG_NAME}@${version} tarball`,
    )
    // 以 tmp 为 cwd、用相对路径解包：Windows 上 tar 会把 "C:\\..." 里的盘符冒号
    // 当成远程主机（"Cannot connect to C: resolve failed"），不能把绝对路径喂给 tar。
    run(`tar -xzf pkg.tgz package/dist package/package.json`, { cwd: tmp })
    const src = path.join(tmp, "package", "dist")
    requireDist(src)
    if (!supportsWorkerSetup(src)) {
      console.warn(
        `  Published frontend ${version} lacks the Worker setup protocol; building ${OFFICIAL_REPO_REF} instead`,
      )
      return false
    }
    replaceDist(src)
    return true
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function main() {
  console.log("[fetch-frontend] Fetching official frontend build artifacts...")

  // 1. 本地已构建产物目录（显式指定）
  const localDist = process.env.FRONTEND_DIST
  if (localDist) {
    const src = path.resolve(localDist)
    requireDist(src)
    replaceDist(src)
    return
  }

  // 2. 本地前端仓库目录（显式指定）
  const localRepo = process.env.FRONTEND_REPO
  if (localRepo) {
    await buildLocalRepo(localRepo)
    return
  }

  // 3. 同级目录 ../OpenList-Frontend（monorepo 布局，自动探测）
  const siblingRepo = path.resolve(ROOT, "..", "OpenList-Frontend")
  if (fs.existsSync(path.join(siblingRepo, "package.json"))) {
    console.log(`  Detected sibling official frontend repo: ${siblingRepo}`)
    await buildLocalRepo(siblingRepo)
    return
  }

  // 4. 下载 npm 上已发布且兼容 Worker 初始化协议的 dist（默认）
  //    从 main 现构建的产物哈希与 CDN 不一致，会让路径 A 失效、npmmirror 之类的
  //    镜像完全不可用（详见文件头），故默认改为取已发布产物。
  if (process.env.FRONTEND_BUILD_FROM_SOURCE !== "1") {
    if (await fetchPublishedDist()) return
  }

  // 5. 从 Git 克隆并构建（显式要求源码构建，或发布版尚未兼容 Worker）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-frontend-"))
  console.log(
    `  Cloning official frontend: ${OFFICIAL_REPO_URL}#${OFFICIAL_REPO_REF}` +
      (OFFICIAL_REPO_SHA ? `@${OFFICIAL_REPO_SHA}` : " (未固定 commit)"),
  )
  try {
    // -c core.autocrlf=false：禁用克隆端的换行符转换。Windows 上 autocrlf
    // 会把前端源码（含 index.html）检出为 CRLF，改变 vite 构建出的
    // dist/index.html 内容，进而导致产物哈希跨平台不一致。
    // REF/URL 来自环境变量：先做字符集白名单（挡掉以 - 开头的 git 选项注入），
    // 再以 argv 交给 git（挡掉 shell 展开）。
    assertSafeGitRef(OFFICIAL_REPO_REF)
    assertSafeGitUrl(OFFICIAL_REPO_URL)
    if (OFFICIAL_REPO_SHA) {
      // 固定到不可变 commit：先只取该 SHA（不触碰工作区），核对 HEAD 后再检出，
      // 保证 install 的 postinstall 钩子跑的就是被审过的那份源码。
      assertSafeGitSha(OFFICIAL_REPO_SHA)
      runArgv("git", ["init", "-q", tmp])
      runArgv("git", ["-C", tmp, "remote", "add", "origin", OFFICIAL_REPO_URL])
      runArgv("git", ["-C", tmp, "fetch", "--depth", "1", "origin", OFFICIAL_REPO_SHA])
      const fetched = captureArgv("git", ["-C", tmp, "rev-parse", "FETCH_HEAD"]).trim()
      if (fetched.toLowerCase() !== OFFICIAL_REPO_SHA.toLowerCase()) {
        throw new Error(
          `[fetch-frontend] FRONTEND_GIT_SHA 与实际取到的 commit 不一致（期望 ${OFFICIAL_REPO_SHA}，FETCH_HEAD ${fetched}）`,
        )
      }
      runArgv("git", [
        "-C",
        tmp,
        "-c",
        "core.autocrlf=false",
        "checkout",
        "--detach",
        OFFICIAL_REPO_SHA,
      ])
    } else {
      // 浮动分支：上游随时可推入任意代码，且 install 会执行其依赖的构建脚本。
      // CI/生产构建应设 FRONTEND_GIT_SHA 固定；这里只提示，不静默。
      console.warn(
        "  [fetch-frontend] 警告：源码构建未固定 commit（FRONTEND_GIT_SHA 为空），本次构建不可复现",
      )
      runArgv("git", [
        "-c",
        "core.autocrlf=false",
        "clone",
        "--depth",
        "1",
        "--branch",
        OFFICIAL_REPO_REF,
        OFFICIAL_REPO_URL,
        tmp,
      ])
    }
    await buildLocalRepo(tmp)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (err) {
  console.error("[fetch-frontend] Failed:", err?.message || err)
  process.exit(1)
}
