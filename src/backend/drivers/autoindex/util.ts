// AutoIndex utility functions
import * as xpath from "xpath"
import { DOMParser } from "@xmldom/xmldom"
import { parse, serialize } from "parse5"
import { AutoIndexNode } from "./types"

/**
 * 从 xpath.select 的返回中提取字符串值。
 * xpath 库对 string()/number() 等表达式返回原始值（string/number），
 * 对 node-set 表达式返回数组。这里统一兼容两种情况。
 */
function extractXPathValue(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw.trim() || undefined
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw)
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0] as any
    const v = (first?.nodeValue ?? first?.textContent ?? "").trim()
    return v || undefined
  }
  return undefined
}

// 将宽松 HTML 清洗为可被 XML 解析器（xmldom）解析的良构 XML：
// 1) 先用 parse5 按 HTML5 容错规则修复未闭合/错位/重复标签；
// 2) 移除 XML 不需要的 DOCTYPE、注释和 script/style；
// 3) 把 void 标签（<hr>/<meta>/<br> 等）转为自闭合。
//
// 不能直接把远端 HTML 交给 xmldom 的 XML 模式：真实目录页常包含浏览器可以
// 正常处理的非严格 HTML。例如 archive.apache.org/dist/tomcat/ 同时有重复的
// html/body/pre 标签，旧实现会抛 "Opening and ending tag mismatch"。parse5 与
// Go 版 htmlquery 底层的 HTML parser 一样会容错，再转 XML 后仍可继续使用用户
// 配置的无前缀 XPath（如 //pre/a）。
//
// 注意：若直接用 xmldom 的 text/html 模式，它会注入 XHTML 命名空间，导致
// //pre/a 匹配不到。
const HTML_VOID_TAGS =
  "area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr"

function htmlToXml(html: string): string {
  let s = serialize(parse(html))
  s = s.replace(/<!DOCTYPE[^>]*>/gi, "")
  s = s.replace(/<!--[\s\S]*?-->/g, "")
  // script/style 的 raw text 可以包含 XML 非法的裸 <、&；AutoIndex XPath 不会
  // 依赖这些内容，移除可避免第二阶段 XML 解析被无关脚本或样式破坏。
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  s = s.replace(
    new RegExp(`<(${HTML_VOID_TAGS})([^>]*?)/?\\s*>`, "gi"),
    "<$1$2/>",
  )
  return s
}

export function parseAutoIndexHTML(
  html: string,
  itemXPath: string,
  nameXPath: string,
  sizeXPath: string,
  modifiedXPath: string,
  ignoreNames: string[],
): AutoIndexNode[] {
  // @xmldom/xmldom >= 0.9 已废弃 errorHandler，改用 onError 回调
  const doc = new DOMParser({
    onError: () => {},
  }).parseFromString(htmlToXml(html), "text/xml")

  const items = xpath.select(itemXPath, doc as unknown as Node) as Node[]
  const result: AutoIndexNode[] = []

  for (const item of items) {
    try {
      const nameNodes = xpath.select(nameXPath, item) as Node[]
      if (nameNodes.length === 0) continue

      const nameNode = nameNodes[0]
      let name = ""
      let url = ""

      if (nameNode.nodeType === 1) {
        // Element node
        const element = nameNode as Element
        name = element.textContent?.trim() || ""
        url = element.getAttribute("href") || ""
      } else if (nameNode.nodeType === 2) {
        // Attribute node
        const attr = nameNode as Attr
        name = attr.value.trim()
        url = attr.value
      } else {
        name = nameNode.textContent?.trim() || ""
      }

      // 与 Go 一致：先 CutSuffix 去掉目录尾斜杠，再判断是否命中忽略列表
      const isDir = name.endsWith("/")
      if (isDir) {
        name = name.slice(0, -1)
      }

      if (!name || ignoreNames.includes(name)) continue

      const size = extractXPathValue(xpath.select(sizeXPath, item))
      const modified = extractXPathValue(xpath.select(modifiedXPath, item))

      result.push({
        name,
        url,
        isDir,
        size,
        modified,
      })
    } catch (e) {
      // Skip invalid items
    }
  }

  return result
}

// 与 Go 侧 units 映射对齐（支持 KiB/MiB/GiB/TiB/PiB、KB/MB/GB/TB/PB、bytes 等）
// 注意：不能用 `1 << 40`/`1 << 50` —— JS 位运算按 32 位取模，`1 << 40 === 256`、
// `1 << 50 === 262144`，TB/PB 单位会被算成 KB 级假大小（F-379）。
const KiB = 1024
const MiB = KiB * 1024
const GiB = MiB * 1024
const TiB = GiB * 1024
const PiB = TiB * 1024

const sizeUnits: Record<string, number> = {
  "": 1,
  b: 1,
  byte: 1,
  bytes: 1,
  k: KiB,
  kb: KiB,
  kib: KiB,
  m: MiB,
  mb: MiB,
  mib: MiB,
  g: GiB,
  gb: GiB,
  gib: GiB,
  t: TiB,
  tb: TiB,
  tib: TiB,
  p: PiB,
  pb: PiB,
  pib: PiB,
}

function splitUnit(s: string): [string, string] {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] >= "0" && s[i] <= "9") {
      return [s.slice(0, i + 1).trim(), s.slice(i + 1).trim()]
    }
  }
  return ["", s]
}

export function parseSize(sizeStr: string): number {
  if (!sizeStr || sizeStr.trim() === "-") return 0
  const s = sizeStr.trim()
  const [numStr, unitStr] = splitUnit(s)
  const unit = unitStr.toLowerCase()
  const mul = sizeUnits[unit] ?? 1
  const num = parseFloat(numStr)
  if (isNaN(num)) return 0
  return Math.round(num * mul)
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
]

/** Go time layout 记号 → 正则片段（按长度降序匹配，避免 "2006" 被 "2" 抢先） */
const GO_LAYOUT_TOKENS: Array<[string, string]> = [
  ["January", "([A-Za-z]+)"],
  ["2006", "(\\d{4})"],
  ["Z07:00", "([+-]\\d{2}:\\d{2})"],
  ["Z0700", "([+-]\\d{4})"],
  ["-07:00", "([+-]\\d{2}:\\d{2})"],
  ["-0700", "([+-]\\d{4})"],
  ["Monday", "([A-Za-z]+)"],
  ["Jan", "([A-Za-z]{3})"],
  ["Mon", "([A-Za-z]{3})"],
  ["MST", "([A-Za-z]{2,5})"],
  ["_2", "(\\s?\\d{1,2})"],
  ["15", "(\\d{2})"],
  ["04", "(\\d{2})"],
  ["05", "(\\d{2})"],
  ["06", "(\\d{2})"],
  ["01", "(\\d{2})"],
  ["02", "(\\d{2})"],
  ["03", "(\\d{2})"],
  ["PM", "(AM|PM)"],
  ["pm", "(am|pm)"],
  ["1", "(\\d{1,2})"],
  ["2", "(\\d{1,2})"],
  ["3", "(\\d{1,2})"],
  ["4", "(\\d{1,2})"],
  ["5", "(\\d{1,2})"],
]

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 按 Go time layout 解析时间戳（F-380）。
 *
 * 支持常用记号：2006/06（年）、01/1/Jan/January（月）、02/2/_2（日）、
 * 15/3（时）、04/4（分）、05/5（秒）、PM/pm（上下午）、
 * -0700/Z07:00/MST（时区）。未带时区的输入按 UTC 解释（与 Go time.Parse 一致），
 * 不随宿主 TZ 漂移。解析失败返回空串。
 */
export function parseWithGoLayout(timeStr: string, layout: string): string {
  if (!timeStr || !layout) return ""
  const tokens = [...GO_LAYOUT_TOKENS].sort((a, b) => b[0].length - a[0].length)
  let pattern = "^"
  const kinds: string[] = []
  let i = 0
  while (i < layout.length) {
    const token = tokens.find((t) => layout.startsWith(t[0], i))
    if (token) {
      pattern += token[1]
      // 记录记号首字符即可区分语义（"15"/"1" 等都以数字开头，需用完整 token）
      kinds.push(token[0])
      i += token[0].length
      continue
    }
    // 连续空白视作 \s+
    if (/\s/.test(layout[i])) {
      while (i < layout.length && /\s/.test(layout[i])) i++
      pattern += "\\s+"
      continue
    }
    pattern += escapeRegExp(layout[i])
    i++
  }
  pattern += "$"

  let m: RegExpExecArray | null
  try {
    m = new RegExp(pattern).exec(timeStr.trim())
  } catch {
    return ""
  }
  if (!m) return ""
  const values = m.slice(1)

  const year: number[] = []
  const month: number[] = []
  const day: number[] = []
  const hour: number[] = []
  const minute: number[] = []
  const second: number[] = []
  let meridiem = ""
  let offsetMinutes: number | null = null

  for (let k = 0; k < kinds.length; k++) {
    const token = kinds[k]
    const raw = values[k]
    switch (token) {
      case "2006":
        year.push(parseInt(raw, 10))
        break
      case "06": {
        const yy = parseInt(raw, 10)
        year.push(yy >= 69 ? 1900 + yy : 2000 + yy)
        break
      }
      case "January":
      case "Jan": {
        const idx = MONTH_NAMES.indexOf(raw.slice(0, 3).toLowerCase())
        if (idx < 0) return ""
        month.push(idx + 1)
        break
      }
      case "01":
      case "1":
        month.push(parseInt(raw, 10))
        break
      case "02":
      case "2":
      case "_2":
        day.push(parseInt(raw.trim(), 10))
        break
      case "15":
        hour.push(parseInt(raw, 10))
        break
      case "03":
      case "3":
        hour.push(parseInt(raw, 10))
        break
      case "04":
      case "4":
        minute.push(parseInt(raw, 10))
        break
      case "05":
      case "5":
        second.push(parseInt(raw, 10))
        break
      case "PM":
      case "pm":
        meridiem = raw.toUpperCase()
        break
      case "Z07:00":
      case "-07:00":
        offsetMinutes = parseUtcOffset(raw)
        break
      case "Z0700":
      case "-0700":
        offsetMinutes = parseUtcOffset(raw)
        break
      case "MST":
        // 只有 UTC/GMT 能无歧义换算；其他缩写（CST 等）歧义太大，视为本地无区
        if (/^(utc|gmt)$/i.test(raw)) offsetMinutes = 0
        break
      default:
        break
    }
  }

  if (year.length === 0 || month.length === 0 || day.length === 0) return ""
  let h = hour.length ? hour[0] : 0
  if (meridiem === "PM" && h < 12) h += 12
  if (meridiem === "AM" && h === 12) h = 0
  const mi = minute.length ? minute[0] : 0
  const sec = second.length ? second[0] : 0
  const ms =
    Date.UTC(year[0], month[0] - 1, day[0], h, mi, sec) -
    (offsetMinutes ?? 0) * 60_000
  const d = new Date(ms)
  return isNaN(d.getTime()) ? "" : d.toISOString()
}

function parseUtcOffset(raw: string): number | null {
  const m = raw.match(/^([+-])(\d{2}):?(\d{2})$/)
  if (!m) return null
  const sign = m[1] === "-" ? -1 : 1
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10))
}

/** 显式时区标记（GMT/UTC/Z/±hh:mm）：只有这类输入才可交给 Date 解析 */
function hasExplicitTimezone(s: string): boolean {
  return /(?:GMT|UTC|Z|[+-]\d{2}:?\d{2})$/i.test(s.trim())
}

export function parseTime(timeStr: string, format: string): string {
  // 空输入没有可推断的信息，不能伪造成「当前时刻」（F-380）
  if (!timeStr || !timeStr.trim()) return ""

  // 1) 用户配置的 Go layout 优先
  if (format) {
    const byLayout = parseWithGoLayout(timeStr, format)
    if (byLayout) return byLayout
  }

  const s = timeStr.trim()

  // 2) 内置 "YYYY-MM-DD HH:MM[:SS]"：无时区标记，按 UTC 解释（与 Go time.Parse
  //    一致），避免同一远端页面在不同宿主 TZ 上得到不同 modified。
  const isoMatch = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  )
  if (isoMatch) {
    const [, year, month, day, hour, minute, second] = isoMatch
    const d = new Date(
      Date.UTC(
        parseInt(year, 10),
        parseInt(month, 10) - 1,
        parseInt(day, 10),
        parseInt(hour, 10),
        parseInt(minute, 10),
        second ? parseInt(second, 10) : 0,
      ),
    )
    if (!isNaN(d.getTime())) return d.toISOString()
  }

  // 3) 带显式时区的通用格式（RFC1123 等）交给 Date；无时区的裸串一律不猜
  if (hasExplicitTimezone(s)) {
    const parsed = new Date(s)
    if (!isNaN(parsed.getTime())) return parsed.toISOString()
  }

  // 4) 解析失败：返回空串，让上层看到「未知」而不是伪造的当前时间
  return ""
}
