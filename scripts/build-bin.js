/**
 * 生成 Node SEA（Single Executable Application）二进制。
 *
 * 说明（audit F-131）：
 * - 旧版第一步执行 `npm run build:server`，但 package.json 里没有这个 script，
 *   脚本必然在第一步失败；
 * - 旧版从未做 SEA 注入（postject），却把 node 可执行文件原样拷贝成
 *   dist/server-bin 并打印 "Injected blob into binary..."，产物实际不可用。
 *
 * 现在的行为：每一步都校验前置条件，任何一步不满足都以非零退出并说明原因，
 * 绝不再产出「看起来成功」的裸 node 副本。SEA 注入依赖 Node 官方推荐的
 * postject 工具（本项目未内置该依赖），未安装时明确失败。
 *
 * 用法：node scripts/build-bin.js
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = process.cwd()
const SEA_CONFIG = path.join(ROOT, "sea-config.json")
const OUTPUT_BINARY = path.join(ROOT, "dist", "server-bin")
// Node 文档规定的 SEA sentinel fuse
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

function fail(message) {
  console.error(`[build-bin] ${message}`)
  process.exit(1)
}

function readSeaConfig() {
  if (!fs.existsSync(SEA_CONFIG)) {
    fail(`缺少 sea-config.json（${SEA_CONFIG}），未生成任何二进制。`)
  }
  try {
    return JSON.parse(fs.readFileSync(SEA_CONFIG, "utf-8"))
  } catch (err) {
    return fail(`sea-config.json 不是合法 JSON：${err?.message || err}`)
  }
}

/**
 * 定位 postject 的 CLI 入口（通过 require.resolve，未安装时返回 null）。
 * 走 node + cli.js 而不是 .bin/*.cmd，避免 Windows 上 .cmd 无法被无 shell 的
 * execFileSync 启动的问题。
 */
function resolvePostjectCli() {
  try {
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve("postject/package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.postject
    if (!bin) return null
    const cli = path.resolve(path.dirname(pkgPath), bin)
    return fs.existsSync(cli) ? cli : null
  } catch {
    return null
  }
}

function main() {
  const config = readSeaConfig()
  const mainEntry = config.main ? path.resolve(ROOT, config.main) : ""
  if (!mainEntry || !fs.existsSync(mainEntry)) {
    fail(
      `sea-config.json 的 main 指向 ${config.main || "(缺失)"}，但该文件不存在。\n` +
        `本仓库的打包产物是 dist-server/api/[...route].js（npm run build:edge），` +
        `请先把 sea-config.json 的 main 指向实际入口。本次未生成任何二进制。`,
    )
  }
  const blob = config.output ? path.resolve(ROOT, config.output) : ""
  if (!blob) {
    fail("sea-config.json 缺少 output（SEA blob 路径），本次未生成任何二进制。")
  }

  const postjectCli = resolvePostjectCli()
  if (!postjectCli) {
    fail(
      "未安装 postject（Node SEA 注入必需的工具），无法生成可执行二进制。\n" +
        "未注入的 dist/server-bin 只是 node 可执行文件的副本（运行只会进入 REPL），" +
        "因此本次不创建该文件。请安装 postject（devDependency）后重试，或直接使用 " +
        "`npm run build:edge` 产出的 dist-server/api/[...route].js 配 node 运行。",
    )
  }

  console.log("Step 1: Generating SEA blob...")
  execFileSync(process.execPath, ["--experimental-sea-config", SEA_CONFIG], {
    cwd: ROOT,
    stdio: "inherit",
  })
  if (!fs.existsSync(blob)) {
    fail(`SEA blob 未生成（期望路径 ${blob}），终止。`)
  }

  console.log("Step 2: Creating standalone binary...")
  fs.mkdirSync(path.dirname(OUTPUT_BINARY), { recursive: true })
  fs.copyFileSync(process.execPath, OUTPUT_BINARY)

  console.log("Step 3: Injecting SEA blob...")
  const injectArgs = [
    postjectCli,
    OUTPUT_BINARY,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    SENTINEL_FUSE,
  ]
  if (process.platform === "darwin") {
    injectArgs.push("--macho-segment-name", "NODE_SEA")
  }
  execFileSync(process.execPath, injectArgs, { cwd: ROOT, stdio: "inherit" })

  console.log(`✓ SEA binary created: ${OUTPUT_BINARY}`)
  if (process.platform === "darwin") {
    console.log(
      "  macOS 上还需对注入后的二进制重新签名（codesign --sign - <binary>），否则会被系统终止。",
    )
  }
}

main()
