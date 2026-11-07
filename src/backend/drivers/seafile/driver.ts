import {
  calcFileType,
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { SeafileAddition, SeafileLibraryItem, SeafileRepoItem } from "./types"
import { SeafileApiClient } from "./util"

export class SeafileDriver implements StorageDriver {
  private addition: SeafileAddition
  private client: SeafileApiClient
  private repoId?: string
  private rootPath: string = "/"
  /** F-358：repo_id 形态下是否已确认过库的加密状态 */
  private repoChecked = false

  constructor(
    addition: SeafileAddition,
    onTokenRefreshed?: (token: string) => Promise<void>,
  ) {
    this.addition = addition
    this.repoId = addition.repo_id || undefined
    this.client = new SeafileApiClient(addition, onTokenRefreshed)
  }

  async init(): Promise<void> {
    await this.client.getToken()
    this.rootPath =
      "/" +
      (this.addition.root_folder_path || "/")
        .split("/")
        .filter(Boolean)
        .join("/")
  }

  private cleanPath(p: string): string {
    const s = "/" + (p || "").split("/").filter(Boolean).join("/")
    return s === "/" ? "/" : s
  }

  /**
   * 确保配置了 repo_id 的加密资料库已完成解密（F-358）。
   *
   * 只在每个驱动实例内探测一次库信息；解密结果由 SeafileApiClient 再做
   * 30 分钟缓存。库信息探测失败时不阻塞操作（保持原有失败行为），
   * 但一旦确认库是加密的就必须解密成功，否则后续请求必然 440。
   */
  private async ensureRepoDecrypted(repoId: string): Promise<void> {
    if (this.repoChecked) return
    let repo: SeafileLibraryItem
    try {
      repo = await this.client.getLibraryInfo(repoId)
    } catch (e: any) {
      // 探测失败（网络/权限）不应把原本可用的操作变成失败
      console.warn(`[Seafile] failed to inspect library ${repoId}:`, e?.message)
      return
    }
    if (repo?.encrypted) {
      await this.client.decryptLibrary(repo)
    }
    this.repoChecked = true
  }

  private async resolveRepoAndPath(physicalPath: string): Promise<{
    repoId: string
    innerPath: string
    isRootListRepos: boolean
  }> {
    const clean = this.cleanPath(physicalPath)

    if (this.repoId) {
      // F-358：repo_id 是最常用的配置形态，加密资料库同样必须先解密，
      // 否则 Seafile 对未解锁库的 dir/file 接口直接返回 440。
      await this.ensureRepoDecrypted(this.repoId)
      return {
        repoId: this.repoId,
        innerPath: clean,
        isRootListRepos: false,
      }
    }

    if (clean === "/") {
      return {
        repoId: "",
        innerPath: "/",
        isRootListRepos: true,
      }
    }

    // First segment is repo name
    const segments = clean.split("/").filter(Boolean)
    const repoName = segments[0]
    const innerPath = "/" + segments.slice(1).join("/")

    const repos =
      await this.client.request<SeafileLibraryItem[]>("/api2/repos/")
    const match = repos.find((r) => r.name === repoName || r.id === repoName)
    if (!match) {
      throw new Error(`Seafile library '${repoName}' not found`)
    }

    if (match.encrypted) {
      await this.client.decryptLibrary(match)
    }

    return {
      repoId: match.id,
      innerPath: innerPath === "/" ? "/" : innerPath,
      isRootListRepos: false,
    }
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const { repoId, innerPath, isRootListRepos } =
      await this.resolveRepoAndPath(physicalPath)

    if (isRootListRepos) {
      const repos =
        await this.client.request<SeafileLibraryItem[]>("/api2/repos/")
      const items: FileItem[] = repos.map((repo) => ({
        name: repo.name,
        size: repo.size || 0,
        is_dir: true,
        modified: repo.mtime
          ? new Date(repo.mtime * 1000).toISOString()
          : new Date().toISOString(),
        sign: repo.id,
        type: 1, // Folder / Library
        raw_url: "",
      }))
      return sortFileItems(
        items,
        this.addition.order_by,
        this.addition.order_direction,
      )
    }

    const dirItems = await this.client.request<SeafileRepoItem[]>(
      `/api2/repos/${encodeURIComponent(repoId)}/dir/`,
      {
        params: { p: innerPath },
      },
    )

    const items: FileItem[] = dirItems.map((item) => {
      const isDir = item.type === "dir"
      return {
        name: item.name,
        size: item.size || 0,
        is_dir: isDir,
        modified: item.mtime
          ? new Date(item.mtime * 1000).toISOString()
          : new Date().toISOString(),
        sign: item.id,
        type: calcFileType(item.name, isDir),
        raw_url: "",
      }
    })

    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    const { repoId, innerPath, isRootListRepos } =
      await this.resolveRepoAndPath(physicalPath)
    const clean = this.cleanPath(physicalPath)
    const name = clean.split("/").filter(Boolean).pop() || "root"

    if (isRootListRepos) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    }

    if (innerPath === "/") {
      const repo = await this.client.getLibraryInfo(repoId)
      return {
        name: repo.name || name,
        size: repo.size || 0,
        is_dir: true,
        modified: repo.mtime
          ? new Date(repo.mtime * 1000).toISOString()
          : new Date().toISOString(),
        sign: repo.id,
        type: 1,
        raw_url: "",
      }
    }

    // Get direct download link for file
    let downloadUrl = ""
    try {
      const rawRes = await this.client.request<string>(
        `/api2/repos/${encodeURIComponent(repoId)}/file/`,
        {
          params: { p: innerPath, reuse: "1" },
        },
      )
      if (typeof rawRes === "string") {
        downloadUrl = rawRes.replace(/^"|"$/g, "").trim()
      }
    } catch {
      // Might be a directory or link not ready
    }

    const parentDir = innerPath.split("/").slice(0, -1).join("/") || "/"
    const fileName = innerPath.split("/").pop() || ""

    // F-359：父目录列表是判断「存在/类型」的唯一可靠来源。
    // 只有列表成功且命中时才构造条目；列表成功但没命中 → 真实 404。
    let siblings: SeafileRepoItem[] | null = null
    let listingError: unknown = null
    try {
      siblings = await this.client.request<SeafileRepoItem[]>(
        `/api2/repos/${encodeURIComponent(repoId)}/dir/`,
        {
          params: { p: parentDir },
        },
      )
    } catch (e) {
      listingError = e
    }

    if (siblings) {
      const found = siblings.find((s) => s.name === fileName)
      if (!found) {
        throw new Error(`[Seafile] object not found: ${innerPath}`)
      }
      const isDir = found.type === "dir"
      return {
        name: found.name,
        size: found.size || 0,
        is_dir: isDir,
        modified: found.mtime
          ? new Date(found.mtime * 1000).toISOString()
          : new Date().toISOString(),
        sign: found.id,
        type: calcFileType(found.name, isDir),
        raw_url: isDir ? "" : downloadUrl,
      }
    }

    // 列表不可用：直链成功即证明这是一个文件，其余情况一律按上游错误抛出，
    // 不再用 `is_dir: !downloadUrl` 把任意失败伪造成目录。
    if (downloadUrl) {
      return {
        name,
        size: 0,
        is_dir: false,
        modified: new Date().toISOString(),
        sign: "",
        type: calcFileType(name, false),
        raw_url: downloadUrl,
      }
    }
    throw listingError instanceof Error
      ? listingError
      : new Error(`[Seafile] object not found: ${innerPath}`)
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const { repoId, innerPath } = await this.resolveRepoAndPath(physicalPath)
    await this.client.request(
      `/api2/repos/${encodeURIComponent(repoId)}/dir/`,
      {
        method: "POST",
        isFormData: true,
        params: { p: innerPath },
        body: { operation: "mkdir" },
      },
    )
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const { repoId, innerPath } = await this.resolveRepoAndPath(physicalPath)
    await this.client.request(
      `/api2/repos/${encodeURIComponent(repoId)}/file/`,
      {
        method: "POST",
        isFormData: true,
        params: { p: innerPath },
        body: {
          operation: "rename",
          newname: newName,
        },
      },
    )
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    // physicalPath 是目标项自身的物理路径（op/storage.ts removeItems 逐项调用），
    // resolveRepoAndPath 已解析到目标项，参数即目标项路径，不得再拼 name，否则指向
    // `<item>/<name>`，DELETE 到不存在的路径，接口成功但文件仍在。
    const { repoId, innerPath } = await this.resolveRepoAndPath(physicalPath)

    await this.client.request(
      `/api2/repos/${encodeURIComponent(repoId)}/file/`,
      {
        method: "DELETE",
        params: { p: innerPath },
      },
    )
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 是源/目标项自身的物理路径（op/storage.ts moveItems 逐项调用），
    // 参数即目标项路径，不得再拼 name，否则指向 `<item>/<name>`；
    // 源路径直接用 src.innerPath，dst_dir 需要目录，取 dst.innerPath 的父级。
    const src = await this.resolveRepoAndPath(srcPhys)
    const dst = await this.resolveRepoAndPath(dstPhys)
    const dstDirPath =
      dst.innerPath.substring(0, dst.innerPath.lastIndexOf("/")) || "/"

    await this.client.request(
      `/api2/repos/${encodeURIComponent(src.repoId)}/file/`,
      {
        method: "POST",
        isFormData: true,
        params: { p: src.innerPath },
        body: {
          operation: "move",
          dst_repo: dst.repoId,
          dst_dir: dstDirPath,
        },
      },
    )
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 是源/目标项自身的物理路径（op/storage.ts copyItems 逐项调用），
    // 参数即目标项路径，不得再拼 name，否则指向 `<item>/<name>`；
    // 源路径直接用 src.innerPath，dst_dir 需要目录，取 dst.innerPath 的父级。
    const src = await this.resolveRepoAndPath(srcPhys)
    const dst = await this.resolveRepoAndPath(dstPhys)
    const dstDirPath =
      dst.innerPath.substring(0, dst.innerPath.lastIndexOf("/")) || "/"

    await this.client.request(
      `/api2/repos/${encodeURIComponent(src.repoId)}/file/`,
      {
        method: "POST",
        isFormData: true,
        params: { p: src.innerPath },
        body: {
          operation: "copy",
          dst_repo: dst.repoId,
          dst_dir: dstDirPath,
        },
      },
    )
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const { repoId, innerPath } = await this.resolveRepoAndPath(physicalPath)
    const parentPath = innerPath.split("/").slice(0, -1).join("/") || "/"
    const fileName = innerPath.split("/").pop() || "upload"

    const uploadLinkRes = await this.client.request<string>(
      `/api2/repos/${encodeURIComponent(repoId)}/upload-link/`,
      {
        params: { p: parentPath },
      },
    )

    const uploadUrl = (uploadLinkRes || "").replace(/^"|"$/g, "").trim()
    if (!uploadUrl) {
      throw new Error("Failed to get Seafile upload link")
    }

    const formData = new FormData()
    formData.append("parent_dir", parentPath)
    formData.append("replace", "1")
    formData.append(
      "file",
      new Blob([new Uint8Array(content)], { type: "application/octet-stream" }),
      fileName,
    )

    await this.client.request(uploadUrl, {
      method: "POST",
      body: formData,
    })
  }
}
