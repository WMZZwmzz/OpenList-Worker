import CryptoJS from "crypto-js"
import { randomInt } from "../rand"
import { DefaultClientSecret, ChannelAPIUser } from "./consts"

const DEFAULT_IV = "wNSOYIB1k1DjY5lA"

export interface HeaderResult {
  key: string
  resTime: number
  reqSeq: number
  channel: string
  sign: string
  version: string
}

export class WoPanCrypto {
  private key: string = DefaultClientSecret
  private iv: string = DEFAULT_IV
  private accessKey: string = ""

  constructor(accessToken?: string) {
    if (accessToken) {
      this.setAccessToken(accessToken)
    }
  }

  setAccessToken(token: string): void {
    // F-216：AES 密钥必须为 16 字节。短于 16 字符的 token 会被 CryptoJS
    // 接受但产出服务器无法解密的密文，因此这里直接拒绝（置空），
    // 由 initData 走 refresh_token 刷新。
    if (token && token.length >= 16) {
      this.accessKey = token.slice(0, 16)
    } else {
      this.accessKey = ""
    }
  }

  encrypt(content: string, channel: string): string {
    const keyStr =
      channel === ChannelAPIUser ? this.key : this.accessKey || this.key
    const key = CryptoJS.enc.Utf8.parse(keyStr)
    const iv = CryptoJS.enc.Utf8.parse(this.iv)
    const encrypted = CryptoJS.AES.encrypt(
      CryptoJS.enc.Utf8.parse(content),
      key,
      {
        iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      },
    )
    return encrypted.toString()
  }

  decrypt(cipherBase64: string, channel: string): string {
    const keyStr =
      channel === ChannelAPIUser ? this.key : this.accessKey || this.key
    const key = CryptoJS.enc.Utf8.parse(keyStr)
    const iv = CryptoJS.enc.Utf8.parse(this.iv)
    const decrypted = CryptoJS.AES.decrypt(cipherBase64, key, {
      iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    })
    return decrypted.toString(CryptoJS.enc.Utf8)
  }

  userEncrypt(content: string): string {
    return this.encrypt(content, ChannelAPIUser)
  }

  userDecrypt(content: string): string {
    return this.decrypt(content, ChannelAPIUser)
  }

  woHomeEncrypt(content: string): string {
    return this.encrypt(content, "wohome")
  }

  woHomeDecrypt(content: string): string {
    return this.decrypt(content, "wohome")
  }

  calHeader(channel: string, key: string): HeaderResult {
    const resTime = Date.now()
    // S-04 同类清单：签名序列号改用 CSPRNG（原 Math.random）。
    const reqSeq = 100000 + randomInt(8999)
    const version = ""
    const sign = CryptoJS.MD5(
      `${key}${resTime}${reqSeq}${channel}${version}`,
    ).toString()
    return {
      key,
      resTime,
      reqSeq,
      channel,
      sign,
      version,
    }
  }
}
