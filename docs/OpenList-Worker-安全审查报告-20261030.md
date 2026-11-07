# OpenList-Worker 深度安全审查报告

**审查日期**：2026-10-30
**审查范围**：https://github.com/WMZZwmzz/OpenList-Worker（552 文件 / 约 9.1 万行 TS 代码；fork 相对上游有 128 文件、8200+ 行自有改动，含 4 轮历史安全整改）
**审查方式**：4 个并行深审模块（认证会话 / 初始化与SSO / 路径与文件服务 / 管理面与供应链）+ 人工复核，关键发现均经源码逐条验证

---

## 总体结论

前 4 轮整改质量很高：SQL 全参数化、JWT 算法全部 pin HS256、路径多重解码防穿越、SSO/WebAuthn 的 2FA 旁路已封堵、CI 规范、依赖锁定与 package.json 零偏差、无硬编码密钥、主题文件哈希与上游一致。

**未发现可直接匿名利用的高危漏洞，但仍有 1 个高危 + 6 个中危残留。**

---

## 一、高危（1 个）

### H-1 WebDAV PUT 无请求体大小上限 → 单请求 OOM
- **位置**：`src/backend/server/webdav.ts:398`
- **描述**：`Buffer.from(await c.req.arrayBuffer())` 把整个请求体一次性读入内存，无任何上限。/fs/put、/fs/form、multipart、/s3 PUT 都已接 `readBodyWithinLimit()`，唯独 WebDAV PUT 漏掉。
- **利用场景**：任何有 WebDAV 写权限的账号（含受限普通用户）对 `/dav/x` 发一个 10GB 的 PUT，即可打爆 Worker/Node 实例内存。
- **修复**：改用 `readBodyWithinLimit(c)`，超限回 413（一行改动）。

---

## 二、中危（6 个）

### M-1 `/api/auth/otp/login` 缺登录锁定前置检查 → TOTP 爆破不受约束
- **位置**：`src/backend/server/auth.ts:690-779`
- **描述**：入口从不调用 `isLoginLocked`（对照 `/login`、`/login/hash`、WebDAV 均有）。失败计数一直累积但没有任何地方消费。SSO/Passkey 通道拿到的 5 分钟 pending 令牌可无限试 6 位 TOTP 码，到期重新领取即可循环。
- **修复**：入口加 `if (await isLoginLocked(c, user.username, c.env)) return 429`（一行改动）。

### M-2 `checkAdminAuth` 未显式拒绝 otp_pending 令牌
- **位置**：`src/backend/pkg/utils.ts`（checkAdminAuth 校验链）
- **描述**：待兑换令牌含 id/username 但无 `pwd_ts`，目前仅靠 `isPasswordStampValid` 偶然拦截。一旦账号 `pwd_update_at` 为空（手工迁移、历史数据、未来建号路径漏写），未完成 2FA 的待兑换令牌即可通过全部 `/api/admin/*`，等于 2FA 对管理面失效。
- **修复**：在 `findUserByTokenPayload` 或 `checkAdminAuth` 开头加 `if (isOtpPendingPayload(payload)) return false`（一行改动）。

### M-3 `/api/public/init/setup` 初始化 TOCTOU 竞争 → 并列管理员注入
- **位置**：`src/backend/server/public.ts:795（existing 检查）→ 856（saveDb force）`
- **描述**：`existing` 检查与 `saveDb(force:true)` 写入之间无锁。部署者打开安装向导提交的同一时刻，攻击者并发 POST `/init/setup` 可注入并列管理员；若抢注 `guest` 用户名，此后所有匿名请求直接获得管理员身份（guest 回退会带其真实 role）。
- **修复**：初始化流程加互斥（singleflight / KV 抢占锁），拿锁后重新执行 existing 检查；拒绝保留用户名（guest/admin）。

### M-4 SSO state 用 IP 绑定，IP 不可信时防护失效 → 账号接管链
- **位置**：`src/backend/server/sso.ts:430-437`
- **描述**：state 记录绑定 `clientIpOf(c)`，在 EdgeOne/自托管未设 `TRUST_PROXY_HEADERS=1` 的部署上所有客户端 IP 恒为 `"unknown"`，`rec.ip !== ip` 永不成立，state 防护退化为「知道 state 值即可」。攻击者可走 `get_sso_id` 流程后把回调 URL 发给已登录的受害者，受害者浏览器被 302 到 `/@manage?sso_id=<攻击者身份>` 完成绑定，随后攻击者用自己的 IdP 账号登录受害者账号。
- **修复**：state 改用 HttpOnly SameSite cookie 双提交绑定；或绑定后要求显式确认页；IP 为 unknown 时拒绝跨请求消费。

### M-5 SSRF 尾部点 FQDN 绕过黑名单
- **位置**：`src/backend/pkg/http.ts:269`（isSafeUrl）
- **描述**：`isSafeUrl` 只做 `hostname.toLowerCase().trim()`，而同文件 433 行的 `isBrowserUnsafeUrl` 有 `.replace(/\.+$/,"")`——规则漂移。`http://localhost./`、`http://metadata.google.internal./` 的尾部点被 WHATWG URL 保留，`host==="localhost"`、`endsWith(".local")`、rebind 域名正则全部落空，但 DNS 仍解析到 127.0.0.1。
- **利用场景**：驱动 raw_url 或 302 Location 指向 `http://metadata.google.internal./computeMetadata/v1/`，经 safeProxyFetch 逐跳校验全部通过，服务端 fetch 直接打到云元数据。
- **修复**：269 行改为 `host = parsed.hostname.toLowerCase().replace(/\.+$/, "").trim()`（一行改动）。
- **附带残余风险**：SSRF 判定基于 URL 文本而实际 DNS 解析在 fetch 内部，存在 DNS rebinding TOCTOU 窗口；如需收紧可在校验点自行解析并对每个返回 IP 跑内网段检查。

### M-6 EdgeOne KV 代理只信 JWT 内 role 快照
- **位置**：`functions/_kv-proxy.js:243`（verifyJwt :117-198）
- **描述**：`Number(payload.role) !== ADMIN_ROLE` 只看签发时刻的 role claim，不查 DB 当前 role/disabled，也不查注销黑名单。主站 `checkAdminAuth` 已修复此缺陷，Edge 侧未同步。KV 里存的是全量业务数据（含敏感字段密文、JWT secret 本身）。
- **利用场景**：管理员降权/禁用/登出某账号后，其 7 天有效期的旧 JWT 仍可调 `/kv-put` 覆盖任意键。
- **修复**：Edge 侧加短 TTL 信任窗口 + 撤销检查，或由 Node 云函数代理校验后转发。

---

## 三、资源类中危（3 个）

### R-1 zip 解压总量预算使用不可信的声明大小
- **位置**：`src/backend/server/fs.ts:2321`、`internal/archive/zip.ts:67`
- **描述**：解压预算按中央目录里归档作者自填的 uncompressedSize 累加，未与实际解压字节数核对。构造 10000 个条目（声明 size=1、实际各展开 60MB）可通过 512MB 预算检查，实际写出约 600GB。
- **修复**：按 `content.byteLength` 累加 totalBytes，超限立即中止。

### R-2 multipart 会话无限累积（pruneSessions 从未被调用）
- **位置**：`internal/upload/multipart.ts:190-210`；`server/fs.ts:84` 仅 import 无调用
- **描述**：会话 Map 只增不减，无每用户会话数上限。任一可写账号循环调 `/fs/multipart/init` 可在数小时内堆积数十万会话耗尽内存。清理函数已实现但忘了接线。
- **修复**：在 init/chunk 入口调用 `pruneSessions()`，并加每用户活跃会话上限。

### R-3 SSO stateStore 无限增长
- **位置**：`src/backend/server/sso.ts:33, 64-72`
- **描述**：`generateState` 只 set 不清理，未消费的 state（用户放弃或攻击者刷接口）永久驻留。对比同文件 `ssoExchangeCodes`（>1024 清理）和 webauthn 的 challenge（TTL+上限），这里漏了。端点无需鉴权即可刷。
- **修复**：仿照 ssoExchangeCodes：超阈值按 exp 清理 + 容量上限淘汰最旧。

---

## 四、低危（择要）

| # | 位置 | 问题 |
|---|------|------|
| L-1 | `fs.ts:446/736/327` | 分享**子路径**的 meta（密码/read_users）只在下载侧 /sd 校验，/fs/list、/fs/get、/fs/dirs 分享分支不校验 → 匿名可枚举受保护子目录的文件列表与 raw_url（下载仍被拦） |
| L-2 | `fs.ts:1436` | `/fs/regex_rename` 用户正则未复用 `validateHide` 的回溯检测 → 普通用户可 ReDoS 打满 CPU 配额 |
| L-3 | `middlewares.ts:265-295` | JWT 撤销黑名单整表读-改-写回，并发注销 last-write-wins 互相丢失；无 exp 的令牌条目永远进不了黑名单 |
| L-4 | `audit.ts:113` | 审计日志读 `c.get("user")`（全仓库无人 set，实际键是 `authedUser`）→ 结构化字段恒为空；生产日志默认只进内存 → 登录审计取证失效 |
| L-5 | `pkg/csrf.ts`、`auth.ts:1084` | CSRF token 不绑定会话，`GET /api/auth/csrf` 匿名可领；两套 CSRF 中间件均为死代码（未挂载），未来启用即成洞，建议删除或修复 |
| L-6 | `edgeone.json:19`、`vercel.json` | EdgeOne CSP 含 `unsafe-inline`、Vercel 完全无 CSP，弱于 Worker 默认 `script-src 'self'` → 放大 `customize_head` 管理员注入面 |
| L-7 | `pkg/password.ts:28` | 双层裸 SHA-256 非慢哈希（对齐 Go 格式的已知取舍），DB 泄露后 GPU 离线爆破快；建议新写入渐进迁移 PBKDF2/Argon2 |
| L-8 | `admin.ts:5755` | `/api/admin/audit/cleanup` 不校验 retention_days，`-1` 即全量清空审计日志 |
| L-9 | `raw.ts:413-423` | `/p` 端点前缀 `startsWith("/p")` 误匹配普通挂载路径（如 `/photo/x`）→ 误 403 或误入代理 |
| L-10 | `admin.ts:54-58` | `generateSecureToken` 的 Math.random 兜底分支被 `reset_token`（轮换下载签名密钥）使用，异常运行时下产出可预测密钥，建议直接 throw |
| L-11 | `pkg/secure-log.ts:123` | 长字符串是截断而非脱敏，JWT 前 200 字符（全部 claims）仍明文入日志 |
| L-12 | `sso.ts:274` | SSO 自动注册硬编码 `base_path:"/"`，未使用 `sso_default_dir` 设置 → 新 SSO 用户默认获全站根目录读权限 |

---

## 五、已确认干净的部分

- **SQL 注入**：Durable Objects / D1 / MySQL / sql-format 适配器全部参数化，表名来自硬编码前缀白名单
- **路径穿越**：`decodePathFully`（64 轮解码）+ 段折叠 + base_path 钳制，`%2e%2e`、`...`、`%5c`、Windows 盘符、UNC 均被拦截；zip-slip 有 `safeArchiveEntryPath` 防护
- **JWT**：全仓库 6 处 verify 全部显式 pin HS256，无算法混淆面；改密/降权/禁用/登出均有对应失效机制（pwd_ts + epoch + jti 黑名单）
- **SSO**：回调无 open redirect；所有平台回调前置 state 校验（除 M-4 的 IP 弱绑定）；OIDC id_token payload 级 iss/aud/exp/nonce 校验；IdP 端点过 assertSsoUrl 防投毒
- **WebAuthn**：challenge 服务端签发、读取即作废、5 分钟 TTL、容量上限；origin/ rpIdHash/UP/UV/signCount 全校验
- **安装向导**：DB 不可读/密文解不开时拒绝初始化；无默认弱口令（admin/admin 自愈已移除）
- **管理面**：55 条 admin 路由鉴权逐条核对无遗漏；禁止经 create/update 提权、禁删 admin/guest
- **设置泄露**：公开设置走显式 allowlist（fail-closed）+ 管理键黑名单 + 敏感键正则双保险
- **CI/供应链**：workflow 最小权限、action 按 SHA 固定、SSH 私钥经 env 传入、known_hosts 固定指纹、前端下载产物 SRI 校验；pnpm-lock 与 package.json 95 条依赖零偏差、无可疑包、无硬编码密钥；主题文件 SHA-256 与上游声明一致、字体魔数合法

---

## 六、修复优先级建议

**第一批（全部一行级改动，建议立即修）**
1. H-1：WebDAV PUT 接 `readBodyWithinLimit`（webdav.ts:398）
2. M-1：`/otp/login` 入口加 `isLoginLocked`（auth.ts:690）
3. M-2：`checkAdminAuth` 加 `isOtpPendingPayload` 拒绝（pkg/utils.ts）
4. M-5：`isSafeUrl` 加尾部点归一化（pkg/http.ts:269）

**第二批（本轮内修）**
5. M-3：init/setup 加互斥锁 + 拒绝保留用户名
6. M-6：KV 代理加令牌复核（撤销黑名单 / 短 TTL 窗口）
7. L-1：三个分享分支对 realPath 追加 meta 判定
8. R-1：zip 预算改按实际解压字节累加
9. R-2：pruneSessions 接线 + 每用户会话上限
10. R-3：stateStore 加清理与容量上限

**第三批（按威胁模型决策）**
11. M-4：SSO state 改 cookie 绑定 / 显式确认绑定
12. L-6：EdgeOne/Vercel CSP 对齐 Worker
13. L-2/L-3/L-4/L-5 等低危项
14. L-7：密码哈希渐进迁移慢哈希（需兼容规划）
