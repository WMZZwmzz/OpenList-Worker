import {
  OnedriveSharelinkAddition,
  OnedriveShareItem,
  SharePointListDataResp,
} from "./types"

/** NextHref 分页的安全上限，防止上游返回重复 NextHref 时死循环 */
const MAX_PAGES = 100

export class OnedriveSharelinkApiClient {
  private addition: OnedriveSharelinkAddition
  private finalUrl = ""
  private cookie = ""
  constructor(addition: OnedriveSharelinkAddition) {
    this.addition = addition
  }

  async init(): Promise<void> {
    if (!this.addition.url) {
      throw new Error("OneDrive Sharelink URL is required")
    }

    // Resolve short links (like 1drv.ms)
    try {
      const res = await fetch(this.addition.url, {
        method: "HEAD",
        redirect: "follow",
      })
      this.finalUrl = res.url || this.addition.url
    } catch {
      this.finalUrl = this.addition.url
    }
  }

  /**
   * 列出分享内的某个目录。
   *
   * F-459：folderPath 之前被完全忽略（任何子目录都返回分享根目录的内容）。
   * SharePoint renderListDataAsStream 用 FolderServerRelativeUrl 指定要列出的
   * 目录，这里把分享根路径与 folderPath 拼接后作为该参数传入（对齐 Go 版
   * `rootFolder = rootFolder + path`）。
   *
   * F-461：单页结果之外还必须跟随 ListData.NextHref 继续请求并聚合，
   * 否则超过单页上限的目录会被静默截断。
   */
  async getFiles(folderPath = "/"): Promise<OnedriveShareItem[]> {
    if (!this.finalUrl) {
      await this.init()
    }

    const u = new URL(this.finalUrl)
    // For single file shared links
    if (
      u.pathname.includes("/:u:/") ||
      u.pathname.includes("/:v:/") ||
      u.pathname.includes("/:b:/")
    ) {
      const fileName = decodeURIComponent(u.pathname.split("/").pop() || "file")
      return [
        {
          id: "root_file",
          name: fileName,
          size: 0,
          is_folder: false,
          modified: new Date().toISOString(),
          download_url: this.getDirectDownloadLink(this.finalUrl),
        },
      ]
    }

    // Attempt SharePoint renderListDataAsStream
    const items: OnedriveShareItem[] = []
    try {
      const sharePath = decodeURIComponent(u.pathname).replace(/\/+$/, "")
      const cleanFolder =
        "/" + String(folderPath || "").split("/").filter(Boolean).join("/")
      const folderServerRelativeUrl =
        cleanFolder === "/" ? "" : `${sharePath}${cleanFolder}`
      const apiUrl = `${u.origin}${u.pathname}/_api/web/GetListUsingPath(DecodedUrl=@a1)/renderListDataAsStream`

      let nextHref = ""
      for (let page = 0; page < MAX_PAGES; page++) {
        const parameters: Record<string, unknown> = {
          RenderOptions: 5707,
          AllowMultipleValueFilterForTaxonomyFields: true,
          AddRequiredFields: true,
        }
        if (folderServerRelativeUrl) {
          parameters.FolderServerRelativeUrl = folderServerRelativeUrl
        }
        if (nextHref) parameters.NextHref = nextHref

        const res = await fetch(apiUrl, {
          method: "POST",
          headers: {
            Accept: "application/json;odata=nometadata",
            "Content-Type": "application/json;odata=verbose",
          },
          body: JSON.stringify({ parameters }),
        })
        if (!res.ok) break

        const data = (await res.json()) as SharePointListDataResp
        const rows = data.ListData?.Row || []
        for (const r of rows) {
          const isDir = String(r.FSObjType) === "1"
          const sizeNum = parseInt(r.File_x0020_Size || "0", 10)
          items.push({
            id: r.UniqueId,
            name: r.FileLeafRef,
            size: isDir ? 0 : isNaN(sizeNum) ? 0 : sizeNum,
            is_folder: isDir,
            modified: r["Modified."] || new Date().toISOString(),
            download_url: r["@content.downloadUrl"],
            sp_item_url: r[".spItemUrl"],
          })
        }
        nextHref = data.ListData?.NextHref || ""
        if (!nextHref) break
      }
    } catch {
      // Fallback
    }

    return items
  }

  getDirectDownloadLink(url: string): string {
    const u = new URL(url)
    u.searchParams.set("download", "1")
    return u.toString()
  }
}
