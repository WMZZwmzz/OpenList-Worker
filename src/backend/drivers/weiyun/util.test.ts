import { describe, it } from "node:test"
import assert from "node:assert"
import { parseCookieStr, cookieToString, WeiyunClient } from "./util"
import { getHash33, IncrementalSha1, sha1Hex } from "./crypto"
import { WeiyunDriver, normalizeWeiyunAddition } from "./driver"

describe("Weiyun Crypto & Hash", () => {
  it("computes hash33 correctly for ptqrtoken", () => {
    const hash = getHash33("abc123xyz")
    assert.strictEqual(typeof hash, "string")
    assert.ok(parseInt(hash, 10) > 0)
    // Deterministic test for "test_sig"
    assert.strictEqual(getHash33("test_sig"), "20502530")
  })

  it("computes SHA-1 correctly", () => {
    const text = "hello weiyun"
    const hex = sha1Hex(text)
    assert.strictEqual(hex, "ea23d28e84d5bc815f8c8f26527464656afdc7e3")
  })

  it("handles incremental SHA-1 state extraction", () => {
    const sha = new IncrementalSha1()
    const block = new Uint8Array(64).fill(0x61) // 64 'a's
    sha.update(block)
    const stateHex = sha.getStateHex()
    assert.strictEqual(stateHex.length, 40) // 20 bytes = 40 hex chars
  })
})

describe("Weiyun Cookie Management", () => {
  it("parses and formats cookie string", () => {
    const cookieStr = "uin=123456; skey=@abc; wyctoken=token123; wy_uf=0"
    const cookies = parseCookieStr(cookieStr)
    assert.strictEqual(cookies.get("uin"), "123456")
    assert.strictEqual(cookies.get("skey"), "@abc")
    assert.strictEqual(cookies.get("wyctoken"), "token123")
    assert.strictEqual(cookies.get("wy_uf"), "0")

    const formatted = cookieToString(cookies)
    assert.ok(formatted.includes("uin=123456"))
    assert.ok(formatted.includes("skey=@abc"))
  })

  it("identifies QQ and WeChat account types", () => {
    const qqClient = new WeiyunClient({
      cookies: "uin=123456; p_skey=psk123; wy_uf=0",
    })
    assert.strictEqual(qqClient.loginType(), "qq")
    const qqToken = qqClient.parseTokenInfo()
    assert.strictEqual(qqToken.token_type, 0)
    assert.strictEqual(qqToken.login_key_type, 27)
    assert.strictEqual(qqToken.login_key_value, "psk123")

    const wxClient = new WeiyunClient({
      cookies: "openid=wx123; access_token=act456; wy_appid=app789; wy_uf=1",
    })
    assert.strictEqual(wxClient.loginType(), "weixin")
    const wxToken = wxClient.parseTokenInfo()
    assert.strictEqual(wxToken.token_type, 1)
    assert.strictEqual(wxToken.openid, "wx123")
    assert.strictEqual(wxToken.access_token, "act456")
  })
})

describe("WeiyunDriver", () => {
  it("normalizes additions with valid defaults", () => {
    const addition = normalizeWeiyunAddition({})
    assert.strictEqual(addition.root_folder_id, "")
    assert.strictEqual(addition.cookies, "")
    assert.strictEqual(addition.order_by, "name")
    assert.strictEqual(addition.order_direction, "asc")
    assert.strictEqual(addition.upload_thread, "4")
  })

  it("throws error on copy operation (as in Go driver)", async () => {
    const driver = new WeiyunDriver({
      cookies: "uin=123",
    })
    await assert.rejects(async () => {
      await driver.copy(
        "/src",
        "/dst",
        ["file.txt"],
        "/src/file.txt",
        "/dst/file.txt",
      )
    }, /不支持复制操作/)
  })
})

/**
 * F-165：uploadPart 必须按服务层真实分片大小计算 offset（默认 10MB），
 * 不能再用会话 token 里的 1MB 常量。
 */
describe("Weiyun chunked upload offsets (F-165)", () => {
  const MB = 1024 * 1024

  function makeDriver() {
    const driver = new WeiyunDriver({ cookies: "uin=123" })
    const pieces: any[] = []
    const client = (driver as any).client
    client.preUpload = async () => ({
      upload_key: "uk",
      ex: "ex",
      channel_list: [
        { id: 0, offset: 0, len: 0 },
        { id: 1, offset: 0, len: 0 },
        { id: 2, offset: 0, len: 0 },
        { id: 3, offset: 0, len: 0 },
      ],
    })
    client.uploadPiece = async (channel: any) => {
      pieces.push({ ...channel })
      return { upload_state: 1 }
    }
    return { driver, pieces }
  }

  it("places the 2nd 10MB part at 10MB (not 1MB)", async () => {
    const { driver, pieces } = makeDriver()
    const size = 30 * MB
    const session = await driver.createUploadSession("", "/", "big.bin", size)
    await driver.uploadPart(session.session, 1, Buffer.alloc(10 * MB))
    await driver.uploadPart(session.session, 2, Buffer.alloc(10 * MB))
    await driver.uploadPart(session.session, 3, Buffer.alloc(10 * MB))

    assert.deepStrictEqual(
      pieces.map((p) => ({ id: p.id, offset: p.offset, len: p.len })),
      [
        { id: 0, offset: 0, len: 10 * MB },
        { id: 1, offset: 10 * MB, len: 10 * MB },
        { id: 2, offset: 20 * MB, len: 10 * MB },
      ],
    )
  })

  it("handles a short final part with the correct tail offset", async () => {
    const { driver, pieces } = makeDriver()
    const size = 25 * MB
    const session = await driver.createUploadSession("", "/", "tail.bin", size)
    await driver.uploadPart(session.session, 1, Buffer.alloc(10 * MB))
    await driver.uploadPart(session.session, 2, Buffer.alloc(10 * MB))
    await driver.uploadPart(session.session, 3, Buffer.alloc(5 * MB))

    assert.deepStrictEqual(
      pieces.map((p) => ({ offset: p.offset, len: p.len })),
      [
        { offset: 0, len: 10 * MB },
        { offset: 10 * MB, len: 10 * MB },
        { offset: 20 * MB, len: 5 * MB },
      ],
    )
  })

  it("rejects parts larger than the file", async () => {
    const { driver } = makeDriver()
    const session = await driver.createUploadSession("", "/", "x.bin", 2 * MB)
    await assert.rejects(
      () => driver.uploadPart(session.session, 1, Buffer.alloc(3 * MB)),
      /超过文件大小/,
    )
  })

  it("accepts the empty upload for a zero-byte file", async () => {
    const { driver, pieces } = makeDriver()
    const session = await driver.createUploadSession("", "/", "empty.bin", 0)
    await driver.uploadPart(session.session, 1, Buffer.alloc(0))
    assert.deepStrictEqual(pieces, [{ id: 0, offset: 0, len: 0 }])
  })
})

/**
 * F-166：会话路径不得用空内容伪造真实 file_size 的块哈希。
 */
describe("Weiyun session preUpload (F-166)", () => {
  it("requests a hash-less session for non-empty files", async () => {
    const driver = new WeiyunDriver({ cookies: "uin=123" })
    const client = (driver as any).client
    let reqData: any = null
    client.addUploadChannel = async () => ({})
    client.request = async (
      _svc: string,
      _cmd: string,
      _code: number,
      data: any,
    ) => {
      reqData = data
      return {
        upload_key: "uk",
        ex: "ex",
        channel_list: [{ id: 0, offset: 0, len: 0 }],
      }
    }

    const size = 1048676
    const session = await driver.createUploadSession("", "/", "a.bin", size)
    assert.strictEqual(session.reuse, false)
    assert.ok(reqData)
    assert.strictEqual(reqData.common_upload_req.file_size, size)
    assert.deepStrictEqual(reqData.block_info_list, [])
    assert.strictEqual(reqData.check_sha, "")
    assert.strictEqual(reqData.check_data, "")
  })

  it("never reports reuse when the hash-less probe says file exists", async () => {
    const driver = new WeiyunDriver({ cookies: "uin=123" })
    const client = (driver as any).client
    client.request = async () => ({
      file_exist: true,
      upload_key: "uk",
      ex: "ex",
      channel_list: [],
    })
    const session = await driver.createUploadSession(
      "",
      "/",
      "b.bin",
      5 * 1024 * 1024,
    )
    assert.strictEqual(session.reuse, false)
    assert.ok(session.session.length > 0)
  })
})
