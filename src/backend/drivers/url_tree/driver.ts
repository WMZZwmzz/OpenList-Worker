// UrlTree driver — 从 url_structure 文本构建虚拟文件树，文件内容为 URL 直链
// 移植自 OpenList Go 版 drivers/url_tree。
//
// 文本结构（每行缩进 2 空格表示一级）：
//   FolderName:
//     [FileName:][FileSize:][Modified:]Url
// 无名称时用 URL 最后一段作为文件名。
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { assertSafeUrl, safeRedirectUrl } from "../../pkg/http"
import { UrlTreeAddition, UrlTreeNode } from "./types"

// ---- 树构建 ----

function parseFileLine(line: string): UrlTreeNode {
  const httpIdx = line.indexOf("http://")
  const httpsIdx = line.indexOf("https://")
  // 取两者中更早出现的下标：`https://x/?u=http://y` 的 https 才是 URL 起点。
  const candidates = [httpIdx, httpsIdx].filter((i) => i >= 0)
  const idx = candidates.length > 0 ? Math.min(...candidates) : -1
  if (idx < 0) {
    throw new Error(`invalid line: ${line}, because url is required for file`)
  }
  const url = line.slice(idx)
  const info = line.slice(0, idx)
  const node: UrlTreeNode = {
    url,
    name: "",
    level: 0,
    modified: 0,
    size: 0,
    children: [],
  }

  if (idx > 0) {
    if (!info.endsWith(":")) {
      throw new Error(`invalid line: ${line}, file info must end with ':'`)
    }
    const trimmed = info.slice(0, -1)
    if (!trimmed) {
      throw new Error(`invalid line: ${line}, file name can't be empty`)
    }
    const parts = trimmed.split(":")
    node.name = parts[0]
    if (parts.length > 1) {
      const size = parseInt(parts[1], 10)
      if (Number.isNaN(size)) {
        throw new Error(`invalid line: ${line}, file size must be an integer`)
      }
      node.size = size
      if (parts.length > 2) {
        const modified = parseInt(parts[2], 10)
        if (Number.isNaN(modified)) {
          throw new Error(
            `invalid line: ${line}, modified must be a unix timestamp`,
          )
        }
        node.modified = modified
      }
    }
  } else {
    // 无名称：用 URL 最后一段
    const u = new URL(url)
    const segs = u.pathname.split("/").filter(Boolean)
    node.name = segs[segs.length - 1] || url
  }
  return node
}

function buildTree(text: string): UrlTreeNode {
  const root: UrlTreeNode = {
    url: "",
    name: "root",
    level: -1,
    modified: 0,
    size: 0,
    children: [],
  }
  const stack: UrlTreeNode[] = [root]
  const lines = String(text || "").split("\n")
  for (const rawLine of lines) {
    let indent = 0
    while (indent < rawLine.length && rawLine[indent] === " ") indent++
    if (indent % 2 !== 0) {
      throw new Error(`the line '${rawLine}' indent is not a multiple of 2`)
    }
    const level = indent / 2
    const line = rawLine.slice(indent).trim()
    if (!line) continue
    // 回退到父级
    while (level <= stack[stack.length - 1].level) {
      stack.pop()
    }
    if (line.endsWith(":")) {
      const node: UrlTreeNode = {
        url: "",
        name: line.slice(0, -1),
        level,
        modified: 0,
        size: 0,
        children: [],
      }
      stack[stack.length - 1].children.push(node)
      stack.push(node)
    } else {
      const node = parseFileLine(line)
      node.level = level
      stack[stack.length - 1].children.push(node)
    }
  }
  return root
}

/** 递归重设节点及其全部子孙的 level（stringifyTree 依赖绝对 level 生成缩进） */
function setLevelRecursive(node: UrlTreeNode, level: number): void {
  node.level = level
  for (const child of node.children) setLevelRecursive(child, level + 1)
}

function calcSize(node: UrlTreeNode): number {
  if (node.url) return node.size
  let size = 0
  for (const child of node.children) size += calcSize(child)
  node.size = size
  return size
}

function stringifyTree(root: UrlTreeNode): string {
  const walk = (node: UrlTreeNode): string => {
    if (node.level === -1) {
      return node.children.map(walk).join("\n")
    }
    const indent = "  ".repeat(node.level)
    if (!node.url) {
      const children = node.children.map(walk).join("\n")
      return `${indent}${node.name}:${children ? "\n" + children : ""}`
    }
    const base = new URL(node.url)
    const baseName = base.pathname.split("/").filter(Boolean).pop() || ""
    if (node.size === 0 && node.modified === 0) {
      return `${indent}${baseName === node.name ? node.url : `${node.name}:${node.url}`}`
    }
    let info = node.name
    if (node.size !== 0 || node.modified !== 0) info += `:${node.size}`
    if (node.modified !== 0) info += `:${node.modified}`
    return `${indent}${info}:${node.url}`
  }
  return walk(root)
}

function splitPath(path: string): string[] {
  if (path === "/" || !path) return ["root"]
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean)
  return ["root", ...parts]
}

function getNodeByPath(root: UrlTreeNode, path: string): UrlTreeNode | null {
  const segs = splitPath(path) // ["root", ...]
  let node: UrlTreeNode | null = root
  for (let i = 0; i < segs.length; i++) {
    if (!node) return null
    if (node.name !== segs[i]) return null
    if (i === segs.length - 1) return node
    let found: UrlTreeNode | null = null
    for (const child of node.children) {
      if (child.name === segs[i + 1]) {
        found = child
        break
      }
    }
    node = found
  }
  return node
}

async function getSizeFromUrl(url: string): Promise<number> {
  try {
    assertSafeUrl(url, "UrlTree head_size")
    // redirect:follow 会绕过 assertSafeUrl（只校验初始 URL），
    // 必须手动跟随并用 safeRedirectUrl 校验每一跳目标。
    let current = url
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(current, { method: "HEAD", redirect: "manual" })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("Location")
        if (!location) return 0
        const next = safeRedirectUrl(location, current)
        if (!next) return 0
        current = next
        continue
      }
      if (!res.ok) return 0
      const len = parseInt(res.headers.get("Content-Length") || "0", 10)
      return Number.isFinite(len) ? len : 0
    }
    return 0
  } catch {
    return 0
  }
}

// ---- 驱动 ----

export class UrlTreeDriver implements StorageDriver {
  private addition: UrlTreeAddition
  private root: UrlTreeNode
  private onUpdate?: (urlStructure: string) => void

  constructor(
    addition: UrlTreeAddition,
    onUpdate?: (urlStructure: string) => void,
  ) {
    this.addition = addition || {}
    this.root = buildTree(this.addition.url_structure || "")
    calcSize(this.root)
    this.onUpdate = onUpdate
  }

  async init(): Promise<void> {
    if (!this.addition.url_structure || !this.addition.url_structure.trim()) {
      throw new Error("[UrlTree] url_structure is required")
    }
  }

  private persist(): void {
    if (!this.addition.writable) return
    this.addition.url_structure = stringifyTree(this.root)
    if (this.onUpdate) {
      try {
        this.onUpdate(this.addition.url_structure)
      } catch {}
    }
  }

  private nodeToFileItem(node: UrlTreeNode, path: string): FileItem {
    const isDir = !node.url
    return {
      name: node.name,
      size: node.size,
      is_dir: isDir,
      modified: node.modified
        ? new Date(node.modified * 1000).toISOString()
        : new Date().toISOString(),
      sign: "",
      thumb: "",
      type: calcFileType(node.name, isDir),
      raw_url: isDir ? "" : node.url,
    }
  }

  async list(_v: string, physicalPath: string): Promise<FileItem[]> {
    const node = getNodeByPath(this.root, physicalPath)
    if (!node) throw new Error(`[UrlTree] path not found: ${physicalPath}`)
    if (node.url) throw new Error(`[UrlTree] not a folder: ${physicalPath}`)
    const items = node.children.map((child) =>
      this.nodeToFileItem(
        child,
        `${physicalPath.replace(/\/+$/, "")}/${child.name}`,
      ),
    )
    return sortFileItems(items, "name", "asc")
  }

  async get(_v: string, physicalPath: string): Promise<FileItem> {
    const node = getNodeByPath(this.root, physicalPath)
    if (!node) throw new Error(`[UrlTree] path not found: ${physicalPath}`)
    return this.nodeToFileItem(node, physicalPath)
  }

  async mkdir(_v: string, physicalPath: string): Promise<void> {
    if (!this.addition.writable) throw new Error("[UrlTree] not writable")
    const segs = splitPath(physicalPath)
    const name = segs[segs.length - 1]
    const parent = getNodeByPath(this.root, "/" + segs.slice(1, -1).join("/"))
    if (!parent || parent.url) throw new Error("[UrlTree] parent not found")
    parent.children.push({
      url: "",
      name,
      level: parent.level + 1,
      modified: 0,
      size: 0,
      children: [],
    })
    this.persist()
  }

  async rename(
    _v: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    if (!this.addition.writable) throw new Error("[UrlTree] not writable")
    const node = getNodeByPath(this.root, physicalPath)
    if (!node) throw new Error("[UrlTree] path not found")
    node.name = newName
    this.persist()
  }

  async remove(
    _v: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    if (!this.addition.writable) throw new Error("[UrlTree] not writable")
    const segs = splitPath(physicalPath)
    const name = segs[segs.length - 1]
    const parent = getNodeByPath(this.root, "/" + segs.slice(1, -1).join("/"))
    if (!parent) throw new Error("[UrlTree] parent not found")
    parent.children = parent.children.filter((c) => c.name !== name)
    calcSize(this.root)
    this.persist()
  }

  async move(
    _s: string,
    _d: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    if (!this.addition.writable) throw new Error("[UrlTree] not writable")
    const srcParent = getNodeByPath(
      this.root,
      "/" + splitPath(srcPhys).slice(1, -1).join("/"),
    )
    const dstParent = getNodeByPath(
      this.root,
      "/" + splitPath(dstPhys).slice(1, -1).join("/"),
    )
    if (!srcParent || !dstParent || dstParent.url)
      throw new Error("[UrlTree] invalid path")
    for (const name of names) {
      const idx = srcParent.children.findIndex((c) => c.name === name)
      if (idx < 0) continue
      const [node] = srcParent.children.splice(idx, 1)
      // 子孙节点也必须同步重设 level：持久化文本按 node.level 缩进，
      // 只改自身会让子项缩进停留在旧深度，重新加载后挂到错误的父级。
      setLevelRecursive(node, dstParent.level + 1)
      dstParent.children.push(node)
    }
    calcSize(this.root)
    this.persist()
  }

  async copy(
    _s: string,
    _d: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    if (!this.addition.writable) throw new Error("[UrlTree] not writable")
    const srcParent = getNodeByPath(
      this.root,
      "/" + splitPath(srcPhys).slice(1, -1).join("/"),
    )
    const dstParent = getNodeByPath(
      this.root,
      "/" + splitPath(dstPhys).slice(1, -1).join("/"),
    )
    if (!srcParent || !dstParent || dstParent.url)
      throw new Error("[UrlTree] invalid path")
    for (const name of names) {
      const src = srcParent.children.find((c) => c.name === name)
      if (!src) continue
      dstParent.children.push(this.deepCopy(src, dstParent.level + 1))
    }
    calcSize(this.root)
    this.persist()
  }

  async put(_v: string, physicalPath: string, content: Buffer): Promise<void> {
    if (!this.addition.writable) throw new Error("[UrlTree] not writable")
    // put 的内容应是一行 URL 定义（name:url）
    const line = content.toString("utf8").trim()
    const parent = getNodeByPath(
      this.root,
      "/" + splitPath(physicalPath).slice(1, -1).join("/"),
    )
    if (!parent || parent.url) throw new Error("[UrlTree] parent not found")
    const name = physicalPath.split("/").filter(Boolean).pop() || "file"
    // 覆盖上传：同名文件必须原地替换（putItem 语义是上传/覆盖），
    // 追加新节点会让 getNodeByPath 继续命中旧节点、覆盖静默失效并污染树。
    const existing = parent.children.find((c) => c.name === name)
    if (existing && !existing.url) {
      throw new Error(`[UrlTree] cannot overwrite directory: ${physicalPath}`)
    }
    const node = parseFileLine(`${name}:${line}`)
    node.level = parent.level + 1
    if (this.addition.head_size) {
      node.size = await getSizeFromUrl(node.url)
    }
    if (existing) {
      existing.url = node.url
      existing.size = node.size
      existing.modified = node.modified
    } else {
      parent.children.push(node)
    }
    calcSize(this.root)
    this.persist()
  }

  private deepCopy(node: UrlTreeNode, level: number): UrlTreeNode {
    return {
      url: node.url,
      name: node.name,
      level,
      modified: node.modified,
      size: node.size,
      children: node.children.map((c) => this.deepCopy(c, level + 1)),
    }
  }
}
