import { describe, it } from "node:test"
import assert from "node:assert"
import { parseAddress, isNoSuchFileError, SFTPClientWrapper } from "./util"
import { SFTPDriver, normalizeSFTPAddition } from "./driver"

describe("SFTP Address & Config", () => {
  it("parses address host and port correctly", () => {
    assert.deepStrictEqual(parseAddress("192.168.1.100:2222"), {
      host: "192.168.1.100",
      port: 2222,
    })
    assert.deepStrictEqual(parseAddress("example.com"), {
      host: "example.com",
      port: 22,
    })
    assert.deepStrictEqual(parseAddress("[2001:db8::1]:2222"), {
      host: "2001:db8::1",
      port: 2222,
    })
    assert.deepStrictEqual(parseAddress(""), {
      host: "127.0.0.1",
      port: 22,
    })
  })

  it("F-326：bare IPv6 is treated as host, not host+port", () => {
    assert.deepStrictEqual(parseAddress("2001:db8::1"), {
      host: "2001:db8::1",
      port: 22,
    })
    assert.deepStrictEqual(parseAddress("::1"), { host: "::1", port: 22 })
    assert.deepStrictEqual(parseAddress("fe80::1"), {
      host: "fe80::1",
      port: 22,
    })
  })

  it("normalizes additions with valid defaults", () => {
    const addition = normalizeSFTPAddition({
      address: " 1.2.3.4:22 ",
      username: " root ",
      root_folder_path: "data/storage",
      ignore_symlink_error: "true",
    })
    assert.strictEqual(addition.address, "1.2.3.4:22")
    assert.strictEqual(addition.username, "root")
    assert.strictEqual(addition.root_folder_path, "/data/storage")
    assert.strictEqual(addition.ignore_symlink_error, true)
  })

  it("validates missing address or username on init", async () => {
    const driver = new SFTPDriver({
      address: "",
      username: "",
    })
    await assert.rejects(async () => {
      await driver.init()
    }, /address and username are required/)
  })

  it("throws error on copy operation (as in Go driver)", async () => {
    const driver = new SFTPDriver({
      address: "127.0.0.1:22",
      username: "root",
    })
    await assert.rejects(async () => {
      await driver.copy(
        "/src",
        "/dst",
        ["file.txt"],
        "/src/file.txt",
        "/dst/file.txt",
      )
    }, /Copy not supported/)
  })
})

describe("F-325: removeRecursive only swallows 'no such file'", () => {
  it("classifies ssh2 errors", () => {
    assert.equal(isNoSuchFileError({ code: "NO_SUCH_FILE" }), true)
    assert.equal(isNoSuchFileError({ status: 2 }), true)
    assert.equal(
      isNoSuchFileError({ code: "SSH_FX_PERMISSION_DENIED", status: 3 }),
      false,
    )
    assert.equal(isNoSuchFileError(new Error("Connection lost")), false)
  })

  it("rethrows lstat errors other than not-found, no-ops on not-found", async () => {
    const makeWrapper = (err: any) => {
      const wrapper = new SFTPClientWrapper({
        address: "127.0.0.1:22",
        username: "root",
      })
      ;(wrapper as any).sftpClient = {
        lstat: (_path: string, cb: any) => cb(err),
      }
      return wrapper
    }

    await assert.rejects(
      () =>
        makeWrapper(
          Object.assign(new Error("permission denied"), {
            code: "SSH_FX_PERMISSION_DENIED",
            status: 3,
          }),
        )
        .removeRecursive("/secret"),
      /permission denied/,
      "权限错误不得被当成「不存在」静默成功",
    )

    // 不存在 → 正常的 no-op
    await makeWrapper({ code: "NO_SUCH_FILE", status: 2 }).removeRecursive(
      "/missing",
    )
  })
})
