import { StorageDriver, FileItem, calcFileType } from "../internal/driver/base"
import { assertLocalPathInsideRoot } from "../pkg/local-fs-guard"

let fs: any = null
let path: any = null

async function initNodeModules() {
  if (
    typeof process !== "undefined" &&
    process.release?.name === "node" &&
    !fs
  ) {
    try {
      fs = await import("fs/promises")
      path = await import("path")
    } catch (e) {}
  }
}

export class LocalDriver implements StorageDriver {
  /**
   * 存储根目录（storage.addition.root_folder_path）。
   *
   * 仅用于软链越界校验（M-9）：所有落到 fs 的操作在真正执行前都会把目标
   * realpath 一次，断言仍在根目录之内。为空/"/" 表示「无限制」，与
   * resolvePath 对 root 的语义一致。
   */
  private readonly rootFolder?: string

  constructor(rootFolder?: string) {
    this.rootFolder = rootFolder
  }

  private async guard(p: string): Promise<void> {
    await assertLocalPathInsideRoot(p, this.rootFolder)
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    await initNodeModules()
    if (!fs || !path)
      throw new Error("LocalDriver is not supported in Edge Runtime")
    await this.guard(physicalPath)
    let files: any[] = []
    try {
      files = await fs.readdir(physicalPath, { withFileTypes: true })
    } catch (e) {
      return []
    }
    // 软链条目：解析后仍必须在根目录内，越界的一律不列出（否则光是列目录
    // 就能探出 `ln -s / root/etc` 之类的穿透点）。只有软链需要额外一次
    // realpath，普通条目仍走 Promise.all 并行 stat。
    if (files.some((f: any) => f.isSymbolicLink?.())) {
      const kept: any[] = []
      for (const file of files) {
        if (file.isSymbolicLink?.()) {
          try {
            await this.guard(path.join(physicalPath, file.name))
          } catch {
            continue
          }
        }
        kept.push(file)
      }
      files = kept
    }
    const items: FileItem[] = await Promise.all(
      files.map(async (file: any) => {
        const isDir = file.isDirectory()
        let size = 0
        let mtime = new Date()
        try {
          const stat = await fs.stat(path.join(physicalPath, file.name))
          size = stat.size
          mtime = stat.mtime
        } catch (_) {}
        return {
          name: file.name,
          size: isDir ? 0 : size,
          is_dir: isDir,
          created: mtime.toISOString(),
          modified: mtime.toISOString(),
          sign: "",
          type: calcFileType(file.name, isDir),
        }
      }),
    )
    return items
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    await initNodeModules()
    if (!fs || !path)
      throw new Error("LocalDriver is not supported in Edge Runtime")
    await this.guard(physicalPath)
    const stat = await fs.stat(physicalPath)
    const isDir = stat.isDirectory()
    // physicalPath may use either "/" or "\" separators
    const name =
      physicalPath
        .split(/[\\/]+/)
        .filter(Boolean)
        .pop() || "root"
    return {
      name,
      size: isDir ? 0 : stat.size,
      is_dir: isDir,
      created: stat.ctime?.toISOString() || stat.mtime.toISOString(),
      modified: stat.mtime.toISOString(),
      sign: "",
      type: calcFileType(name, isDir),
    }
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    await initNodeModules()
    if (!fs || !path)
      throw new Error("LocalDriver is not supported in Edge Runtime")
    await this.guard(physicalPath)
    await fs.mkdir(physicalPath, { recursive: true })
    // 建完之后复检一次：父目录若是指向根外的软链，recursive mkdir 会在外面
    // 造目录（例如 /root/link 指向 /tmp，mkdir /root/link/x 会落到 /tmp/x）。
    await this.guard(physicalPath)
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    await initNodeModules()
    if (!fs || !path)
      throw new Error("LocalDriver is not supported in Edge Runtime")
    const dst = path.join(path.dirname(physicalPath), newName)
    await this.guard(physicalPath)
    await this.guard(dst)
    await fs.rename(physicalPath, dst)
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    await initNodeModules()
    if (!fs || !path)
      throw new Error("LocalDriver is not supported in Edge Runtime")
    // physicalPath 是目标项自身的路径（op/storage.ts removeItems 逐项调用），
    // 直接删除即可；不得再拼 name，否则指向 <item>/<name>，配合 force:true 会
    // 静默"成功"但什么都没删。
    await this.guard(physicalPath)
    await fs.rm(physicalPath, { recursive: true, force: true })
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    await initNodeModules()
    if (!fs || !path)
      throw new Error("LocalDriver is not supported in Edge Runtime")
    // srcPhys/dstPhys 是源/目标项自身的路径（已含 name），直接移动即可；
    // 不得再拼 name，否则指向不存在的 <item>/<name> 而 ENOENT。
    await this.guard(srcPhys)
    await this.guard(dstPhys)
    await fs.mkdir(path.dirname(dstPhys), { recursive: true })
    await this.guard(dstPhys)
    await fs.rename(srcPhys, dstPhys)
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    await initNodeModules()
    if (!fs || !path)
      throw new Error("LocalDriver is not supported in Edge Runtime")
    // 同 move：srcPhys/dstPhys 已是源/目标项自身路径，不得再拼 name。
    await this.guard(srcPhys)
    await this.guard(dstPhys)
    await fs.mkdir(path.dirname(dstPhys), { recursive: true })
    await this.guard(dstPhys)
    await fs.cp(srcPhys, dstPhys, { recursive: true })
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    await initNodeModules()
    if (!fs || !path)
      throw new Error("LocalDriver is not supported in Edge Runtime")
    await this.guard(physicalPath)
    await fs.mkdir(path.dirname(physicalPath), { recursive: true })
    // 写前复检：目标本身可能就是一条指向根外的软链，写进去会覆盖外部文件
    await this.guard(physicalPath)
    await fs.writeFile(physicalPath, content)
  }
}
