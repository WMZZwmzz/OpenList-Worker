import {
  GithubAddition,
  GithubBranchResp,
  GithubObject,
  GithubRepoResp,
  GithubTreeObjReq,
  GithubTreeResp,
  GithubUserResp,
  MessageTemplateVars,
} from "./types"

export function cleanPath(p: string): string {
  if (!p) return "/"
  const normalized = p.replace(/\\/g, "/").replace(/\/+/g, "/")
  const trimmed = normalized.replace(/^\/|\/$/g, "")
  return trimmed ? "/" + trimmed : "/"
}

export function dirname(p: string): string {
  const cleaned = cleanPath(p)
  if (cleaned === "/") return "/"
  const parts = cleaned.split("/").filter(Boolean)
  parts.pop()
  return parts.length ? "/" + parts.join("/") : "/"
}

export function basename(p: string): string {
  const cleaned = cleanPath(p)
  if (cleaned === "/") return ""
  const parts = cleaned.split("/").filter(Boolean)
  return parts[parts.length - 1] || ""
}

export function joinPath(...parts: string[]): string {
  return cleanPath(parts.join("/"))
}

/**
 * 路径段级父子判断（F-202）：`/aa/1x` 不是 `/aa/1` 的子路径。
 * 仅字符串前缀判断会把名称互为前缀的兄弟目录误判为嵌套关系。
 */
export function isChildPath(parent: string, p: string): boolean {
  const parentClean = cleanPath(parent)
  const childClean = cleanPath(p)
  if (parentClean === childClean) return false
  const prefix = parentClean === "/" ? "/" : parentClean + "/"
  return childClean.startsWith(prefix)
}

/** 模板变量替换：用函数形式避免 `$&`/`$'` 等替换模式被展开（F-206） */
function replaceVar(msg: string, name: string, value: string | undefined): string {
  return msg.replace(new RegExp(`\\{\\{\\.${name}\\}\\}`, "g"), () => value || "")
}

export function renderCommitMessage(
  tmpl: string | undefined,
  vars: MessageTemplateVars,
  defaultOp: string,
): string {
  if (!tmpl || !tmpl.trim()) {
    return `${vars.UserName} ${defaultOp} ${vars.ObjPath}`
  }
  let msg = tmpl
  msg = replaceVar(msg, "UserName", vars.UserName)
  msg = replaceVar(msg, "ObjName", vars.ObjName)
  msg = replaceVar(msg, "ObjPath", vars.ObjPath)
  msg = replaceVar(msg, "ParentName", vars.ParentName)
  msg = replaceVar(msg, "ParentPath", vars.ParentPath)
  msg = replaceVar(msg, "TargetName", vars.TargetName)
  msg = replaceVar(msg, "TargetPath", vars.TargetPath)
  return msg
}

/**
 * Example:
 * a = /aaa/bbb/ccc
 * b = /aaa/b11/ddd/ccc
 *
 * ancestor = /aaa
 * aChildName = bbb
 * bChildName = b11
 * aRest = bbb/ccc
 * bRest = b11/ddd/ccc
 */
export function getPathCommonAncestor(
  a: string,
  b: string,
): {
  ancestor: string
  aChildName: string
  bChildName: string
  aRest: string
  bRest: string
} {
  const pathA = cleanPath(a)
  const pathB = cleanPath(b)

  let idx = 1
  while (idx < pathA.length && idx < pathB.length) {
    if (pathA[idx] !== pathB[idx]) {
      break
    }
    idx++
  }

  let aNextIdx = idx
  while (aNextIdx < pathA.length) {
    if (pathA[aNextIdx] === "/") {
      break
    }
    aNextIdx++
  }

  let bNextIdx = idx
  while (bNextIdx < pathB.length) {
    if (pathB[bNextIdx] === "/") {
      break
    }
    bNextIdx++
  }

  while (idx > 0) {
    if (pathA[idx] === "/") {
      break
    }
    idx--
  }

  const ancestor = cleanPath(pathA.slice(0, idx))
  const aChildName = pathA.slice(idx + 1, aNextIdx)
  const bChildName = pathB.slice(idx + 1, bNextIdx)
  const aRest = pathA.slice(idx + 1)
  const bRest = pathB.slice(idx + 1)

  return { ancestor, aChildName, bChildName, aRest, bRest }
}

/** 带 HTTP 状态码的请求错误（F-205）：便于只对 404 做「非分支引用」降级 */
export class GithubRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "GithubRequestError"
    this.status = status
  }
}

/** 是否为 HTTP 404（兼容普通 Error 文本） */
export function isNotFoundError(e: unknown): boolean {
  if (e instanceof GithubRequestError) return e.status === 404
  const msg = e instanceof Error ? e.message : String(e ?? "")
  return /^404\b/.test(msg)
}

export class GithubApiClient {
  private addition: GithubAddition
  private token: string
  private owner: string
  private repo: string

  constructor(addition: GithubAddition) {
    this.addition = addition
    this.token = (addition.token || "").trim()
    this.owner = (addition.owner || "").trim()
    this.repo = (addition.repo || "").trim()
  }

  get hasToken(): boolean {
    return !!this.token
  }

  private get headers(): Record<string, string> {    const h: Record<string, string> = {
      Accept: "application/vnd.github.object+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "OpenList-Github-Driver",
    }
    if (this.token) {
      h.Authorization = `Bearer ${this.token}`
    }
    return h
  }

  private async request<T>(
    url: string,
    options: {
      method?: string
      body?: any
      headers?: Record<string, string>
    } = {},
  ): Promise<T> {
    const reqHeaders: Record<string, string> = {
      ...this.headers,
      ...(options.headers || {}),
    }

    let bodyStr: string | undefined = undefined
    if (options.body !== undefined) {
      if (typeof options.body === "string") {
        bodyStr = options.body
      } else {
        bodyStr = JSON.stringify(options.body)
        if (!reqHeaders["Content-Type"]) {
          reqHeaders["Content-Type"] = "application/json"
        }
      }
    }

    const res = await fetch(url, {
      method: options.method || "GET",
      headers: reqHeaders,
      body: bodyStr,
    })

    if (!res.ok) {
      let errMsg = `${res.status} ${res.statusText}`
      try {
        const errJson = (await res.json()) as any
        if (errJson?.message) {
          errMsg = `${res.status} ${res.statusText}: ${errJson.message}`
        }
      } catch {}
      throw new GithubRequestError(errMsg, res.status)
    }

    if (res.status === 204) {
      return {} as T
    }

    return (await res.json()) as T
  }

  getContentApiUrl(path: string): string {
    const clean = cleanPath(path)
    // F-201: 路径段必须逐段百分号编码。否则文件名里的 # / ? / % 会被
    // WHATWG URL 解析成 fragment/query 或非法转义，请求到错误对象。
    const encoded =
      clean === "/"
        ? ""
        : clean
            .split("/")
            .map((seg) => encodeURIComponent(seg))
            .join("/")
    return `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents${encoded}`
  }

  async getContents(path: string, ref?: string): Promise<GithubObject> {
    const url = new URL(this.getContentApiUrl(path))
    if (ref) {
      url.searchParams.set("ref", ref)
    }
    return this.request<GithubObject>(url.toString())
  }

  async getRepo(): Promise<GithubRepoResp> {
    return this.request<GithubRepoResp>(
      `https://api.github.com/repos/${this.owner}/${this.repo}`,
    )
  }

  async getBranchHead(branch: string): Promise<string> {
    const res = await this.request<GithubBranchResp>(
      `https://api.github.com/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(branch)}`,
    )
    return res.commit.sha
  }

  /** 仓库分支列表；空仓库返回 []（F-204：区分「空仓库」与「ref 不存在」） */
  async listBranches(): Promise<{ name: string }[]> {
    return this.request<{ name: string }[]>(
      `https://api.github.com/repos/${this.owner}/${this.repo}/branches?per_page=1`,
    )
  }

  async getAuthenticatedUser(): Promise<GithubUserResp> {
    return this.request<GithubUserResp>("https://api.github.com/user")
  }

  async getTree(sha: string): Promise<GithubTreeResp> {
    return this.request<GithubTreeResp>(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/trees/${sha}`,
    )
  }

  /**
   * 取 blob 原始字节流（F-203：私有仓库没有 download_url 时的服务端回退）。
   * 使用 `application/vnd.github.raw` 媒体类型，Authorization 由 this.headers 携带。
   * 传入 range 时转发 Range 头；上游返回 200（忽略 Range）时由调用方裁剪。
   */
  async getBlobRaw(
    sha: string,
    range?: { start: number; end: number },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.headers,
      Accept: "application/vnd.github.raw",
    }
    if (range) {
      headers.Range = `bytes=${range.start}-${range.end}`
    }
    return fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/blobs/${encodeURIComponent(sha)}`,
      { headers },
    )
  }

  async getTreeDirectly(
    path: string,
    ref?: string,
  ): Promise<{ tree: GithubTreeResp; dirSha: string }> {
    const p = await this.getContents(path, ref)
    if (!p.entries && p.type !== "dir") {
      throw new Error(`${path} is not a folder`)
    }
    const tree = await this.getTree(p.sha)
    if (tree.truncated) {
      throw new Error(`tree ${path} is truncated`)
    }
    return { tree, dirSha: p.sha }
  }

  async newTree(
    baseSha: string | null | undefined,
    trees: (
      | GithubTreeObjReq
      | { path: string; mode: string; type: string; content?: string }
    )[],
  ): Promise<string> {
    const body: Record<string, any> = { tree: trees }
    if (baseSha) {
      body.base_tree = baseSha
    }
    const res = await this.request<GithubTreeResp>(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/trees`,
      {
        method: "POST",
        body,
        headers: { Accept: "application/vnd.github+json" },
      },
    )
    return res.sha
  }

  async putBlob(content: Buffer | Uint8Array): Promise<string> {
    const base64Content = Buffer.from(content).toString("base64")
    const res = await this.request<{ sha: string }>(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/blobs`,
      {
        method: "POST",
        body: {
          encoding: "base64",
          content: base64Content,
        },
        headers: { Accept: "application/vnd.github+json" },
      },
    )
    return res.sha
  }

  async createCommit(
    message: string,
    treeSha: string,
    parentCommitSha: string | null,
    committer?: { name: string; email: string },
    author?: { name: string; email: string },
  ): Promise<string> {
    const body: Record<string, any> = {
      message,
      tree: treeSha,
    }
    // F-204：空仓库的首次提交没有 parent
    if (parentCommitSha) {
      body.parents = [parentCommitSha]
    }
    if (committer?.name) {
      body.committer = {
        name: committer.name,
        email: committer.email,
        date: new Date().toISOString(),
      }
    }
    if (author?.name) {
      body.author = {
        name: author.name,
        email: author.email,
        date: new Date().toISOString(),
      }
    }

    const res = await this.request<{ sha: string }>(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/commits`,
      {
        method: "POST",
        body,
        headers: { Accept: "application/vnd.github+json" },
      },
    )
    return res.sha
  }

  async updateRef(branch: string, commitSha: string): Promise<void> {
    await this.request(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        method: "PATCH",
        body: {
          sha: commitSha,
          force: false,
        },
        headers: { Accept: "application/vnd.github+json" },
      },
    )
  }

  /** 创建分支引用（F-204：空仓库首次提交后 PATCH 不存在，必须 POST） */
  async createRef(branch: string, commitSha: string): Promise<void> {
    await this.request(
      `https://api.github.com/repos/${this.owner}/${this.repo}/git/refs`,
      {
        method: "POST",
        body: {
          ref: `refs/heads/${branch}`,
          sha: commitSha,
        },
        headers: { Accept: "application/vnd.github+json" },
      },
    )
  }

  /**
   * Recursively renew parent trees from path up until `until` directory.
   */
  async renewParentTrees(
    path: string,
    prevSha: string,
    curSha: string,
    until: string,
    ref?: string,
  ): Promise<string> {
    let currentPath = cleanPath(path)
    const targetUntil = cleanPath(until)

    while (currentPath !== targetUntil) {
      // 子树 sha 完全由内容决定：内容相同的兄弟目录（例如两个都只含空 .gitkeep
      // 的目录）sha 必然相同，只能按目录名定位待替换条目，否则同 sha 的兄弟目录
      // 会被错误替换，提交落到别的目录。名字必须在向上爬之前取。
      const childName = basename(currentPath)
      if (!childName) break // 已到根目录
      currentPath = dirname(currentPath)
      const { tree, dirSha } = await this.getTreeDirectly(currentPath, ref)

      const targetTreeObj = tree.tree.find((t) => t.path === childName)
      if (!targetTreeObj) {
        throw new Error(
          `Object '${childName}' (sha ${prevSha}) not found in ${currentPath}`,
        )
      }

      const newTreeReq: GithubTreeObjReq = {
        path: targetTreeObj.path,
        mode: targetTreeObj.mode,
        type: targetTreeObj.type,
        sha: curSha,
      }

      curSha = await this.newTree(dirSha, [newTreeReq])
      prevSha = dirSha
    }
    return curSha
  }
}
