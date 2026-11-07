/**
 * 蓝奏云辅助工具函数：
 * - 阿里云 WAF 防火墙 (acw_sc__v2) 纯 TS 自动求解
 * - 中文相对时间与文件大小解析
 * - HTML / JS 动态变量与表单提取
 */

import { escapeRegExp } from "../../pkg/path"

const timeSplitReg = /([0-9.]*)\s*([\u4e00-\u9fa5]+)/
const sizeSplitReg = /([0-9.]+)\s*([bkm]+)/i
const findAcwScV2Reg = /arg1='([0-9A-Z]+)'/i
const findDataReg = /data[:\s]+({[^}]+})/
const findKVReg = /'(.+?)':('?([^' },]*)'?)/g

/**
 * 解析蓝奏云的各种中文时间格式
 */
export function mustParseTime(str: string): string {
  if (!str) return new Date().toISOString()
  const trimmed = str.trim()

  // 尝试标准日期格式 YYYY-MM-DD
  const directDate = new Date(trimmed)
  if (!isNaN(directDate.getTime())) {
    return directDate.toISOString()
  }

  const now = Date.now()
  const DAY_MS = 86400000

  const match = trimmed.match(timeSplitReg)
  if (match) {
    const unit = match[2]
    // 「半小时前」之类没有数字前缀：按 0.5 处理，而不是当成 0（F-161）
    const parsed = parseFloat(match[1])
    const val = Number.isFinite(parsed) ? parsed : unit.startsWith("半") ? 0.5 : 0

    // 顺序敏感（F-161）：「昨天」「前天」都包含「天」，必须先于「天」判断；
    // 「分」也必须先于「小时」，否则「半小时前」会被当成 0 小时。
    if (unit.includes("秒前")) {
      return new Date(now - val * 1000).toISOString()
    } else if (unit.includes("昨天")) {
      return new Date(now - DAY_MS).toISOString()
    } else if (unit.includes("前天")) {
      return new Date(now - DAY_MS * 2).toISOString()
    } else if (unit.includes("分")) {
      return new Date(now - val * 60000).toISOString()
    } else if (unit.includes("小时")) {
      return new Date(now - val * 3600000).toISOString()
    } else if (unit.includes("天")) {
      return new Date(now - val * DAY_MS).toISOString()
    }
  }

  return new Date().toISOString()
}

/**
 * 将蓝奏云大小字符串（如 "12.5 M", "500 K", "1024 B"）转换为字节数值
 */
export function sizeStrToInt64(sizeStr: string): number {
  if (!sizeStr) return 0
  const match = sizeStr.trim().match(sizeSplitReg)
  if (!match) return 0

  const s = parseFloat(match[1])
  const unit = match[2].toUpperCase()

  switch (unit) {
    case "B":
      return Math.floor(s)
    case "K":
      return Math.floor(s * 1024)
    case "M":
      return Math.floor(s * 1048576)
    case "G":
      return Math.floor(s * 1073741824)
    default:
      return 0
  }
}

/**
 * 移除 JS 注释（字符串字面量感知）。
 *
 * F-160：旧实现逐字符扫描、没有字符串字面量意识——页面里
 * `<iframe src="https://xxx.lanzou.com/fn?abc">` 中的 `//` 会被当成单行
 * 注释起点，自 `https:` 起整行被删掉，后续 iframe / fn 链接提取全部失效。
 * 这里维护单引号/双引号/反引号/转义状态，位于字符串内部时不再识别注释。
 */
function stripComments(data: string): string {
  let result = ""
  let inBlockComment = false
  let inLineComment = false
  let quote: "" | "'" | '"' | "`" = ""

  for (let i = 0; i < data.length; i++) {
    const v = data[i]

    if (inLineComment) {
      if (v === "\n" || v === "\r") {
        inLineComment = false
        result += v
      }
      continue
    }
    if (inBlockComment) {
      if (v === "*" && i + 1 < data.length && data[i + 1] === "/") {
        inBlockComment = false
        i++
      }
      continue
    }
    if (quote) {
      result += v
      if (v === "\\") {
        // 保留转义序列的下一个字符，避免 \" 被误判为字符串结束
        if (i + 1 < data.length) {
          result += data[i + 1]
          i++
        }
        continue
      }
      if (v === quote) quote = ""
      continue
    }
    if (v === "'" || v === '"' || v === "`") {
      quote = v
      result += v
      continue
    }
    if (v === "/" && i + 1 < data.length) {
      const nextChar = data[i + 1]
      if (nextChar === "*") {
        inBlockComment = true
        i++
        continue
      } else if (nextChar === "/") {
        inLineComment = true
        i++
        continue
      }
    }
    result += v
  }

  return result
}

/**
 * 移除 HTML 注释与 JS 注释
 */
export function removeNotes(html: string): string {
  return stripComments(html.replace(/<!--[\s\S]*?-->/g, "\n"))
}

/**
 * 移除 JS 注释（保留字符串字面量中的 `//`，见 F-160）
 */
export function removeJSComment(data: string): string {
  return stripComments(data)
}

function unbox(hexStr: string): string {
  const box = [
    6, 28, 34, 31, 33, 18, 30, 23, 9, 8, 19, 38, 17, 24, 0, 5, 32, 21, 10, 22,
    25, 14, 15, 3, 16, 27, 13, 35, 2, 29, 11, 26, 4, 36, 1, 39, 37, 7, 20, 12,
  ]
  const newBox: string[] = new Array(hexStr.length).fill("")
  for (let i = 0; i < box.length; i++) {
    const targetIdx = box[i]
    if (targetIdx < newBox.length && i < hexStr.length) {
      newBox[targetIdx] = hexStr[i]
    }
  }
  return newBox.join("")
}

function hexXor(hex1: string, hex2: string): string {
  const len = Math.min(hex1.length, hex2.length)
  const byteLen = Math.floor(len / 2)
  let res = ""
  for (let i = 0; i < byteLen; i++) {
    const b1 = parseInt(hex1.slice(i * 2, i * 2 + 2), 16)
    const b2 = parseInt(hex2.slice(i * 2, i * 2 + 2), 16)
    const xor = b1 ^ b2
    res += xor.toString(16).padStart(2, "0")
  }
  return res
}

/**
 * 判断响应是否为阿里云盾 acw_sc__v2 WAF 挑战页。
 *
 * F-163：旧实现只做 `body.includes("acw_sc__v2")` 裸子串判断，任何提到该
 * 名字的正常响应（脚本、帮助文本）都会被当成挑战页去求解并抛错。真正的
 * 挑战页一定带有 `arg1='<HEX>'` 参数，必须两者同时成立。
 */
export function isAcwScV2Challenge(html: string): boolean {
  return html.includes("acw_sc__v2") && findAcwScV2Reg.test(html)
}

/**
 * 自动计算阿里云盾 WAF (acw_sc__v2) 挑战响应 Cookie
 */
export function calcAcwScV2(htmlContent: string): string {
  const match = htmlContent.match(findAcwScV2Reg)
  if (!match || match.length < 2) {
    throw new Error("[Lanzou] 无法匹配到 acw_sc__v2 的 arg1 参数")
  }
  const arg1 = match[1]
  const mask = "3000176000856006061501533003690027800375"
  return hexXor(unbox(arg1), mask)
}

function findJSVarFunc(key: string, data: string): string {
  if (!key || !data) return ""
  // 页面可能先 var key = '' 再 var key = '真实值'（覆盖式赋值），
  // 必须取最后一个非空匹配，而不是第一个匹配
  const takeLastNonEmpty = (
    matches: RegExpMatchArray[],
  ): string => {
    for (let i = matches.length - 1; i >= 0; i--) {
      const v = (matches[i][1] || "").trim().replace(/^['"]|['"]$/g, "")
      if (v) return v
    }
    return ""
  }

  if (key !== "sasign") {
    // key 来自远端 HTML（不可信）：必须按字面量转义后再拼进 RegExp，
    // 否则 `(a+)+$` 之类的值会变成灾难性回溯模式，或直接让正则构造抛错。
    const keyLiteral = escapeRegExp(key)
    // 1. var key = 'val'; or let key = "val"; or const key = val;
    const matches1 = Array.from(
      data.matchAll(
        new RegExp(
          `(?:var|let|const)\\s+${keyLiteral}\\s*=\\s*['"]?([\\s\\S]*?)['"]?;`,
          "gi",
        ),
      ),
    )
    if (matches1.length) {
      const v = takeLastNonEmpty(matches1)
      if (v) return v
    }

    // 2. key = 'val';
    const matches2 = Array.from(
      data.matchAll(
        new RegExp(
          `(?:^|[;,\\s])${keyLiteral}\\s*=\\s*['"]?([\\s\\S]*?)['"]?;`,
          "gim",
        ),
      ),
    )
    if (matches2.length) {
      const v = takeLastNonEmpty(matches2)
      if (v) return v
    }

    // 3. 'key' : 'val'
    const matches3 = Array.from(
      data.matchAll(
        new RegExp(
          `['"]?${keyLiteral}['"]?\\s*:\\s*['"]?([\\s\\S]*?)['"]?`,
          "gi",
        ),
      ),
    )
    if (matches3.length) {
      const v = takeLastNonEmpty(matches3)
      if (v) return v
    }
  } else {
    const matches = Array.from(
      data.matchAll(
        new RegExp(
          `(?:var|let|const)?\\s*${escapeRegExp(key)}\\s*=\\s*['"]?([\\s\\S]*?)['"]?;`,
          "gi",
        ),
      ),
    )
    if (matches.length === 3) {
      return matches[1][1].trim().replace(/^['"]|['"]$/g, "")
    } else if (matches.length > 0) {
      return takeLastNonEmpty(matches)
    }
  }
  return ""
}

function jsonToMap(data: string, html: string): Record<string, string> {
  const param: Record<string, string> = {}
  // Matches: 'key':'val', key:'val', 'key':varName, "key":"val", etc.
  const kvRegex = /['"]?([a-zA-Z0-9_$]+)['"]?\s*:\s*(['"]?([^'",}\s]+)['"]?)/g
  const matches = data.matchAll(kvRegex)
  for (const kv of matches) {
    const k = kv[1]
    const rawVal = kv[2]
    const v = kv[3]
    if (!v) {
      param[k] = ""
    } else if (
      rawVal.includes("'") ||
      rawVal.includes('"') ||
      /^\d+$/.test(rawVal)
    ) {
      param[k] = v
    } else {
      const resolved = findJSVarFunc(v, html)
      param[k] = resolved !== "" ? resolved : v
    }
  }
  return param
}

/** decodeURIComponent 的安全版本：非法 % 序列原样返回而不是抛 URIError（F-162） */
function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function formToMap(formData: string): Record<string, string> {  const param: Record<string, string> = {}
  const pairs = formData.split("&")
  for (const pair of pairs) {
    // F-162：值本身可能含 "="（base64 padding），只能按**第一个** = 截断
    const eq = pair.indexOf("=")
    const rawKey = eq === -1 ? pair : pair.slice(0, eq)
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1)
    if (!rawKey) continue
    // F-162：非法 % 序列不能炸掉整个 get()
    param[safeDecodeURIComponent(rawKey)] = safeDecodeURIComponent(rawValue)
  }
  return param
}

/** 仅用于单测：暴露 formToMap（F-162） */
export function formToMapForTest(formData: string): Record<string, string> {
  return formToMap(formData)
}

/**
 * 解析 HTML 中内嵌的 data: { ... } 对象或 data : '...' 表单字符串并解析变量
 */
export function htmlJsonToMap(
  html: string,
  fullHtml?: string,
): Record<string, string> {
  const contextHtml = fullHtml || html
  // 1. 尝试匹配最长 data : { ... } 对象
  const dataMatches = Array.from(html.matchAll(/data\s*:\s*({[\s\S]*?})/g))
  if (dataMatches.length > 0) {
    let bestMatch = dataMatches[0][1]
    for (const m of dataMatches) {
      if (m[1].length > bestMatch.length) {
        bestMatch = m[1]
      }
    }
    const res = jsonToMap(bestMatch, contextHtml)
    if (Object.keys(res).length > 0) {
      return res
    }
  }

  // 2. 尝试匹配 data : 'key=val&...' 字符串
  const formMatch = html.match(/data\s*:\s*['"]([^'"]+)['"]/)
  if (formMatch && formMatch[1].includes("=")) {
    return formToMap(formMatch[1])
  }

  throw new Error("[Lanzou] 未能找到请求参数 data 对象")
}

/**
 * 查找并提取 HTML 中的指定 JS 函数源码
 */
export function getJSFunctionByName(html: string, name: string): string {
  const fnReg = new RegExp(
    `function\\s+${escapeRegExp(name)}\\s*\\([^)]*\\)\\s*\\{`,
    "i",
  )
  const match = html.search(fnReg)
  if (match === -1) {
    throw new Error(`[Lanzou] 未找到函数 ${name}`)
  }

  let count = 0
  let start = -1
  for (let i = match; i < html.length; i++) {
    if (html[i] === "{") {
      if (count === 0) start = i
      count++
    } else if (html[i] === "}") {
      count--
      if (count === 0) {
        return html.slice(match, i + 1)
      }
    }
  }
  return html.slice(match)
}
