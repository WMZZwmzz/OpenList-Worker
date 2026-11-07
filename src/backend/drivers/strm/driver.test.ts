import assert from "node:assert/strict"
import { test } from "node:test"
import { StrmDriver } from "./driver"
import { verifyDownloadSign } from "../../pkg/sign"
import { setEnvCtx, __resetDbCacheForTest } from "../../internal/model/db"
import { resetJwtSecretCache } from "../../server/middlewares"

// F-472：withSign 在管理界面可配置但驱动从未读取；开启全站下载签名的部署里
// 每条 .strm 链接都会被 /d 的验签拦成 401。getLink 必须用 pkg/sign 的同一套
// HMAC 为虚拟路径签发 sign 并拼到链接上。
test("F-472：withSign 时 .strm 链接带可验证的 sign", async () => {
  const driver: any = new StrmDriver({
    paths: "x:/remote",
    siteUrl: "https://site.example.com",
    withSign: true,
  })
  const link: string = await driver.getLink("/remote/movie/a.mp4")
  const url = new URL(link)
  assert.equal(url.pathname, "/d/remote/movie/a.mp4")
  const sign = url.searchParams.get("sign")
  assert.ok(sign, `链接必须带 sign 参数: ${link}`)
  assert.equal(
    await verifyDownloadSign({}, "/remote/movie/a.mp4", sign!),
    true,
    "sign 必须能被 /d 路由的验签函数接受",
  )
})

test("F-472：未开启 withSign 时链接保持原样（无 sign）", async () => {
  const driver: any = new StrmDriver({
    paths: "x:/remote",
    siteUrl: "https://site.example.com",
  })
  const link: string = await driver.getLink("/remote/movie/a.mp4")
  assert.equal(link, "https://site.example.com/d/remote/movie/a.mp4")
})

test("F-472：encodePath 与 withSign 并存（签名针对解码后的虚拟路径）", async () => {
  const driver: any = new StrmDriver({
    paths: "x:/remote",
    siteUrl: "https://site.example.com",
    encodePath: true,
    withSign: true,
  })
  const link: string = await driver.getLink("/remote/我的 视频.mp4")
  const url = new URL(link)
  assert.equal(
    url.pathname,
    "/d/remote/%E6%88%91%E7%9A%84%20%E8%A7%86%E9%A2%91.mp4",
  )
  const sign = url.searchParams.get("sign")
  assert.ok(sign)
  assert.equal(
    await verifyDownloadSign({}, "/remote/我的 视频.mp4", sign!),
    true,
  )
})

// 生产场景回归：JWT 密钥存持久化后端（未配置 JWT_SECRET 环境变量）时，
// 驱动侧若拿不到请求 env 会各生成一把随机会话密钥，sign 永远验不过。
// setEnvCtx 注入请求级 env 后，签发（getEnvCtx）与验签（raw.ts 的 c.env）
// 必须派生自同一把密钥。
test("F-472：驱动经请求级 env 签发，与带 env 的验签上下文一致", async () => {
  const env = { JWT_SECRET: "0123456789abcdef0123456789abcdef" }
  setEnvCtx(env)
  try {
    const driver: any = new StrmDriver({
      paths: "x:/remote",
      siteUrl: "https://site.example.com",
      withSign: true,
    })
    const link: string = await driver.getLink("/remote/movie/a.mp4")
    const sign = new URL(link).searchParams.get("sign")
    assert.ok(sign, `链接必须带 sign 参数: ${link}`)
    // 对齐 raw.ts:516：验签上下文是携带请求 env 的 hono context
    assert.equal(
      await verifyDownloadSign({ env }, "/remote/movie/a.mp4", sign!),
      true,
      "驱动签发的 sign 必须能被携带真实 env 的 /d 验签接受",
    )
  } finally {
    // 还原模块级状态，避免串味到其他用例
    resetJwtSecretCache()
    __resetDbCacheForTest()
  }
})
