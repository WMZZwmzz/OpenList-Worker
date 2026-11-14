import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverIpfsAddition } from "./types"
import { ClientIpfs } from "./util"

/** 物理路径的父目录（根为 "/"），F-467 */
export function parentPath(physicalPath: string): string {
  const parts = String(physicalPath || "")
    .split("/")
    .filter(Boolean)
  return parts.length > 1 ? "/" + parts.slice(0, -1).join("/") : "/"
}

export class DriverIpfs implements StorageDriver {
  private client: ClientIpfs
  private addition: DriverIpfsAddition

  constructor(addition: DriverIpfsAddition) {
    this.addition = addition
    this.client = new ClientIpfs(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private isMfs(): boolean {
    return this.addition.mode === "mfs"
  }

  private fullPath(physicalPath: string): string {
    const root = (this.addition.root_path || "").replace(/^\/+|\/+$/g, "")
    const p = physicalPath.replace(/^\/+/, "")
    if (!root) return "/" + p
    return "/" + (p ? `${root}/${p}` : root)
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const rawPath = this.fullPath(physicalPath)
    // F-469：resolveIpfsPath 在 ipfs/ipns 模式下可能返回 /ipfs/... 或 /ipns/...，
    // ls() 两种前缀都接受，不能再只剥 /ipfs/ 再把裸串拼回 /ipfs/。
    const ipfsPath = await this.client.resolveIpfsPath(rawPath)
    const resp = await this.client.ls(ipfsPath)
    const links = resp.Objects?.[0]?.Links || []
    return links.map((l) => ({
      name: l.Name,
      size: l.Size || 0,
      is_dir: l.Type === 1,
      modified: new Date().toISOString(),
      sign: l.Hash,
      type: calcFileType(l.Name, l.Type === 1),
      raw_url: "",
    }))
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const rawPath = this.fullPath(physicalPath)
    const parts = rawPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    // 注意：list() 内部会再次应用 fullPath，因此这里必须传「物理路径」而不是 rawPath。
    const segs = String(physicalPath || "").split("/").filter(Boolean)
    const parentPhysicalPath = "/" + segs.slice(0, -1).join("/")

    if (this.isMfs()) {
      try {
        const stat = await this.client.filesStat(rawPath)
        const isDir = stat.Type === "directory"
        const item: FileItem = {
          name,
          size: stat.Size || 0,
          is_dir: isDir,
          modified: new Date().toISOString(),
          sign: stat.Hash,
          type: calcFileType(name, isDir),
          raw_url: "",
        }
        if (!isDir) item.raw_url = this.client.downloadUrl(stat.Hash, name)
        return item
      } catch {}
    }

    // ipfs/ipns 模式：通过父目录 list 找到。父目录列表失败（节点不可达/
    // CID 无法解析）必须向上抛，不能降级成伪造条目。
    const files = await this.list(_virtualPath, parentPhysicalPath)
    const entry = files.find((f) => f.name === name)
    if (entry) {
      if (!entry.is_dir) {
        entry.raw_url = this.client.downloadUrl(entry.sign, name)
      }
      return entry
    }

    // F-469：未命中时做真实探活（列目标自身），只有列成功才确认是目录。
    // 之前用 resolveIpfsPath 作判据，而它在 ipfs/ipns 模式下只是字符串拼接、
    // 永不失败，任何不存在的路径都会被当成目录。
    try {
      await this.list(_virtualPath, physicalPath)
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    } catch {
      throw new Error(`[IPFS] '${rawPath}' not found`)
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    if (!this.isMfs()) throw new Error("[IPFS] only write in mfs mode")
    await this.client.filesMkdir(this.fullPath(physicalPath))
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    if (!this.isMfs()) throw new Error("[IPFS] only write in mfs mode")
    const full = this.fullPath(physicalPath)
    const parts = full.split("/").filter(Boolean)
    const parent = parts.slice(0, -1).join("/")
    // F-473：顶层项（parent 为空）不能拼出 "//新名"，与 kodbox 的防护一致。
    const dst = parent ? `/${parent}/${newName}` : `/${newName}`
    await this.client.filesMv(full, dst)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    if (!this.isMfs()) throw new Error("[IPFS] only write in mfs mode")
    await this.client.filesRm(this.fullPath(physicalPath))
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    if (!this.isMfs()) throw new Error("[IPFS] only write in mfs mode")
    // F-467：MFS files/mv 的目标是「父目录」，必须由物理路径派生
    // （虚拟 dstDir 会被 fullPath 再拼一层 root_path，指向不存在的目录）。
    const src = this.fullPath(srcPhysical)
    const dst = this.fullPath(parentPath(dstPhysical))
    await this.client.filesMv(src, dst)
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    if (!this.isMfs()) throw new Error("[IPFS] only write in mfs mode")
    // F-467：同 move，目标父目录取物理路径。
    const srcFull = this.fullPath(srcPhysical)
    const stat = await this.client.filesStat(srcFull)
    const srcIpfs = `/ipfs/${stat.Hash}`
    const dst = this.fullPath(parentPath(dstPhysical))
    await this.client.filesCp(srcIpfs, dst)
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Uint8Array,
  ): Promise<void> {
    if (!this.isMfs()) throw new Error("[IPFS] only write in mfs mode")
    const full = this.fullPath(physicalPath)
    const parts = full.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "file"
    const hash = await this.client.add(content, name)
    await this.client.filesCp(`/ipfs/${hash}`, full)
  }
}
