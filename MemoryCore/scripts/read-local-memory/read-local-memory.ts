#!/usr/bin/env npx tsx
/**
 * 本地 Memory 数据查询脚本
 *
 * 查询 memory-tdai 目录下的记忆数据，支持：
 *   - 按层级（L0~L3）查询
 *   - L0/L1 从 SQLite（vectors.db）读取
 *   - 时间范围过滤（--since / --until）
 *   - 字段过滤（--filter，仅支持 SQLite 表的直接列）
 *   - 排序、分页（下推到 SQL 层）
 *   - 多种输出格式（table / json / jsonl）
 *
 * @example
 *   npx tsx read-local-memory.ts -d ./memory-tdai示例数据
 *   npx tsx read-local-memory.ts -d ./memory-tdai示例数据 -L L0 --since 7d
 *   npx tsx read-local-memory.ts -d ./memory-tdai示例数据 -L L1 -f 'type=persona'
 */

import { createRequire } from "node:module"
import type { DatabaseSync } from "node:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

const require = createRequire(import.meta.url)

function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite")
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type Level = "L0" | "L1" | "L2" | "L3"
type SortDirection = "asc" | "desc"
type OutputFormat = "table" | "json" | "jsonl"

interface CliOptions {
  dataDir: string
  level?: Level
  since?: string
  until?: string
  limit: number
  offset: number
  sort: SortDirection
  filter?: string
  format: OutputFormat
  file?: string  // L2 单文件详情查询：指定文件名，只返回该文件的完整内容
}

interface FilterCondition {
  field: string
  operator: "=" | "!=" | ">=" | "<=" | ">" | "<"
  value: string
}

interface L2Meta {
  created: string
  updated: string
  summary: string
  heat: number
  [key: string]: string | number
}

interface L2Entry {
  fileName: string
  meta: L2Meta
  body: string
}

interface QueryResult<T> {
  level: string
  total: number
  offset: number
  limit: number
  sort: SortDirection
  filter: Record<string, string> | null
  data: T[]
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const SQLITE_DB_NAME = "vectors.db"

const LEVEL_DIRS: Record<string, string> = {
  L2: "scene_blocks",
  L3: "persona.md",
}

/** L0 表的允许过滤列（白名单防 SQL 注入） */
const L0_FILTER_COLUMNS = new Set([
  "record_id", "session_key", "session_id", "role", "message_text", "recorded_at", "timestamp",
])

/** L1 表的允许过滤列（白名单防 SQL 注入） */
const L1_FILTER_COLUMNS = new Set([
  "record_id", "content", "type", "priority", "scene_name",
  "session_key", "session_id", "timestamp_str", "timestamp_start", "timestamp_end",
  "created_time", "updated_time", "metadata_json",
])

/** 驼峰字段名 → SQLite 列名映射（用户用驼峰过滤，内部转成 SQL 列名） */
const CAMEL_TO_COLUMN: Record<string, string> = {
  id: "record_id",
  recordId: "record_id",
  sessionKey: "session_key",
  sessionId: "session_id",
  messageText: "message_text",
  recordedAt: "recorded_at",
  sceneName: "scene_name",
  timestampStr: "timestamp_str",
  timestampStart: "timestamp_start",
  timestampEnd: "timestamp_end",
  createdAt: "created_time",
  updatedAt: "updated_time",
  metadataJson: "metadata_json",
}

const META_START = "-----META-START-----"
const META_END = "-----META-END-----"

const RELATIVE_TIME_RE = /^(\d+)(d|h|m|s)$/

const HELP_TEXT = `
📖  Local Memory query script (SQLite mode)

Usage:
  npx tsx read-local-memory.ts -d <Data directory> [Options]

The data directory must contain vectors.db (SQLite), which stores L0/L1 data.

Options:
  -d, --data-dir <path>    Local memory-tdai data directory (required; must contain vectors.db)
  -L, --level <level>       Query level: L0 / L1 / L2 / L3 (all if omitted)
      --since <time>       Start time (ISO string or relative expression, e.g. 7d, 24h, 30m)
      --until <time>       End time (same format as since)
  -l, --limit <count>       Results per page (default: 50)
      --offset <offset>      Page offset (default: 0)
      --sort <direction>        Sort: desc (newest first) / asc (oldest first), default: desc
  -f, --filter <expression>    Filter direct table columns only (e.g. role=user, type=persona, priority>=80)
                           Supports camelCase or snake_case columns; comma-separate multiple conditions
      --format <format>      Output: table / json / jsonl(default: table)
  -h, --help               Show help

L0 Filterable columns: record_id, session_key, session_id, role, message_text, recorded_at, timestamp
L1 Filterable columns: record_id, content, type, priority, scene_name, session_key, session_id,
             timestamp_str, timestamp_start, timestamp_end, created_time, updated_time

Examples:
  # View all levels
  npx tsx read-local-memory.ts -d ./memory-tdai-sample-data

  # Query L0 conversations from the last 7 days
  npx tsx read-local-memory.ts -d ./memory-tdai-sample-data -L L0 --since 7d

  # Query L1 memories of type persona
  npx tsx read-local-memory.ts -d ./memory-tdai-sample-data -L L1 -f 'type=persona'

  # L0 pagination: page 2 (20 records per page)
  npx tsx read-local-memory.ts -d ./memory-tdai-sample-data -L L0 -l 20 --offset 20

  # Output as JSON
  npx tsx read-local-memory.ts -d ./memory-tdai-sample-data -L L0 --since 7d --format json
`.trim()

// ─────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string", short: "d" },
      level:      { type: "string", short: "L" },
      since:      { type: "string" },
      until:      { type: "string" },
      limit:      { type: "string", short: "l" },
      offset:     { type: "string" },
      sort:       { type: "string" },
      filter:     { type: "string", short: "f" },
      format:     { type: "string" },
      file:       { type: "string" },
      help:       { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values.help) {
    console.log(HELP_TEXT)
    process.exit(0)
  }

  const dataDir = values["data-dir"]
  if (!dataDir) {
    console.error("❌  Missing required arguments: --data-dir (-d)")
    console.error('   Use --help for usage')
    process.exit(1)
  }

  const resolvedDir = path.resolve(dataDir)
  if (!fs.existsSync(resolvedDir)) {
    console.error(`❌  Data directorydoes not exist: ${resolvedDir}`)
    process.exit(1)
  }

  const level = values.level?.toUpperCase() as Level | undefined
  if (level && !["L0", "L1", "L2", "L3"].includes(level)) {
    console.error(`❌  Invalid level: ${values.level}   (options: L0, L1, L2, L3)`)
    process.exit(1)
  }

  const sort = (values.sort?.toLowerCase() ?? "desc") as SortDirection
  if (!["asc", "desc"].includes(sort)) {
    console.error(`❌  Invalid sort direction: ${values.sort}   (options: asc, desc)`)
    process.exit(1)
  }

  const format = (values.format?.toLowerCase() ?? "table") as OutputFormat
  if (!["table", "json", "jsonl"].includes(format)) {
    console.error(`❌  Invalid output format: ${values.format}   (options: table, json, jsonl)`)
    process.exit(1)
  }

  const limit = values.limit ? parseInt(values.limit, 10) : 50
  const offset = values.offset ? parseInt(values.offset, 10) : 0

  if (isNaN(limit) || limit < 1) {
    console.error(`❌  Invalid limit: ${values.limit}`)
    process.exit(1)
  }
  if (isNaN(offset) || offset < 0) {
    console.error(`❌  Invalid offset: ${values.offset}`)
    process.exit(1)
  }

  return {
    dataDir: resolvedDir,
    level,
    since: values.since,
    until: values.until,
    limit,
    offset,
    sort,
    filter: values.filter,
    format,
    file: values.file,
  }
}

// ─────────────────────────────────────────────
// Time Parsing
// ─────────────────────────────────────────────

/** 将时间表达式解析为 Date 对象。支持 ISO 字符串或相对表达式（7d / 24h / 30m / 60s） */
function parseTimeExpr(expr: string): Date {
  const match = expr.match(RELATIVE_TIME_RE)
  if (match) {
    const [, numStr, unit] = match
    const num = parseInt(numStr, 10)
    const now = Date.now()
    const ms: Record<string, number> = {
      d: 86_400_000,
      h: 3_600_000,
      m: 60_000,
      s: 1_000,
    }
    return new Date(now - num * ms[unit])
  }

  const date = new Date(expr)
  if (isNaN(date.getTime())) {
    console.error(`❌  Cannot parse time: ${expr}`)
    process.exit(1)
  }
  return date
}

/** 将 L0 的 epoch ms 或 L1 的 ISO 字符串统一转换为 Date */
function toDate(value: unknown): Date | null {
  if (typeof value === "number") return new Date(value)
  if (typeof value === "string") {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

// ─────────────────────────────────────────────
// Filter Parsing
// ─────────────────────────────────────────────

const FILTER_OPERATORS = [">=", "<=", "!=", ">", "<", "="] as const

/** SQL 操作符映射（!= → <> for SQLite） */
const SQL_OPERATOR_MAP: Record<string, string> = {
  "=": "=",
  "!=": "<>",
  ">=": ">=",
  "<=": "<=",
  ">": ">",
  "<": "<",
}

function parseFilterExpr(expr: string): FilterCondition[] {
  return expr.split(",").map((part) => {
    const trimmed = part.trim()
    for (const op of FILTER_OPERATORS) {
      const idx = trimmed.indexOf(op)
      if (idx > 0) {
        return {
          field: trimmed.slice(0, idx).trim(),
          operator: op as FilterCondition["operator"],
          value: trimmed.slice(idx + op.length).trim(),
        }
      }
    }
    console.error(`❌  Cannot parse filter: ${trimmed}`)
    process.exit(1)
  })
}

/** 将用户传入的字段名解析为 SQLite 列名（支持驼峰和蛇形） */
function resolveColumnName(field: string, allowedColumns: Set<string>): string {
  // 直接匹配蛇形列名
  if (allowedColumns.has(field)) return field
  // 尝试驼峰转换
  const mapped = CAMEL_TO_COLUMN[field]
  if (mapped && allowedColumns.has(mapped)) return mapped
  return field // 返回原值，后续校验会报错
}

/** 校验过滤条件的列名是否在白名单中 */
function validateFilterColumns(conditions: FilterCondition[], allowedColumns: Set<string>, level: string): void {
  for (const c of conditions) {
    const col = resolveColumnName(c.field, allowedColumns)
    if (!allowedColumns.has(col)) {
      console.error(`❌  ${level} Unsupported filter field: ${c.field}`)
      console.error(`   Available fields: ${[...allowedColumns].join(", ")}`)
      process.exit(1)
    }
  }
}

function filtersToRecord(conditions: FilterCondition[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const c of conditions) {
    result[c.field] = `${c.operator}${c.value}`
  }
  return result
}

function filtersToDisplayString(conditions: FilterCondition[]): string {
  return conditions.map((c) => `${c.field}${c.operator}${c.value}`).join(", ")
}

// ─────────────────────────────────────────────
// SQLite Helpers
// ─────────────────────────────────────────────

/** 只读打开 SQLite 数据库 */
function openSqliteReadonly(dbPath: string): DatabaseSync {
  const { DatabaseSync: DbSync } = requireNodeSqlite()
  const db = new DbSync(dbPath, { open: false })
  // node:sqlite 没有直接的 readOnly 选项，用 query_only pragma 保证只读
  db.open()
  db.exec("PRAGMA query_only = ON")
  return db
}

interface SqlQueryResult {
  total: number
  records: Record<string, unknown>[]
}

/**
 * 构建 WHERE 子句（时间过滤 + 字段过滤），返回 SQL 片段和参数。
 * 所有过滤条件通过参数化查询绑定，防止 SQL 注入。
 */
function buildWhereClause(
  level: "L0" | "L1",
  sinceDate: Date | null,
  untilDate: Date | null,
  filterConditions: FilterCondition[] | null,
): { whereClause: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  const allowedColumns = level === "L0" ? L0_FILTER_COLUMNS : L1_FILTER_COLUMNS

  // 时间过滤
  if (level === "L0") {
    // L0: timestamp 是 epoch ms (INTEGER)
    if (sinceDate) {
      clauses.push("timestamp >= ?")
      params.push(sinceDate.getTime())
    }
    if (untilDate) {
      clauses.push("timestamp <= ?")
      params.push(untilDate.getTime())
    }
  } else {
    // L1: updated_time 是 ISO 字符串 (TEXT)
    if (sinceDate) {
      clauses.push("updated_time >= ?")
      params.push(sinceDate.toISOString())
    }
    if (untilDate) {
      clauses.push("updated_time <= ?")
      params.push(untilDate.toISOString())
    }
  }

  // 字段过滤
  if (filterConditions) {
    for (const c of filterConditions) {
      const col = resolveColumnName(c.field, allowedColumns)
      const sqlOp = SQL_OPERATOR_MAP[c.operator]
      clauses.push(`${col} ${sqlOp} ?`)
      // 如果值可解析为数字且列是数字类型，传数字；否则传字符串
      const numVal = Number(c.value)
      params.push(!isNaN(numVal) && c.value.trim() !== "" ? numVal : c.value)
    }
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
  return { whereClause, params }
}

/** L0 SQLite 行 → 驼峰命名输出对象 */
function mapL0Row(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.record_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    role: row.role,
    content: row.message_text,
    recordedAt: row.recorded_at,
    timestamp: row.timestamp,
  }
}

/** L1 SQLite 行 → 驼峰命名输出对象 */
function mapL1Row(row: Record<string, unknown>): Record<string, unknown> {
  const metadataRaw = row.metadata_json as string
  let metadata: unknown = {}
  try {
    metadata = metadataRaw ? JSON.parse(metadataRaw) : {}
  } catch {
    metadata = {}
  }

  const timestamps = [
    ...(new Set(
      [row.timestamp_str, row.timestamp_start, row.timestamp_end]
        .filter(Boolean) as string[]
    ))
  ]

  return {
    id: row.record_id,
    content: row.content,
    type: row.type,
    priority: row.priority,
    scene_name: row.scene_name,
    source_message_ids: [],
    metadata,
    timestamps,
    createdAt: row.created_time || "",
    updatedAt: row.updated_time || "",
    sessionKey: row.session_key || "",
    sessionId: row.session_id || "",
  }
}

function querySqlite(db: DatabaseSync, level: "L0" | "L1", opts: CliOptions): SqlQueryResult {
  const table = level === "L0" ? "l0_conversations" : "l1_records"
  const timeCol = level === "L0" ? "timestamp" : "updated_time"
  const allowedColumns = level === "L0" ? L0_FILTER_COLUMNS : L1_FILTER_COLUMNS

  const sinceDate = opts.since ? parseTimeExpr(opts.since) : null
  const untilDate = opts.until ? parseTimeExpr(opts.until) : null

  let filterConditions: FilterCondition[] | null = null
  if (opts.filter) {
    filterConditions = parseFilterExpr(opts.filter)
    validateFilterColumns(filterConditions, allowedColumns, level)
  }

  const { whereClause, params } = buildWhereClause(level, sinceDate, untilDate, filterConditions)

  // 查总数
  const countSql = `SELECT COUNT(*) AS cnt FROM ${table} ${whereClause}`
  const countRow = db.prepare(countSql).get(...params) as { cnt: number }
  const total = countRow.cnt

  // 查数据（排序 + 分页）
  const sortDir = opts.sort === "asc" ? "ASC" : "DESC"
  const dataSql = `SELECT * FROM ${table} ${whereClause} ORDER BY ${timeCol} ${sortDir} LIMIT ? OFFSET ?`
  const dataParams: (string | number)[] = [...params, opts.limit, opts.offset]
  const rows = db.prepare(dataSql).all(...dataParams) as Record<string, unknown>[]

  // 映射为驼峰命名
  const mapFn = level === "L0" ? mapL0Row : mapL1Row
  const records = rows.map(mapFn)

  return { total, records }
}

// ─────────────────────────────────────────────
// Query: L0 / L1 (SQLite)
// ─────────────────────────────────────────────

function querySqliteLevel(db: DatabaseSync, opts: CliOptions, level: "L0" | "L1") {
  const { total, records: paged } = querySqlite(db, level, opts)

  const timeField = level === "L0" ? "timestamp" : "updatedAt"
  const levelLabel = level === "L0" ? "conversations" : "records"

  let filterConditions: FilterCondition[] | null = null
  if (opts.filter) {
    filterConditions = parseFilterExpr(opts.filter)
  }
  const filterRecord = filterConditions ? filtersToRecord(filterConditions) : null
  const filterDisplay = filterConditions ? filtersToDisplayString(filterConditions) : ""
  const sinceInfo = opts.since ? `since=${opts.since}` : ""
  const untilInfo = opts.until ? `until=${opts.until}` : ""
  const filterParts = [filterDisplay, sinceInfo, untilInfo].filter(Boolean)

  if (opts.format === "json") {
    const result: QueryResult<Record<string, unknown>> = {
      level,
      total,
      offset: opts.offset,
      limit: opts.limit,
      sort: opts.sort,
      filter: filterRecord,
      data: paged,
    }
    console.log(JSON.stringify(result))
    return
  }

  if (opts.format === "jsonl") {
    for (const record of paged) {
      console.log(JSON.stringify(record))
    }
    return
  }

  // ── table 格式 ──
  const rangeStart = total === 0 ? 0 : opts.offset + 1
  const rangeEnd = Math.min(opts.offset + opts.limit, total)

  console.log()
  console.log(`📊  Query results:${level} ${levelLabel} (SQLite)`)
  console.log(`   Total records: ${total}`)
  console.log(`   Current page: ${rangeStart}-${rangeEnd} / ${total} (by ${timeField} ${opts.sort === "desc" ? "Descending" : "Ascending"})`)
  if (filterParts.length > 0) {
    console.log(`   Filter: ${filterParts.join(", ")}`)
  }
  console.log()

  if (paged.length === 0) {
    console.log("   (No matching data)")
    console.log()
    return
  }

  if (level === "L0") {
    renderL0Table(paged)
  } else {
    renderL1Table(paged)
  }
}

/** 截断字符串并添加省略号 */
function truncate(str: string, maxLen: number): string {
  if (!str) return ""
  const clean = str.replace(/\n/g, "↵").replace(/\r/g, "")
  if (clean.length <= maxLen) return clean
  return clean.slice(0, maxLen - 1) + "…"
}

/** 计算字符串的显示宽度（CJK 字符占 2 宽） */
function displayWidth(str: string): number {
  let width = 0
  for (const char of str) {
    const code = char.codePointAt(0)!
    // CJK Unified Ideographs / fullwidth / common CJK ranges
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK 基本
      (code >= 0x3000 && code <= 0x303f) ||   // CJK 标点
      (code >= 0xff00 && code <= 0xffef) ||   // 全角
      (code >= 0x3400 && code <= 0x4dbf) ||   // CJK 扩展A
      (code >= 0x20000 && code <= 0x2a6df) || // CJK 扩展B
      (code >= 0xf900 && code <= 0xfaff)      // CJK 兼容
    ) {
      width += 2
    } else {
      width += 1
    }
  }
  return width
}

/** 将字符串右填充到指定显示宽度 */
function padEnd(str: string, targetWidth: number): string {
  const diff = targetWidth - displayWidth(str)
  return diff > 0 ? str + " ".repeat(diff) : str
}

/** 将字符串居中到指定显示宽度 */
function padCenter(str: string, targetWidth: number): string {
  const diff = targetWidth - displayWidth(str)
  if (diff <= 0) return str
  const left = Math.floor(diff / 2)
  const right = diff - left
  return " ".repeat(left) + str + " ".repeat(right)
}

/** 打印表格 */
function printTable(headers: string[], rows: string[][], colWidths: number[]) {
  const hLine = (left: string, mid: string, right: string, fill: string) =>
    left + colWidths.map((w) => fill.repeat(w + 2)).join(mid) + right

  console.log(hLine("┌", "┬", "┐", "─"))

  const headerRow = headers.map((h, i) => ` ${padCenter(h, colWidths[i])} `).join("│")
  console.log(`│${headerRow}│`)

  console.log(hLine("├", "┼", "┤", "─"))

  for (const row of rows) {
    const line = row.map((cell, i) => ` ${padEnd(cell, colWidths[i])} `).join("│")
    console.log(`│${line}│`)
  }

  console.log(hLine("└", "┴", "┘", "─"))
}

/** 格式化时间为可读字符串 */
function formatTime(value: unknown): string {
  const date = toDate(value)
  if (!date) return String(value ?? "")
  const y = date.getFullYear()
  const M = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const h = String(date.getHours()).padStart(2, "0")
  const m = String(date.getMinutes()).padStart(2, "0")
  return `${y}-${M}-${d} ${h}:${m}`
}

// ─────────────────────────────────────────────
// File I/O Helpers (L2 Markdown)
// ─────────────────────────────────────────────

/** 读取并解析 L2 Markdown 文件（含 META 头） */
function parseL2File(filePath: string): L2Entry {
  const content = fs.readFileSync(filePath, "utf-8")
  const fileName = path.basename(filePath)

  const startIdx = content.indexOf(META_START)
  const endIdx = content.indexOf(META_END)

  const meta: L2Meta = { created: "", updated: "", summary: "", heat: 0 }
  let body = content

  if (startIdx !== -1 && endIdx !== -1) {
    const metaBlock = content.slice(startIdx + META_START.length, endIdx).trim()

    for (const line of metaBlock.split("\n")) {
      const colonIdx = line.indexOf(":")
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim()
        const val = line.slice(colonIdx + 1).trim()
        if (key === "heat") {
          meta.heat = parseInt(val, 10) || 0
        } else {
          ;(meta as Record<string, string | number>)[key] = val
        }
      }
    }

    body = content.slice(endIdx + META_END.length).trim()
  }

  return { fileName, meta, body }
}

function renderL0Table(records: Record<string, unknown>[]) {
  const headers = ["#", "timestamp", "role", "content"]
  const colWidths = [5, 18, 10, 50]

  const rows = records.map((r, i) => [
    String(i + 1),
    formatTime(r.timestamp),
    truncate(String(r.role ?? ""), 10),
    truncate(String(r.content ?? ""), 50),
  ])

  // 动态调整内容列宽（至少 30，至多 80）
  const maxContentWidth = Math.min(
    80,
    Math.max(30, ...rows.map((r) => displayWidth(r[3])))
  )
  colWidths[3] = maxContentWidth

  printTable(headers, rows, colWidths)
  console.log()
}

function renderL1Table(records: Record<string, unknown>[]) {
  const headers = ["#", "updatedAt", "type", "pri", "content"]
  const colWidths = [5, 18, 12, 4, 50]

  const rows = records.map((r, i) => [
    String(i + 1),
    formatTime(r.updatedAt),
    truncate(String(r.type ?? ""), 12),
    String(r.priority ?? ""),
    truncate(String(r.content ?? ""), 50),
  ])

  const maxContentWidth = Math.min(
    80,
    Math.max(30, ...rows.map((r) => displayWidth(r[4])))
  )
  colWidths[4] = maxContentWidth

  printTable(headers, rows, colWidths)
  console.log()
}

// ─────────────────────────────────────────────
// Query: L2 (Scene Blocks)
// ─────────────────────────────────────────────

function queryL2(opts: CliOptions) {
  const dirPath = path.join(opts.dataDir, LEVEL_DIRS.L2)

  if (!fs.existsSync(dirPath)) {
    // 目录不存在是正常业务场景（尚未产生场景数据），返回空数据
    if (opts.format === "json") {
      console.log(JSON.stringify({ level: "L2", total: 0, data: [] }))
      return
    }
    if (opts.format === "jsonl") {
      return
    }
    console.log()
    console.log(`📊  Query results:L2 scene_blocks`)
    console.log(`   (No scene data generated yet)`)
    console.log()
    return
  }

  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".md")).sort()
  const entries: L2Entry[] = files.map((f) => parseL2File(path.join(dirPath, f)))

  // --file 参数：只返回指定文件的完整内容（含 body）
  if (opts.file) {
    const target = entries.find((e) => e.fileName === opts.file)
    if (!target) {
      console.error(`❌  File does not exist: ${opts.file}`)
      process.exit(1)
    }
    if (opts.format === "json") {
      console.log(JSON.stringify({
        level: "L2",
        fileName: target.fileName,
        ...target.meta,
        body: target.body,
      }))
      return
    }
    // table / jsonl 格式直接输出文件内容
    console.log(target.body)
    return
  }

  if (opts.format === "json") {
    // 默认列表模式：只输出元信息（不含 body），避免超过 TAT 24KB 输出限制
    const result = {
      level: "L2",
      total: entries.length,
      data: entries.map(({ fileName, meta }) => ({
        fileName,
        ...meta,
      })),
    }
    console.log(JSON.stringify(result))
    return
  }

  if (opts.format === "jsonl") {
    for (const { fileName, meta, body } of entries) {
      console.log(JSON.stringify({ fileName, ...meta, body }))
    }
    return
  }

  // ── table 格式 ──
  console.log()
  console.log(`📊  Query results:L2 scene_blocks`)
  console.log(`   Total files: ${entries.length}`)
  console.log()

  if (entries.length === 0) {
    console.log("   (No scene profile files)")
    console.log()
    return
  }

  for (const { fileName, meta, body } of entries) {
    console.log(`${"─".repeat(60)}`)
    console.log(`📄  ${fileName}`)
    console.log(`   Summary : ${meta.summary}`)
    console.log(`   Heat    : ${meta.heat}`)
    console.log(`   Created : ${meta.created}`)
    console.log(`   Updated : ${meta.updated}`)
    console.log()

    // 输出正文（限制行数避免过长）
    const lines = body.split("\n")
    const maxLines = 30
    if (lines.length > maxLines) {
      console.log(lines.slice(0, maxLines).join("\n"))
      console.log(`   ... (omitted ${lines.length - maxLines} lines, total ${lines.length} lines)`)
    } else {
      console.log(body)
    }
    console.log()
  }
}

// ─────────────────────────────────────────────
// Query: L3 (Persona)
// ─────────────────────────────────────────────

function queryL3(opts: CliOptions) {
  const filePath = path.join(opts.dataDir, LEVEL_DIRS.L3)

  // 文件不存在是正常业务场景（用户还没对话、插件刚安装等），返回空数据
  if (!fs.existsSync(filePath)) {
    if (opts.format === "json") {
      console.log(JSON.stringify({ level: "L3", content: "" }))
      return
    }
    if (opts.format === "jsonl") {
      console.log(JSON.stringify({ level: "L3", content: "" }))
      return
    }
    console.log()
    console.log(`📊  Query results:L3 persona`)
    console.log(`   (Profile file not generated yet)`)
    console.log()
    return
  }

  const content = fs.readFileSync(filePath, "utf-8")

  if (opts.format === "json") {
    console.log(JSON.stringify({ level: "L3", content }))
    return
  }

  if (opts.format === "jsonl") {
    console.log(JSON.stringify({ level: "L3", content }))
    return
  }

  console.log()
  console.log(`📊  Query results:L3 persona`)
  console.log(`${"─".repeat(60)}`)
  console.log(content)
  console.log()
}

// ─────────────────────────────────────────────
// Overview: 全层级概览
// ─────────────────────────────────────────────

function showOverview(db: DatabaseSync, opts: CliOptions) {
  console.log()
  console.log(`🗂️  Memory data overview`)
  console.log(`   Data directory: ${opts.dataDir}`)
  console.log(`   Database: ${SQLITE_DB_NAME}`)
  console.log(`${"═".repeat(60)}`)

  // ── L0 ──
  try {
    const l0Count = (db.prepare("SELECT COUNT(*) AS cnt FROM l0_conversations").get() as { cnt: number }).cnt
    const l0Roles = db.prepare("SELECT role, COUNT(*) AS cnt FROM l0_conversations GROUP BY role").all() as Array<{ role: string; cnt: number }>
    const roleSummary = l0Roles.map((r) => `${r.role || "unknown"}: ${r.cnt}`).join(", ")

    console.log()
    console.log(`📂  L0 · conversations (l0_conversations)`)
    console.log(`   Total records: ${l0Count}`)
    if (roleSummary) {
      console.log(`   Role distribution: ${roleSummary}`)
    }
  } catch {
    console.log()
    console.log(`📂  L0 · conversations  (Table does not exist or query failed)`)
  }

  // ── L1 ──
  try {
    const l1Count = (db.prepare("SELECT COUNT(*) AS cnt FROM l1_records").get() as { cnt: number }).cnt
    const l1Types = db.prepare("SELECT type, COUNT(*) AS cnt FROM l1_records GROUP BY type").all() as Array<{ type: string; cnt: number }>
    const typeSummary = l1Types.map((t) => `${t.type || "unknown"}: ${t.cnt}`).join(", ")

    console.log()
    console.log(`📂  L1 · records (l1_records)`)
    console.log(`   Total records: ${l1Count}`)
    if (typeSummary) {
      console.log(`   Type distribution: ${typeSummary}`)
    }
  } catch {
    console.log()
    console.log(`📂  L1 · records  (Table does not exist or query failed)`)
  }

  // ── L2 ──
  const l2Dir = path.join(opts.dataDir, LEVEL_DIRS.L2)
  if (fs.existsSync(l2Dir)) {
    const files = fs.readdirSync(l2Dir).filter((f) => f.endsWith(".md"))
    const entries = files.map((f) => parseL2File(path.join(l2Dir, f)))
    const totalHeat = entries.reduce((sum, e) => sum + e.meta.heat, 0)

    console.log()
    console.log(`📂  L2 · scene_blocks`)
    console.log(`   File count: ${files.length}   Total heat: ${totalHeat}`)
    for (const entry of entries) {
      console.log(`   · ${entry.fileName}  (heat: ${entry.meta.heat})  ${truncate(entry.meta.summary, 40)}`)
    }
  } else {
    console.log()
    console.log(`📂  L2 · scene_blocks  (Directory does not exist)`)
  }

  // ── L3 ──
  const l3Path = path.join(opts.dataDir, LEVEL_DIRS.L3)
  if (fs.existsSync(l3Path)) {
    const content = fs.readFileSync(l3Path, "utf-8")
    const lines = content.split("\n").length
    const bytes = Buffer.byteLength(content, "utf-8")

    console.log()
    console.log(`📂  L3 · persona`)
    console.log(`   Size: ${formatBytes(bytes)}   Line count: ${lines}`)
  } else {
    console.log()
    console.log(`📂  L3 · persona  (File does not exist)`)
  }

  console.log()
  console.log(`${"═".repeat(60)}`)
  console.log(`💡  Use -L <level> for details, e.g. -L L0 --since 7d`)
  console.log()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

/** 尝试打开 SQLite 数据库，不存在时返回 null */
function tryOpenSqlite(dataDir: string): DatabaseSync | null {
  const dbPath = path.join(dataDir, SQLITE_DB_NAME)
  if (!fs.existsSync(dbPath)) {
    return null
  }
  return openSqliteReadonly(dbPath)
}

/** L0/L1 数据库不存在时返回空数据（正常业务场景：插件刚安装，尚未产生对话） */
function emptyL0L1Result(opts: CliOptions, level: "L0" | "L1") {
  if (opts.format === "json") {
    const result: QueryResult<Record<string, unknown>> = {
      level,
      total: 0,
      offset: opts.offset,
      limit: opts.limit,
      sort: opts.sort,
      filter: null,
      data: [],
    }
    console.log(JSON.stringify(result))
    return
  }
  if (opts.format === "jsonl") {
    return
  }
  const label = level === "L0" ? "conversations" : "records"
  console.log()
  console.log(`📊  Query results:${level} ${label} (SQLite)`)
  console.log(`   (Database not generated yet; no data)`)
  console.log()
}

function main() {
  const opts = parseCli()

  // L2/L3 不依赖 SQLite 数据库，直接处理
  if (opts.level === "L2") {
    queryL2(opts)
    return
  }
  if (opts.level === "L3") {
    queryL3(opts)
    return
  }

  // L0/L1/概览模式需要 SQLite
  const db = tryOpenSqlite(opts.dataDir)

  // 数据库不存在：L0/L1 返回空数据，概览模式提示
  if (!db) {
    if (opts.level === "L0" || opts.level === "L1") {
      emptyL0L1Result(opts, opts.level)
      return
    }
    // 概览模式：数据库不存在，报错退出
    console.error(`❌  SQLite Databasedoes not exist: ${path.join(opts.dataDir, SQLITE_DB_NAME)}`)
    console.error(`   Ensure the data directory contains ${SQLITE_DB_NAME}`)
    process.exit(1)
  }

  try {
    if (!opts.level) {
      showOverview(db, opts)
      return
    }

    switch (opts.level) {
      case "L0":
        querySqliteLevel(db, opts, "L0")
        break
      case "L1":
        querySqliteLevel(db, opts, "L1")
        break
    }
  } finally {
    db.close()
  }
}

main()
