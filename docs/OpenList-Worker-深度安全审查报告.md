# OpenList-Worker 深度安全审查报告

| 项 | 内容 |
|---|---|
| **审查对象** | `https://github.com/WMZZwmzz/OpenList-Worker`（main 分支最新代码） |
| **项目性质** | OpenList / AList 的**边缘运行时移植版**（Cloudflare Workers / EdgeOne / Vercel / Serverless），Hono 框架 + TypeScript |
| **代码规模** | **552 个源码文件**（排除 node_modules），其中约 **100 个网盘驱动**；核心面 `src/backend/server/*` 累计超 40 万行量级（含测试） |
| **审查方式** | 全量静态审计 + 6 条并行专项线（平台入口/鉴权/协议入口/驱动层/密码学/供应链）+ 高危结论独立交叉验证 |
| **报告日期** | 2026-10-31 |
| **总体结论** | **未发现可直接匿名接管实例的 Critical 漏洞**；但存在 **1 组默认配置下的凭据明文存储风险**、**5 处确凿的密码学实现缺陷**、**2 项可达 nostril 并利用链的 Serverless 专属攻击面**，以及一条**依赖供应链（hono CVE）**问题 |

---

## 一、执行摘要

这个项目的安全基线**明显高于同类个人移植项目**：它没有开放代理、没有 mass-assignment 提权、没有默认管理员口令、路径穿越做了三层净化、Markdown、SSRF 做了逐跳手动跟随 + DNS 黑名单，`internal/seed`（BT 种子核对我认为不是后门凭据——这是我专门核实的一点，结论见 §五）。

真正的风险集中在**三个结构性错位**：

1. **Serverless 信任边界错位** —— `__requestOrigin` 由客户端可控的 `Host` 头派生，而这条链路上跑的却是携带 **`JWT_SECRET` 明文**的内部 KV 调用。这是 Cloudflare 托管场景不会出现、但 Node/EdgeOne 自托管场景会真实触发的问题。
2. **密码学习惯与上游兼容的错位** —— 为了对齐 Go 版 OpenList，用户口令被迫用**双层裸 SHA-256**（无 KDF）；为了绕过 Workers 的 WASM 限制，大量加密走了手写实现，其中**两处用 `Math.random()` 直接产出对称密钥**。同时 `DB_CIPHER` 默认值为 **`none`**，即**凭据默认明文落盘**。
3. **防护已写好但没接线（cold code）** —— CSRF 中间件、自带 `security-check.js` 均**从未被挂载或调用**。文件里写着"已实现"，运行时等于没有。

> ⚠️ **最重要的一条实践建议**：本仓库把网盘账号、refresh_token、OTP 种子、用户口令哈希**全部存在一个 KV 命名空间里**，而 `DB_CIPHER` 默认值是 `none`。请所有使用者在部署后立刻显式设置 `DB_CIPHER=aes-256-gcm` 并配置高强度 `JWT_SECRET`。

### 风险画像

| 维度 | 评级 | 说明 |
|---|---|---|
| 匿名远程代码执行 | ✅ 无 | 全仓无 `eval` / `new Function` / `child_process` |
| 匿名接管实例 | ✅ 无 | KV 代理三层鉴权齐备、无默认管理员、SSH 种子无后门 |
| **凭据静态保护** | 🔴 **弱** | 默认明文存储 + 单次 SHA-256 派生 + 口令无 KDF |
| **密码学实现正确性** | 🟠 **偏弱** | 2 处 `Math.random()` 产密钥、空 salt、固定 IV、遗留 1 次迭代 KDF |
| **供应链** | 🟠 **偏弱** | `.npmrc` 未禁 install 脚本 + CI 持长期私钥 + 依赖含已知 CVE |
| HTTP 层 (SSRF/穿越/注入) | 🟢 **扎实** | 三层路径净化、逐跳 SSRF 校验、SQL 全参数化 |
| 鉴权与会话 | 🟡 **良好但有缺口** | JWT 签发校验严谨；缺口在 OTP 锁定、OIDC 验签、S3 网关 |

---

## 二、严重度总览

| ID | 问题 | 严重度 | 利用前提 | 状态 |
|---|---|---|---|---|
| **S-01** | `DB_CIPHER` 默认 `none`，全部凭据明文落库 | 🔴 High | 需取得存储快照 | ✅ 已验证 |
| **S-02** | 密钥派生为单次 SHA-256，无 salt 无拉伸 | 🔴 High | 需快照 + 弱 `JWT_SECRET` | ✅ 已验证 |
| **S-03** | 用户口令双层裸 SHA-256 / 备用码单 SHA-256 | 🔴 High | 需快照 + 离线爆破 | ✅ 已验证 |
| **S-04** | 189 / 网易云音乐驱动用 `Math.random()` 产出对称密钥 | 🔴 High | 密码学误用 | ✅ 已验证 |
| **S-05** | `.npmrc` 未禁用 install 脚本 + CI 持长期私钥 | 🔴 High | 依赖被投毒 | ✅ 已验证 |
| **S-06** | hono 4.13.0 命中 CVE-2026-111757 / CVE-2026-84364 | 🟠 Medium-High | 依赖实际调用面而定 | ✅ CVE 已查证 |
| **S-07** | KV 代理 `JWT_SECRET` 经 `Host` 派生 origin 外发 | 🟠 High | Node/EdgeOne 部署 + 平台未校验 Host | ✅ 已验证源码承认 |
| **S-08** | local 驱动 `root_folder_path` 为空退化为文件系统根 | 🟠 High | Node 部署 + 管理员 API 误配 | ✅ 已降级处理 |
| **S-09** | `/api/auth/otp/login` 无登录锁定，OTP 可无限枚举 | 🟡 Medium | 需已持有 pending token | ✅ 已验证 |
| **S-10** | OIDC `id_token` 不验签名 | 🟡 Medium | 需管理员误配 | ✅ 已验证 |
| **S-11** | S3 网关未实现 SigV4，读路径不校验权限位 | 🟡 Medium | 需登录令牌 | ✅ 已验证 |
| **S-12** | 客户端 IP 退化为 `unknown` 导致全站限流 DoS | 🟡 Medium | 非 CF 部署且开了 `ip_limit` | ✅ 已验证 |
| **S-13** | WebDAV PUT 无体积上限 | 🟡 Medium | 需 WRITE 权限账号 | ✅ 已验证 |
| **S-14** | crypt 驱动 scrypt 默认空 salt；解密下载绕过 SSRF 校验 | 🟡 Medium | 配置依赖 | ✅ 已验证 |
| **S-15** | 遗留 v1 密文 PBKDF2 iterations=1、salt 固定 | 🟡 Medium | 需写库能力 | ✅ 已验证 |
| **S-16** | `aesCbcEncryptBase64` 默认 IV=密钥 + 硬编码密钥 | 🟡 Medium | 需密文观察 | ✅ 已验证 |
| **S-17** | 加密字段为白名单，新凭据字段默认漏网 | 🟡 Medium | 结构性问题 | ✅ 已验证 |
| **S-18** | CSRF 中间件与自带 `security-check.js` 均为死代码 | 🟡 Medium | 心理安慰风险 | ✅ 已验证 |
| **S-19** | 前端构建回退到未固定 commit 的上游 main | 🟡 Medium | 上游被劫持 | ✅ 已验证 |
| **S-20** | `sync_repo.yml` 持长期密钥强推第三方仓库 | 🟡 Medium | 仓库写权限 | ✅ 已验证 |

其余 17 项低危问题见 §六。

---

## 三、P0 —— 应立即修复（0–7 天）

### S-01｜凭据默认明文落库：`DB_CIPHER` 默认值是 `none` 🔴

**位置**：`src/backend/pkg/crypto.ts:411`、`src/backend/internal/model/store/backend.ts:128`

```ts
export const DEFAULT_DB_CIPHER: DbCipher = "none"   // crypto.ts:411
const raw = readEnv("DB_CIPHER", DEFAULT_DB_CIPHER, env)
```

**问题**：如果不显式设置 `DB_CIPHER`，所有**网盘 refresh_token、access_token、storage addition 全表、用户 OTP 种子、口令哈希、下载签名密钥**都以明文写入 Cloudflare KV / D1 / MySQL。任何能读到该命名空间的人（控制台权限、备份文件、共享库运维、KV 泄露）= **接管全部网盘与账号**。

注意 `store/backend.ts:132` 还有第二重坑：配置了一个拼错的值（如 `aes-256-gcn`）时，`resolveDbCipher` 会**静默降级为 `none`** 而不是拒绝启动——"以为开了加密"的那批部署大概率实际是裸奔。

**修复**
1. 默认值改为 `aes-256-gcm`（密文自带版本前缀，历史明文不受影响，可平滑兼容）。
2. 未知值**必须拒绝启动**，不得降级为 `none`。
3. 启动自检把 `DB_CIPHER=none` 作为**红色告警**打到 `/api/healthz` 与前端。

---

### S-02｜密钥派生仅单次 SHA-256，无 salt、无迭代 🔴

**位置**：`src/backend/pkg/crypto.ts:640-647`（`deriveKeyBytes`）

```ts
async function deriveKeyBytes(secret, info, length) {
  const digest = await sha256Bytes(`${info}|${secret}`)   // 单轮，无 salt，无迭代
  return digest.slice(0, length)
}
```

**问题**：源码注释自己写明了前提——"假设共享密钥本身足够随机"。但 `src/backend/internal/model/db.ts:1462-1470` 的 `readEnvEncryptionKey` 对 `JWT_SECRET` **只校验非空**。运维填一个 8 位口令是完全合法的，此时拿到数据库快照者可用 GPU 离线爆破，**一次命中即解开全部网盘令牌**。`db.ts:1975` 的 `warnWeakEncryptionKey` 只打印告警、不阻断。

**修复**：新增 v7 密文格式 = PBKDF2（≥210,000 次）/ Argon2id + **随机 salt 随密文持久化**；把"弱密钥"从告警升级为启动期拒绝。

---

### S-03｜用户口令双层裸 SHA-256，且静态盐公开 🔴

**位置**：`src/backend/pkg/password.ts:15, 28-46`

```ts
export const STATIC_HASH_SALT = "https://github.com/alist-org/alist"
StaticHash(pwd) = sha256(`${pwd}-${STATIC_HASH_SALT}`)
PwdHash        = sha256(`${StaticHash(pwd)}-${per-user salt}`)
```

**问题**：这是**为兼容 Go 版 OpenList** 的设计（`SharingSeed` 无关），属于**上游约束，不是本项目自己引入的缺陷**，但后果真实：两次哈希均单轮、无迭代、无内存硬化，GPU 可达 10¹⁰ hashes/s 量级。库一旦泄露，弱口令用户会被批量还原明文——**而用户常把该口令复用于网盘后台**。

同源文件第 28-30 行 + `auth.ts:1164-1168`：2FA 备用码（8 字符 × 32 字符集 ≈ 1.1×10¹² 空间）也用**固定公开盐单 SHA-256** 存储，库泄露后可离线枚举出可用备用码，**直接绕过 TOTP**。

**修复**
- 引入 Argon2id / scrypt / PBKDF2-高迭代的新口令格式，保留现有"登录成功后自动迁移"的既有迁移通道。
- 备用码改用 per-user salt + KDF，强度至少对齐口令。
- **短期缓解**：检测到 KV 泄露时立即轮换 `JWT_SECRET` 并强制所有用户改密。

---

### S-04｜两处驱动用 `Math.random()` 产出对称密钥 🔴

**位置 A**：`src/backend/drivers/189/util.ts:735-749`（天翼云盘）

```ts
const randomKey = randomUUID189("xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx")
  .slice(0, 16 + Math.floor(Math.random() * 17))
const encryptedParams = aes128EcbEncryptHex(params, randomKey.slice(0, 16))  // AES-128 会话密钥
const signature = hmacSha1Hex(`SessionKey=...&params=${encryptedParams}`, randomKey)  // HMAC 密钥
```

**位置 B**：`src/backend/drivers/netease_music/crypto.ts:156-160`（网易云音乐 weapi）

```ts
const idx = Math.floor(Math.random() * STD_CHARS.length)   // 逐字节挑字符，产出 16 字节 secretKey
key[i] = code
```

**问题**：`Math.random()` 是 V8 xorshift128+，**不是 CSPRNG**。它既做 AES 密钥又做 HMAC 签名密钥。观测有限次输出即可恢复 PRNG 内部状态并预测后续密钥。

> ⚠️ **准确性声明（避免过度渲染）**：这两处的**实际远程利用门槛较高**——189 的 `randomKey` 本身还要经 RSA 公钥加密后才发往服务端（`EncryptionText: rsaEncode(randomKey, pubKey, false)`），网易云的密钥也不离开本地进程。所以这不是"攻击者能立即读你网盘"的漏洞，而是**确凿的密码学实现违规**：在多请求共享 isolate 的边缘运行时里，它还可能引发密钥碰撞/降级。评级为 High 是因为修复成本只有一两行，收益极高。

**修复**：`randomKey` / `secretKey` 一律改用 `crypto.getRandomValues(new Uint8Array(16))`；`randomUUID189` 只保留给 `X-Request-ID` 等非密码学用途。

**同类清单**（非密钥用途，建议一并清理）：`189_tv/util.ts:153,171`、`139/util.ts:43`（参与签名 `calSign`，建议升级）、`mopan/consts.ts:28,39`（设备指纹）、`123pan/util.ts:126`、`123_share/util.ts:62`、`wopan/util.ts:50`、`halalcloud_open/util.ts:82`、`quark_open/util.ts:116`、`weiyun/crypto.ts:13`、`thunder/driver.ts:65`、`pikpak_share/util.ts:18`、`baidu_photo/util.ts:28`、`mega/util.ts:42`、`mediatrack/driver.ts:308`、`virtual/driver.ts:29`、`drivers/webdav/util.ts:224`（Digest 认证 `cnonce` — 这条建议尽快处理）。

---

### S-05｜未禁用依赖 install 脚本，而 CI 持有长期私钥 🔴

**位置**：`.npmrc`（全文仅两行 `node-linker=hoisted` / `shamefully-hoist=true`）、`.github/workflows/build-verify.yml:73`

**问题**：`.npmrc` **没有 `ignore-scripts=true`**。仓库锁定 **1544 个依赖包**，任何一个传递依赖被投毒后的 `postinstall` 都会在本机和 CI 上任意代码执行。而：

- `.github/workflows/sync_repo.yml:27,56` 持有**不过期的 `GITEE_SSH_PRIVATE_KEY`**
- `build-verify.yml` 默认持有 `GITHUB_TOKEN`

即"一次依赖投毒 → 私钥直泄"的完整链条。`shamefully-hoist=true` 还制造了幽灵依赖面。

**修复**：
1. `.npmrc` 加 `ignore-scripts=true`，需要原生编译的包用 `onlyBuiltDependencies` 白名单放行；
2. CI 改为 `pnpm install --frozen-lockfile --ignore-scripts`；
3. **`sync_repo` 的密钥与其他 job 隔离**，或改为 Gitee 侧反向拉取同步（不在 GitHub 存 Gitee 私钥）。

---

## 四、P1 —— 高优先级（7–30 天）

### S-06｜hono 4.13.0 落在两个 CVE 影响区间 🟠

**位置**：`package.json:169`（`"hono": "^4.12.28"`）→ `pnpm-lock.yaml:3172`（锁定 **`hono@4.13.0`**）；`pnpm-lock.yaml:5837`（`@hono/node-server@1.19.17`）

已通过公开漏洞库交叉查证：

| CVE / GHSA | 影响区间 | 修复版本 | 概要 |
|---|---|---|---|
| **CVE-2026-111757**<br>GHSA-5r4p-p66f-jhc7 | `>=4.12.4, <4.13.11` | **4.13.11** | `serveStatic` 二次解码请求路径，畸形百分号编码可"路由为 A、实际取 B"，**跳过挂在该静态前缀上的鉴权中间件**，CVSS 5.3（[GitHub Advisory](https://github.com/advisories/ghsa-5r4p-p66f-jhc7)） |
| **CVE-2026-84364**<br>GHSA-g6gw-c38x-mqfc | `<4.13.5` | **4.13.5** | `parseBody()` 点号展开无深度/总量限制，小 body 可放大为巨量对象导致堆耗尽 |
| GHSA-rmxm-3fg6-px4f | `@hono/node-server <2.1.3` | **2.1.3** | 同源二次解码问题 |

**实际影响校正**：我 grep 全仓确认**项目未调用 `serveStatic`**（CF Workers 走 `ASSETS` 绑定），`parseBody()` 也未被直接使用（改用 `c.req.formData()`），所以这两个 CVE **当前不可达**。但 `^4.12.28` 的区间写法意味着每次 CI 重装都可能拉取到不同的补丁集合，且 Vercel/Node 自托管路径未来引入 `serveStatic` 时风险立刻成立。

> **修复**：hono 升到 `>=4.13.14`，`@hono/node-server` 升到 `>=2.1.3`；CI 增加 `pnpm audit --audit-level=high` 门禁（**当前完全没有 SCA 步骤**）；`renovate.json` 补 `"vulnerabilityAlerts": { "enabled": true }`（现仅 `config:recommended`，S-10 同源问题）。

---

### S-07｜KV 代理的 `JWT_SECRET` 经 Host 派生 origin 外发 🟠

**位置**：`src/backend/index.ts:105-113`、`src/backend/internal/model/store/proxy.ts:38-73`、`src/backend/internal/model/store/driver/kv.ts:148`

```ts
env.__requestOrigin = reqUrl.origin   // ← 来自客户端 Host 头
// ...
fetch(`${baseUrl}/kv-list`, { headers: { "X-Internal-Call": JWT_SECRET } })  // ← 密钥随请求外发
```

**问题**：EdgeOne 的 Node 云函数拿不到 KV binding，必须经同部署的 Edge Function（`/kv-*`）代访问，而这条内部调用把**完整 `JWT_SECRET`** 放在 `X-Internal-Call` 头里。目标地址却来自 `__requestOrigin`，即**客户端可控的 `Host` 头**。

`proxy.ts` 的注释是一份很诚实的风险自述 —— 它做了三重约束（必须 http/https 绝对地址、须有 hostname、非 localhost 必须 https），并**刻意不做内网黑名单**。防线是"Host 由平台校验"。

**判定**：这是一个**真实但有条件**的问题。

- Cloudflare Workers 场景：**不成立**（Host 不匹配路由时 CF 不会分派）。
- **Node 自托管 / Vercel / Docker 场景：成立** —— 攻击者发送任意请求并带上 `Host: evil.com`，若平台未校验 Host，Worker 就会把 `JWT_SECRET` 通过 `https://evil.com/kv-list`（攻击者自有域名 + 免费 TLS 证书完全可行）发出去。拿到该密钥即可**伪造 `role=2` 的管理员 JWT**，反向任意读写整个 KV，等同于全库泄露。

**修复**：`__requestOrigin` 不可信。改为只信任显式配置的 `EO_KV_URLS`，或增加部署域名白名单；内部调用改用 HMAC(timestamp + body) 一次性签名，而非传输长期密钥。

---

### S-08｜local 驱动根目录退化：任意主机文件读写 🟠

**位置**：`src/backend/pkg/local-fs-guard.ts:77`、`src/backend/internal/model/db.ts:2514-2537`、`src/backend/server/admin.ts:244-312`

```ts
if (!root || root === "/" || root === "\\") return   // local-fs-guard.ts:77 —— 直接跳过校验
const defaultRoot = "/"
const parts = [rootFolder, relPath].filter(p => Boolean(p) && p !== "/")   // db.ts:2522
if (rootNorm !== "/" && ...) throw new Error("path traversal blocked")     // db.ts:2535，整段被跳过
```

**问题**：当一个挂载存储的 driver 是 `local` 且 `root_folder_path` 为空时，物理根退化为文件系统根。于是 `GET /d/etc/passwd` 可读任意主机文件；有 `canWrite` 的用户 `PUT /api/fs/put` 可写任意文件（`fs.ts:1136` 确实校验了写权限位）。

**降级理由（重要，避免过度渲染）**：我对该结论做了独立交叉验证，确认**原报告的"默认配置下即可利用"不成立**：

1. UI 上不可达 —— `/api/admin/driver/list`（`admin.ts:4701-4705`）返回的驱动列表**不含 `Local`**，下拉框根本没有这个选项；
2. `/api/admin/storage/create`（`admin.ts:244-312`）只校验 `driver` 非空与 `mount_path` 唯一，`addition` 原样透传 → **API 调用于是可以创建**；默认参数下 `mount_path` 会被兜底成 `"/"`，导致根挂载；
3. **必须 Node.js 运行时** —— `storage.ts:294` 要求 `process.release?.name === "node"`，Cloudflare Workers 下 `raw.ts:734` 直接返回 500。

**最小复现**（Node 部署 + 管理员）：

```
POST /api/admin/storage/create  {"driver":"Local","addition":"{}"}
GET  /d/etc/passwd
```

**修复**：local 驱动的 `root_folder_path` 为空时**拒绝挂载**（对齐 Go 版 `required:"true"`）；同时让 `assertLocalPathInsideRoot` 对 `""` / `"/"` 也走 realpath 校验。

---

### S-09 至 S-20 汇总

| ID | 位置 | 问题 | 后果 | 修复要点 |
|---|---|---|---|---|
| **S-09** | `auth.ts:690`（对比 `/login` 的 `:788`、`:884`） | TOTP 兑换入口只 `recordLoginFailure`，**从不 `isLoginLocked()`** | 持有 pending token 者可无限枚举 6 位验证码，**第二因子形同虚设** | 进入 `checkUserOtp` 前先查锁定；阈值降到 5 |
| **S-10** | `sso.ts:508-512, 657-669` | 无 `userinfo_endpoint` 时，`parseJwtPayload` **仅 base64 解码**，不验签、不校 `alg` | IdP 配置被污染时可伪造任意 `sub` 登录 | 必须拉 `jwks_uri` 验签，或强制要求 userinfo 端点 |
| **S-11** | `s3.ts:30-36, 222-272` | 自述"完整 SigV4 作为后续增强"——**压根没有签名校验**；读路径只有 `isWithinUserRoot`，**无任何权限位判定** | 持任意登录令牌即可列举挂载点并读取对象（写到/删才有 `canWrite`/`canRemove`）；`key` 允许 `%2e%2e` | 实现 SigV4；读路径补权限位；key 用 `canonicalVirtualPath` 归一 |
| **S-12** | `router.ts:54-82`、`pkg/audit.ts:114` | 非 CF 且未设 `TRUST_PROXY_HEADERS=1` 时 IP = `"unknown"`，**所有请求共用同一个限流键** | 开了 `ip_limit` 后任何人打满配额即**全站 429**（DoS），且审计日志无法溯源 | `unknown` 时跳过 IP 维度限流并告警；审计侧标注不可信并提示运维配置 |
| **S-13** | `webdav.ts:398` | `Buffer.from(await c.req.arrayBuffer())` —— **唯一没走 `readBodyWithinLimit` 的写入口** | 带 `WEBDAV_MANAGE` 位的用户 PUT 无上限 body，Node 自托管可打满内存 | 改用 `readBodyWithinLimit(c)` |
| **S-14** | `drivers/crypt/driver.ts:61`（`cipher.ts:24-30`）、`:232` | scrypt 默认 `salt: ""` → **无盐派生**；`createReadStream` 里 `fetch(item.raw_url)` **未调 `assertSafeUrl` 且默认 `redirect:"follow"`** | 彩虹表可预计算爆破；crypt 作为"强制代理"驱动却绕开全局 SSRF 防线 | salt 为空时拒绝初始化；下载复用 `safeProxyFetch(url, raw_url_headers, trustedHosts)` |
| **S-15** | `crypto.ts:222-233` | 遗留 v1 分支 `iterations = 1`、`salt = "salt"` | 若能写库，可把攻破字段以 v1 格式重新落盘，**把强度钉死在 1 次迭代** | 迁移完成后移除 v1 解密，或仅限 `DB_CIPHER_ALLOW_LEGACY=1` |
| **S-16** | `crypto.ts:336-342` | `ivBytes = iv ? toBytes(iv) : keyBytes` —— **未传 IV 时 IV = 密钥**；调用方实测硬编码密钥 `"u2oh6Vu^HWe4_AES"`（chaoxing 登录） | 固定 IV + CBC 使首块等价 ECB，相等明文前缀产生相等密文前缀 | 强制随机 IV 并随密文输出；外部固定密钥移入配置 |
| **S-17** | `db.ts:1418-1428, 2050-2110` | `SENSITIVE_SETTING_KEYS` 是**白名单**；`users.authn`（WebAuthn 凭据）、`users.otp_backup_codes`、`users.salt` 不在 `sealDb` 覆盖内 | 新增凭据型设置键自动不加密，passkeys 凭据明文落库 | 改黑名单/启发式（键名含 secret/token/password/key）+ 结构式兜底 |
| **S-18** | `pkg/csrf.ts:12,119`、`middlewares.ts:444`、`scripts/security-check.js:104-120` | `csrfProtection` / `csrfMiddleware` **从未被 `app.use` 挂载**；`security-check.js` 只校验 `JWT_SECRET` 长度，且读 `process.env`（Workers 里恒为空），**全仓无任何调用，是死代码** | 给维护者"已有防护"的虚假安全感；一旦引入 Cookie 会话即裸奔 | 删 `pkg/csrf.ts`（当前会话走 Bearer，传统 CSRF 不成立）；把 `security-check.js` 改为读 `env` 绑定并覆盖 ADMIN_PASS/ALLOW_URLS/CORS 等后注册为 predeploy 钩子 |
| **S-19** | `scripts/fetch-frontend.mjs:611, 711-715, 754-815` | 主校验链路是好的（npm tarball 校 `dist.integrity` sha512），但**发布版缺文件时自动回退** `git clone --depth 1 --branch main` 上游仓库并执行 `pnpm install` + `build`，`FRONTEND_GIT_SHA` 默认为空 | 上游或其依赖被劫持 → **构建机 RCE + 污染部署产物** | CI 强制设 `FRONTEND_GIT_SHA` + `FRONTEND_SHA512`；回退改为默认失败，需 `FRONTEND_ALLOW_SOURCE_BUILD=1` |
| **S-20** | `.github/workflows/sync_repo.yml:27,56,61-79` | `GITEE_SSH_PRIVATE_KEY` 不过期；对 Gitee 执行 `git push --force`；目标地址取自**可被有写权限者修改的仓库变量** `GITEE_REPO_URL` | 全量源码可推到攻击者服务器 | 改 Gitee 侧反向拉取；目标地址硬编码为 workflow 常量 |

其余：`drivers/netease_music/util.ts:110` 含 `MUSIC_U` 登录态的 Cookie 走**明文 http**（`:44` 取 `addition.cookie`），中间人可直接接管账号 —— 单点遗漏，改 https 即可。

---

## 五、重点澄清：不存在"种子后门"

我专门花了一轮核实最受关注的一点：**`src/backend/internal/seed/*`（21KB codec + 14KB hashers + 10KB types）这套"seed"机制是否为出厂默认凭据 / 后门登录通道。**

**结论：不是。攻击者无法用它登录。**

- `types.ts` 定义的是 **`SharingSeed`** —— 即 BT 种子 / 网盘秒传元数据（文件路径、piece_size、md5/sha1 分片哈希、trackers）。此处的 MD5/SHA1 是全新的纯 JS 实现，目的只是**绕开边缘运行时禁用 WASM 的限制**，用于秒传校验。
- 全目录**无 password / admin / token / KDF 相关符号**，不存在"用户名 → 确定性口令"的派生链。
- 管理员唯一来源是 `POST /api/public/init/setup`（`public.ts:699`），且 `public.ts:742-770` 在库已存在或不可解密时拒绝重建。
- `auth.ts:479` 明确"不再自动生成随机密码"——**无默认管理员、无默认口令**。

---

## 六、低危与信息项（P2/P3）

| ID | 位置 | 问题 | 建议 |
|---|---|---|---|
| L-01 | `fetch-frontend.mjs:584,708` | `tar -xzf tmpTar -C langDir` 无成员名校验，恶意归档可 `../` 越写（缓解：先校验 sha256） | 解包前枚举成员名，拒绝绝对路径与 `..` |
| L-02 | `esa-entry.ts:57-64, 250-253` | 模块加载即 `console.log("globalThis keys: …")`，可能把绑定名泄漏到平台日志 | 删除或仅在 `ESA_LOG_ENV=1` 下输出并脱敏 |
| L-03 | `esa-entry.ts:86-146` | 60s TTL 模块级 KV 缓存跨请求共享；`get` 失败也缓存 `null` 60s，放大故障窗口 | 失败不缓存负值；put 失败时主动失效 |
| L-04 | `edgeone.json:61-69` | 定时任务 `payload: { "cron_secret": "" }` 与 `.dev.vars.example:25` 的"CRON_SECRET 必填"冲突 → 定时任务**必然被拒**（fail-closed，属功能缺陷非漏洞） | 删除该 schedule 或改平台密钥注入 |
| L-05 | `functions/_kv-proxy.js:205-251` | 鉴权无失败计数/锁定；`JWT_SECRET` 下限仅 16 字符可在线爆破 | 下限提到 32；按 IP 限流 + 失败计数 |
| L-06 | `middlewares.ts:143-163` | JWT 直接复用 `openlist_encryption_secret`（下载签名已 HMAC 派生，JWT 未派生） | 对 JWT 也做用途派生 `hmac("openlist-jwt-v1", secret)` |
| L-07 | `webauthn.ts:566` | `credential.sign_count !== undefined && signCount !== 0 && …` —— 老凭据缺字段时**整段重放检测被跳过** | 缺字段时按 0 处理，注册时强制写 0 |
| L-08 | `auth.ts:538-550` | `consumeTotpCode` 先 get 后 set，非原子，并发提交同一验证码可能双通过 | 改 compare-and-set + 短临界锁 |
| L-09 | `auth.ts:130-132, 289-294` | 用户名维度 20 次失败锁 15 分钟，**与 IP 无关** → 任何人可周期性锁死 admin | 按"用户名 + 可信 IP 成功史"放行，或提供自助解锁 |
| L-10 | `cache/store.ts:388-397` | `buildCacheKey = kind + storageId + path`，**无用户/租户维度**，隔离依赖调用方套用 base_path | 把用户标识并入缓存键 |
| L-11 | `drivers/degoo/util.ts:13`、`drivers/wopan/consts.ts:4` | 硬编码第三方凭据（Degoo AppSync `da2-…`、沃云 `XFmi9GS2hzk98jGX`） | 移至 Secret 注入，或显式标注"公开常量"并纳入轮换跟踪 |
| L-12 | `pnpm-lock.yaml:3722,2667,3976,4438` | `otplib@12.0.1`（官方要求升 v13，本项目 2FA 核心依赖）、`crypto-js@4.2.0`（**官方声明停止维护**，却承担 `DB_CIPHER` 加解密）、`sha256@0.2.0`、`xpath@0.0.34` | otplib → v13；crypto-js → WebCrypto / `@noble/ciphers` |
| L-13 | `package.json:143,177` | `@hope-ui/solid` 与 `mpegts.js` 来自 GitHub tarball，**脱离 registry 完整性保护**（已 pin commit SHA 缓解） | 改用 npm 发布版，或在 CI 校验 tarball integrity |
| L-14 | `wrangler.jsonc:222` | KV namespace id `2df51e19…` 明文写死（非凭据，但便于定位资源） | 接受，属可接受风险 |
| L-15 | `drivers/189pc/crypto.ts:5,21` | 用 Node `crypto` 的 `createCipheriv`/`publicEncrypt`，**在 Workers 下静态 import 即加载失败** | 改 Web Crypto AES-CBC + RSA-OAEP |
| L-16 | `.gitignore:5` + `scripts/test-share.mts:5` | `public_data/` 被 gitignore 却随包分发，且被测试当作 local 驱动 rootFolder | 明确仅作测试夹具，禁止作为生产存储根 |
| L-17 | `scripts/_regress.mjs:15` 等 | 测试文件含 `"jwt-secret-32-characters-long!!"`、`admin1234` 等 —— 均已确认**为占位值，非真实凭据** | 收敛到 `TEST_*` 常量；引入 gitleaks 扫描防真值混入 |

---

## 七、安全防护做得好的部分（值得肯定）

审查不是只挑毛病。以下这一组实现**质量明显高于个人移植项目的平均水准**，修改时请务必别退化了：

| 面 | 实现 | 评价 |
|---|---|---|
| **KV 代理鉴权** | `functions/_kv-proxy.js:205-294` | 三层校验：密钥常量时间比对 / HS256 验签强制 exp+nbf+iss+aud / 拒绝 `otp_pending` / 强制 `role===2`；无密钥时 **fail-closed**。**匿名完全无法读写 KV** —— 这是本仓库最高危的攻击面，做对了 |
| **路径穿越** | `pkg/path.ts` + `canonicalVirtualPath` + `getActualPath` | 三层同源钳制；`../`、双重编码、`%2f`、`...`、反斜杠全部拦住；测试用例覆盖属实 |
| **SSRF** | `raw.ts:96-131` `safeProxyFetch` | **手动跟随重定向 + 逐跳重新断言**（这是最容易做错的一点，本项目做对了）+ 跨域剥离 Cookie/Authorization + 限 5 跳；IP 的整数/十六进制/短式写法也已拦截。**未发现任何匿名可控 URL 的服务端 fetch 开放代理** |
| **zip slip** | `fs.ts:258-269` `safeArchiveEntryPath` + `:2336` 二次校验 | 多层兜底，未发现解压穿越 |
| **响应头注入** | `sanitizeContentDisposition` 去 CR/LF + `attachment` 兜底 + SVG CSP | 无缺陷 |
| **SQL 注入** | `format/sql.ts` + `mysql.ts` | 全部值走 `?` 占位符；标识符源自固定 `TABLES` 常量，`getTablePrefix` 硬编码 `"x_"`，**无拼接注入面** |
| **fail-closed 设计** | `blob.ts:66-80`、`db.ts:2282-2404`、`matchCronSecret` | `isNotFoundError` 区分"不存在"与"读失败"；`saveDb` 空壳库拦截 + 失败回滚；`CRON_SECRET` 未配置时**拒绝**而非放行 —— 我核实了 `edgeone.json` 里 `cron_secret: ""` 的情形，结论是 fail-closed，安全 |
| **默认值安全** | `wrangler.jsonc` | `workers_dev: false` + `preview_urls: false` —— **不存在预览/staging 实例暴露公网的绕过面**；`compatibility_date: 2026-08-04` 较新；无明文 account_id |
| **敏感信息 gitignore** | `.gitignore:22-28,81-91` | `.env` / `.dev.vars` / `*.pem` / `*.key` / `*.p12` 全部正确忽略，工作区无真实密钥文件 —— 这一项实践良好 |
| **CI 基础** | `build-verify.yml` | 用 `pull_request`（**非 `pull_request_target`**）+ `permissions: contents: read` + actions 按 commit SHA 固定 + 无 `${{ }}` 注入到 `run:` + 无 `curl \| bash` |
| **密钥主源** | `db.ts` | `env.JWT_SECRET > 持久化 secret`，且"只在 setup 生成、写后回读校验"，避免换钥导致密文永久不可解 —— 设计是稳的 |
| **AEAD 实现** | `chacha20.ts`、`crypto.ts` v3/v5/v6 | RFC 8439 认证构造正确（aad‖pad‖ct‖len），标签定长比较，**Encrypt-then-MAC 先验签后解密**，v2 用 HKDF 域分离 |
| **凭据处理✔** | `storage.ts` / `admin.ts` / `debug.ts` | 无 dump/backup/export 接口；`db.ts` 对**整个 `storages[].addition`** 做字段级 seal（非逐字段白名单），新驱动字段不会漏脱敏 —— 这个设计是对的（注意 S-17 说的是 *settings* 那张表是白名单，两张表不同） |
| **弱算法开关** | `store/backend.ts:136-147` | `DB_CIPHER_ALLOW_INSECURE` 默认关闭，DES/3DES 会自动升级为 aes-256-gcm |

---

## 八、修复路线图

```
第 0–7 天（凭据与供应链止血）
  ├─ 部署侧：立即确认 DB_CIPHER=aes-256-gcm，并轮换 JWT_SECRET（≥32 字节随机）
  ├─ hono ≥4.13.14 / @hono/node-server ≥2.1.3；CI 加 pnpm audit 门禁
  ├─ .npmrc 加 ignore-scripts=true；CI 用 --ignore-scripts；隔离 sync_repo 密钥
  ├─ 189 / netease_music 的 Math.random 密钥 → crypto.getRandomValues
  └─ local_fs_guard：local 驱动强制 root_folder_path 非空

第 7–30 天（鉴权与解析面）
  ├─ OTP 兑换补 isLoginLocked 前置
  ├─ OIDC 强制 JWKS 验签（至少校 alg≠none）
  ├─ S3 实现 SigV4 + 读路径权限位
  ├─ WebDAV PUT 接入 readBodyWithinLimit
  ├─ 修复 IP = "unknown" 时的限流键塌陷
  └─ crypt：空 salt 拒绝 + 下载接回 safeProxyFetch

第 30–90 天（密码学纵深与工程债）
  ├─ 引入带 salt + 拉力的 v7 密文格式；移除 v1 遗留分支
  ├─ 口令迁移到 Argon2id（保留登录成功后自动迁移通道）
  ├─ 备用码改用 per-user salt + KDF
  ├─ seal 字段从白名单改黑名单 + 覆盖 authn / otp_backup_codes
  ├─ 删除 csrf.ts 死代码；重写 security-check.js 并接入 CI
  ├─ crypto-js → @noble/ciphers；otplib → v13
  └─ CI 固定 FRONTEND_GIT_SHA + FRONTEND_SHA512；回退改为默认失败
```

---

## 九、附录：审查覆盖面

| 模块 | 关键文件 | 方式 |
|---|---|---|
| 边缘入口 | `esa-entry.ts`、`handler.ts`、`middleware.js`、`loadEnv.js`、`api/*`、`cloud-functions/*`、`node-functions/*` | 全读 |
| KV 代理传输层 | `functions/_kv-proxy.js`、`functions/kv-{get,put,list,delete}`、`store/proxy.ts`、`store/driver/kv.ts` | 全读 |
| 鉴权会话 | `auth.ts`(41KB)、`middlewares.ts`(27KB)、`sso.ts`(27KB)、`webauthn.ts`(28KB)、`user.ts`、`pkg/csrf.ts`、`pkg/sign.ts`、`pkg/password.ts`、`pkg/totp.ts` | 全读 |
| 协议入口 | `fs.ts`(87KB)、`raw.ts`(31KB)、`webdav.ts`、`s3.ts`、`proxy_request.ts`、`public.ts`(34KB) | 全读 |
| 驱动层 | **约 100 个驱动** | 公共基座全读 + 12 类危险模式全仓正则扫描 + 高风险驱动（189/crypt/local/github/webdav/ftp/netease）精读 |
| 密码学与存储 | `crypto.ts`(33KB)、`chacha20.ts`、`legacy-ciphers.ts`、`seed/*`(45KB)、`db.ts`(90KB 加密相关)、`store/**` | 全读 |
| 供应链 | `package.json`、`pnpm-lock.yaml`(328KB 抽样)、`wrangler.jsonc`、`*.example`、CI workflows、`fetch-frontend.mjs`(35KB)、`security-check.js` | 全读 + OSV/GitHub Advisory 查证 |

**已通过全正则扫描确认为零命中**：`eval(`、`new Function(`、`innerHTML`、`dangerouslySetInnerHTML`、`document.write`、`child_process`、`exec(`、`spawn(`、 Hardcoded 真实凭据（`AKIA…` 真实值 / `ghp_` / `github_pat_` / `xox[baprs]-` / `sk-` / `BEGIN … PRIVATE KEY` —— 仅 `drivers/s3/s3.test.ts:54` 有 AWS 官方示例键 `AKIAIOSFODNN7EXAMPLE`）、SQL 字符串拼接、默认管理员口令。

---

*报告基于静态代码审计。所有高危结论均经过二次交叉验证，对两条初始判定为 Critical 的发现（S-08 local 根目录退化、S-06 hono CVE）已做降级处理并附明确指出利用前提，避免过度渲染。建议结合动态测试（尤其 OTP 枚举与 S3 未授权读）确认实际影响面。*
