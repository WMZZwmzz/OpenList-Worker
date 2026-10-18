import { FileItem, StorageDriver } from "../../internal/driver/base"
import { SMBAddition } from "./types"

export class SMBDriver implements StorageDriver {
  private addition: SMBAddition

  constructor(addition: SMBAddition) {
    this.addition = addition
  }

  async init(): Promise<void> {
    if (!this.addition.address || !this.addition.share_name) {
      throw new Error("SMB: address and share_name are required")
    }
  }

  /**
   * 本驱动没有 SMB 客户端实现。此前这些方法体是空的，接口一律返回成功，
   * 用户「删除/上传成功」但文件根本没动——静默失败比报错危险得多，
   * 因此改为显式抛出未实现。
   */
  private unsupported(op: string): never {
    throw new Error(`SMB driver: ${op} is not implemented in this build`)
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    this.unsupported("list")
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    // 原先这里凭路径拼出一个 size:0、raw_url:"" 的假条目：不存在的文件也会
    // 「存在」，下载则静默失败。改为显式抛出未实现。
    this.unsupported("get")
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    this.unsupported("mkdir")
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    this.unsupported("rename")
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    this.unsupported("remove")
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    this.unsupported("move")
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    this.unsupported("copy")
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer | Uint8Array,
  ): Promise<void> {
    this.unsupported("put")
  }
}
