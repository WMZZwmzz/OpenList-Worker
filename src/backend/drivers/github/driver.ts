import {
  calcFileType,
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { GithubAddition, GithubObject, GithubTreeObjReq, GithubTreeResp } from "./types"
import {
  basename,
  cleanPath,
  dirname,
  getPathCommonAncestor,
  GithubApiClient,
  isChildPath,
  isNotFoundError,
  joinPath,
  renderCommitMessage,
} from "./util"

export class GithubDriver implements StorageDriver {
  private addition: GithubAddition
  private client: GithubApiClient
  private isOnBranch: boolean = false
  private isEmptyRepo: boolean = false
  private commitLock: Promise<void> = Promise.resolve()

  constructor(addition: GithubAddition) {
    this.addition = addition
    this.client = new GithubApiClient(addition)
  }

  private async acquireLock<T>(fn: () => Promise<T>): Promise<T> {
    const currentLock = this.commitLock
    let releaseLock: () => void
    this.commitLock = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    await currentLock
    try {
      return await fn()
    } finally {
      releaseLock!()
    }
  }

  private formatDownloadUrl(rawUrl: string | null | undefined): string {
    if (!rawUrl) return ""
    const ghProxy = (this.addition.gh_proxy || "").trim()
    if (ghProxy) {
      return rawUrl.replace("https://raw.githubusercontent.com", ghProxy)
    }
    return rawUrl
  }

  private async commitAndPush(
    message: string,
    rootTreeSha: string,
  ): Promise<void> {
    const branch = this.addition.ref!
    const committer =
      this.addition.committer_name && this.addition.committer_email
        ? {
            name: this.addition.committer_name,
            email: this.addition.committer_email,
          }
        : undefined

    const author =
      this.addition.author_name && this.addition.author_email
        ? {
            name: this.addition.author_name,
            email: this.addition.author_email,
          }
        : undefined

    // F-204：空仓库的首次提交没有 parent，且分支引用还不存在（PATCH 无法创建）
    if (this.isEmptyRepo) {
      const firstCommitSha = await this.client.createCommit(
        message,
        rootTreeSha,
        null,
        committer,
        author,
      )
      await this.client.createRef(branch, firstCommitSha)
      this.isEmptyRepo = false
      this.isOnBranch = true
      return
    }

    const headCommitSha = await this.client.getBranchHead(branch)

    const newCommitSha = await this.client.createCommit(
      message,
      rootTreeSha,
      headCommitSha,
      committer,
      author,
    )
    await this.client.updateRef(branch, newCommitSha)
  }

  async init(): Promise<void> {
    this.addition.root_folder_path = cleanPath(
      this.addition.root_folder_path || "/",
    )

    if (
      (this.addition.committer_name && !this.addition.committer_email) ||
      (!this.addition.committer_name && this.addition.committer_email)
    ) {
      throw new Error(
        "committer_name and committer_email must both be set or empty",
      )
    }

    if (
      (this.addition.author_name && !this.addition.author_email) ||
      (!this.addition.author_name && this.addition.author_email)
    ) {
      throw new Error("author_name and author_email must both be set or empty")
    }

    if (!this.addition.ref || !this.addition.ref.trim()) {
      const repo = await this.client.getRepo()
      this.addition.ref = repo.default_branch
    }

    try {
      await this.client.getBranchHead(this.addition.ref)
      this.isOnBranch = true
    } catch (e) {
      // F-205：只有 404 才可能是「ref 不是分支」；401/403/429/5xx/网络错误
      // 必须原样抛出，否则写入口会以误导性的 "cannot write to non-branch
      // reference" 失败，真实原因被丢弃。
      if (!isNotFoundError(e)) throw e
      // F-204：空仓库没有任何分支/提交，getBranchHead 必然 404。
      // 用 /branches 是否为空区分「空仓库」与「写错 ref」。
      const branches = await this.client.listBranches().catch(() => null)
      if (branches && branches.length === 0) {
        this.isEmptyRepo = true
        this.isOnBranch = true
      } else {
        this.isOnBranch = false
      }
    }
  }

  /** 空仓库根目录的 404 "This repository is empty"（F-204） */
  private isEmptyRepoError(e: unknown): boolean {
    if (!isNotFoundError(e)) return false
    const msg = e instanceof Error ? e.message : String(e ?? "")
    return /empty/i.test(msg)
  }

  /**
   * 读取父目录；空仓库的根目录按空目录处理（无 base_tree，F-204）。
   */
  private async getParentDir(parentPath: string): Promise<GithubObject> {
    try {
      const parent = await this.client.getContents(
        parentPath,
        this.addition.ref,
      )
      if (!parent.entries && parent.type !== "dir") {
        throw new Error(`${parentPath} is not a folder`)
      }
      return parent
    } catch (e) {
      if (this.isEmptyRepo && parentPath === "/" && isNotFoundError(e)) {
        return {
          type: "dir",
          size: 0,
          name: "",
          path: "/",
          sha: "",
          url: "",
          git_url: "",
          html_url: "",
          download_url: null,
          entries: [],
        }
      }
      throw e
    }
  }

  /**
   * 私有仓库没有 download_url 时的服务端流式回退（F-203）。
   * raw.ts 在 raw_url 为空且驱动实现 createReadStream 时走这里。
   */
  async createReadStream(
    physicalPath: string,
    options?: { start?: number; end?: number },
  ): Promise<ReadableStream<Uint8Array>> {
    const p = cleanPath(physicalPath)
    const obj = await this.client.getContents(p, this.addition.ref)
    if (obj.type === "dir" || obj.entries) {
      throw new Error(`${physicalPath} is not a file`)
    }
    const range =
      options?.start !== undefined && options?.end !== undefined
        ? { start: options.start, end: options.end }
        : undefined
    const res = await this.client.getBlobRaw(obj.sha, range)
    if (!res.ok || !res.body) {
      throw new Error(`GitHub blob fetch failed: HTTP ${res.status}`)
    }
    if (!range || res.status === 206) return res.body
    // 上游忽略 Range（返回 200 全量）时在本地裁剪
    return sliceStream(res.body, range)
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const p = cleanPath(physicalPath)
    if (this.isEmptyRepo && p === "/") return []
    let obj: GithubObject
    try {
      obj = await this.client.getContents(p, this.addition.ref)
    } catch (e) {
      if (p === "/" && this.isEmptyRepoError(e)) {
        this.isEmptyRepo = true
        this.isOnBranch = true
        return []
      }
      throw e
    }

    if (!obj.entries && obj.type !== "dir") {
      throw new Error(`${physicalPath} is not a folder`)
    }

    const items: FileItem[] = []

    if (obj.entries && obj.entries.length >= 1000) {
      const tree = await this.client.getTree(obj.sha)
      if (tree.truncated) {
        throw new Error(`Tree ${physicalPath} is truncated (>100,000 items)`)
      }
      for (const t of tree.tree) {
        if (t.path === ".gitkeep") continue
        const isDir = t.type === "tree"
        items.push({
          name: t.path,
          size: t.size || 0,
          is_dir: isDir,
          modified: new Date(0).toISOString(),
          sign: "",
          type: calcFileType(t.path, isDir),
          raw_url: "",
        })
      }
    } else if (obj.entries) {
      for (const entry of obj.entries) {
        if (entry.name === ".gitkeep") continue
        const isDir = entry.type === "dir"
        items.push({
          name: entry.name,
          size: entry.size || 0,
          is_dir: isDir,
          modified: new Date(0).toISOString(),
          sign: "",
          type: calcFileType(entry.name, isDir),
          raw_url: this.formatDownloadUrl(entry.download_url),
        })
      }
    }

    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const p = cleanPath(physicalPath)
    let obj: GithubObject
    try {
      obj = await this.client.getContents(p, this.addition.ref)
    } catch (e) {
      if (p === "/" && this.isEmptyRepoError(e)) {
        this.isEmptyRepo = true
        this.isOnBranch = true
        return {
          name: "root",
          size: 0,
          is_dir: true,
          modified: new Date(0).toISOString(),
          sign: "",
          type: 1,
          raw_url: "",
        }
      }
      throw e
    }

    if (obj.type === "submodule") {
      throw new Error("cannot download a submodule")
    }

    const isDir = obj.type === "dir" || !!obj.entries
    const name = obj.name || basename(p) || "root"
    const rawUrl = this.formatDownloadUrl(obj.download_url)

    const item: FileItem = {
      name,
      size: obj.size || 0,
      is_dir: isDir,
      modified: new Date(0).toISOString(),
      sign: "",
      type: calcFileType(name, isDir),
      raw_url: rawUrl,
    }
    if (!isDir && !rawUrl) {
      // F-203：私有仓库的 contents API 返回 download_url=null。这里给出具体
      // 原因（raw.ts 会把它拼进 404 文案），并已实现 createReadStream 回退。
      item.raw_url_error = this.client.hasToken
        ? "GitHub contents API 未返回 download_url（私有仓库），已回退为服务端流式下载。"
        : "GitHub contents API 未返回 download_url（私有仓库需要配置 token）。"
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error("cannot write to non-branch reference")
    }

    const p = cleanPath(physicalPath)
    const parentPath = dirname(p)
    const dirName = basename(p)

    await this.acquireLock(async () => {
      const parent = await this.getParentDir(parentPath)

      // Create new tree with .gitkeep inside sub directory
      const subDirSha = await this.client.newTree("", [
        {
          path: ".gitkeep",
          mode: "100644",
          type: "blob",
          content: "",
        },
      ])

      const newTreeEntries: GithubTreeObjReq[] = [
        {
          path: dirName,
          mode: "040000",
          type: "tree",
          sha: subDirSha,
        },
      ]

      // If parent only had .gitkeep, remove .gitkeep
      if (
        parent.entries?.length === 1 &&
        parent.entries[0].name === ".gitkeep" &&
        // F-207：写入对象本身是 .gitkeep 时不能同时追加删除条目
        dirName !== ".gitkeep"
      ) {
        newTreeEntries.push({
          path: ".gitkeep",
          mode: "100644",
          type: "blob",
          sha: null,
        })
      }

      const newSha = await this.client.newTree(parent.sha || null, newTreeEntries)
      // 空仓库根目录没有可续写的父树
      const rootSha = parent.sha
        ? await this.client.renewParentTrees(
            parentPath,
            parent.sha,
            newSha,
            "/",
            this.addition.ref,
          )
        : newSha

      const commitMessage = renderCommitMessage(
        this.addition.mkdir_commit_message,
        {
          UserName: "OpenList",
          ObjName: dirName,
          ObjPath: p,
          ParentName: basename(parentPath),
          ParentPath: parentPath,
        },
        "mkdir",
      )

      await this.commitAndPush(commitMessage, rootSha)
    })
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error("cannot write to non-branch reference")
    }

    const p = cleanPath(physicalPath)
    const parentPath = dirname(p)
    const fileName = basename(p)

    await this.acquireLock(async () => {
      const blobSha = await this.client.putBlob(content)
      const parent = await this.getParentDir(parentPath)

      const newTreeEntries: GithubTreeObjReq[] = [
        {
          path: fileName,
          mode: "100644",
          type: "blob",
          sha: blobSha,
        },
      ]

      // If parent had only .gitkeep, remove .gitkeep
      if (
        parent.entries?.length === 1 &&
        parent.entries[0].name === ".gitkeep" &&
        // F-207：上传的文件本身就叫 .gitkeep 时两条同 path 条目语义相反
        fileName !== ".gitkeep"
      ) {
        newTreeEntries.push({
          path: ".gitkeep",
          mode: "100644",
          type: "blob",
          sha: null,
        })
      }

      const newSha = await this.client.newTree(parent.sha || null, newTreeEntries)
      // 空仓库根目录没有可续写的父树
      const rootSha = parent.sha
        ? await this.client.renewParentTrees(
            parentPath,
            parent.sha,
            newSha,
            "/",
            this.addition.ref,
          )
        : newSha

      const commitMessage = renderCommitMessage(
        this.addition.put_commit_message,
        {
          UserName: "OpenList",
          ObjName: fileName,
          ObjPath: p,
          ParentName: basename(parentPath),
          ParentPath: parentPath,
        },
        "upload",
      )

      await this.commitAndPush(commitMessage, rootSha)
    })
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error("cannot write to non-branch reference")
    }

    const p = cleanPath(physicalPath)
    const parentPath = dirname(p)
    const oldName = basename(p)

    await this.acquireLock(async () => {
      const { tree, dirSha } = await this.client.getTreeDirectly(
        parentPath,
        this.addition.ref,
      )
      const target = tree.tree.find((t) => t.path === oldName)
      if (!target) {
        throw new Error(`Object not found: ${p}`)
      }
      if (target.type === "commit") {
        throw new Error("cannot rename a submodule")
      }

      const delOld: GithubTreeObjReq = {
        path: oldName,
        mode: target.mode,
        type: target.type,
        sha: null,
      }
      const addNew: GithubTreeObjReq = {
        path: newName,
        mode: target.mode,
        type: target.type,
        sha: target.sha,
      }

      const newSha = await this.client.newTree(dirSha, [delOld, addNew])
      const rootSha = await this.client.renewParentTrees(
        parentPath,
        dirSha,
        newSha,
        "/",
        this.addition.ref,
      )

      const commitMessage = renderCommitMessage(
        this.addition.rename_commit_message,
        {
          UserName: "OpenList",
          ObjName: oldName,
          ObjPath: p,
          ParentName: basename(parentPath),
          ParentPath: parentPath,
          TargetName: newName,
          TargetPath: joinPath(parentPath, newName),
        },
        "rename",
      )

      await this.commitAndPush(commitMessage, rootSha)
    })
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error("cannot write to non-branch reference")
    }

    const p = cleanPath(physicalPath)
    const parentPath = dirname(p)
    const objName = basename(p)

    await this.acquireLock(async () => {
      const { tree, dirSha } = await this.client.getTreeDirectly(
        parentPath,
        this.addition.ref,
      )
      const target = tree.tree.find((t) => t.path === objName)
      if (!target) {
        throw new Error(`Object not found: ${p}`)
      }
      if (target.type === "commit") {
        throw new Error("cannot remove a submodule")
      }

      const treeEntries: (
        | GithubTreeObjReq
        | { path: string; mode: string; type: string; content?: string }
      )[] = [
        {
          path: objName,
          mode: target.mode,
          type: target.type,
          sha: null,
        },
      ]

      // If emptying directory, add .gitkeep so folder remains valid
      // F-207：删除的对象本身是 .gitkeep 时不能再追加同 path 的新增条目
      if (tree.tree.length === 1 && objName !== ".gitkeep") {
        treeEntries.push({
          path: ".gitkeep",
          mode: "100644",
          type: "blob",
          content: "",
        })
      }

      const newSha = await this.client.newTree(dirSha, treeEntries)
      const rootSha = await this.client.renewParentTrees(
        parentPath,
        dirSha,
        newSha,
        "/",
        this.addition.ref,
      )

      const commitMessage = renderCommitMessage(
        this.addition.delete_commit_message,
        {
          UserName: "OpenList",
          ObjName: objName,
          ObjPath: p,
          ParentName: basename(parentPath),
          ParentPath: parentPath,
        },
        "remove",
      )

      await this.commitAndPush(commitMessage, rootSha)
    })
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error("cannot write to non-branch reference")
    }

    const srcPath = cleanPath(srcPhys)
    const dstPath = cleanPath(dstDir)

    if (isChildPath(srcPath, dstPath)) {
      throw new Error("cannot move parent dir to child")
    }

    await this.acquireLock(async () => {
      let rootSha = ""
      const srcParentPath = dirname(srcPath)
      const srcObjName = basename(srcPath)

      if (dstPath === srcParentPath || isChildPath(srcParentPath, dstPath)) {
        // Case 1: moving to sibling subdirectory (e.g. /aa/1 -> /aa/bb/)
        const { dstOldSha, dstNewSha, ancestorOldSha, srcParentTree } =
          await this.copyWithoutRenewTree(srcPath, dstPath)

        const dstRest = dstPath.slice(srcParentPath.length).replace(/^\//, "")
        const dstNextName = dstRest.split("/")[0]
        const dstNextPath = joinPath(srcParentPath, dstNextName)

        const dstNextTreeSha = await this.client.renewParentTrees(
          dstPath,
          dstOldSha,
          dstNewSha,
          dstNextPath,
          this.addition.ref,
        )

        const delSrc = srcParentTree.tree.find((t) => t.path === srcObjName)
        const dstNextTree = srcParentTree.tree.find(
          (t) => t.path === dstNextName,
        )

        if (!delSrc || !dstNextTree) {
          throw new Error("Object not found during move")
        }

        const ancestorNewSha = await this.client.newTree(ancestorOldSha, [
          {
            path: delSrc.path,
            mode: delSrc.mode,
            type: delSrc.type,
            sha: null,
          },
          {
            path: dstNextTree.path,
            mode: dstNextTree.mode,
            type: dstNextTree.type,
            sha: dstNextTreeSha,
          },
        ])

        rootSha = await this.client.renewParentTrees(
          srcParentPath,
          ancestorOldSha,
          ancestorNewSha,
          "/",
          this.addition.ref,
        )
      } else if (isChildPath(dstPath, srcPath)) {
        // Case 2: moving to ancestor directory (e.g. /aa/bb/1 -> /aa/)
        const { tree: srcParentTree, dirSha: srcParentOldSha } =
          await this.client.getTreeDirectly(srcParentPath, this.addition.ref)

        const src = srcParentTree.tree.find((t) => t.path === srcObjName)
        if (!src) throw new Error("Object not found")
        if (src.type === "commit") throw new Error("cannot move a submodule")

        const delSrcTree: (
          | GithubTreeObjReq
          | { path: string; mode: string; type: string; content?: string }
        )[] = [
          {
            path: src.path,
            mode: src.mode,
            type: src.type,
            sha: null,
          },
        ]
        if (srcParentTree.tree.length === 1 && src.path !== ".gitkeep") {
          delSrcTree.push({
            path: ".gitkeep",
            mode: "100644",
            type: "blob",
            content: "",
          })
        }

        const srcParentNewSha = await this.client.newTree(
          srcParentOldSha,
          delSrcTree,
        )

        const srcRest = srcPath.slice(dstPath.length).replace(/^\//, "")
        const srcNextName = srcRest.split("/")[0]
        if (!srcNextName) throw new Error("cannot move in place")

        const srcNextPath = joinPath(dstPath, srcNextName)
        const srcNextTreeSha = await this.client.renewParentTrees(
          srcParentPath,
          srcParentOldSha,
          srcParentNewSha,
          srcNextPath,
          this.addition.ref,
        )

        const { tree: ancestorTree, dirSha: ancestorOldSha } =
          await this.client.getTreeDirectly(dstPath, this.addition.ref)

        const srcNextTree = ancestorTree.tree.find(
          (t) => t.path === srcNextName,
        )
        if (!srcNextTree) throw new Error("Object not found")

        const ancestorNewSha = await this.client.newTree(ancestorOldSha, [
          {
            path: srcNextTree.path,
            mode: srcNextTree.mode,
            type: srcNextTree.type,
            sha: srcNextTreeSha,
          },
          {
            path: src.path,
            mode: src.mode,
            type: src.type,
            sha: src.sha,
          },
        ])

        rootSha = await this.client.renewParentTrees(
          dstPath,
          ancestorOldSha,
          ancestorNewSha,
          "/",
          this.addition.ref,
        )
      } else {
        // Case 3: moving across different branches (e.g. /aa/1 -> /bb/)
        const { dstOldSha, dstNewSha, srcParentOldSha, srcParentTree } =
          await this.copyWithoutRenewTree(srcPath, dstPath)

        const src = srcParentTree.tree.find((t) => t.path === srcObjName)
        if (!src) throw new Error("Object not found")

        const delSrcTree: (
          | GithubTreeObjReq
          | { path: string; mode: string; type: string; content?: string }
        )[] = [
          {
            path: src.path,
            mode: src.mode,
            type: src.type,
            sha: null,
          },
        ]
        if (srcParentTree.tree.length === 1 && src.path !== ".gitkeep") {
          delSrcTree.push({
            path: ".gitkeep",
            mode: "100644",
            type: "blob",
            content: "",
          })
        }

        const srcParentNewSha = await this.client.newTree(
          srcParentOldSha,
          delSrcTree,
        )

        const {
          ancestor,
          aChildName: srcChildName,
          bChildName: dstChildName,
        } = getPathCommonAncestor(srcPath, dstPath)

        const dstNextTreeSha = await this.client.renewParentTrees(
          dstPath,
          dstOldSha,
          dstNewSha,
          joinPath(ancestor, dstChildName),
          this.addition.ref,
        )

        const srcNextTreeSha = await this.client.renewParentTrees(
          srcParentPath,
          srcParentOldSha,
          srcParentNewSha,
          joinPath(ancestor, srcChildName),
          this.addition.ref,
        )

        const { tree: ancestorTree, dirSha: ancestorOldSha } =
          await this.client.getTreeDirectly(ancestor, this.addition.ref)

        const srcChild = ancestorTree.tree.find((t) => t.path === srcChildName)
        const dstChild = ancestorTree.tree.find((t) => t.path === dstChildName)

        if (!srcChild || !dstChild) {
          throw new Error("Ancestor child tree not found")
        }

        const ancestorNewSha = await this.client.newTree(ancestorOldSha, [
          {
            path: srcChild.path,
            mode: srcChild.mode,
            type: srcChild.type,
            sha: srcNextTreeSha,
          },
          {
            path: dstChild.path,
            mode: dstChild.mode,
            type: dstChild.type,
            sha: dstNextTreeSha,
          },
        ])

        rootSha = await this.client.renewParentTrees(
          ancestor,
          ancestorOldSha,
          ancestorNewSha,
          "/",
          this.addition.ref,
        )
      }

      const commitMessage = renderCommitMessage(
        this.addition.move_commit_message,
        {
          UserName: "OpenList",
          ObjName: srcObjName,
          ObjPath: srcPath,
          ParentName: basename(srcParentPath),
          ParentPath: srcParentPath,
          TargetName: basename(dstPath),
          TargetPath: dstPath,
        },
        "move",
      )

      await this.commitAndPush(commitMessage, rootSha)
    })
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    if (!this.isOnBranch) {
      throw new Error("cannot write to non-branch reference")
    }

    const srcPath = cleanPath(srcPhys)
    const dstPath = cleanPath(dstDir)

    if (isChildPath(srcPath, dstPath)) {
      throw new Error("cannot copy parent dir to child")
    }

    await this.acquireLock(async () => {
      const { dstOldSha, dstNewSha } = await this.copyWithoutRenewTree(
        srcPath,
        dstPath,
      )
      const rootSha = await this.client.renewParentTrees(
        dstPath,
        dstOldSha,
        dstNewSha,
        "/",
        this.addition.ref,
      )

      const commitMessage = renderCommitMessage(
        this.addition.copy_commit_message,
        {
          UserName: "OpenList",
          ObjName: basename(srcPath),
          ObjPath: srcPath,
          ParentName: basename(dirname(srcPath)),
          ParentPath: dirname(srcPath),
          TargetName: basename(dstPath),
          TargetPath: dstPath,
        },
        "copy",
      )

      await this.commitAndPush(commitMessage, rootSha)
    })
  }

  private async copyWithoutRenewTree(
    srcPath: string,
    dstPath: string,
  ): Promise<{
    dstOldSha: string
    dstNewSha: string
    srcParentOldSha: string
    srcParentTree: GithubTreeResp
    ancestorOldSha: string
  }> {
    const dst = await this.client.getContents(dstPath, this.addition.ref)
    if (!dst.entries && dst.type !== "dir") {
      throw new Error(`${dstPath} is not a folder`)
    }

    const srcParentPath = dirname(srcPath)
    const srcObjName = basename(srcPath)
    const { tree: srcParentTree, dirSha: srcParentOldSha } =
      await this.client.getTreeDirectly(srcParentPath, this.addition.ref)

    const src = srcParentTree.tree.find((t) => t.path === srcObjName)
    if (!src) {
      throw new Error(`Object not found: ${srcPath}`)
    }
    if (src.type === "commit") {
      throw new Error("cannot copy a submodule")
    }

    const newTreeEntries: GithubTreeObjReq[] = [
      {
        path: src.path,
        mode: src.mode,
        type: src.type,
        sha: src.sha,
      },
    ]

    // If destination only had .gitkeep, remove .gitkeep
    // F-207：复制对象本身是 .gitkeep 时不能同时追加删除条目
    if (
      dst.entries?.length === 1 &&
      dst.entries[0].name === ".gitkeep" &&
      src.path !== ".gitkeep"
    ) {
      newTreeEntries.push({
        path: ".gitkeep",
        mode: "100644",
        type: "blob",
        sha: null,
      })
    }

    const dstNewSha = await this.client.newTree(dst.sha, newTreeEntries)

    return {
      dstOldSha: dst.sha,
      dstNewSha,
      srcParentOldSha,
      srcParentTree,
      ancestorOldSha: srcParentOldSha,
    }
  }
}

/** 上游忽略 Range 时按 [start, end] 裁剪流（F-203） */
function sliceStream(
  body: ReadableStream<Uint8Array>,
  range: { start: number; end: number },
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let offset = 0
  let finished = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return
      try {
        const { done, value } = await reader.read()
        if (done) {
          finished = true
          controller.close()
          return
        }
        const chunkStart = offset
        offset += value.byteLength
        if (offset > range.start) {
          const from = Math.max(0, range.start - chunkStart)
          const to = Math.min(value.byteLength, range.end + 1 - chunkStart)
          if (to > from) controller.enqueue(value.subarray(from, to))
        }
        if (offset > range.end) {
          finished = true
          controller.close()
          await reader.cancel().catch(() => {})
        }
      } catch (e) {
        finished = true
        controller.error(e)
      }
    },
    cancel(reason) {
      finished = true
      return reader.cancel(reason)
    },
  })
}

