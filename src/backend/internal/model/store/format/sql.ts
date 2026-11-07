/**
 * SQL 格式适配器（列式表，与 Go 后端完全一致）。
 *
 * 每个字段对应一列，表结构由 schema.ts 的 TABLES 定义。字段名对齐 Go 的
 * json tag，表名通过 TABLE_SQL_NAMES 映射为 Go 的复数名并加上固定前缀 "x_"
 * 前缀（默认 x_），因此 D1 / MySQL 中的表结构与 Go 的 GORM 建表结果一致。
 */
import type { FormatAdapter, Driver } from "../types"
import {
  TABLE_NAMES,
  TABLE_KEY,
  TABLES,
  TableName,
  tableSqlName,
  rowToEntity,
  entityToRow,
} from "../schema"

const INIT_MARK = "openlist_config"

/**
 * 单条 SQL 语句允许的最大绑定参数个数。
 *
 * Cloudflare D1 与 Durable Objects SQLite 的硬上限均为 100（官方 limits：
 * "Maximum bound parameters per query: 100"；D1 的 batch 里该上限按**每条
 * 语句**分别计算，实测 101 个占位符即报 "too many SQL variables"）。
 *
 * 旧实现为每张表只生成一条 `DELETE ... WHERE key NOT IN (?,?,...)`，占位符
 * 数量等于该表实体数：metas / settings / shares 超过 100 行后，每次 save 都
 * 会因超限整单失败（saveDb 回滚内存，配置无法落盘，且每次都在同一点失败）。
 *
 * 这里取 90 留出余量，并保证 save() 生成的**任何**单条语句参数数 ≤ 该值。
 */
const MAX_BOUND_PARAMS = 90

/** 把数组切成每块不超过 size 个元素的块（用于按参数预算分批）。 */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

function quote(name: string): string {
  return "`" + name + "`"
}

/**
 * 生成 UPSERT 语句。
 *
 * SQLite（D1 / DO）与 MySQL 语法不同，必须按方言分支：
 *   - SQLite: INSERT OR REPLACE INTO ...
 *   - MySQL:  INSERT INTO ... ON DUPLICATE KEY UPDATE ...
 *
 * 驱动名即方言标识：d1 / do 为 SQLite，mysql 为 MySQL。
 */
function upsertSql(
  table: string,
  columns: string[],
  params: any[],
  driver: Driver,
): { sql: string; params: any[] } {
  const cols = columns.map((c) => quote(c)).join(", ")
  const placeholders = columns.map(() => "?").join(", ")

  if (driver.name === "mysql") {
    // MySQL 无 INSERT OR REPLACE；用 ON DUPLICATE KEY UPDATE 覆盖全部非主键列。
    // 主键列不参与 UPDATE（写回自身无意义），其余列以 VALUES(col) 覆盖。
    const updates = columns
      .slice(1)
      .map((c) => `${quote(c)} = VALUES(${quote(c)})`)
      .join(", ")
    const sql = updates
      ? `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`
      : `INSERT INTO ${table} (${cols}) VALUES (${placeholders})`
    return { sql, params }
  }

  return {
    sql: `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`,
    params,
  }
}

/** 带前缀+复数的完整表名（含反引号）。 */
function qn(table: TableName, env?: any): string {
  return quote(tableSqlName(table, env))
}

/** 列名列表（含反引号）。 */
function cols(table: TableName): string {
  return TABLES[table].columns.map((c) => quote(c.name)).join(", ")
}

/**
 * 探测哪些数据表已有行（带前缀的表名，用于错误信息）。
 *
 * 只在「schema_info 标记缺失」时调用，用于区分「真正的全新空库」与
 * 「有数据但标记从未写成」。`LIMIT 1` 保证探测代价与表大小无关。
 */
async function findTablesWithRows(
  query: (sql: string, params: any[], env?: any) => Promise<any[]>,
  env?: any,
): Promise<string[]> {
  const populated: string[] = []
  for (const table of TABLE_NAMES) {
    const rows = await query(`SELECT 1 FROM ${qn(table, env)} LIMIT 1`, [], env)
    if (rows.length > 0) populated.push(tableSqlName(table, env))
  }
  return populated
}

export const sqlFormat: FormatAdapter = {
  name: "sql",

  async load(driver: Driver, env?: any): Promise<any | null> {
    if (!driver.query) {
      throw new Error(`Driver ${driver.name} does not support SQL queries`)
    }
    const query = driver.query

    // 检查是否已初始化（schema_info 为 TS 内部标记表，不加前缀）
    const marks = await query(
      "SELECT v FROM schema_info WHERE k = ?",
      [INIT_MARK],
      env,
    )
    if (!marks || marks.length === 0) {
      // 标记缺失 ≠ 全新空库。
      //
      // 历史缺陷：仅凭 schema_info 判定初始化，而标记是 save() 写入序列的
      // **最后**一条语句。d1 的 batch 按 100 条语句分片且跨片不原子：首次保存
      // 中途失败（数据行已提交、标记永远缺失）后，load 返回 null，loadDb 走
      // 「读取成功但后端为空」分支（loadError=null）→ 匿名 /init/setup 放行
      // → 以 force 保存覆盖原有数据。
      //
      // 因此这里补一次「数据表是否已有行」的探测：有数据就抛错（比照 map.ts
      // 对损坏配置抛错的策略），loadDb 会记录 dbLastLoadError，初始化接口据此
      // 拒绝；真正的全新空库（所有表均为空）仍返回 null，正常初始化不受影响。
      const populated = await findTablesWithRows(query, env)
      if (populated.length > 0) {
        throw new Error(
          `[sqlFormat] init marker "${INIT_MARK}" is missing from schema_info, ` +
            `but table(s) ${populated.join(", ")} already contain rows. ` +
            `Refusing to treat this database as a brand-new empty one: doing so ` +
            `would re-open anonymous /init/setup and let it overwrite existing ` +
            `data. Restore the marker (or a backup), or explicitly remove the ` +
            `stale tables if the data is intentionally discarded.`,
        )
      }
      return null
    }

    const out: Record<string, any> = {}

    for (const table of TABLE_NAMES) {
      const rows = await query(`SELECT * FROM ${qn(table, env)}`, [], env)
      out[table] = rows.map((r: any) => rowToEntity(table, r))
    }

    return out
  },

  async save(data: any, driver: Driver, env?: any): Promise<boolean> {
    if (!driver.batch) {
      throw new Error(`Driver ${driver.name} does not support batch operations`)
    }

    const statements: Array<{ sql: string; params: any[] }> = []

    // 标记**先行**（F-084）：初始化标记必须是写入序列的第一条语句。
    //
    // 历史实现把它 push 在全部表语句之后：d1 的 batch 按 100 条语句分片且
    // 「片内原子、跨片不原子」，首次保存时标记落在最后一片，任一片失败都会
    // 留下「数据已提交、标记永远缺失」的库 —— load 返回 null，系统把它当成
    // 全新空库，重新打开匿名 /init/setup 接管与清库路径。
    //
    // 放到首位后，标记与首批数据位于同一片（片内原子）：该片失败则什么都没写
    // （仍可安全地按全新库初始化）；该片成功则标记必然存在，后续片失败最多
    // 留下「部分更新 + 已初始化」，由下一次 save 幂等收敛，而不会被误判为空库。
    statements.push(
      upsertSql(
        quote("schema_info"),
        ["k", "v"],
        [INIT_MARK, String(Date.now())],
        driver,
      ),
    )

    // 策略：**UPSERT 每行 + 删除已不存在的行**，而非「先清空再插入」。
    //
    // 为什么不用 DELETE 全表：DELETE 与 INSERT 之间存在「表为空」的窗口，
    // 若批量执行中途失败，数据会整体丢失；与 Go 后端共享同一物理库时，
    // DELETE 还会清掉 Go 侧并发写入的行。
    //
    // UPSERT 保证既有行先被覆盖（不丢数据），再删除本端不再持有的键。
    // 注意：仍需按主键比对以删除"本端删除了的记录"，且该删除是必要的，
    // 否则历史残留行不会被清理。
    for (const table of TABLE_NAMES) {
      const keyCol = TABLE_KEY[table]
      const entities: any[] = data?.[table] || []
      const keepKeys: string[] = []

      for (const entity of entities) {
        const { columns, values } = entityToRow(table, entity)
        const upsert = upsertSql(qn(table, env), columns, values, driver)
        statements.push({ sql: upsert.sql, params: upsert.params })

        const pk = entity?.[keyCol]
        if (pk !== undefined && pk !== null) keepKeys.push(String(pk))
      }

      // 删除本端已移除的行（keys 为空则整表清空，与原语义一致）
      if (keepKeys.length === 0) {
        statements.push({ sql: `DELETE FROM ${qn(table, env)}`, params: [] })
      } else if (keepKeys.length <= MAX_BOUND_PARAMS) {
        // 常规规模：一条 NOT IN 即可，参数数 ≤ MAX_BOUND_PARAMS，行为不变。
        statements.push({
          sql: `DELETE FROM ${qn(table, env)} WHERE ${quote(keyCol)} NOT IN (${keepKeys
            .map(() => "?")
            .join(", ")})`,
          params: keepKeys,
        })
      } else {
        // 大表（> MAX_BOUND_PARAMS 行）：单条 NOT IN 的占位符数会超过
        // D1 / DO 的单语句 100 参数硬上限，整次保存必然失败（F-083）。
        //
        // 改成：先 SELECT 既有主键，在 JS 侧与 keepKeys 求差集，再把**需要
        // 删除**的键按 ≤ MAX_BOUND_PARAMS 一组用 `DELETE ... WHERE key IN (?)`
        // 分片。每条语句的参数数都在上限内，且语义与 NOT IN 等价。
        //
        // 代价是这类表多一次「只读主键列」的查询（仅在大表保存时发生）。
        if (!driver.query) {
          throw new Error(
            `Driver ${driver.name} does not support SQL queries, which are ` +
              `required to delete stale rows of "${table}" without exceeding ` +
              `the ${MAX_BOUND_PARAMS}-bound-parameter limit per statement`,
          )
        }
        const existing = await driver.query(
          `SELECT ${quote(keyCol)} FROM ${qn(table, env)}`,
          [],
          env,
        )
        const keep = new Set(keepKeys)
        const stale: any[] = []
        for (const row of existing) {
          const value = row?.[keyCol]
          if (value === undefined || value === null) continue
          if (!keep.has(String(value))) stale.push(value)
        }
        for (const group of chunk(stale, MAX_BOUND_PARAMS)) {
          statements.push({
            sql: `DELETE FROM ${qn(table, env)} WHERE ${quote(keyCol)} IN (${group
              .map(() => "?")
              .join(", ")})`,
            params: group,
          })
        }
      }
    }

    await driver.batch(statements, env)
    return true
  },

  async getTable(table: string, driver: Driver, env?: any): Promise<any[]> {
    if (!driver.query) {
      throw new Error(`Driver ${driver.name} does not support SQL queries`)
    }
    const t = table as TableName
    const rows = await driver.query(`SELECT * FROM ${qn(t, env)}`, [], env)
    return rows.map((r: any) => rowToEntity(t, r))
  },

  async saveTable(
    table: string,
    records: any[],
    driver: Driver,
    env?: any,
  ): Promise<void> {
    if (!driver.batch) {
      throw new Error(`Driver ${driver.name} does not support batch operations`)
    }
    const t = table as TableName

    const statements: Array<{ sql: string; params: any[] }> = [
      { sql: `DELETE FROM ${qn(t, env)}`, params: [] },
    ]

    for (const entity of records) {
      const { columns, values } = entityToRow(t, entity)
      const placeholders = columns.map(() => "?").join(", ")
      const sql = `INSERT INTO ${qn(t, env)} (${columns
        .map((c) => quote(c))
        .join(", ")}) VALUES (${placeholders})`
      statements.push({ sql, params: values })
    }

    await driver.batch(statements, env)
  },

  async getRecord(
    table: string,
    key: string,
    driver: Driver,
    env?: any,
  ): Promise<any | null> {
    if (!driver.query) {
      throw new Error(`Driver ${driver.name} does not support SQL queries`)
    }
    const t = table as TableName
    const keyCol = TABLE_KEY[t]
    const rows = await driver.query(
      `SELECT * FROM ${qn(t, env)} WHERE ${quote(keyCol)} = ?`,
      [key],
      env,
    )
    return rows.length > 0 ? rowToEntity(t, rows[0]) : null
  },

  async saveRecord(
    table: string,
    key: string,
    record: any,
    driver: Driver,
    env?: any,
  ): Promise<void> {
    if (!driver.execute) {
      throw new Error(`Driver ${driver.name} does not support SQL execution`)
    }
    const t = table as TableName
    void key

    const { columns, values } = entityToRow(t, record)
    // 方言兼容的 UPSERT（SQLite: INSERT OR REPLACE / MySQL: ON DUPLICATE KEY UPDATE）
    const { sql } = upsertSql(qn(t, env), columns, values, driver)

    await driver.execute(sql, values, env)
  },

  async deleteRecord(
    table: string,
    key: string,
    driver: Driver,
    env?: any,
  ): Promise<void> {
    if (!driver.execute) {
      throw new Error(`Driver ${driver.name} does not support SQL execution`)
    }
    const t = table as TableName
    const keyCol = TABLE_KEY[t]
    await driver.execute(
      `DELETE FROM ${qn(t, env)} WHERE ${quote(keyCol)} = ?`,
      [key],
      env,
    )
  },
}
