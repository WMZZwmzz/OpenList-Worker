// Pure TypeScript FTP Client for OpenList
// Dynamic import for Node runtime; safe for edge packaging.

import { FTPAddition, FTPFileEntry } from "./types"
import {
  encodeFtpString,
  decodeFtpBuffer,
  normalizeEncoding,
  ensureEncodingReady,
} from "./encoding"

let netModule: any = null
let streamModule: any = null

async function getNet(): Promise<any> {
  if (typeof process === "undefined" || process.release?.name !== "node") {
    throw new Error(
      "[FTP] FTP driver requires Node.js container runtime (raw TCP sockets not available in standard Edge isolates)",
    )
  }
  if (!netModule) {
    try {
      const modName = "node:net"
      netModule = await import(/* @vite-ignore */ modName)
    } catch (e: any) {
      throw new Error(`[FTP] Failed to load net module: ${e.message}`)
    }
  }
  return netModule
}

async function getStream(): Promise<any> {
  if (!streamModule) {
    try {
      const modName = "node:stream"
      streamModule = await import(/* @vite-ignore */ modName)
    } catch (e: any) {
      throw new Error(`[FTP] Failed to load stream module: ${e.message}`)
    }
  }
  return streamModule
}

export interface ParsedHostPort {
  host: string
  port: number
}

export function parseFtpAddress(address: string): ParsedHostPort {
  const clean = (address || "").trim()
  if (!clean) return { host: "127.0.0.1", port: 21 }

  if (clean.startsWith("[")) {
    // IPv6 [::1]:21
    const closeBracket = clean.indexOf("]")
    if (closeBracket > 0) {
      const host = clean.slice(1, closeBracket)
      const rest = clean.slice(closeBracket + 1)
      const colon = rest.indexOf(":")
      const port = colon >= 0 ? parseInt(rest.slice(colon + 1), 10) || 21 : 21
      return { host, port }
    }
  }

  const parts = clean.split(":")
  // F-270：不带方括号的 IPv6 字面量（"::1"、"2001:db8::1"）按 ":" 切分会把
  // 末段当端口（::1 → host ":"、port 1）。冒号多于一个时整串视为主机，
  // 端口取默认 21。
  if (parts.length > 2) {
    return { host: clean, port: 21 }
  }
  if (parts.length === 1) {
    return { host: parts[0], port: 21 }
  }
  const port = parseInt(parts[parts.length - 1], 10)
  if (isNaN(port)) {
    return { host: clean, port: 21 }
  }
  const host = parts.slice(0, parts.length - 1).join(":")
  return { host, port: port || 21 }
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

/**
 * F-265：`ls` 对近 6 个月的文件只输出 `MMM DD HH:MM`（没有年份）。原实现
 * `Date.parse("Aug 24 10:00 UTC")` 会被 V8 当成 2001 年，几乎所有近期文件的
 * mtime 都失真。按 ls 语义补年份：先按当年，若推算落在未来 1 天之后则回退一年。
 */
function parseUnixListDate(rawDate: string, now = new Date()): Date | null {
  const match = /^([A-Za-z]{3})\s+(\d{1,2})\s+(?:(\d{4})|(\d{1,2}):(\d{2}))$/.exec(
    rawDate.trim(),
  )
  if (!match) return null
  const month = MONTH_INDEX[match[1].toLowerCase()]
  if (month === undefined) return null
  const day = parseInt(match[2], 10)
  if (match[3]) {
    return new Date(Date.UTC(parseInt(match[3], 10), month, day))
  }
  const hour = parseInt(match[4], 10)
  const minute = parseInt(match[5], 10)
  const nowYear = now.getUTCFullYear()
  let date = new Date(Date.UTC(nowYear, month, day, hour, minute))
  if (date.getTime() - now.getTime() > 24 * 3600 * 1000) {
    date = new Date(Date.UTC(nowYear - 1, month, day, hour, minute))
  }
  return date
}

/**
 * F-268：DOS/IIS 风格 `MM-DD-YY(YY) HH:MM[AM/PM]` 必须手工解析。
 * `Date.parse` 对 AM/PM 形式恒返回 NaN，原实现静默回退 `new Date()`，
 * 所有条目的 mtime 都变成「当前时刻」。
 */
function parseDosListDate(rawDate: string): Date | null {
  const match = /^(\d{2})-(\d{2})-(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec(
    rawDate.trim(),
  )
  if (!match) return null
  const month = parseInt(match[1], 10) - 1
  const day = parseInt(match[2], 10)
  let year = parseInt(match[3], 10)
  if (match[3].length === 2) {
    // 两位年份按 <70 → 2000s、否则 1900s 的惯例补全
    year += year < 70 ? 2000 : 1900
  }
  let hour = parseInt(match[4], 10)
  const minute = parseInt(match[5], 10)
  const ampm = (match[6] || "").toUpperCase()
  if (ampm) {
    if (hour === 12) hour = 0
    if (ampm === "PM") hour += 12
  }
  return new Date(Date.UTC(year, month, day, hour, minute))
}

export function parseListLine(
  line: string,
  encoding: string,
): FTPFileEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // MLSD format: type=dir;modify=20260824100000;size=1234; name
  if (trimmed.includes("type=") && trimmed.includes(";")) {
    const parts = trimmed.split(";")
    const name = parts[parts.length - 1].trim()
    if (!name || name === "." || name === "..") return null

    let is_dir = false
    let size = 0
    let modified = new Date()

    for (const part of parts.slice(0, -1)) {
      const [k, v] = part.split("=").map((s) => s.trim().toLowerCase())
      if (k === "type") {
        is_dir = v === "dir" || v === "cdir" || v === "pdir"
      } else if (k === "size") {
        size = parseInt(v, 10) || 0
      } else if (k === "modify") {
        // YYYYMMDDHHMMSS
        if (v && v.length >= 14) {
          const year = parseInt(v.slice(0, 4), 10)
          const month = parseInt(v.slice(4, 6), 10) - 1
          const day = parseInt(v.slice(6, 8), 10)
          const hour = parseInt(v.slice(8, 10), 10)
          const min = parseInt(v.slice(10, 12), 10)
          const sec = parseInt(v.slice(12, 14), 10)
          modified = new Date(Date.UTC(year, month, day, hour, min, sec))
        }
      }
    }
    return { name, size, is_dir, modified }
  }

  // Unix format: drwxr-xr-x 2 user group 4096 Jan 01 12:00 dirname
  // or -rw-r--r-- 1 user group 12345 Aug 24 10:00 filename
  const unixMatch = trimmed.match(
    /^([bcdlps-])[rwxstST-]{9}\s+\d+\s+(?:\S+\s+){1,2}(\d+)\s+([A-Za-z]{3}\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2}))\s+(.+)$/,
  )
  if (unixMatch) {
    const typeChar = unixMatch[1]
    const size = parseInt(unixMatch[2], 10) || 0
    const rawDate = unixMatch[3]
    let name = unixMatch[4]

    // Handle symlink target notation "name -> target"
    if (typeChar === "l" && name.includes(" -> ")) {
      name = name.split(" -> ")[0]
    }
    if (name === "." || name === "..") return null

    const is_dir = typeChar === "d"
    let modified = new Date()
    try {
      // F-265：无年份的 "MMM DD HH:MM" 按 ls 语义补年份
      const parsedDate = parseUnixListDate(rawDate)
      if (parsedDate && !isNaN(parsedDate.getTime())) {
        modified = parsedDate
      }
    } catch {}

    return { name, size: is_dir ? 0 : size, is_dir, modified }
  }

  // DOS format: 08-24-26 10:00AM <DIR> dirname or 08-24-26 10:00AM 12345 filename
  const dosMatch = trimmed.match(
    /^(\d{2}-\d{2}-\d{2,4}\s+\d{1,2}:\d{2}(?:[AP]M)?)\s+(<DIR>|\d+)\s+(.+)$/i,
  )
  if (dosMatch) {
    const dateStr = dosMatch[1]
    const dirOrSize = dosMatch[2].toUpperCase()
    const name = dosMatch[3].trim()
    if (name === "." || name === "..") return null

    const is_dir = dirOrSize === "<DIR>"
    const size = is_dir ? 0 : parseInt(dirOrSize, 10) || 0
    let modified = new Date()
    try {
      // F-268：手工解析 MM-DD-YY(YY) HH:MM[AM/PM]
      const parsedDate = parseDosListDate(dateStr)
      if (parsedDate && !isNaN(parsedDate.getTime())) {
        modified = parsedDate
      }
    } catch {}

    return { name, size, is_dir, modified }
  }

  return null
}

export interface FTPResponse {
  code: number
  message: string
  raw: string
}

export interface FTPClientOptions {
  /** 建连 + 登录的最长等待（毫秒），默认 15s */
  connectTimeoutMs?: number
  /** 单条非传输命令等待最终响应的上限（毫秒），默认 30s */
  commandTimeoutMs?: number
  /** 数据连接空闲上限（毫秒），默认 60s */
  dataIdleTimeoutMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15000
const DEFAULT_COMMAND_TIMEOUT_MS = 30000
const DEFAULT_DATA_IDLE_TIMEOUT_MS = 60000

interface PendingCallback {
  resolve: (res: FTPResponse) => void
  reject: (err: any) => void
  /** 1xx 先行响应（125/150）的通知入口；绝不会用它结束一条命令 */
  onPreliminary?: (res: FTPResponse) => void
  timer?: any
}

interface DataConnection {
  socket: any
  /** TCP 建连成功时 resolve，连接失败时 reject */
  ready: Promise<void>
  /** socket 的首个 error；迟到订阅同样安全（用于转发给消费者） */
  error: Promise<any>
}

/** 1yz = preliminary（先行）响应，不是命令的最终结果 */
function isPreliminary(code: number): boolean {
  return code >= 100 && code < 200
}

function asError(err: any, fallback: string): Error {
  if (err instanceof Error) return err
  return new Error(`${fallback}: ${String(err)}`)
}

/** 给 Promise 加超时（ms<=0 表示不限） */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export class FTPClient {
  private addition: FTPAddition
  private controlSocket: any = null
  private host: string
  private port: number
  private encoding: string
  /** 控制通道的未成行字节（F-267：按字节累积，行边界再解码） */
  private controlBuffer: Buffer = Buffer.alloc(0)
  private pendingCallbacks: PendingCallback[] = []
  private options: Required<FTPClientOptions>
  /** connect() 去重：并发调用共享同一次建连 */
  private connectPromise: Promise<void> | null = null
  /** 命令级互斥队列尾（串行化所有会话性操作，见 withLock） */
  private lockTail: Promise<void> = Promise.resolve()

  constructor(addition: FTPAddition, options: FTPClientOptions = {}) {
    this.addition = addition
    const { host, port } = parseFtpAddress(addition.address)
    this.host = host
    this.port = port
    this.encoding = normalizeEncoding(addition.encoding)
    this.options = {
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      dataIdleTimeoutMs:
        options.dataIdleTimeoutMs ?? DEFAULT_DATA_IDLE_TIMEOUT_MS,
    }
  }

  /**
   * 命令级互斥（F-263）。
   *
   * op 层按 storageId_modified 缓存 FTPDriver，因此同一个 FTPClient（一条控制
   * 连接）同时服务该存储的所有并发请求。而 REST 偏移、CWD、PASV 端口都是
   * **服务端连接级**状态：并发时 B 的 `REST` 会插在 A 的 `REST` 与 `RETR` 之间，
   * A 就从 B 的偏移开始传（静默数据错乱）。这里用 promise 链做 FIFO 串行队列，
   * 把每次会话性操作（REST+RETR、CWD+LIST、PASV+STOR…）整体包起来。
   */
  private async acquireLock(): Promise<() => void> {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.lockTail
    this.lockTail = previous.then(() => held)
    await previous
    return release
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  async connect(): Promise<void> {
    return await this.withLock(() => this.ensureConnected())
  }

  /**
   * 保证控制连接可用（已连接 + 已登录）。调用方必须持锁。
   */
  private async ensureConnected(): Promise<void> {
    // F-264：非 UTF-8 编码需要 iconv-lite。必须在任何命令编解码之前加载好，
    // 否则 encode/decode 会显式抛错（不再静默回退 UTF-8）。
    await ensureEncodingReady(this.encoding)
    if (this.controlSocket && !this.controlSocket.destroyed) {
      try {
        await this.sendCommand("NOOP")
        return
      } catch {
        this.close()
      }
    }

    // F-263（子问题 3）：getNet() 是让位点，原先两个并发 connect() 都会看到
    // controlSocket == null、各自建连，后者的 socket 覆盖前者，失败者的 close
    // 处理器还会把胜者的连接一起销毁。用初始化 Promise 去重。
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect().finally(() => {
        this.connectPromise = null
      })
    }
    await this.connectPromise
  }

  private async doConnect(): Promise<void> {
    const net = await getNet()

    await new Promise<void>((resolve, reject) => {
      let isGreeting = true
      const socket = net.createConnection({ host: this.host, port: this.port })

      this.controlSocket = socket
      // F-261：Node 的 socket.setTimeout 是「不活动超时」，原实现设了 15s 且
      // 从不清除，任何超过 15s 的数据传输（控制连接在 1xx 之后本就完全静默）
      // 都会被客户端自己 close() 掉，下载被截断成一次干净的 EOF。
      // 这里彻底取消 socket 级空闲杀连接，改由「命令级超时」+「数据连接
      // 空闲超时」兜底，传输期间不会再误杀控制连接。
      socket.setTimeout(0)

      socket.on("data", (chunk: Buffer) => {
        this.handleData(chunk)
      })

      socket.on("error", (err: any) => {
        if (isGreeting) reject(err)
        // 只有仍是当前控制连接时才清理全局状态：旧 socket 的 error/close
        // 不得把重连后的新连接一起销毁。
        if (this.controlSocket === socket) this.close()
      })

      socket.on("close", () => {
        if (this.controlSocket === socket) this.close()
      })

      // Handle greeting
      const entry: PendingCallback = {
        resolve: (res) => {
          if (entry.timer) clearTimeout(entry.timer)
          isGreeting = false
          if (res.code !== 220) {
            this.close()
            reject(new Error(`[FTP] Unexpected banner: ${res.raw}`))
            return
          }
          this.login().then(resolve, (loginErr) => {
            this.close()
            reject(loginErr)
          })
        },
        reject: (err) => {
          if (entry.timer) clearTimeout(entry.timer)
          isGreeting = false
          this.close()
          reject(err)
        },
      }
      this.pendingCallbacks.push(entry)
      this.armTimer(
        entry,
        this.options.connectTimeoutMs,
        "[FTP] Control connection timeout",
      )
    })
  }

  private async login(): Promise<void> {
    const userRes = await this.sendCommand(`USER ${this.addition.username}`)
    if (userRes.code === 331) {
      const passRes = await this.sendCommand(
        `PASS ${this.addition.password || ""}`,
      )
      if (passRes.code !== 230) {
        throw new Error(`[FTP] Login failed: ${passRes.message}`)
      }
    } else if (userRes.code !== 230) {
      throw new Error(`[FTP] Login failed: ${userRes.message}`)
    }

    // Set binary mode
    await this.sendCommand("TYPE I")

    // Attempt UTF-8 mode if UTF-8 is selected
    if (this.encoding === "utf-8") {
      try {
        await this.sendCommand("OPTS UTF8 ON")
      } catch {}
    }
  }

  private armTimer(
    entry: PendingCallback,
    ms: number,
    message: string,
  ): void {
    if (!Number.isFinite(ms) || ms <= 0) return
    entry.timer = setTimeout(() => {
      const idx = this.pendingCallbacks.indexOf(entry)
      if (idx >= 0) this.pendingCallbacks.splice(idx, 1)
      entry.reject(new Error(message))
      // 超时后响应可能仍在路上，留在队列里会错配给下一条命令
      // → 直接重建连接（close 会清空队列与缓冲）。
      this.close()
    }, ms)
    entry.timer.unref?.()
  }

  private handleData(chunk: Buffer): void {
    // F-267：必须先按字节累积、到 CRLF 行边界后再整行解码。逐 chunk 解码时，
    // 被 TCP 分段切开的多字节字符（UTF-8 汉字 / GBK 双字节）各自解码都会
    // 产生替换符，乱码被永久写进缓冲区并污染 2xx/257 的消息文本。
    this.controlBuffer = this.controlBuffer.length
      ? Buffer.concat([this.controlBuffer, chunk])
      : Buffer.from(chunk)

    let idx: number
    while ((idx = this.controlBuffer.indexOf("\r\n")) !== -1) {
      const lineBuf = this.controlBuffer.subarray(0, idx)
      this.controlBuffer = this.controlBuffer.subarray(idx + 2)
      const line = decodeFtpBuffer(lineBuf, this.encoding)
      if (!line.trim()) continue

      // 最终响应行形如 "220 ..." / "226 ..."；多行响应的续行是
      // "220-..." 或纯文本，不匹配本正则，因此不会被误判为最终响应。
      const match = line.match(/^(\d{3})(?: (.*))?$/)
      if (!match) continue

      const code = parseInt(match[1], 10)
      const res: FTPResponse = {
        code,
        message: match[2] || "",
        raw: line,
      }

      if (isPreliminary(code)) {
        // F-262：1xx（125/150）是先行响应，绝不能当作最终响应消费队首回调
        // ——那会把 150 当成 LIST/STOR 的结果，随后的 226 再被错配给下一条
        // 命令（完成码丢失、请求挂起）。
        const head = this.pendingCallbacks[0]
        if (head?.onPreliminary) {
          try {
            head.onPreliminary(res)
          } catch {
            // 通知方异常不得打断控制通道
          }
        }
        continue
      }

      const cb = this.pendingCallbacks.shift()
      if (cb) {
        if (cb.timer) clearTimeout(cb.timer)
        cb.resolve(res)
      }
    }
  }

  async sendCommand(
    cmd: string,
    options: {
      /** 等待最终响应的上限；0/Infinity = 不限（传输命令用） */
      timeoutMs?: number
      /** 1xx 先行响应（125/150）的通知入口 */
      onPreliminary?: (res: FTPResponse) => void
    } = {},
  ): Promise<FTPResponse> {
    // D-3：FTP 是「一行一条命令」的行协议，CR/LF 就是命令分隔符。
    // `rename` 的目标名、用户名、密码都来自用户配置；若透传 `\r\n`，攻击者
    // 可以凭一个文件名追加任意 FTP 命令（如 DELE / SITE EXEC）。
    // 命令字面量里永远不需要 CR/LF/NUL，一律拒绝。
    if (/[\r\n\0]/.test(cmd)) {
      throw new Error("[FTP] Illegal control character in command")
    }
    if (!this.controlSocket || this.controlSocket.destroyed) {
      // 调用方通常已持锁，这里只补齐连接，不重复加锁
      await this.ensureConnected()
    }

    return await new Promise<FTPResponse>((promiseResolve, promiseReject) => {
      const entry: PendingCallback = {
        resolve: (res) => {
          if (entry.timer) clearTimeout(entry.timer)
          promiseResolve(res)
        },
        reject: (err) => {
          if (entry.timer) clearTimeout(entry.timer)
          promiseReject(err)
        },
        onPreliminary: options.onPreliminary,
      }

      // F-262：等待最终响应的回调必须在写命令之前入队。原实现里 LIST 的
      // 226 等待回调要等数据连接 close 之后才 push，upload 的也要等
      // end() 回调之后才 push——226/550 完全可能先到而被丢弃或错配。
      this.pendingCallbacks.push(entry)
      this.armTimer(
        entry,
        options.timeoutMs ?? this.options.commandTimeoutMs,
        `[FTP] Command timed out: ${cmd}`,
      )

      const buf = Buffer.concat([
        encodeFtpString(cmd, this.encoding),
        Buffer.from("\r\n", "ascii"),
      ])
      this.controlSocket.write(buf, (err: any) => {
        if (err) {
          const idx = this.pendingCallbacks.indexOf(entry)
          if (idx >= 0) this.pendingCallbacks.splice(idx, 1)
          entry.reject(err)
        }
      })
    })
  }

  private async openDataConnection(): Promise<DataConnection> {
    const net = await getNet()
    const pasvRes = await this.sendCommand("PASV")
    if (pasvRes.code !== 227) {
      throw new Error(`[FTP] PASV failed: ${pasvRes.raw}`)
    }

    const match = pasvRes.message.match(
      /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/,
    )
    if (!match) {
      throw new Error(`[FTP] Invalid PASV response: ${pasvRes.message}`)
    }

    const host = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`
    const port = parseInt(match[5], 10) * 256 + parseInt(match[6], 10)

    // In NAT/docker setups, if host in PASV response is 0.0.0.0 or private, fallback to control host
    const targetHost =
      host === "0.0.0.0" || host === "127.0.0.1" ? this.host : host

    const dataSocket = net.createConnection({ host: targetHost, port })

    // F-260：error 监听器必须在「建连结果返回之前」同步挂上。原实现要等
    // STOR/RETR 一个完整往返之后才挂监听器，PASV 数据连接在此期间失败
    // （NAT/防火墙/docker 未发布端口，FTP 最常见的失败模式）时，socket 以零
    // 监听器状态 emit 'error'，EventEmitter 会把整个 Node 进程打崩。
    let firstError: any = null
    let resolveError!: (err: any) => void
    const error = new Promise<any>((resolve) => {
      resolveError = resolve
    })
    let resolveReady!: () => void
    let rejectReady!: (err: any) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    dataSocket.on("error", (err: any) => {
      if (!firstError) {
        firstError = err
        resolveError(err)
      }
      rejectReady(err)
    })
    dataSocket.once("connect", () => resolveReady())
    // 数据连接空闲上限：传输彻底卡死时也能释放命令锁，而不是永久挂住缓存客户端
    dataSocket.setTimeout(this.options.dataIdleTimeoutMs, () => {
      dataSocket.destroy(new Error("[FTP] Data connection idle timeout"))
    })
    // 调用方在若干 await 之后才会 await ready，先标记为已处理避免误报 unhandledRejection
    ready.catch(() => {})

    try {
      await ready
    } catch (err) {
      dataSocket.destroy()
      throw asError(err, "[FTP] Data connection failed")
    }

    return { socket: dataSocket, ready, error }
  }

  /**
   * 收集数据连接上的全部字节：close 视为结束，error 视为失败。
   * 处理函数在返回 Promise 之前同步挂好，迟到 await 也不会漏事件。
   */
  private collectData(conn: DataConnection): Promise<Buffer> {
    const chunks: Buffer[] = []
    const socket = conn.socket
    const result = new Promise<Buffer>((resolve, reject) => {
      socket.on("data", (chunk: Buffer) => chunks.push(chunk))
      socket.on("close", () => resolve(Buffer.concat(chunks)))
      conn.error.then(reject)
    })
    // 调用方会在命令往返之后才 await，先挂空 catch 防止 unhandledRejection
    result.catch(() => {})
    return result
  }

  async list(remotePath: string, cwdList = false): Promise<FTPFileEntry[]> {
    return await this.withLock(() => this.listInternal(remotePath, cwdList))
  }

  private async listInternal(
    remotePath: string,
    cwdList: boolean,
  ): Promise<FTPFileEntry[]> {
    await this.ensureConnected()

    const cleanPath = remotePath || "/"
    let target = cleanPath

    if (cwdList && cleanPath !== "/") {
      const cwdRes = await this.sendCommand(`CWD ${cleanPath}`)
      if (cwdRes.code >= 400) {
        throw new Error(`[FTP] CWD failed: ${cwdRes.raw}`)
      }
      target = ""
    }

    const conn = await this.openDataConnection()
    const dataPromise = this.collectData(conn)

    const listCmd = target ? `LIST ${target}` : "LIST"
    let rawBuffer: Buffer
    let completeRes: FTPResponse
    try {
      // 传输命令不设命令级超时：控制连接在 1xx 之后本就静默，卡死由数据
      // 连接的空闲超时兜底（见 openDataConnection）。
      const commandPromise = this.sendCommand(listCmd, { timeoutMs: 0 })
      commandPromise.catch(() => {})
      // 先收完数据，再给「等待 226」加一个有界超时：数据连接已关闭却迟迟不来
      // 完成码时，绝不无限期占住命令锁（F-262）。
      rawBuffer = await dataPromise
      completeRes = await withTimeout(
        commandPromise,
        this.options.commandTimeoutMs,
        "[FTP] LIST completion timeout",
      )
    } catch (err) {
      conn.socket.destroy()
      // 传输中途失败时残留的等待回调会错配后续命令 → 直接重建连接
      this.close()
      throw err
    }

    if (completeRes.code >= 400) {
      conn.socket.destroy()
      throw new Error(`[FTP] LIST failed: ${completeRes.raw}`)
    }

    const listText = decodeFtpBuffer(rawBuffer, this.encoding)
    const lines = listText.split(/\r?\n/)
    const entries: FTPFileEntry[] = []

    for (const line of lines) {
      const entry = parseListLine(line, this.encoding)
      if (entry) entries.push(entry)
    }

    return entries
  }

  async stat(remotePath: string): Promise<FTPFileEntry> {
    return await this.withLock(async () => {
      await this.ensureConnected()
      const cleanPath = remotePath.replace(/\\/g, "/")
      const parent = cleanPath.slice(0, cleanPath.lastIndexOf("/")) || "/"
      const name = cleanPath.split("/").filter(Boolean).pop() || ""

      if (!name || cleanPath === "/") {
        return {
          name: "root",
          size: 0,
          is_dir: true,
          modified: new Date(),
        }
      }

      const entries = await this.listInternal(parent, false)
      const found = entries.find((e) => e.name === name)
      if (!found) {
        throw new Error(`[FTP] File not found: ${remotePath}`)
      }
      return found
    })
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.withLock(() => this.mkdirInternal(remotePath))
  }

  /**
   * F-269：判断目录是否真的存在（仅在错误路径上用）。
   * MKD 的 550 在 RFC 959 里既可能是「已存在」也可能是权限拒绝，必须回查。
   */
  private async dirExists(remotePath: string): Promise<boolean> {
    const clean = remotePath.replace(/\/+$/, "")
    const parent = clean.slice(0, clean.lastIndexOf("/")) || "/"
    const name = clean.split("/").filter(Boolean).pop() || ""
    if (!name) return true
    try {
      const entries = await this.listInternal(parent, false)
      return entries.some((e) => e.name === name && e.is_dir)
    } catch {
      return false
    }
  }

  private async mkdirInternal(remotePath: string): Promise<void> {
    await this.ensureConnected()
    const res = await this.sendCommand(`MKD ${remotePath}`)
    if (res.code >= 400) {
      // 550 只有回查确认目录确实存在时才视为「已存在」，权限拒绝必须上抛
      if (res.code === 550 && (await this.dirExists(remotePath))) return
      throw new Error(`[FTP] MKD failed: ${res.raw}`)
    }
  }

  async mkdirAll(remotePath: string): Promise<void> {
    await this.withLock(async () => {
      const clean = remotePath.replace(/\\/g, "/")
      const parts = clean.split("/").filter(Boolean)
      let current = clean.startsWith("/") ? "/" : ""

      for (const part of parts) {
        current = current === "/" ? "/" + part : current + "/" + part
        try {
          await this.mkdirInternal(current)
        } catch (err: any) {
          // F-269：只吞「目录已存在」，其余（权限/连接/协议错误）必须上抛，
          // 否则 mkdir 假报成功，put 随后以一条与根因无关的 STOR 错误失败。
          if (await this.dirExists(current).catch(() => false)) continue
          throw err
        }
      }
    })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.withLock(async () => {
      await this.ensureConnected()
      // RNFR/RNTO 必须作为一对原子操作，中间不允许插入其他命令
      const rnfrRes = await this.sendCommand(`RNFR ${oldPath}`)
      if (rnfrRes.code !== 350) {
        throw new Error(`[FTP] RNFR failed: ${rnfrRes.raw}`)
      }
      const rntoRes = await this.sendCommand(`RNTO ${newPath}`)
      if (rntoRes.code !== 250) {
        throw new Error(`[FTP] RNTO failed: ${rntoRes.raw}`)
      }
    })
  }

  async removeFile(remotePath: string): Promise<void> {
    await this.withLock(() => this.removeFileInternal(remotePath))
  }

  private async removeFileInternal(remotePath: string): Promise<void> {
    await this.ensureConnected()
    const res = await this.sendCommand(`DELE ${remotePath}`)
    // A-25：550 既可能是「文件不存在」，也可能是「无权限 / 目录非空」。
    // 历史实现对 550 直接放行，删除失败被伪装成成功。这里统一抛错，由调用方
    // 决定是否按「不存在」处理（removeRecursive 会先 list 再删除）。
    if (res.code >= 400) {
      throw new Error(`[FTP] DELE failed: ${res.raw}`)
    }
  }

  async removeDir(remotePath: string): Promise<void> {
    await this.withLock(() => this.removeDirInternal(remotePath))
  }

  private async removeDirInternal(remotePath: string): Promise<void> {
    await this.ensureConnected()
    const res = await this.sendCommand(`RMD ${remotePath}`)
    // A-25：同 DELE，550 不能当作成功。
    if (res.code >= 400) {
      throw new Error(`[FTP] RMD failed: ${res.raw}`)
    }
  }

  async removeRecursive(remotePath: string): Promise<void> {
    await this.withLock(() => this.removeRecursiveInternal(remotePath))
  }

  private async removeRecursiveInternal(remotePath: string): Promise<void> {
    let entries: FTPFileEntry[] = []
    try {
      entries = await this.listInternal(remotePath, false)
    } catch {
      // If listing fails, try DELE as file
      await this.removeFileInternal(remotePath)
      return
    }

    for (const entry of entries) {
      const child = `${remotePath.replace(/\/+$/, "")}/${entry.name}`
      if (entry.is_dir) {
        await this.removeRecursiveInternal(child)
      } else {
        await this.removeFileInternal(child)
      }
    }

    await this.removeDirInternal(remotePath)
  }

  async upload(remotePath: string, content: Uint8Array): Promise<void> {
    await this.withLock(async () => {
      await this.ensureConnected()
      const conn = await this.openDataConnection()

      let resolvePreliminary!: (res: FTPResponse) => void
      const preliminary = new Promise<FTPResponse>((resolve) => {
        resolvePreliminary = resolve
      })
      // 完成码（226/550…）的等待回调在写命令之前就已入队（sendCommand 内部），
      // 因此 226 先到也不会丢（F-262）。
      const completion = this.sendCommand(`STOR ${remotePath}`, {
        timeoutMs: 0,
        onPreliminary: (res) => resolvePreliminary(res),
      })
      completion.catch(() => {})

      try {
        // 先等到 150（或直接拿到最终码）再发数据；等待本身有界，
        // 服务端不响应时不会永久占住命令锁（F-262）。
        const first = await withTimeout(
          Promise.race([preliminary, completion]),
          this.options.commandTimeoutMs,
          "[FTP] STOR response timeout",
        )
        if (!isPreliminary(first.code)) {
          conn.socket.destroy()
          if (first.code >= 400) {
            throw new Error(`[FTP] STOR failed: ${first.raw}`)
          }
          throw new Error(`[FTP] Unexpected STOR response: ${first.raw}`)
        }

        await new Promise<void>((resolve, reject) => {
          conn.error.then(reject)
          conn.socket.end(content, () => resolve())
        })

        const completeRes = await withTimeout(
          completion,
          this.options.dataIdleTimeoutMs,
          "[FTP] Upload completion timeout",
        )
        if (completeRes.code >= 400) {
          throw new Error(`[FTP] Upload completion error: ${completeRes.raw}`)
        }
        // 传输已确认完成，释放数据连接（部分服务端不会主动关）
        conn.socket.destroy()
      } catch (err) {
        conn.socket.destroy()
        // 传输失败后控制连接上的等待回调状态不可信 → 重建连接
        this.close()
        throw err
      }
    })
  }

  async download(
    remotePath: string,
    options?: { start?: number; end?: number },
  ): Promise<any> {
    // F-263：锁必须一直持有到这次传输真正结束（数据连接关闭 + 最终 226），
    // 否则下一条命令会插进正在进行的传输（REST/CWD 互相污染）。
    const release = await this.acquireLock()
    let released = false
    const releaseOnce = () => {
      if (released) return
      released = true
      release()
    }

    try {
      await this.ensureConnected()
      const { PassThrough } = await getStream()

      if (options && options.start && options.start > 0) {
        const restRes = await this.sendCommand(`REST ${options.start}`)
        if (restRes.code !== 350) {
          throw new Error(`[FTP] REST offset failed: ${restRes.raw}`)
        }
      }

      const conn = await this.openDataConnection()
      const dataSocket = conn.socket
      const passThrough = new PassThrough()

      const completion = this.sendCommand(`RETR ${remotePath}`, {
        timeoutMs: 0,
      })
      completion.catch(() => {})
      // 服务端直接拒绝传输（550 等）时数据连接不会再有数据，主动收尾
      completion
        .then((res) => {
          if (res.code >= 400) dataSocket.destroy()
        })
        .catch(() => {})

      // Range 截断是我们主动 destroy 数据连接的正常结果，服务端此时常回
      // 426/451，不能把它当成失败（否则每个 Range 请求都会报错）。
      let abortedForRange = false
      let finishing = false
      let finished = false
      const releaseAfterTransfer = () => {
        if (finished) return
        finished = true
        releaseOnce()
      }

      // 数据连接结束（正常 close / 出错 / 消费方取消）后的统一收尾：
      // 必须等 RETR 的最终响应落地，队列才不会残留 waiter 污染下一条命令。
      const finishTransfer = async () => {
        if (finishing || finished) return
        finishing = true
        try {
          const res = await withTimeout(
            completion,
            this.options.commandTimeoutMs,
            "[FTP] RETR completion timeout",
          )
          if (res.code >= 400 && !abortedForRange) {
            throw new Error(`[FTP] RETR failed: ${res.raw}`)
          }
          if (!passThrough.destroyed) passThrough.end()
        } catch (err) {
          if (!passThrough.destroyed) {
            passThrough.destroy(asError(err, "[FTP] Download failed"))
          }
          this.close()
        } finally {
          releaseAfterTransfer()
        }
      }

      // F-260：错误一律经 conn.error 转发（监听器在 openDataConnection 里已同步挂好）
      conn.error.then((err: any) => {
        if (!passThrough.destroyed) passThrough.destroy(err)
        this.close()
        void finishTransfer()
      })

      let bytesSent = 0
      const length =
        options &&
        typeof options.end === "number" &&
        typeof options.start === "number"
          ? options.end - options.start + 1
          : Infinity

      dataSocket.on("data", (chunk: Buffer) => {
        if (bytesSent >= length) {
          abortedForRange = true
          dataSocket.destroy()
          return
        }
        if (bytesSent + chunk.length > length) {
          const slice = chunk.slice(0, length - bytesSent)
          passThrough.write(slice)
          bytesSent += slice.length
          abortedForRange = true
          dataSocket.destroy()
        } else {
          passThrough.write(chunk)
          bytesSent += chunk.length
        }
      })

      dataSocket.on("close", () => {
        // 等 226 再 end()：否则传输失败会退化成一次「干净的 EOF」，下载被静默截断。
        void finishTransfer()
      })

      // 消费方提前取消（客户端断连）时立刻停掉服务端传输，并在收尾后释放锁
      passThrough.once("close", () => {
        if (!dataSocket.destroyed) dataSocket.destroy()
        void finishTransfer()
      })

      return passThrough
    } catch (err) {
      releaseOnce()
      this.close()
      throw err
    }
  }

  close(): void {
    const socket = this.controlSocket
    this.controlSocket = null
    if (socket) {
      try {
        socket.destroy()
      } catch {}
    }
    this.controlBuffer = Buffer.alloc(0)
    const pending = this.pendingCallbacks.splice(0, this.pendingCallbacks.length)
    for (const cb of pending) {
      if (cb.timer) clearTimeout(cb.timer)
      cb.reject(new Error("[FTP] Connection closed"))
    }
  }
}
