// rclone crypt v1 兼容的内容加密实现。
//
// 格式与 rclone backend/crypt（OpenList Go 版 crypt 驱动的底层）完全一致：
//   [magic "RCLONE\x00\x00" : 8B][file nonce : 24B][数据块...]
// 每个数据块（明文最多 64KiB）为 NaCl secretbox（XSalsa20-Poly1305）：
//   [MAC : 16B][密文 : 1..65536B]
// 块 nonce = 文件 nonce 按小端整 192 位加 1 递增（第 0 块用文件 nonce 本身）。
// EncryptedSize / DecryptedSize 与 rclone 的 EncryptedSize/DecryptedSize 同式。
//
// 密钥派生（与 rclone Cipher.Key 一致）：
//   scrypt(password, salt || rclone 内置 defaultSalt, N=16384, r=8, p=1, dkLen=80)
//   dataKey = dk[0:32]（内容加密）；nameKey = dk[32:64]、nameTweak = dk[64:80]
//   仅用于文件名加密，本驱动当前只支持 filename_encryption=off。
//
// 注意：这是对旧的私有格式 [nonce:16][reserved:16][AES-256-CTR] 的替换，
// 旧格式数据无法再用本驱动读取（旧格式从未与任何外部实现兼容）。
import { scrypt } from "hash-wasm"
import { secretboxOpen, secretboxSeal, SECRETBOX_OVERHEAD } from "./secretbox"

/** rclone 文件头 magic */
export const FILE_MAGIC = new Uint8Array([
  0x52, 0x43, 0x4c, 0x4f, 0x4e, 0x45, 0x00, 0x00, // "RCLONE\0\0"
])
export const FILE_MAGIC_SIZE = FILE_MAGIC.length
export const FILE_NONCE_SIZE = 24
export const FILE_HEADER_SIZE = FILE_MAGIC_SIZE + FILE_NONCE_SIZE
export const BLOCK_DATA_SIZE = 64 * 1024
export const BLOCK_HEADER_SIZE = SECRETBOX_OVERHEAD
export const BLOCK_SIZE = BLOCK_HEADER_SIZE + BLOCK_DATA_SIZE
/** dataKey(32) + nameKey(32) + nameTweak(16) */
export const KEY_SIZE = 80

/** rclone 在 salt 为空时使用的内置 16 字节 salt */
export const DEFAULT_SALT = new Uint8Array([
  0xa8, 0x0d, 0xf4, 0x3a, 0x8f, 0xbd, 0x03, 0x08, 0xa7, 0xca, 0xb8, 0x3e, 0x58,
  0x1f, 0x86, 0xb1,
])

/** 小端整数加 1（rclone nonce.increment 的语义：从第 0 字节开始进位） */
export function incrementNonce(nonce: Uint8Array): void {
  for (let i = 0; i < nonce.length; i++) {
    nonce[i] = (nonce[i] + 1) & 0xff
    if (nonce[i] !== 0) break
  }
}

export class CryptCipher {
  private dataKey: Uint8Array

  private constructor(dataKey: Uint8Array) {
    this.dataKey = dataKey
  }

  /** scrypt 派生 80 字节主密钥并取出 dataKey（与 rclone 一致） */
  static async create(password: string, salt: string): Promise<CryptCipher> {
    if (!password) {
      throw new Error("[Crypt] password 不能为空")
    }
    const saltBytes = salt
      ? new TextEncoder().encode(salt)
      : DEFAULT_SALT.slice()
    const dk = (await scrypt({
      password: new TextEncoder().encode(password),
      salt: saltBytes,
      costFactor: 16384, // N = 2^14
      blockSize: 8, // r
      parallelism: 1, // p
      hashLength: KEY_SIZE, // 80 = 32 + 32 + 16
      outputType: "binary",
    })) as Uint8Array
    return new CryptCipher(dk.slice(0, 32))
  }

  /**
   * 仅供互操作测试：用给定 32 字节 dataKey 直接构造（不做 scrypt 派生）。
   * 用于复现 rclone 官方已知答案向量（空 password 对应全零密钥）。
   */
  static fromDataKey(dataKey: Uint8Array): CryptCipher {
    if (dataKey.length !== 32) throw new Error("[Crypt] dataKey 必须是 32 字节")
    return new CryptCipher(dataKey.slice())
  }

  /** 明文字节数 → 密文字节数（rclone EncryptedSize） */
  encryptedSize(plainSize: number): number {
    const blocks = Math.floor(plainSize / BLOCK_DATA_SIZE)
    const residue = plainSize % BLOCK_DATA_SIZE
    let encrypted = FILE_HEADER_SIZE + blocks * BLOCK_SIZE
    if (residue !== 0) encrypted += BLOCK_HEADER_SIZE + residue
    return encrypted
  }

  /** 密文字节数 → 明文字节数（rclone DecryptedSize；畸形长度返回 0） */
  decryptedSize(encryptedSize: number): number {
    let size = encryptedSize - FILE_HEADER_SIZE
    if (size < 0) return 0
    const blocks = Math.floor(size / BLOCK_SIZE)
    let residue = size % BLOCK_SIZE
    let decrypted = blocks * BLOCK_DATA_SIZE
    if (residue !== 0) {
      residue -= BLOCK_HEADER_SIZE
      if (residue <= 0) return 0
      decrypted += residue
    }
    return decrypted
  }

  /** 加密明文，返回 magic + nonce + 分块密文。nonce 仅供测试注入。 */
  async encrypt(plain: Uint8Array, fileNonce?: Uint8Array): Promise<Uint8Array> {
    const nonce = fileNonce
      ? fileNonce.slice(0, FILE_NONCE_SIZE)
      : crypto.getRandomValues(new Uint8Array(FILE_NONCE_SIZE))
    if (nonce.length !== FILE_NONCE_SIZE) {
      throw new Error("[Crypt] file nonce 必须是 24 字节")
    }
    const out = new Uint8Array(this.encryptedSize(plain.length))
    out.set(FILE_MAGIC, 0)
    out.set(nonce, FILE_MAGIC_SIZE)
    const blockNonce = nonce.slice()
    let inPos = 0
    let outPos = FILE_HEADER_SIZE
    while (inPos < plain.length) {
      const chunk = plain.subarray(inPos, inPos + BLOCK_DATA_SIZE)
      const box = secretboxSeal(chunk, blockNonce, this.dataKey)
      out.set(box, outPos)
      outPos += box.length
      inPos += chunk.length
      incrementNonce(blockNonce)
    }
    return out
  }

  /** 解密单个 secretbox 分块（供按 range 分块读取使用，F-466） */
  decryptBlock(box: Uint8Array, blockNonce: Uint8Array): Uint8Array {
    return secretboxOpen(box, blockNonce, this.dataKey)
  }

  /** 解密（data 必须含 rclone 文件头）；magic/MAC 不符即抛错，不再静默返回乱码 */
  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (data.length < FILE_HEADER_SIZE) {
      throw new Error("[Crypt] 加密文件过短（缺少 rclone 文件头）")
    }
    for (let i = 0; i < FILE_MAGIC_SIZE; i++) {
      if (data[i] !== FILE_MAGIC[i]) {
        throw new Error(
          "[Crypt] 不是 rclone crypt v1 文件（magic 不匹配）",
        )
      }
    }
    const nonce = data.slice(FILE_MAGIC_SIZE, FILE_HEADER_SIZE)
    const plainSize = this.decryptedSize(data.length)
    const out = new Uint8Array(plainSize)
    const blockNonce = nonce.slice()
    let inPos = FILE_HEADER_SIZE
    let outPos = 0
    while (inPos < data.length) {
      const n = Math.min(data.length - inPos, BLOCK_SIZE)
      if (n <= BLOCK_HEADER_SIZE) {
        throw new Error("[Crypt] 加密块长度非法")
      }
      const plain = secretboxOpen(
        data.subarray(inPos, inPos + n),
        blockNonce,
        this.dataKey,
      )
      out.set(plain, outPos)
      outPos += plain.length
      inPos += n
      incrementNonce(blockNonce)
    }
    return out
  }
}
