import {
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { AliasAddition, AliasPathPair } from "./types"

export class AliasDriver implements StorageDriver {
  private addition: AliasAddition
  private pathPairs: AliasPathPair[] = []
  private rootOrder: string[] = []
  private pathMap: Map<string, string[]> = new Map()

  constructor(addition: AliasAddition) {
    this.addition = addition
    this.parsePaths()
  }

  private cleanPath(p: string): string {
    const s = "/" + (p || "").split("/").filter(Boolean).join("/")
    return s === "/" ? "/" : s
  }

  /** 取所在目录：physicalPath 是目标项自身路径时，去掉最后一段即其父目录 */
  private parentPath(p: string): string {
    const clean = this.cleanPath(p)
    return clean.substring(0, clean.lastIndexOf("/")) || "/"
  }

  private parsePaths(): void {
    const raw = this.addition.paths || ""
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)

    this.pathPairs = []
    this.rootOrder = []
    this.pathMap.clear()

    for (const line of lines) {
      let aliasSub = "/"
      let target = line
      const colonIdx = line.indexOf(":")
      if (colonIdx > 0) {
        aliasSub = this.cleanPath(line.slice(0, colonIdx))
        target = line.slice(colonIdx + 1).trim()
      }
      target = this.cleanPath(target)

      this.pathPairs.push({ aliasSubPath: aliasSub, targetPath: target })

      if (!this.pathMap.has(aliasSub)) {
        this.rootOrder.push(aliasSub)
        this.pathMap.set(aliasSub, [])
      }
      this.pathMap.get(aliasSub)!.push(target)
    }
  }

  async init(): Promise<void> {
    this.parsePaths()
  }

  private getTargetsForPath(physicalPath: string): Array<{
    targetFullPath: string
    subPath: string
  }> {
    const clean = this.cleanPath(physicalPath)
    const results: Array<{ targetFullPath: string; subPath: string }> = []

    if (this.rootOrder.length === 1 && this.rootOrder[0] === "/") {
      const targets = this.pathMap.get("/") || []
      for (const target of targets) {
        const full = clean === "/" ? target : `${target}${clean}`
        results.push({ targetFullPath: this.cleanPath(full), subPath: clean })
      }
      return results
    }

    for (const [aliasSub, targets] of this.pathMap.entries()) {
      if (aliasSub === clean) {
        for (const target of targets) {
          results.push({ targetFullPath: target, subPath: "/" })
        }
      } else if (clean.startsWith(aliasSub === "/" ? "/" : `${aliasSub}/`)) {
        const sub = clean.slice(aliasSub === "/" ? 0 : aliasSub.length)
        for (const target of targets) {
          const full = sub === "/" ? target : `${target}${sub}`
          results.push({ targetFullPath: this.cleanPath(full), subPath: sub })
        }
      }
    }

    return results
  }

  /**
   * F-462：aliasSub 可能是多段路径（/a/b），中间的 /a 既不是完整映射也不是
   * 映射下的子路径，需要由前缀树合成为可导航目录。返回 clean 下需要补齐的
   * 目录名（不含已完整映射的 aliasSub 本身）。
   */
  private syntheticChildren(clean: string): string[] {
    const prefix = clean === "/" ? "/" : `${clean}/`
    const names: string[] = []
    for (const aliasSub of this.rootOrder) {
      if (aliasSub === clean || !aliasSub.startsWith(prefix)) continue
      const seg = aliasSub.slice(prefix.length).split("/")[0]
      if (seg && !names.includes(seg)) names.push(seg)
    }
    return names
  }

  /** F-462：clean 是否为某些多段 aliasSub 的中间目录 */
  private isSyntheticDir(clean: string): boolean {
    const prefix = clean === "/" ? "/" : `${clean}/`
    return this.rootOrder.some(
      (aliasSub) => aliasSub !== clean && aliasSub.startsWith(prefix),
    )
  }

  private syntheticItem(dirName: string, parent: string): FileItem {
    const childPath =
      parent === "/" ? `/${dirName}` : `${parent}/${dirName}`
    return {
      name: dirName,
      size: 0,
      is_dir: true,
      modified: new Date().toISOString(),
      sign: childPath,
      type: 1,
      raw_url: "",
    }
  }

  async list(virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const clean = this.cleanPath(physicalPath)
    const { listItems } = await import("../../internal/op/storage")

    const targets = this.getTargetsForPath(physicalPath)
    const synthetic = this.syntheticChildren(clean)
    if (targets.length === 0 && synthetic.length === 0) {
      return []
    }

    const mergedMap = new Map<string, FileItem>()

    for (const target of targets) {
      try {
        const res = await listItems(target.targetFullPath)
        for (const item of res.content) {
          if (!mergedMap.has(item.name)) {
            mergedMap.set(item.name, item)
          }
        }
      } catch (e) {
        console.warn(
          `[Alias] listing target ${target.targetFullPath} warning:`,
          e,
        )
      }
    }

    // F-462：补齐多段 aliasSub 的中间目录，使整棵别名树可导航。
    for (const dirName of synthetic) {
      if (!mergedMap.has(dirName)) {
        mergedMap.set(dirName, this.syntheticItem(dirName, clean))
      }
    }

    const items = Array.from(mergedMap.values())
    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(virtualPath: string, physicalPath: string): Promise<FileItem> {
    const clean = this.cleanPath(physicalPath)
    const name = clean.split("/").filter(Boolean).pop() || "root"

    // 存储根永远是目录。
    if (clean === "/") {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "/",
        type: 1,
        raw_url: "",
      }
    }

    const targets = this.getTargetsForPath(physicalPath)
    if (targets.length > 0) {
      const { getItem } = await import("../../internal/op/storage")

      let lastError: unknown
      for (const target of targets) {
        try {
          const res = await getItem(target.targetFullPath)
          if (res?.item) {
            return {
              ...res.item,
              raw_url: res.item.raw_url || res.rawUrl,
            }
          }
        } catch (e) {
          lastError = e
        }
      }
      // F-463：映射存在但所有候选都失败时必须上报，不能伪装成 0 字节文件。
      if (lastError) throw lastError
    }

    // F-462：中间目录按目录语义返回，不再报成文件。
    if (this.isSyntheticDir(clean)) {
      return this.syntheticItem(name, this.parentPath(clean))
    }

    // F-463：无法映射的路径抛 not found，让上层返回 404。
    throw new Error(`[Alias] '${clean}' not found`)
  }

  async mkdir(virtualPath: string, physicalPath: string): Promise<void> {
    const targets = this.getTargetsForPath(physicalPath)
    if (targets.length === 0) {
      throw new Error(`[Alias] no target found for path ${physicalPath}`)
    }
    const { makeDirectory } = await import("../../internal/op/storage")
    await makeDirectory(targets[0].targetFullPath)
  }

  async rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const targets = this.getTargetsForPath(physicalPath)
    if (targets.length === 0) {
      throw new Error(`[Alias] no target found for path ${physicalPath}`)
    }
    const { renameItem } = await import("../../internal/op/storage")
    await renameItem(targets[0].targetFullPath, newName)
  }

  async remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    // physicalPath 是目标项自身的路径（op/storage.ts removeItems 逐项调用），
    // 而 removeItems 需要「父目录 + names」（内部会再拼 name）；直接把项路径
    // 当目录传入会得到 <item>/<name>，目标不存在导致删除静默失败。
    const dirPath = this.parentPath(physicalPath)
    const targets = this.getTargetsForPath(dirPath)
    if (targets.length === 0) return
    const { removeItems } = await import("../../internal/op/storage")
    await removeItems(targets[0].targetFullPath, names)
  }

  async move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // srcPhys/dstPhys 是源/目标项自身的路径（已含 name），moveItems 需要的
    // 是各自所在父目录（内部会再拼 name）；传项路径会得到 <item>/<name>，
    // 操作静默失败。
    const srcDirPath = this.parentPath(srcPhys)
    const dstDirPath = this.parentPath(dstPhys)
    const srcTargets = this.getTargetsForPath(srcDirPath)
    const dstTargets = this.getTargetsForPath(dstDirPath)
    if (srcTargets.length === 0 || dstTargets.length === 0) {
      throw new Error("[Alias] cannot resolve source or destination path")
    }
    const { moveItems } = await import("../../internal/op/storage")
    await moveItems(
      srcTargets[0].targetFullPath,
      dstTargets[0].targetFullPath,
      names,
    )
  }

  async copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // 同 move：srcPhys/dstPhys 是项自身路径，copyItems 需要各自所在父目录。
    const srcDirPath = this.parentPath(srcPhys)
    const dstDirPath = this.parentPath(dstPhys)
    const srcTargets = this.getTargetsForPath(srcDirPath)
    const dstTargets = this.getTargetsForPath(dstDirPath)
    if (srcTargets.length === 0 || dstTargets.length === 0) {
      throw new Error("[Alias] cannot resolve source or destination path")
    }
    const { copyItems } = await import("../../internal/op/storage")
    await copyItems(
      srcTargets[0].targetFullPath,
      dstTargets[0].targetFullPath,
      names,
    )
  }

  async put(
    virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const targets = this.getTargetsForPath(physicalPath)
    if (targets.length === 0) {
      throw new Error(`[Alias] no target found for upload path ${physicalPath}`)
    }
    const { putItem } = await import("../../internal/op/storage")
    await putItem(targets[0].targetFullPath, content)
  }
}
