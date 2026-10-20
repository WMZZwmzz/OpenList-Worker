import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { saveDb } from "../internal/model/db"
import { publicRouter } from "./public"

/**
 * M-8（SECURITY-AUDIT-2026-10-20）回归测试：
 *
 * `/api/public/settings` 的 allowlist 由「默认设置对象的全部键」展开而来，
 * 于是 `ocr_api`、`privacy_regs`、`iframe_previews` 这些**管理员配置**也进了
 * 公开面。`ocr_api` 尤其危险：它的键名既不含 `api_key` 也不含 `secret`，
 * 旧敏感正则放行，而 OCR 端点常把密钥放在 query 里 —— 匿名读到这里就等于
 * 拿到管理员配置的密钥。
 */

const env: any = {}

const seed = (settings: any[]) =>
  saveDb({ settings, users: [], storages: [], shares: [] }, env)

const fetchSettings = async () => {
  const app = new Hono()
  app.route("/api/public", publicRouter)
  const res = await app.request("/api/public/settings")
  assert.equal(res.status, 200)
  return (await res.json()) as any
}

test("M-8: 管理员专用配置键不回显给匿名请求", async () => {
  await seed([
    { key: "ocr_api", value: "https://ocr.example/api?key=SUPER_SECRET_OCR" },
    { key: "privacy_regs", value: "^/private/.*$" },
    {
      key: "iframe_previews",
      value: '{"mp4":{"preview_name":"http://10.0.0.1/x"}}',
    },
    { key: "hide_files", value: "/secret\\.txt/i" },
    { key: "handle_hook_after_writing", value: "https://hook.example/x" },
    { key: "api_token", value: "SUPER_SECRET_API_TOKEN" },
    { key: "download_sign_secret", value: "SUPER_SECRET_SIGN" },
  ])

  const json = await fetchSettings()
  for (const key of [
    "ocr_api",
    "privacy_regs",
    "iframe_previews",
    "hide_files",
    "handle_hook_after_writing",
    "api_token",
    "download_sign_secret",
  ]) {
    assert.equal(
      key in json.data,
      false,
      `"${key}" 属于管理员专用配置，不得出现在公开设置里`,
    )
  }
  assert.equal(
    JSON.stringify(json.data).includes("SUPER_SECRET_OCR"),
    false,
    "任何响应片段都不应包含 OCR 密钥",
  )
})

test("M-8: 展示类设置照常回显（无误伤）", async () => {
  await seed([
    { key: "site_title", value: "My Site" },
    { key: "customize_body", value: "<p>custom</p>" },
    { key: "sign_all", value: "true" },
  ])
  const json = await fetchSettings()
  assert.equal(json.data.site_title, "My Site")
  assert.equal(json.data.customize_body, "<p>custom</p>")
  assert.equal(json.data.sign_all, "true")
})
