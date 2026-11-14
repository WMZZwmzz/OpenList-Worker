/**
 * Key 格式适配器
 *
 * 将数据按表拆分，每个实体一条记录：
 * - settings_<key>
 * - users_<id>
 * - storages_<id>
 * - shares_<id>
 * - metas_<id>
 * - plugins_<id>
 *
 * 避免大 JSON，适合频繁读写单条记录的场景。
 *
 * 键名约束：EdgeOne KV 只接受字母、数字和下划线，因此分隔符用 `_`
 * 而不是 `:`，且 id 中的非法字符（如 UUID 的 `-`）需转义。
 *
 * 转义方案无需反向解析：所有读写都是"构造键名"，实体的主键值一律
 * 来自记录 JSON 本身，key 只用作存储地址。
 */
import type { FormatAdapter, Driver } from "../types"
import { TABLE_NAMES, TABLE_KEY, type TableName } from "../schema"
import { entityKeyOf, tableKeyPrefix } from "../keycodec"

const INIT_MARK = "openlist_config"

/**
 * list 视野最终一致的驱动（QS-1）。
 *
 * KV 语义的后端（Cloudflare KV 原生 binding、EdgeOne KV、CF KV REST）在文档里
 * 明确是**最终一致**的：某个 isolated 实例的 `list()` 可能暂时看不到其他实例
 * 刚写入的键。key 格式的「差集删除」正是建立在这个 list 视野上的，于是出现：
 *
 *   I1 写入 storages_5 → I2 load 时 list 漏报 storages_5（部分缺失，不报错）
 *   → I2 的内存库把它当作不存在 → I2 任意一次 save 的 list 此时已收敛，
 *   storages_5 出现在「旧键」里但不在 liveKeys 中 → **被 delete 掉**。
 *
 * 修复分两层（缺一不可）：
 *   1. 本文件 save()：对这类驱动不再删除「本实例从未观察到过」的键（见 save 内注释），
 *      只删除「上一次成功 load/save 确实见过、且新快照不再包含」的键 —— 正常的
 *      删除语义（管理员删实体）完全保留，被漏报的真实键不会被误删。
 *   2. db.ts：`keyFormatListCompletenessProven()` 返回 false 时不再把内存库标记为
 *      dbTrusted（list 完整性无法证明 ⇒ 内存库不是持久化状态的完整镜像）。
 */
const EVENTUALLY_CONSISTENT_LIST_DRIVERS = new Set(["kv", "cfkv"])

/** 该驱动的 list 是否可能「部分漏报」（QS-1）。 */
export function mayUnderReportList(driver: Driver): boolean {
  return EVENTUALLY_CONSISTENT_LIST_DRIVERS.has(
    String(driver?.name || "").toLowerCase(),
  )
}

/**
 * 本次 load 的 list 完整性是否可证明。
 *
 * 强一致后端（d1 / do / mysql / memory）的 list 即事实，可证明；KV 族最终一致，
 * 客户端无法证明「没看到 = 不存在」，因此为 false，db.ts 据此不置 dbTrusted。
 */
export function keyFormatListCompletenessProven(driver: Driver): boolean {
  return !mayUnderReportList(driver)
}

/**
 * 每个驱动最近一次成功 load（或 save）观察到的键集合。
 *
 * 用于 QS-1 的删除护栏：只允许删除「本实例确实见过」的键。用 WeakMap 以驱动
 * 对象为键（驱动是模块级单例，条目随驱动回收），跨请求累积正是指望的行为 ——
 * 一个键被漏报一次不代表它从未存在过，之前见过就可以安全判定其已被删除。
 */
const observedKeysByDriver = new WeakMap<object, Set<string>>()

function observedKeysOf(driver: Driver): Set<string> {
  let seen = observedKeysByDriver.get(driver)
  if (!seen) {
    seen = new Set<string>()
    observedKeysByDriver.set(driver, seen)
  }
  return seen
}

/** 构造表前缀（使用共享键名编码，兼容 EdgeOne KV 字符集约束） */
function tablePrefix(table: string): string {
  return tableKeyPrefix(table)
}

/** 构造完整键名 */
function fullKeyOf(table: string, id: string): string {
  return entityKeyOf(table, id)
}

/**
 * 将一次全局 list 的结果按表前缀分组。
 *
 * key 格式的键名统一为 `<table>_<id>`（见 keycodec），因此一次空前缀
 * list 即可取回全部表的键，再按前缀分拣 —— 结果与逐表 list 完全一致，
 * 但把 load/save 各自的 list 消耗从「每表 1 次（6 张表 = 6 次）」降为
 * 1 次。Cloudflare 免费版 list 配额仅 1000 次/天（issue #125），
 * key + kv 组合下这是可持续性的关键；对配额无限的平台也无害（省 5 次
 * 往返）。
 *
 * 命名空间中不属于任何表前缀的键（如 INIT_MARK、其他应用的键）会被
 * 忽略，与旧实现「逐表前缀 list 天然排除它们」的行为一致。
 */
function groupKeysByTable(allKeys: string[]): Record<TableName, string[]> {
  const out = {} as Record<TableName, string[]>
  for (const table of TABLE_NAMES) out[table] = []
  for (const key of allKeys) {
    for (const table of TABLE_NAMES) {
      if (key.startsWith(tablePrefix(table))) {
        out[table].push(key)
        break
      }
    }
  }
  return out
}

export const keyFormat: FormatAdapter = {
  name: "key",

  async load(driver: Driver, env?: any): Promise<any | null> {
    // 检查是否已初始化
    const mark = await driver.get(INIT_MARK, env)

    // 一次全局 list 代替逐表 list（6 张表 = 6 次），见 groupKeysByTable
    const allKeys = await driver.list("", env)

    // 记录本次观察到的键（QS-1 删除护栏的输入），见 observedKeysByDriver
    const observed = observedKeysOf(driver)
    for (const key of allKeys) observed.add(key)

    if (!mark) {
      // 标记缺失 ≠ 全新空库（F-084，与 sql.ts 同款修复）。
      //
      // 历史缺陷：只凭 INIT_MARK 判定初始化，而标记是整个保存序列的最后一步。
      // 标记的首次写入中途失败（KV 配额、网络抖动、实例被杀）就会留下「数据键
      // 已写入、标记永远缺失」的库；load 返回 null → loadDb 走「读取成功但后端
      // 为空」分支（loadError=null）→ 匿名 /init/setup 放行 → force 保存覆盖。
      //
      // 因此这里补一次探测：表前缀下已有键就抛错（比照 sql.ts / map.ts 对损坏
      // 配置的策略），真正全新的空库（一个键都没有）仍返回 null。
      const grouped = groupKeysByTable(allKeys)
      const populated = TABLE_NAMES.filter((t) => grouped[t].length > 0)
      if (populated.length > 0) {
        throw new Error(
          `[keyFormat] init marker "${INIT_MARK}" is missing, but key(s) for ` +
            `table(s) ${populated.join(", ")} already exist. Refusing to treat ` +
            `this database as a brand-new empty one: doing so would re-open ` +
            `anonymous /init/setup and let it overwrite existing data. Restore ` +
            `the marker (or a backup), or explicitly remove the stale keys if ` +
            `the data is intentionally discarded.`,
        )
      }
      return null
    }

    // A-15：DB_FORMAT 从 map 切到 key 时，INIT_MARK 里存的是整库 JSON 快照
    // （map 格式的 "openlist_config"），而不是时间戳标记。历史实现只判断
    // 「标记存在」，于是返回一个 users/storages/settings 全空的库，随后 save
    // 把标记改写成时间戳，旧的整库数据永久不可达。这里识别并直接沿用该快照，
    // 下一次 save 会把它拆分写入各表键。
    const markText = String(mark).trim()
    if (markText.startsWith("{")) {
      try {
        const legacy = JSON.parse(markText)
        if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
          const out: Record<string, any> = {}
          for (const table of TABLE_NAMES) {
            const value = (legacy as any)[table]
            out[table] = Array.isArray(value) ? value : []
          }
          return out
        }
      } catch (err) {
        throw new Error(
          `[keyFormat] INIT_MARK looks like a map-format snapshot but is not valid JSON; ` +
            `refusing to treat it as empty. Cause: ${(err as Error)?.message || String(err)}`,
        )
      }
    }

    const grouped = groupKeysByTable(allKeys)

    const out: Record<string, any> = {}

    for (const table of TABLE_NAMES) {
      const records = []
      for (const key of grouped[table]) {
        const raw = await driver.get(key, env)
        if (raw) {
          try {
            records.push(JSON.parse(raw))
          } catch (err) {
            console.warn(`[keyFormat] Failed to parse ${key}:`, err)
          }
        }
      }

      out[table] = records
    }

    return out
  },

  async save(data: any, driver: Driver, env?: any): Promise<boolean> {
    // 先写新数据，**最后**清理陈旧键。
    //
    // 稳定性不变量：save 失败不得让「原有数据整体消失」。
    // 历史实现是「先删光所有前缀键，再写新数据」：一旦写入阶段失败（网络抖动、
    // 配额、实例被杀），旧记录已被删除、新记录尚未写入，数据库直接变成空表。
    // 故障注入实测：users 从 1 条变为 0 条 —— 这是数据丢失，不是「保存失败」。
    //
    // 改为先写后删后，失败时的最坏情况是**残留**旧键（可被下一次成功保存清理），
    // 而不会丢数据；正常成功路径的最终状态与原来完全一致。

    // 标记**先行**（F-084，与 sql.ts 一致）：把 INIT_MARK 作为写入序列的第一步。
    //
    // 历史实现把它放在最后：首次保存任一步失败（KV 写配额、网络）都会留下
    // 「数据键已写入、标记从未写成」的库，load 返回 null，系统把它当全新空库并
    // 重新开放匿名 /init/setup。放到首位后：
    //   - 第一步失败 → 什么都没写，仍可安全按全新库初始化；
    //   - 第一步成功 → 标记必然存在，后续失败最多留下部分更新，不会被误判为空库。
    await driver.put(INIT_MARK, String(Date.now()), env)

    const observed = observedKeysOf(driver)
    const mayUnderReport = mayUnderReportList(driver)

    const liveKeys = new Set<string>()
    for (const table of TABLE_NAMES) {
      const keyCol = TABLE_KEY[table]
      const records = data?.[table] || []

      for (const record of records) {
        const id = String(record?.[keyCol] ?? "")
        if (!id) continue

        const key = fullKeyOf(table, id)
        liveKeys.add(key)
        observed.add(key)
        const value = JSON.stringify(record)
        await driver.put(key, value, env)
      }
    }

    // 清理本快照中已不存在的键（删除的实体 / 改名的键）
    // 一次全局 list 代替逐表 list（6 张表 = 6 次），见 groupKeysByTable
    //
    // QS-1：KV 族（kv / cfkv）的 list 是最终一致的，可能暂时漏报其他实例刚写入的
    // 键。若把「不在 list 里」当成「不存在」，反过来还会把「在 list 里但不在快照
    // 里」的键当作陈旧键删掉 —— 而那个键恰恰是因为刚才的 load 漏报才不在快照里，
    // 结果是用户/存储记录被静默永久删除（审计 3/3 复现）。
    //
    // 因此对这类驱动只删除「本实例此前确实观察过」的键：正常删除（管理员删实体）
    // 仍然是「load 时见过 → save 时不在快照里 → 删除」，语义不变；而被漏报、
    // 本实例从未见过的真实键退化为「残留」，绝不会被误删（残留可被下一次成功
    // 保存或人工清理收敛）。
    let skipped = 0
    const grouped = groupKeysByTable(await driver.list("", env))
    for (const table of TABLE_NAMES) {
      for (const key of grouped[table]) {
        if (liveKeys.has(key)) continue
        // 注意：必须在「加入 observed」之前判断 —— 一旦先把 list 里的键记为已观察，
        // 护栏就退化成「list 即事实」，QS-1 的误删会原样复现。
        const wasObserved = observed.has(key)
        if (mayUnderReport && !wasObserved) {
          skipped += 1
          continue
        }
        await driver.delete(key, env)
        observed.delete(key)
      }
    }
    if (skipped > 0) {
      console.warn(
        `[keyFormat] skipped deleting ${skipped} stale key(s) that this ` +
          `instance never observed: the driver's list view may be incomplete ` +
          `(eventually consistent KV). They will be cleaned up once observed.`,
      )
    }

    return true
  },
  
  async getTable(table: string, driver: Driver, env?: any): Promise<any[]> {
    const prefix = tablePrefix(table)
    const keys = await driver.list(prefix, env)

    const records = []
    for (const key of keys) {
      const raw = await driver.get(key, env)
      if (raw) {
        try {
          records.push(JSON.parse(raw))
        } catch (err) {
          console.warn(`[keyFormat] Failed to parse ${key}:`, err)
        }
      }
    }

    return records
  },

  async saveTable(
    table: string,
    records: any[],
    driver: Driver,
    env?: any
  ): Promise<void> {
    const keyCol = TABLE_KEY[table as keyof typeof TABLE_KEY]
    const prefix = tablePrefix(table)

    // 清空旧数据
    const oldKeys = await driver.list(prefix, env)
    for (const key of oldKeys) {
      await driver.delete(key, env)
    }

    // 写入新数据
    for (const record of records) {
      const id = String(record?.[keyCol] ?? "")
      if (!id) continue

      const key = fullKeyOf(table, id)
      const value = JSON.stringify(record)
      await driver.put(key, value, env)
    }
  },

  async getRecord(
    table: string,
    key: string,
    driver: Driver,
    env?: any
  ): Promise<any | null> {
    const fullKey = fullKeyOf(table, key)
    const raw = await driver.get(fullKey, env)
    if (!raw) return null

    try {
      return JSON.parse(raw)
    } catch (err) {
      console.warn(`[keyFormat] Failed to parse ${fullKey}:`, err)
      return null
    }
  },

  async saveRecord(
    table: string,
    key: string,
    record: any,
    driver: Driver,
    env?: any
  ): Promise<void> {
    const fullKey = fullKeyOf(table, key)
    const value = JSON.stringify(record)
    await driver.put(fullKey, value, env)
  },

  async deleteRecord(
    table: string,
    key: string,
    driver: Driver,
    env?: any
  ): Promise<void> {
    const fullKey = fullKeyOf(table, key)
    await driver.delete(fullKey, env)
  },
}
