// Crypt driver — 加密目录驱动
// 移植自 OpenList Go 版 drivers/crypt，内容加密格式与 rclone crypt v1 一致
// （magic "RCLONE\0\0" + 24 字节 nonce + 64KiB secretbox 分块，见 cipher.ts）。
// 当前支持 filename_encryption=off（默认）：文件名不加密、仅加 encrypted_suffix 后缀。
// standard / obfuscate 文件名加密为后续增强。
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import {
  CryptCipher,
  BLOCK_DATA_SIZE,
  BLOCK_SIZE,
  FILE_HEADER_SIZE,
  FILE_MAGIC,
  FILE_MAGIC_SIZE,
  incrementNonce,
} from "./cipher"

export interface CryptAddition {
  remote_path: string
  password: string
  salt?: string
  filename_encryption?: "off" | "standard" | "obfuscate"
  directory_name_encryption?: string
  encrypted_suffix?: string
  filename_encoding?: string
  thumbnail?: boolean
  show_hidden?: boolean
  root_folder_path?: string
}

export class CryptDriver implements StorageDriver {
  private addition: CryptAddition
  private cipher: CryptCipher | null = null
  private remoteDriver: StorageDriver | null = null
  private remoteRoot = "/"
  private suffix: string

  constructor(addition: CryptAddition) {
    this.addition = addition || {}
    this.suffix = this.addition.encrypted_suffix ?? ".bin"
  }

  async init(): Promise<void> {
    const mode = this.addition.filename_encryption || "off"
    if (mode !== "off") {
      throw new Error(
        `[Crypt] filename_encryption='${mode}' 尚未实现，当前仅支持 off 模式（内容加密、文件名仅加后缀）`,
      )
    }
    // 动态 import，避免与 internal/op/storage.ts 的循环依赖
    const { resolvePath } = await import("../../internal/model/db")
    const { getDriver } = await import("../../internal/op/storage")
    const resolved = await resolvePath(this.addition.remote_path || "/")
    if (resolved.isVirtual || !resolved.storage) {
      throw new Error(
        `[Crypt] remote_path 未匹配到有效存储: ${this.addition.remote_path}`,
      )
    }
    this.remoteRoot = resolved.physical || "/"
    this.remoteDriver = await getDriver(
      resolved.storage.driver,
      resolved.storage,
    )
    this.cipher = await CryptCipher.create(
      this.addition.password,
      this.addition.salt || "",
    )
  }

  private ensureReady(): void {
    if (!this.cipher || !this.remoteDriver) {
      throw new Error("[Crypt] driver not initialized")
    }
  }

  /** crypt 物理路径 → 底层物理路径 */
  private joinRemote(physicalPath: string): string {
    const p = String(physicalPath || "/")
    const base = this.remoteRoot === "/" ? "" : this.remoteRoot
    return (base + p).replace(/\/{2,}/g, "/") || "/"
  }

  private decryptName(name: string): string {
    if (!this.suffix) return name
    return name.endsWith(this.suffix)
      ? name.slice(0, -this.suffix.length)
      : name
  }

  /** 远端名是否带 encrypted_suffix（只有这类文件才是本驱动加密的） */
  private isEncryptedName(name: string): boolean {
    return !!this.suffix && name.endsWith(this.suffix)
  }

  /** 底层密文条目 → 解密后的文件条目（名字剥后缀、尺寸按分块开销折算） */
  private toFileItem(item: FileItem): FileItem {
    const name = this.decryptName(item.name)
    return {
      ...item,
      name,
      size: this.cipher!.decryptedSize(item.size),
      type: calcFileType(name, false),
      // 直链指向密文，必须清空以强制 raw.ts 走 createReadStream 解密下载
      raw_url: "",
    }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    this.ensureReady()
    const remotePhysical = this.joinRemote(physicalPath)
    const items = await this.remoteDriver!.list("", remotePhysical)
    return items.map((item) => {
      if (item.is_dir) return item
      // 不带后缀的同名文件不是本驱动写入的，原样展示（否则尺寸会被算坏）
      if (!this.isEncryptedName(item.name)) return { ...item, raw_url: "" }
      return this.toFileItem(item)
    })
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    this.ensureReady()
    const remotePhysical = this.joinRemote(physicalPath)
    const name = remotePhysical.split("/").filter(Boolean).pop() || "root"
    // F-457：远端目录名不带 encrypted_suffix，文件才带。与 OpenList Go 版
    // 的 guessPath 一致：末段像文件（含点）就先按 <path><suffix> 查文件，
    // 否则先按裸路径查目录；没命中再试另一种。
    const fileFirst = name.includes(".")
    // 用对象持有候选，避免闭包赋值被 TS 的控制流分析窄化成 null
    const state: { plainFile: FileItem | null; lastError: unknown } = {
      plainFile: null,
      lastError: null,
    }

    const tryDir = async (): Promise<FileItem | null> => {
      try {
        const item = await this.remoteDriver!.get("", remotePhysical)
        if (item.is_dir) return item
        // 裸路径上是普通文件（非本驱动写入），作为兜底候选
        if (!state.plainFile) state.plainFile = item
      } catch (e) {
        if (!state.lastError) state.lastError = e
      }
      return null
    }
    const tryFile = async (): Promise<FileItem | null> => {
      if (!this.suffix) return null
      try {
        const item = await this.remoteDriver!.get(
          "",
          remotePhysical + this.suffix,
        )
        if (!item.is_dir) return this.toFileItem(item)
      } catch (e) {
        if (!state.lastError) state.lastError = e
      }
      return null
    }

    for (const attempt of fileFirst ? [tryFile, tryDir] : [tryDir, tryFile]) {
      const hit = await attempt()
      if (hit) return hit
    }
    if (state.plainFile) return { ...state.plainFile, raw_url: "" }
    throw state.lastError instanceof Error
      ? state.lastError
      : new Error(`[Crypt] '${physicalPath}' not found`)
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    this.ensureReady()
    await this.remoteDriver!.mkdir("", this.joinRemote(physicalPath))
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    this.ensureReady()
    const remotePhysical = this.joinRemote(physicalPath)
    const kind = await this.classifyEntry(remotePhysical)
    if (kind === "encrypted") {
      await this.remoteDriver!.rename(
        "",
        remotePhysical + this.suffix,
        newName + this.suffix,
      )
    } else {
      await this.remoteDriver!.rename("", remotePhysical, newName)
    }
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    this.ensureReady()
    const remotePhysical = this.joinRemote(physicalPath)
    const kind = await this.classifyEntry(remotePhysical)
    if (kind === "encrypted") {
      await this.remoteDriver!.remove("", remotePhysical + this.suffix, _names)
    } else {
      await this.remoteDriver!.remove("", remotePhysical, _names)
    }
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    this.ensureReady()
    const srcRemote = this.joinRemote(srcPhysical)
    const dstRemote = this.joinRemote(dstPhysical)
    if ((await this.classifyEntry(srcRemote)) === "encrypted") {
      await this.remoteDriver!.move(
        srcDir,
        dstDir,
        names,
        srcRemote + this.suffix,
        dstRemote + this.suffix,
      )
    } else {
      await this.remoteDriver!.move(srcDir, dstDir, names, srcRemote, dstRemote)
    }
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    this.ensureReady()
    const srcRemote = this.joinRemote(srcPhysical)
    const dstRemote = this.joinRemote(dstPhysical)
    if ((await this.classifyEntry(srcRemote)) === "encrypted") {
      await this.remoteDriver!.copy(
        srcDir,
        dstDir,
        names,
        srcRemote + this.suffix,
        dstRemote + this.suffix,
      )
    } else {
      await this.remoteDriver!.copy(srcDir, dstDir, names, srcRemote, dstRemote)
    }
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Uint8Array,
  ): Promise<void> {
    this.ensureReady()
    const remotePhysical = this.joinRemote(physicalPath) + this.suffix
    const encrypted = await this.cipher!.encrypt(new Uint8Array(content))
    await this.remoteDriver!.put("", remotePhysical, Buffer.from(encrypted))
  }

  /**
   * 解密下载（F-466）。
   *
   * 密文是「32 字节文件头 + 64KiB 定长 secretbox 块（最后一块可短）」，因此
   * range 请求可以精确映射到密文区间：先按 Range 只取覆盖 [start,end] 的块，
   * 再逐块解密后按需切边，内存占用恒定在 1~2 个块，不再整文件入内存。
   *
   * 无法得知密文大小（底层驱动 size 缺失）时退回整份解密，保证行为不变。
   */
  async createReadStream(
    physicalPath: string,
    range?: { start: number; end: number },
  ): Promise<ReadableStream<Uint8Array>> {
    this.ensureReady()
    const remotePhysical = this.joinRemote(physicalPath) + this.suffix
    const item = await this.remoteDriver!.get("", remotePhysical)
    if (!item.raw_url) {
      throw new Error("[Crypt] 底层驱动未返回下载链接，无法解密下载")
    }
    const encryptedSize = Number(item.size) || 0
    const plainSize =
      encryptedSize > FILE_HEADER_SIZE
        ? this.cipher!.decryptedSize(encryptedSize)
        : 0
    if (plainSize <= 0) {
      return this.createBufferedReadStream(item.raw_url, range)
    }

    const start = Math.max(0, Math.min(range?.start ?? 0, plainSize - 1))
    const end = Math.max(
      start,
      Math.min(range?.end ?? plainSize - 1, plainSize - 1),
    )
    if ((range?.start ?? 0) > plainSize - 1) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
    }

    const firstBlock = Math.floor(start / BLOCK_DATA_SIZE)
    const lastBlock = Math.floor(end / BLOCK_DATA_SIZE)
    const blocksStart = FILE_HEADER_SIZE + firstBlock * BLOCK_SIZE
    const blocksEnd = Math.min(
      encryptedSize - 1,
      FILE_HEADER_SIZE + (lastBlock + 1) * BLOCK_SIZE - 1,
    )

    // 头部（magic + file nonce）在文件最前面：与块区间同一次请求能覆盖时
    // 一次取完，否则单独取 32 字节。
    let fileNonce: Uint8Array
    let initial: Uint8Array = new Uint8Array(0)
    let reader: ReadableStreamDefaultReader<Uint8Array>
    let skip = 0
    if (firstBlock === 0) {
      const opened = await this.openCipherStream(item.raw_url, 0, blocksEnd)
      reader = opened.reader
      skip = opened.skip
      const head = await this.readExact(reader, skip, FILE_HEADER_SIZE)
      fileNonce = this.parseHeader(head.bytes)
      initial = head.rest
      skip = 0
    } else {
      fileNonce = await this.fetchHeader(item.raw_url)
      const opened = await this.openCipherStream(
        item.raw_url,
        blocksStart,
        blocksEnd,
      )
      reader = opened.reader
      skip = opened.skip
    }

    const generator = this.decryptBlocks(
      reader,
      initial,
      skip,
      fileNonce,
      firstBlock,
      lastBlock,
      start,
      end,
    )
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await generator.next()
        if (done) {
          controller.close()
          return
        }
        if (value && value.length) controller.enqueue(value)
      },
      async cancel() {
        try {
          await reader.cancel()
        } catch {}
      },
    })
  }

  /** 旧路径：整份拉取后一次性解密（仅在密文大小未知时使用） */
  private async createBufferedReadStream(
    rawUrl: string,
    range?: { start: number; end: number },
  ): Promise<ReadableStream<Uint8Array>> {
    const resp = await fetch(rawUrl)
    if (!resp.ok) {
      throw new Error(`[Crypt] 底层下载失败: HTTP ${resp.status}`)
    }
    const buf = new Uint8Array(await resp.arrayBuffer())
    const plain = await this.cipher!.decrypt(buf)
    const start = range?.start ?? 0
    const end = range?.end ?? plain.length - 1
    const sliced = plain.slice(start, end + 1)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sliced)
        controller.close()
      },
    })
  }

  /** 读取 file magic + 24 字节 nonce 并校验 magic */
  private parseHeader(header: Uint8Array): Uint8Array {
    if (header.length < FILE_HEADER_SIZE) {
      throw new Error("[Crypt] 加密文件过短（缺少 rclone 文件头）")
    }
    for (let i = 0; i < FILE_MAGIC_SIZE; i++) {
      if (header[i] !== FILE_MAGIC[i]) {
        throw new Error("[Crypt] 不是 rclone crypt v1 文件（magic 不匹配）")
      }
    }
    return header.slice(FILE_MAGIC_SIZE, FILE_HEADER_SIZE)
  }

  private async fetchHeader(rawUrl: string): Promise<Uint8Array> {
    const opened = await this.openCipherStream(rawUrl, 0, FILE_HEADER_SIZE - 1)
    const head = await this.readExact(
      opened.reader,
      opened.skip,
      FILE_HEADER_SIZE,
    )
    try {
      await opened.reader.cancel()
    } catch {}
    return this.parseHeader(head.bytes)
  }

  /**
   * 打开密文的字节区间流。
   * 返回的 skip 表示「正文开头需要跳过的字节数」：服务端忽略 Range（200）时
   * 是整个 start，206 时按 Content-Range 校正。
   */
  private async openCipherStream(
    rawUrl: string,
    start: number,
    end: number,
  ): Promise<{
    reader: ReadableStreamDefaultReader<Uint8Array>
    skip: number
  }> {
    const res = await fetch(rawUrl, {
      headers: { Range: `bytes=${start}-${end}` },
    })
    if (!res.ok) {
      throw new Error(`[Crypt] 底层下载失败: HTTP ${res.status}`)
    }
    if (!res.body) throw new Error("[Crypt] 底层响应没有正文")
    let skip = start
    if (res.status === 206) {
      const m = (res.headers.get("content-range") || "").match(
        /^bytes\s+(\d+)-/,
      )
      const actualStart = m ? parseInt(m[1], 10) : start
      skip = actualStart <= start ? start - actualStart : 0
    }
    return { reader: res.body.getReader(), skip }
  }

  /** 从流里读取固定字节数，返回目标字节与被多读到的剩余部分 */
  private async readExact(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    skip: number,
    needed: number,
  ): Promise<{ bytes: Uint8Array; rest: Uint8Array }> {
    let acc = new Uint8Array(0)
    while (acc.length < needed) {
      const { value, done } = await reader.read()
      if (done) break
      let chunk = value
      if (!chunk || chunk.length === 0) continue
      if (skip > 0) {
        if (chunk.length <= skip) {
          skip -= chunk.length
          continue
        }
        chunk = chunk.subarray(skip)
        skip = 0
      }
      const merged = new Uint8Array(acc.length + chunk.length)
      merged.set(acc, 0)
      merged.set(chunk, acc.length)
      acc = merged
    }
    if (acc.length <= needed) return { bytes: acc, rest: new Uint8Array(0) }
    return {
      bytes: acc.subarray(0, needed),
      rest: acc.slice(needed),
    }
  }

  /** 按块解密并只产出落在 [plainStart, plainEnd] 内的明文字节 */
  private async *decryptBlocks(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    initial: Uint8Array,
    skip: number,
    fileNonce: Uint8Array,
    firstBlock: number,
    lastBlock: number,
    plainStart: number,
    plainEnd: number,
  ): AsyncGenerator<Uint8Array> {
    const nonce = fileNonce.slice()
    for (let i = 0; i < firstBlock; i++) incrementNonce(nonce)

    let buf = initial
    let blockIndex = firstBlock
    let eof = false

    const fill = async (): Promise<boolean> => {
      while (!eof && buf.length < BLOCK_SIZE) {
        const { value, done } = await reader.read()
        if (done) {
          eof = true
          break
        }
        let chunk = value
        if (!chunk || chunk.length === 0) continue
        if (skip > 0) {
          if (chunk.length <= skip) {
            skip -= chunk.length
            continue
          }
          chunk = chunk.subarray(skip)
          skip = 0
        }
        const merged = new Uint8Array(buf.length + chunk.length)
        merged.set(buf, 0)
        merged.set(chunk, buf.length)
        buf = merged
      }
      return buf.length > 0
    }

    while (blockIndex <= lastBlock && (await fill())) {
      const take = Math.min(buf.length, BLOCK_SIZE)
      const box = buf.subarray(0, take)
      const rest = buf.subarray(take)
      const plain = this.cipher!.decryptBlock(box, nonce)
      const blockStart = blockIndex * BLOCK_DATA_SIZE
      const localStart = Math.max(0, plainStart - blockStart)
      const localEnd = Math.min(plain.length - 1, plainEnd - blockStart)
      if (localEnd >= localStart) {
        yield plain.subarray(localStart, localEnd + 1)
      }
      buf = new Uint8Array(rest)
      incrementNonce(nonce)
      blockIndex++
    }
    try {
      await reader.cancel()
    } catch {}
  }

  /**
   * 判定底层路径的类型（F-465）。
   *
   * 命名空间允许「目录 X」与「加密文件 X」（远端 X<suffix>）共存，因此必须
   * **目录优先**：先按裸路径 get，命中目录即按目录处理；只有裸路径不是目录时
   * 才继续探测 <path><suffix>。此前的 isFile() 只探 suffix，同名共存时会把
   * 针对目录的改名/删除/移动/复制落到同名文件上。
   */
  private async classifyEntry(
    remotePhysical: string,
  ): Promise<"dir" | "plain" | "encrypted"> {
    try {
      const item = await this.remoteDriver!.get("", remotePhysical)
      if (item?.is_dir) return "dir"
      // 裸路径上是普通文件（非本驱动写入），按裸路径操作
      return "plain"
    } catch {
      // 裸路径不存在（或底层 get 不支持）→ 继续探测加密文件
    }
    if (this.suffix) {
      try {
        const item = await this.remoteDriver!.get(
          "",
          remotePhysical + this.suffix,
        )
        if (item && !item.is_dir) return "encrypted"
      } catch {
        // ignore
      }
    }
    // 两种都不存在：沿用原行为（按目录路径交给底层驱动报错）
    return "dir"
  }
}
