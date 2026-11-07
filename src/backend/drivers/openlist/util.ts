// OpenList（对端实例）API 客户端
import { DriverOpenlistAddition, OLFile, OLResp, OLListData, OLGetData } from "./types"

export class ClientOpenlist {
  private url: string
  private addition: DriverOpenlistAddition
  private token = ""

  constructor(addition: DriverOpenlistAddition) {
    this.addition = addition
    this.url = (addition.url || "").replace(/\/+$/, "")
    this.token = addition.token || ""
  }

  async init(): Promise<void> {
    if (!this.url) throw new Error("[OpenList] url is required")
    if (this.addition.username && this.addition.password) {
      await this.login()
    }
  }

  /**
   * F-471：把驱动收到的物理路径映射到对端实例内的路径。
   * `root_path` 是 openlist 驱动自己的配置项（db 层只认 root_folder_path），
   * 之前从未被消费，填了也静默失效；这里统一在发给 /api/fs/* 前拼上前缀。
   */
  private fullPath(path: string): string {
    const root = (this.addition.root_path || "").replace(/^\/+|\/+$/g, "")
    const p = String(path || "").replace(/^\/+/, "")
    if (!root) return "/" + p
    return "/" + (p ? `${root}/${p}` : root)
  }

  private async login(): Promise<void> {
    const resp = await fetch(`${this.url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.addition.username,
        password: this.addition.password,
      }),
    })
    const data: any = await resp.json().catch(() => ({}))
    if (data?.data?.token) {
      this.token = data.data.token
    } else {
      throw new Error("[OpenList] login failed")
    }
  }

  private async request<T = any>(
    endpoint: string,
    method = "POST",
    body?: any,
  ): Promise<OLResp<T>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (this.token) headers["Authorization"] = this.token
    if (this.addition.meta_password) headers["Meta-Password"] = this.addition.meta_password
    const options: RequestInit = { method, headers }
    if (body) options.body = JSON.stringify(body)
    const resp = await fetch(`${this.url}${endpoint}`, options)
    return (await resp.json()) as OLResp<T>
  }

  async list(path: string): Promise<OLFile[]> {
    const resp = await this.request<OLListData>("/api/fs/list", "POST", {
      path: this.fullPath(path),
      page: 1,
      per_page: 0,
    })
    if (resp.code !== 200) throw new Error(`[OpenList] ${resp.message}`)
    return resp.data?.content || []
  }

  async get(path: string): Promise<OLGetData> {
    const resp = await this.request<OLGetData>("/api/fs/get", "POST", {
      path: this.fullPath(path),
    })
    if (resp.code !== 200) throw new Error(`[OpenList] ${resp.message}`)
    return resp.data
  }

  async mkdir(path: string): Promise<void> {
    const resp = await this.request("/api/fs/mkdir", "POST", {
      path: this.fullPath(path),
    })
    if (resp.code !== 200) throw new Error(`[OpenList] ${resp.message}`)
  }

  async rename(path: string, name: string): Promise<void> {
    const resp = await this.request("/api/fs/rename", "POST", {
      path: this.fullPath(path),
      name,
    })
    if (resp.code !== 200) throw new Error(`[OpenList] ${resp.message}`)
  }

  async move(srcDir: string, dstDir: string, names: string[]): Promise<void> {
    const resp = await this.request("/api/fs/move", "POST", {
      src_dir: this.fullPath(srcDir),
      dst_dir: this.fullPath(dstDir),
      names,
    })
    if (resp.code !== 200) throw new Error(`[OpenList] ${resp.message}`)
  }

  async copy(srcDir: string, dstDir: string, names: string[]): Promise<void> {
    const resp = await this.request("/api/fs/copy", "POST", {
      src_dir: this.fullPath(srcDir),
      dst_dir: this.fullPath(dstDir),
      names,
    })
    if (resp.code !== 200) throw new Error(`[OpenList] ${resp.message}`)
  }

  async remove(dir: string, names: string[]): Promise<void> {
    const resp = await this.request("/api/fs/remove", "POST", {
      dir: this.fullPath(dir),
      names,
    })
    if (resp.code !== 200) throw new Error(`[OpenList] ${resp.message}`)
  }
}
