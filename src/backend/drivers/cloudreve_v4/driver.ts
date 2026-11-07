import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverCloudreveAddition, CloudreveFile } from "./types"
import { ClientCloudreve } from "./util"

function fileToItem(f: CloudreveFile): FileItem {
  const isDir = f.type === 1
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified: f.updated_at || new Date().toISOString(),
    sign: "",
    type: calcFileType(f.name, isDir),
    raw_url: "",
  }
}

/** 规范化 uri（Cloudreve 根为 "/"） */
function normUri(p: string): string {
  if (!p || p === "/") return "/"
  return p.startsWith("/") ? p : "/" + p
}

/** 物理路径的父目录 uri（根为 "/"）；move/copy 的 dst 必须是物理坐标系 */
export function parentUri(physicalPath: string): string {
  const parts = String(physicalPath || "")
    .split("/")
    .filter(Boolean)
  return parts.length > 1 ? "/" + parts.slice(0, -1).join("/") : "/"
}

export class DriverCloudreve implements StorageDriver {
  private client: ClientCloudreve

  constructor(addition: DriverCloudreveAddition) {
    this.client = new ClientCloudreve(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const files = await this.client.listFiles(normUri(physicalPath))
    return files.map(fileToItem)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const uri = normUri(physicalPath)
    const parts = uri.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    const parentUri = "/" + parts.slice(0, -1).join("/")

    // F-464：父目录列表失败（鉴权失效/网络故障）必须向上抛，不能伪装成条目。
    const files = await this.client.listFiles(parentUri === "//" ? "/" : parentUri)
    const file = files.find((f) => f.name === name || f.path === uri)
    if (file) {
      const item = fileToItem(file)
      if (!item.is_dir) {
        try {
          item.raw_url = await this.client.getDownloadUrl(uri)
        } catch (e: any) {
          item.raw_url_error = e.message
        }
      }
      return item
    }

    // 未命中：只有确认路径是目录（列它自己能成功）才合成目录条目，否则 404。
    try {
      await this.client.listFiles(uri)
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
      throw new Error(`[Cloudreve] '${uri}' not found`)
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const uri = normUri(physicalPath)
    const parts = uri.split("/").filter(Boolean)
    const name = parts.pop() || "new_folder"
    const parentUri = "/" + parts.join("/")
    await this.client.mkdir(parentUri === "//" ? "/" : parentUri, name)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    await this.client.rename(normUri(physicalPath), newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    await this.client.remove([normUri(physicalPath)])
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    await this.client.move(
      [normUri(srcPhysical)],
      parentUri(dstPhysical),
      false,
    )
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    await this.client.move(
      [normUri(srcPhysical)],
      parentUri(dstPhysical),
      true,
    )
  }

  async put(
    _virtualPath: string,
    _physicalPath: string,
    _content: Buffer,
  ): Promise<void> {
    throw new Error("[Cloudreve] Direct put not supported in stateless environment")
  }
}
