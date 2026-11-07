import assert from "node:assert/strict"
import net from "node:net"
import { test } from "node:test"
import { FTPClient } from "./ftp-client"

/**
 * F-260 / F-261 / F-262 / F-263 的回归测试：真实 TCP 假 FTP 服务器 + 真实 FTPClient。
 *
 * 覆盖点：
 *   F-260  PASV 数据连接被拒（NAT/防火墙最常见失败）→ 必须抛错，不得以
 *          未捕获 'error' 事件击穿 Node 进程（旧实现会让整个测试进程崩掉）
 *   F-261  控制连接不得残留 socket 级不活动超时；慢传输（> connectTimeoutMs，
 *          旧实现里是硬编码 15s）必须完整读完
 *   F-262  150 与 226 落在同一个 TCP chunk / 226 先于数据连接关闭 →
 *          完成码不能被 1xx 先行响应吞掉，请求不得挂起
 *   F-263  并发操作必须串行化：REST 与对应 RETR 之间不得插入别的会话命令，
 *          并发的两个 upload/download 数据不得互相污染
 */

const CONTROL_TIMEOUT = 5000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 防止实现回归成永久挂起时测试无限等待 */
function inTime<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} 超时未完成（疑似请求挂起）`)),
      CONTROL_TIMEOUT,
    )
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

interface FakeServerOptions {
  /** PASV 回复一个无人监听的端口（模拟数据连接被拒） */
  refuseDataConnection?: boolean
  /** LIST/RETR 在 150 之后延迟多少毫秒再发数据（模拟慢传输） */
  transferDelayMs?: number
  /** 150 与 226 写进同一个 TCP chunk（小目录的真实时序） */
  coalescePreliminaryAndFinal?: boolean
  /** 226 先于数据连接关闭 */
  finalBeforeDataClose?: boolean
}

class FakeFtpServer {
  readonly commands: string[] = []
  readonly uploads = new Map<string, Buffer>()
  readonly files = new Map<string, Buffer>()
  port = 0

  private server: net.Server | null = null
  private dataServer: net.Server | null = null
  private pendingData: Promise<net.Socket> | null = null
  private sockets = new Set<net.Socket>()
  private opts: FakeServerOptions
  private restOffset = 0

  constructor(opts: FakeServerOptions = {}) {
    this.opts = opts
  }

  async start(): Promise<void> {
    this.files.set("/existing.txt", Buffer.from("0123456789"))
    await new Promise<void>((resolve) => {
      this.server = net.createServer((socket) => this.onControl(socket))
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as net.AddressInfo).port
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.dataServer?.close()
    this.dataServer = null
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = null
    }
  }

  private onControl(socket: net.Socket): void {
    this.sockets.add(socket)
    socket.on("error", () => {})
    socket.write("220 Fake FTP ready\r\n")
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      for (;;) {
        const idx = buffer.indexOf("\r\n")
        if (idx < 0) break
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        this.commands.push(line)
        void this.handle(socket, line)
      }
    })
  }

  private async handle(socket: net.Socket, line: string): Promise<void> {
    const space = line.indexOf(" ")
    const cmd = (space < 0 ? line : line.slice(0, space)).toUpperCase()
    const arg = space < 0 ? "" : line.slice(space + 1)
    try {
      switch (cmd) {
        case "USER":
          socket.write("331 Need password\r\n")
          break
        case "PASS":
          socket.write("230 Logged in\r\n")
          break
        case "TYPE":
          socket.write("200 Type set\r\n")
          break
        case "OPTS":
          socket.write("200 UTF8 on\r\n")
          break
        case "NOOP":
          socket.write("200 NOOP ok\r\n")
          break
        case "REST":
          this.restOffset = parseInt(arg, 10) || 0
          socket.write("350 Restarting\r\n")
          break
        case "PASV":
          await this.handlePasv(socket)
          break
        case "LIST":
          await this.handleList(socket)
          break
        case "RETR":
          await this.handleRetr(socket, arg)
          break
        case "STOR":
          await this.handleStor(socket, arg)
          break
        default:
          socket.write("502 Not implemented\r\n")
      }
    } catch {
      // 测试服务器：忽略时序异常
    }
  }

  private async handlePasv(socket: net.Socket): Promise<void> {
    if (this.opts.refuseDataConnection) {
      // 申请一个端口后立刻关闭 listener：客户端连上去必被拒（ECONNREFUSED）
      const tmp = net.createServer()
      const port = await new Promise<number>((resolve) => {
        tmp.listen(0, "127.0.0.1", () => {
          const p = (tmp.address() as net.AddressInfo).port
          tmp.close(() => resolve(p))
        })
      })
      socket.write(
        `227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 0xff})\r\n`,
      )
      return
    }

    this.dataServer?.close()
    const dataServer = net.createServer()
    this.dataServer = dataServer
    await new Promise<void>((resolve) =>
      dataServer.listen(0, "127.0.0.1", () => resolve()),
    )
    const port = (dataServer.address() as net.AddressInfo).port
    this.pendingData = new Promise<net.Socket>((resolve) => {
      dataServer.once("connection", (dataSocket) => {
        this.sockets.add(dataSocket)
        dataSocket.on("error", () => {})
        dataServer.close()
        resolve(dataSocket)
      })
    })
    socket.write(
      `227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 0xff})\r\n`,
    )
  }

  private async handleList(socket: net.Socket): Promise<void> {
    const data = await this.pendingData!
    const payload = "-rw-r--r-- 1 u g 10 Jan 01 12:00 existing.txt\r\n"
    const delay = this.opts.transferDelayMs || 0

    if (this.opts.coalescePreliminaryAndFinal) {
      // 150 与 226 落在同一个 chunk：旧实现把 150 当最终响应消费，
      // 随后的 226 无人接收。
      socket.write("150 Opening data connection\r\n226 Transfer complete\r\n")
      await sleep(delay)
      data.end(payload)
      return
    }

    if (this.opts.finalBeforeDataClose) {
      data.write(payload)
      socket.write("150 Opening data connection\r\n")
      await sleep(delay)
      socket.write("226 Transfer complete\r\n")
      await sleep(10)
      data.end()
      return
    }

    socket.write("150 Opening data connection\r\n")
    await sleep(delay)
    data.end(payload, () => socket.write("226 Transfer complete\r\n"))
  }

  private async handleRetr(socket: net.Socket, path: string): Promise<void> {
    const data = await this.pendingData!
    const content = this.files.get(path)
    if (!content) {
      data.destroy()
      socket.write("550 No such file\r\n")
      return
    }
    const slice = content.subarray(this.restOffset)
    socket.write("150 Opening data connection\r\n")
    await sleep(this.opts.transferDelayMs || 0)
    data.end(slice, () => socket.write("226 Transfer complete\r\n"))
  }

  private async handleStor(socket: net.Socket, path: string): Promise<void> {
    const data = await this.pendingData!
    const chunks: Buffer[] = []
    socket.write("150 Ok to send data\r\n")
    await new Promise<void>((resolve) => {
      data.on("data", (chunk) => chunks.push(chunk))
      data.on("close", () => resolve())
    })
    this.uploads.set(path, Buffer.concat(chunks))
    // 226 在数据连接关闭后立刻写（与真实服务端一致）
    socket.write("226 Transfer complete\r\n")
    data.destroy()
  }
}

function makeClient(port: number, options: Record<string, number> = {}) {
  return new FTPClient(
    { address: `127.0.0.1:${port}`, username: "u", password: "p" },
    { connectTimeoutMs: 2000, commandTimeoutMs: 2000, ...options },
  )
}

function collect(stream: any): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    stream.on("error", reject)
  })
}

test("F-260：PASV 数据连接被拒时抛错，不得以未捕获 error 击穿进程", async () => {
  const server = new FakeFtpServer({ refuseDataConnection: true })
  await server.start()
  const client = makeClient(server.port)

  try {
    await assert.rejects(
      () => inTime(client.upload("/x.txt", Buffer.from("hello")), "upload"),
      /Data connection|ECONNREFUSED|connect/i,
      "数据连接被拒时 upload 必须 reject（旧实现会崩进程）",
    )
    // 客户端仍可继续使用（连接未被毒化），第二次同样以异常收场而不是崩溃
    await assert.rejects(
      () => inTime(client.download("/x.txt"), "download"),
      /Data connection|ECONNREFUSED|connect/i,
      "数据连接被拒时 download 必须 reject",
    )
  } finally {
    client.close()
    await server.stop()
  }
})

test("F-261：控制连接不再保留不活动超时，慢传输不被中途掐断", async () => {
  const server = new FakeFtpServer({ transferDelayMs: 300 })
  await server.start()
  // connectTimeoutMs 远小于传输耗时：若控制连接仍带 socket 级不活动超时，
  // 传输就会被客户端自己 close() 掉
  const client = makeClient(server.port, { connectTimeoutMs: 100 })

  try {
    await inTime(client.connect(), "connect")
    assert.equal(
      (client as any).controlSocket.timeout,
      0,
      "控制连接不得残留 socket 级不活动超时",
    )

    const entries = await inTime(client.list("/"), "list")
    assert.equal(entries.length, 1, "慢传输必须完整返回，不能被截断")
    assert.equal(entries[0].name, "existing.txt")

    const got = await inTime(
      client.download("/existing.txt").then(collect),
      "download",
    )
    assert.equal(got, "0123456789", "慢下载必须完整收满")
  } finally {
    client.close()
    await server.stop()
  }
})

test("F-262：150 与 226 同 chunk 时完成码不丢（list 不挂起）", async () => {
  const server = new FakeFtpServer({ coalescePreliminaryAndFinal: true })
  await server.start()
  const client = makeClient(server.port)

  try {
    const entries = await inTime(client.list("/"), "list")
    assert.equal(entries.length, 1, "150/226 同 chunk 时 LIST 仍应正常返回")
    assert.equal(entries[0].name, "existing.txt")
  } finally {
    client.close()
    await server.stop()
  }
})

test("F-262：226 先于数据连接关闭时 list/upload 不挂起", async () => {
  const server = new FakeFtpServer({ finalBeforeDataClose: true })
  await server.start()
  const client = makeClient(server.port)

  try {
    const entries = await inTime(client.list("/"), "list")
    assert.equal(entries.length, 1, "226 先到时 LIST 仍应正常返回")

    await inTime(client.upload("/new.txt", Buffer.from("payload")), "upload")
    assert.equal(
      server.uploads.get("/new.txt")?.toString("utf8"),
      "payload",
      "upload 必须在 226 之后正常结束",
    )
  } finally {
    client.close()
    await server.stop()
  }
})

test("F-263：并发 upload 串行化，数据不互相污染", async () => {
  const server = new FakeFtpServer({ transferDelayMs: 80 })
  await server.start()
  const client = makeClient(server.port, { commandTimeoutMs: 5000 })

  try {
    await inTime(
      Promise.all([
        client.upload("/a.txt", Buffer.from("AAAA")),
        client.upload("/b.txt", Buffer.from("BBBB")),
      ]),
      "concurrent upload",
    )

    assert.equal(server.uploads.get("/a.txt")?.toString("utf8"), "AAAA")
    assert.equal(server.uploads.get("/b.txt")?.toString("utf8"), "BBBB")

    const pasv = server.commands
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.toUpperCase().startsWith("PASV"))
    const stor = server.commands
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.toUpperCase().startsWith("STOR"))
    assert.equal(stor.length, 2)
    assert.ok(
      pasv.length >= 2 && stor[0].i < pasv[1].i,
      `PASV/STOR 不得交错，实际命令序列：${server.commands.join(" | ")}`,
    )
  } finally {
    client.close()
    await server.stop()
  }
})

test("F-263：并发 Range 下载的 REST 偏移不互相覆盖", async () => {
  const server = new FakeFtpServer({ transferDelayMs: 50 })
  await server.start()
  const client = makeClient(server.port, { commandTimeoutMs: 5000 })

  try {
    const [first, second] = await inTime(
      Promise.all([
        client.download("/existing.txt", { start: 2, end: 4 }),
        client.download("/existing.txt", { start: 6, end: 8 }),
      ]),
      "concurrent download",
    )
    const [a, b] = await inTime(
      Promise.all([collect(first), collect(second)]),
      "collect",
    )
    assert.equal(a, "234", "第一个 Range 的偏移必须保持 2")
    assert.equal(b, "678", "第二个 Range 的偏移必须保持 6")

    const rests = server.commands
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.toUpperCase().startsWith("REST"))
    const retrs = server.commands
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.toUpperCase().startsWith("RETR"))
    assert.equal(rests.length, 2)
    assert.equal(retrs.length, 2)
    assert.ok(
      retrs[0].i < rests[1].i,
      `REST 与对应 RETR 之间不得插入其它会话命令，实际：${server.commands.join(" | ")}`,
    )
  } finally {
    client.close()
    await server.stop()
  }
})

test("F-267：控制通道按行边界解码，多字节字符被 TCP 分段切开不产生乱码", () => {
  const client = makeClient(1)
  const full = Buffer.from("220 中文测试\r\n", "utf8")
  const resolved: any[] = []
  ;(client as any).pendingCallbacks.push({
    resolve: (res: any) => resolved.push(res),
    reject: () => {},
  })
  // 在「中」的第二个字节处切开（"220 " = 4 字节，中 = 3 字节）
  ;(client as any).handleData(full.subarray(0, 5))
  assert.equal(resolved.length, 0, "未成行的半行不得被解码/解析")
  ;(client as any).handleData(full.subarray(5))
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].message, "中文测试", "跨 chunk 的多字节字符必须完整")
  client.close()
})

test("F-266：cwd_list 模式下 CWD 失败必须报错（不得列出错误目录）", async () => {
  const server = new FakeFtpServer()
  await server.start()
  const client = makeClient(server.port)
  try {
    await assert.rejects(
      () => inTime(client.list("/definitely/missing", true), "list"),
      /CWD failed/,
      "CWD 被拒后不得静默 LIST 起始目录",
    )
    assert.ok(
      server.commands.some((c) => c.toUpperCase().startsWith("CWD ")),
      "必须先尝试 CWD",
    )
  } finally {
    client.close()
    await server.stop()
  }
})

test("F-269：mkdirAll 不再吞掉权限/协议错误", async () => {
  const server = new FakeFtpServer()
  await server.start()
  const client = makeClient(server.port)
  try {
    await assert.rejects(
      () => inTime(client.mkdirAll("/denied/sub"), "mkdirAll"),
      /MKD failed/,
      "非「已存在」的 MKD 错误必须上抛",
    )
  } finally {
    client.close()
    await server.stop()
  }
})
