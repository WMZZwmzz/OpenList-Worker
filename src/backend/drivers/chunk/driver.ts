// Chunk driver — 分片打包存储
// 将大文件按 part_size 切成多个分片，存入底层存储的 `[chunk_prefix]name/` 目录；
// 读取时合并分片为一个虚拟文件。remote_path 指向另一个挂载的存储。
// 移植自 OpenList Go 版 drivers/chunk。
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { ChunkAddition, ChunkPart } from "./types"
import { escapeRegExp } from "../../pkg/path"

function joinPath(a: string, b: string): string {
  const left = String(a || "").replace(/\/+$/, "")
  const right = String(b || "").replace(/^\/+/, "")
  if (!left) return "/" + right
  if (!right) return left
  return left + "/" + right
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx > 0 ? p.slice(0, idx) : "/"
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() || ""
}

export class ChunkDriver implements StorageDriver {
  private addition: ChunkAddition
  private remoteDriver: StorageDriver | null = null
  private remoteRoot = "/"
  private chunkPrefix: string
  private customExt: string
  private partSize: number

  constructor(addition: ChunkAddition) {
    this.addition = addition || {}
    this.chunkPrefix = this.addition.chunk_prefix || "[openlist_chunk]"
    this.customExt = this.addition.custom_ext || ""
    this.partSize = Number(this.addition.part_size) || 0
  }

  async init(): Promise<void> {
    if (this.partSize <= 0) {
      throw new Error("[Chunk] part_size must be positive")
    }
    if (!this.chunkPrefix) {
      throw new Error("[Chunk] chunk_prefix must not be empty")
    }
    // 动态 import 避免循环依赖
    const { resolvePath } = await import("../../internal/model/db")
    const { getDriver } = await import("../../internal/op/storage")
    const resolved = await resolvePath(this.addition.remote_path || "/")
    if (resolved.isVirtual || !resolved.storage) {
      throw new Error(
        `[Chunk] remote_path 未匹配到有效存储: ${this.addition.remote_path}`,
      )
    }
    this.remoteRoot = resolved.physical || "/"
    this.remoteDriver = await getDriver(
      resolved.storage.driver,
      resolved.storage,
    )
  }

  private ensureReady(): void {
    if (!this.remoteDriver) {
      throw new Error("[Chunk] driver not initialized")
    }
  }

  /** chunk 物理路径 → 底层物理路径 */
  private joinRemote(physicalPath: string): string {
    const p = String(physicalPath || "/")
    const base = this.remoteRoot === "/" ? "" : this.remoteRoot
    return (base + p).replace(/\/{2,}/g, "/") || "/"
  }

  private getPartName(part: number): string {
    return `${part}${this.customExt}`
  }

  /** 分片目录底层路径（虚拟文件 → 分片目录） */
  private chunkDirRemote(physicalPath: string): string {
    const dir = dirname(this.joinRemote(physicalPath))
    const name = basename(physicalPath)
    return joinPath(dir, this.chunkPrefix + name)
  }

  /** 列出分片目录，返回有序分片列表（按分片序号） */
  private async listParts(physicalPath: string): Promise<ChunkPart[]> {
    this.ensureReady()
    const chunkDir = this.chunkDirRemote(physicalPath)
    const items = await this.remoteDriver!.list("", chunkDir)
    const parts: ChunkPart[] = []
    for (const item of items) {
      if (item.is_dir) continue
      const idx = parseInt(
        // custom_ext 来自存储配置，必须当字面量处理：直接拼进 RegExp 会让
        // `(a+)+` 这类配置变成 ReDoS，或让非法正则直接抛错打断整个列目录。
        item.name.replace(new RegExp(escapeRegExp(this.customExt) + "$"), ""),
        10,
      )
      if (Number.isNaN(idx)) continue
      if (parts[idx]) {
        throw new Error(
          `[Chunk] duplicate chunk part index ${idx}: '${parts[idx].name}' and '${item.name}'`,
        )
      }
      parts[idx] = {
        name: item.name,
        size: item.size,
        modified: item.modified,
        raw_url: item.raw_url || "",
        raw_url_headers: item.raw_url_headers,
      }
    }
    // 分片序号必须为 0..n-1 连续。稀疏数组直接 filter 会把空洞压实，
    // 让残缺的上传产物被当成完整文件按错误顺序拼接（静默数据损坏），
    // 因此缺失任一序号都必须报错（对齐 Go 版语义）。
    const indices = Object.keys(parts)
      .map(Number)
      .sort((a, b) => a - b)
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] !== i) {
        throw new Error(`[Chunk] chunk part ${i} is missing`)
      }
    }
    return indices.map((i) => parts[i])
  }

  /** 分片文件总大小（通过分片目录合并计算） */
  private async totalChunkSize(physicalPath: string): Promise<number> {
    const parts = await this.listParts(physicalPath)
    return parts.reduce((sum, p) => sum + p.size, 0)
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    this.ensureReady()
    const remoteDir = this.joinRemote(physicalPath)
    const items = await this.remoteDriver!.list("", remoteDir)

    const result: FileItem[] = []
    const chunkTasks: Promise<void>[] = []
    for (const item of items) {
      if (item.is_dir) {
        if (item.name.startsWith(this.chunkPrefix)) {
          const name = item.name.slice(this.chunkPrefix.length)
          const idx = result.length
          result.push(null as unknown as FileItem)
          chunkTasks.push(
            (async () => {
              // item.name 已含 chunkPrefix，而 chunkDirRemote() 会自行再拼一次前缀；
              // 必须传入去掉前缀的虚拟文件名，否则会指向双重前缀的不存在目录。
              const virtualPath2 = joinPath(physicalPath, name)
              const size = await this.totalChunkSize(virtualPath2)
              result[idx] = {
                name,
                size,
                is_dir: false,
                modified: item.modified,
                sign: this.chunkPrefix + name,
                type: calcFileType(name, false),
                raw_url: "", // 触发 createReadStream 合并分片
              }
            })(),
          )
          continue
        }
      }
      if (!this.addition.show_hidden && item.name.startsWith(".")) continue
      result.push(item)
    }
    await Promise.all(chunkTasks)
    return result.filter((i) => !!i)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    this.ensureReady()
    const remotePath = this.joinRemote(physicalPath)
    // 先尝试普通文件
    try {
      const item = await this.remoteDriver!.get("", remotePath)
      if (item && !item.is_dir) return item
      if (item) return item
    } catch {
      // 可能是分片文件
    }

    // 分片文件
    const name = basename(physicalPath)
    const size = await this.totalChunkSize(physicalPath)
    const parts = await this.listParts(physicalPath)
    return {
      name,
      size,
      is_dir: false,
      modified: parts[0]?.modified || new Date().toISOString(),
      sign: this.chunkPrefix + name,
      type: calcFileType(name, false),
      raw_url: "",
    }
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
    const remotePath = this.joinRemote(physicalPath)
    try {
      await this.remoteDriver!.get("", remotePath)
      await this.remoteDriver!.rename("", remotePath, newName)
    } catch {
      // 分片文件：rename 分片目录
      const dir = dirname(remotePath)
      const chunkDir = joinPath(dir, this.chunkPrefix + basename(physicalPath))
      await this.remoteDriver!.rename("", chunkDir, this.chunkPrefix + newName)
    }
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    this.ensureReady()
    const remotePath = this.joinRemote(physicalPath)
    // A-25：历史实现把「探测 + 删除」放在同一个 try 里，普通文件删除失败
    // （权限/网络）会落入 catch 去删不存在的分片目录，最终返回成功。
    let isRegularFile = false
    try {
      await this.remoteDriver!.get("", remotePath)
      isRegularFile = true
    } catch {
      isRegularFile = false
    }
    if (isRegularFile) {
      await this.remoteDriver!.remove("", remotePath, names)
      return
    }
    await this.remoteDriver!.remove(
      "",
      this.chunkDirRemote(physicalPath),
      names,
    )
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
    try {
      await this.remoteDriver!.get("", srcRemote)
      await this.remoteDriver!.move(srcDir, dstDir, names, srcRemote, dstRemote)
    } catch {
      // 分片文件：dst 端必须是目标项自己的分片目录（与虚拟文件同级），
      // 拼成 `<目标项>/<chunkPrefix><name>` 会指向不存在的路径。
      await this.remoteDriver!.move(
        srcDir,
        dstDir,
        names,
        this.chunkDirRemote(srcPhysical),
        this.chunkDirRemote(dstPhysical),
      )
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
    try {
      await this.remoteDriver!.get("", srcRemote)
      await this.remoteDriver!.copy(srcDir, dstDir, names, srcRemote, dstRemote)
    } catch {
      // 分片文件：同 move，dst 端用目标项自己的分片目录。
      await this.remoteDriver!.copy(
        srcDir,
        dstDir,
        names,
        this.chunkDirRemote(srcPhysical),
        this.chunkDirRemote(dstPhysical),
      )
    }
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    this.ensureReady()
    const size = content.length
    const remotePath = this.joinRemote(physicalPath)

    // 小文件直接透传（不分片）
    if (size <= this.partSize) {
      // A-26：同名文件此前以分片形式存在时，旧分片目录必须清理，否则列表
      // 会同时出现普通文件与分片文件（同名冲突）。
      await this.removeChunkDirQuiet(physicalPath)
      await this.remoteDriver!.put("", remotePath, content)
      return
    }

    // 分片存储
    const chunkDir = this.chunkDirRemote(physicalPath)
    // A-26：覆盖上传时先删除旧分片目录。历史实现只做 mkdir，旧文件分片数
    // 更多时会残留旧尾部，而 listParts 只校验 0..n-1 连续，结果被当成完整
    // 文件返回截断/损坏内容。
    await this.removeChunkDirQuiet(physicalPath)
    try {
      // 同名普通文件同样要清掉，避免 get 优先命中旧文件。
      await this.remoteDriver!.remove("", remotePath, [basename(physicalPath)])
    } catch {
      // 不存在属正常情况
    }
    try {
      await this.remoteDriver!.mkdir("", chunkDir)
    } catch {
      // 目录可能已存在
    }

    let offset = 0
    let partIndex = 0
    try {
      while (offset < size) {
        const end = Math.min(offset + this.partSize, size)
        const partContent = content.subarray(offset, end)
        const partPath = joinPath(chunkDir, this.getPartName(partIndex))
        await this.remoteDriver!.put("", partPath, Buffer.from(partContent))
        offset = end
        partIndex++
      }
    } catch (err) {
      // 上传中断时清理已写入的分片，避免残缺前缀被当作完整文件。
      for (let i = 0; i < partIndex; i++) {
        try {
          await this.remoteDriver!.remove(
            "",
            joinPath(chunkDir, this.getPartName(i)),
            [this.getPartName(i)],
          )
        } catch {}
      }
      throw err
    }
  }

  /** 静默删除分片目录（A-26：写入前清理旧分片）。 */
  private async removeChunkDirQuiet(physicalPath: string): Promise<void> {
    const chunkDir = this.chunkDirRemote(physicalPath)
    try {
      await this.remoteDriver!.remove("", chunkDir, [basename(chunkDir)])
    } catch {
      // 不存在属正常情况
    }
  }

  /** 合并分片下载，支持 Range */
  async createReadStream(
    physicalPath: string,
    range?: { start: number; end: number },
  ): Promise<ReadableStream<Uint8Array>> {
    this.ensureReady()
    const parts = await this.listParts(physicalPath)
    // 底层列表把大小报成 0（元数据缺失）时分片并非空片：
    // 继续按 size 跳过会输出空/错位流，必须显式拒绝服务。
    const unknownSize = parts.find((p) => p.size <= 0)
    if (unknownSize) {
      throw new Error(
        `[Chunk] chunk part '${unknownSize.name}' has unknown size (reported 0); refusing to merge`,
      )
    }
    const totalSize = parts.reduce((sum, p) => sum + p.size, 0)
    const remoteDriver = this.remoteDriver
    const chunkPrefix = this.chunkPrefix

    let skip = range?.start ?? 0
    let remaining = range ? range.end - range.start + 1 : totalSize

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        for (const part of parts) {
          const partSize = part.size
          if (skip >= partSize) {
            skip -= partSize
            continue
          }
          let url = part.raw_url
          if (!url) {
            // 尝试重新获取该分片的下载链接
            const dir = dirname(physicalPath)
            const partPath = joinPath(
              joinPath(dir, chunkPrefix + basename(physicalPath)),
              part.name,
            )
            try {
              const item = await remoteDriver!.get("", partPath)
              url = item.raw_url || ""
            } catch {
              url = ""
            }
          }
          if (!url) {
            controller.error(
              new Error(
                `[Chunk] failed to resolve download url for ${part.name}`,
              ),
            )
            return
          }
          const resp = await fetch(url, {
            headers: part.raw_url_headers || {},
          })
          if (!resp.ok) {
            controller.error(
              new Error(
                `[Chunk] download part ${part.name} failed: HTTP ${resp.status}`,
              ),
            )
            return
          }
          const buf = new Uint8Array(await resp.arrayBuffer())
          let slice = buf
          if (skip > 0) {
            slice = slice.subarray(skip)
            skip = 0
          }
          if (remaining >= 0 && slice.length > remaining) {
            slice = slice.subarray(0, remaining)
          }
          if (slice.length > 0) controller.enqueue(slice)
          if (remaining >= 0) {
            remaining -= slice.length
            if (remaining <= 0) break
          }
        }
        controller.close()
      },
    })
    return stream
  }
}
