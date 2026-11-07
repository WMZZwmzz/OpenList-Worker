import {
  calcFileType,
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { md5 } from "../../pkg/crypto"
import {
  TeraboxAddition,
  TeraboxCreateResp,
  TeraboxFile,
  TeraboxListResp,
  TeraboxLocateUploadResp,
  TeraboxPrecreateResp,
  TeraboxSuperfileResp,
} from "./types"
import { TeraboxApiClient } from "./util"

// 与上游 OpenList drivers/terabox 一致：初始分片 4MB，文件超过 4GB 后逐级翻倍
const initialChunkSize = 4 * 1024 * 1024
const initialSizeThreshold = 4 * 1024 * 1024 * 1024

function calculateChunkSize(streamSize: number): number {
  let chunkSize = initialChunkSize
  let sizeThreshold = initialSizeThreshold
  if (streamSize < chunkSize) return streamSize
  while (streamSize > sizeThreshold) {
    chunkSize *= 2
    sizeThreshold *= 2
  }
  return chunkSize
}

export class TeraboxDriver implements StorageDriver {
  private addition: TeraboxAddition
  private client: TeraboxApiClient

  constructor(
    addition: TeraboxAddition,
    onCookieRefreshed?: (cookie: string) => Promise<void>,
  ) {
    this.addition = addition
    this.client = new TeraboxApiClient(addition, onCookieRefreshed)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private cleanPath(p: string): string {
    const s = "/" + (p || "").split("/").filter(Boolean).join("/")
    return s === "/" ? "/" : s
  }

  /** 列出目录全部条目（分页翻全量），任何 errno≠0 都抛错而不是当作空目录 */
  private async listDir(dir: string): Promise<TeraboxFile[]> {
    const allFiles: TeraboxFile[] = []
    let page = 1
    const num = 1000

    while (true) {
      const params: Record<string, string> = {
        dir,
        page: String(page),
        num: String(num),
      }
      if (this.addition.order_by) {
        params.order = this.addition.order_by
        if (this.addition.order_direction === "desc") {
          params.desc = "1"
        }
      }

      const resp: TeraboxListResp = await this.client.request("/api/list", {
        method: "GET",
        params,
      })

      if (resp.errno === 9000) {
        throw new Error("TeraBox is not yet available in this area")
      }
      if (resp.errno !== 0) {
        throw new Error(`[TeraBox] list failed (errno: ${resp.errno})`)
      }

      if (!resp.list || resp.list.length === 0) {
        break
      }

      allFiles.push(...resp.list)
      page++
    }

    return allFiles
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const clean = this.cleanPath(physicalPath)
    const allFiles = await this.listDir(clean)

    const items: FileItem[] = allFiles.map((f) => {
      const isDir = f.isdir === 1
      return {
        name: f.server_filename,
        size: f.size || 0,
        is_dir: isDir,
        modified: f.server_mtime
          ? new Date(f.server_mtime * 1000).toISOString()
          : new Date().toISOString(),
        sign: String(f.fs_id),
        type: calcFileType(f.server_filename, isDir),
        thumb: f.thumbs?.url3,
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
    const clean = this.cleanPath(physicalPath)

    if (clean === "/") {
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

    const parentDir = clean.split("/").slice(0, -1).join("/") || "/"
    const fileName = clean.split("/").pop() || ""

    // 翻全量后再查找：父目录超过单页上限时，后面的文件不能被当成不存在。
    const allFiles = await this.listDir(parentDir)
    const found = allFiles.find((f) => f.server_filename === fileName)
    if (!found) {
      throw new Error(`[TeraBox] '${fileName}' not found`)
    }

    const isDir = found.isdir === 1
    let rawUrl = ""
    if (!isDir) {
      try {
        if (this.addition.download_api === "crack") {
          rawUrl = await this.client.linkCrack(clean)
        } else {
          rawUrl = await this.client.linkOfficial(found.fs_id)
        }
      } catch (e) {
        console.warn("[TeraBox] get download link failed:", e)
      }
    }

    return {
      name: found.server_filename,
      size: found.size || 0,
      is_dir: isDir,
      modified: found.server_mtime
        ? new Date(found.server_mtime * 1000).toISOString()
        : new Date().toISOString(),
      sign: String(found.fs_id),
      type: calcFileType(found.server_filename, isDir),
      thumb: found.thumbs?.url3,
      raw_url: rawUrl,
      raw_url_headers: {
        "User-Agent":
          "terabox;1.37.0.7;PC;PC-Windows;10.0.22631;WindowsTeraBox",
      },
    }
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    const resp: TeraboxCreateResp = await this.client.request("/api/create", {
      method: "POST",
      isFormData: true,
      params: { a: "commit" },
      body: {
        path: clean,
        isdir: "1",
        block_list: "[]",
      },
    })
    if (!resp || Number(resp.errno) !== 0) {
      throw new Error(
        `[TeraBox] mkdir failed (errno: ${(resp as any)?.errno})`,
      )
    }
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    await this.client.manage("rename", [
      {
        path: clean,
        newname: newName,
      },
    ])
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    // physicalPath 是目标项自身的物理路径（op/storage.ts removeItems 逐项调用），
    // 参数即项路径，直接删除它即可；不得再拼 name，否则会指向 <item>/<name> 导致静默失败。
    const clean = this.cleanPath(physicalPath)
    await this.client.manage("delete", [clean])
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const srcClean = this.cleanPath(srcPhys)
    const dstClean = this.cleanPath(dstPhys)
    // srcPhys/dstPhys 是目标项自身的路径：path 不得再拼 name；
    // filemanager 的 dest 是目标目录，故取 dstPhys 去掉末段后的父目录，newname 取末段。
    await this.client.manage("move", [
      {
        path: srcClean,
        dest: dstClean.split("/").slice(0, -1).join("/") || "/",
        newname: dstClean.split("/").pop() || "",
      },
    ])
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const srcClean = this.cleanPath(srcPhys)
    const dstClean = this.cleanPath(dstPhys)
    // 同 move：srcPhys/dstPhys 已是目标项自身路径，path 不得再拼 name；
    // dest 取 dstPhys 去掉末段后的父目录，newname 取末段。
    await this.client.manage("copy", [
      {
        path: srcClean,
        dest: dstClean.split("/").slice(0, -1).join("/") || "/",
        newname: dstClean.split("/").pop() || "",
      },
    ])
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const clean = this.cleanPath(physicalPath)
    const parentPath = clean.split("/").slice(0, -1).join("/") || "/"
    const fileName = clean.split("/").pop() || "upload"
    const size = content.length

    const locateRes = await fetch(
      "https://jp-data.terabox.com/rest/2.0/pcs/file?method=locateupload",
    )
    if (!locateRes.ok) {
      throw new Error(
        `TeraBox locateupload failed: HTTP ${locateRes.status} ${locateRes.statusText}`,
      )
    }
    const locateData: TeraboxLocateUploadResp = await locateRes.json()
    const uploadHost = locateData?.host
    if (!uploadHost) {
      throw new Error("TeraBox locateupload returned no upload host")
    }

    // 上游 precreate 的 block_list 只是占位（服务端据此分配分片槽位），
    // 真正的逐片 MD5 在上传完成后用于 create。
    const precreateBlockList =
      size > initialChunkSize
        ? [
            "5910a591dd8fc18c32a8f3df4fdc1761",
            "a5fc157d78e6ad1c7e114b056c92821e",
          ]
        : ["5910a591dd8fc18c32a8f3df4fdc1761"]

    const precreateRes: TeraboxPrecreateResp = await this.client.request(
      "/api/precreate",
      {
        method: "POST",
        isFormData: true,
        body: {
          path: clean,
          autoinit: "1",
          target_path: parentPath,
          block_list: JSON.stringify(precreateBlockList),
          local_mtime: String(Math.floor(Date.now() / 1000)),
          file_limit_switch_v34: "true",
        },
      },
    )

    if (
      !precreateRes ||
      typeof precreateRes !== "object" ||
      Number(precreateRes.errno) !== 0
    ) {
      throw new Error(
        `[TeraBox] precreate failed (errno: ${(precreateRes as any)?.errno})`,
      )
    }

    // Direct rapid return
    if (precreateRes.return_type === 2) {
      return
    }

    const uploadId = precreateRes.uploadid
    if (!uploadId) {
      throw new Error("[TeraBox] precreate returned no uploadid")
    }

    const chunkSize = size > 0 ? calculateChunkSize(size) : initialChunkSize
    const chunkCount = Math.ceil(size / chunkSize)
    const uploadBlockList: string[] = []

    for (let partseq = 0; partseq < chunkCount; partseq++) {
      const start = partseq * chunkSize
      const end = Math.min(start + chunkSize, size)
      const chunk = content.subarray(start, end)
      const localMd5 = md5(chunk)
      uploadBlockList.push(localMd5)

      const uploadUrl =
        `https://${uploadHost}/rest/2.0/pcs/superfile2?method=upload` +
        `&path=${encodeURIComponent(clean)}` +
        `&uploadid=${encodeURIComponent(uploadId)}` +
        `&partseq=${partseq}`

      let lastErr: Error | null = null
      // 上游对每片最多重试 5 次（网络错误、errno、MD5 mismatch 均重试）
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const formData = new FormData()
          formData.append(
            "file",
            new Blob([new Uint8Array(chunk)], {
              type: "application/octet-stream",
            }),
            fileName,
          )

          const uploadRes = await fetch(uploadUrl, {
            method: "POST",
            headers: {
              Cookie: this.addition.cookie,
              "User-Agent":
                "terabox;1.37.0.7;PC;PC-Windows;10.0.22631;WindowsTeraBox",
            },
            body: formData,
          })

          if (!uploadRes.ok) {
            throw new Error(
              `TeraBox upload chunk ${partseq} failed: HTTP ${uploadRes.status} ${uploadRes.statusText}`,
            )
          }

          const text = await uploadRes.text()
          let data: TeraboxSuperfileResp = {}
          try {
            data = JSON.parse(text)
          } catch {
            data = {}
          }

          const errno = Number(data?.errno ?? 0)
          if (errno !== 0) {
            throw new Error(
              `TeraBox upload chunk ${partseq} failed (errno: ${errno})`,
            )
          }
          if (data?.md5 !== localMd5) {
            throw new Error(
              `TeraBox upload chunk ${partseq} MD5 mismatch (local: ${localMd5}, server: ${data?.md5})`,
            )
          }

          lastErr = null
          break
        } catch (e: any) {
          lastErr = e instanceof Error ? e : new Error(String(e))
        }
      }
      if (lastErr) throw lastErr
    }

    const createRes: TeraboxCreateResp = await this.client.request("/api/create", {
      method: "POST",
      isFormData: true,
      params: {
        isdir: "0",
        rtype: "1",
      },
      body: {
        path: clean,
        size: String(size),
        uploadid: uploadId,
        target_path: parentPath,
        block_list: JSON.stringify(uploadBlockList),
        local_mtime: String(Math.floor(Date.now() / 1000)),
      },
    })

    if (
      !createRes ||
      typeof createRes !== "object" ||
      Number(createRes.errno) !== 0
    ) {
      throw new Error(
        `[TeraBox] failed to create file (errno: ${(createRes as any)?.errno})`,
      )
    }
  }
}
