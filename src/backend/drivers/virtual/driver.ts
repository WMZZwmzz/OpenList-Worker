// Virtual driver — 虚拟目录驱动（压测 / 占位）
// 移植自 OpenList Go 版 drivers/virtual。
// 生成指定数量的随机占位文件与目录，下载时返回随机数据流（DummyMFile）。
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"

export interface VirtualAddition {
  root_folder_path?: string
  num_file: number
  num_folder: number
  max_file_size: number
  min_file_size: number
}

export class VirtualDriver implements StorageDriver {
  private addition: VirtualAddition

  constructor(addition: VirtualAddition) {
    this.addition = addition || {}
  }

  /**
   * F-485：同一路径的 size 必须可重复派生（get() 与 createReadStream() 共用），
   * 之前两处各自调用一次 Math.random() 抽样，导致 raw.ts 按 get().size 写死的
   * Content-Length 与实际流长度必然不一致。
   */
  private sizeForPath(physicalPath: string): number {
    const min = this.addition.min_file_size || 0
    const max = this.addition.max_file_size || 0
    if (max <= min) return min
    // FNV-1a 32-bit：确定性、无依赖，同一路径恒定。
    let h = 0x811c9dc5
    for (let i = 0; i < physicalPath.length; i++) {
      h ^= physicalPath.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return min + (h % (max - min))
  }

  /** F-486：list() 生成的目录名，get() 必须识别为目录 */
  private isVirtualFolder(name: string): boolean {
    const m = /^folder_(\d+)$/.exec(name)
    if (!m) return false
    return Number(m[1]) < (this.addition.num_folder || 0)
  }

  private now(): string {
    return new Date().toISOString()
  }

  async list(): Promise<FileItem[]> {
    const items: FileItem[] = []
    for (let i = 0; i < (this.addition.num_file || 0); i++) {
      const name = `file_${i}.bin`
      items.push({
        name,
        size: this.sizeForPath("/" + name),
        is_dir: false,
        modified: this.now(),
        sign: "",
        type: calcFileType(name, false),
      })
    }
    for (let i = 0; i < (this.addition.num_folder || 0); i++) {
      const name = `folder_${i}`
      items.push({
        name,
        size: 0,
        is_dir: true,
        modified: this.now(),
        sign: "",
        type: 1,
      })
    }
    return items
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    // F-486：存储根与 folder_N 都是目录，不能报成随机大小的文件。
    const isDir = segs.length === 0 || this.isVirtualFolder(segs[segs.length - 1])
    const name = segs[segs.length - 1] || "root"
    if (isDir) {
      return {
        name,
        size: 0,
        is_dir: true,
        modified: this.now(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    }
    return {
      name,
      size: this.sizeForPath("/" + segs.join("/")),
      is_dir: false,
      modified: this.now(),
      sign: "",
      type: calcFileType(name, false),
      raw_url: "",
    }
  }

  async mkdir(): Promise<void> {}
  async rename(): Promise<void> {}
  async remove(): Promise<void> {}
  async move(): Promise<void> {}
  async copy(): Promise<void> {}
  async put(): Promise<void> {}

  /**
   * 随机数据流，支持 Range。raw.ts 检测到 createReadStream 时走流式下载
   * （虚拟文件无真实 raw_url，因此依赖此方法返回内容）。
   */
  async createReadStream(
    physicalPath: string,
    range?: { start: number; end: number },
  ): Promise<ReadableStream> {
    const segs = String(physicalPath || "")
      .split("/")
      .filter(Boolean)
    // F-485：无 Range 时用与 get() 同源的长度，保证与声明的 Content-Length 一致。
    const size = this.sizeForPath("/" + segs.join("/"))
    const start = range?.start ?? 0
    const end = range?.end ?? (size > 0 ? size - 1 : -1)
    const length = Math.max(0, end - start + 1)
    const chunkSize = 64 * 1024
    let remaining = length
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close()
          return
        }
        const n = Math.min(chunkSize, remaining)
        const buf = new Uint8Array(n)
        crypto.getRandomValues(buf)
        controller.enqueue(buf)
        remaining -= n
      },
    })
  }
}
