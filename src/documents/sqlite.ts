// SQLite detection, read-only connection, table listing and rendering,
// on node:sqlite over a temp copy of the downloaded database.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SQLITE_MAGIC = new TextEncoder().encode('SQLite format 3\0')
const SQLITE_CANTOPEN = 14
const MAX_RENDER_WIDTH = 120
const TAB_SPACES = '   '
/**
 * Upper bound on rows scanned when counting a table: SQLite has no stored row count, so large tables use the
 * planner's `sqlite_stat1` estimate and only provably small tables are counted exactly.
 */
const ROW_COUNT_PROBE_CAP = 50_000

type TableRowCount = { kind: 'exact' | 'estimate' | 'atLeast'; rows: number }

interface TableSummary {
  name: string
  count: TableRowCount
}

export function looksLikeSqlite(bytes: Uint8Array) {
  if (bytes.byteLength < SQLITE_MAGIC.byteLength) return false
  for (const [index, byte] of SQLITE_MAGIC.entries()) {
    if (bytes[index] !== byte) return false
  }
  return true
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`
}

function configureReadConnection(db: DatabaseSync) {
  try {
    db.exec('PRAGMA query_only = ON')
    db.exec('PRAGMA busy_timeout = 3000')
    db.prepare('SELECT name FROM sqlite_master LIMIT 1').get()
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function isCantOpen(error: unknown) {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    (error.errcode & 0xff) === SQLITE_CANTOPEN
  )
}

/** Query-only connection; read-write mode only where a read-only open cannot initialize WAL sidecars. */
function openReadConnection(filePath: string, header: Uint8Array) {
  // WAL databases (format versions 2) need -wal/-shm sidecars, which a fresh temp copy never has.
  if (header[18] === 2 || header[19] === 2) return configureReadConnection(new DatabaseSync(filePath))
  try {
    return configureReadConnection(new DatabaseSync(filePath, { readOnly: true }))
  } catch (error) {
    if (!isCantOpen(error)) throw error
  }
  return configureReadConnection(new DatabaseSync(filePath))
}

/** Planner row estimates from `sqlite_stat1`: the max leading integer per table; empty when never analyzed. */
function loadRowEstimates(db: DatabaseSync) {
  const estimates = new Map<string, number>()
  const hasStat1 = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get()
  if (!hasStat1) return estimates
  for (const row of db.prepare('SELECT tbl, stat FROM sqlite_stat1').all()) {
    if (typeof row.tbl !== 'string' || typeof row.stat !== 'string') continue
    const rows = Number.parseInt(row.stat, 10)
    if (!Number.isFinite(rows)) continue
    const previous = estimates.get(row.tbl)
    if (previous === undefined || rows > previous) estimates.set(row.tbl, rows)
  }
  return estimates
}

/** Counts a table reading at most `cap + 1` rows: exact when small, else a lower bound of `cap`. */
function probeRowCount(db: DatabaseSync, table: string, cap: number): TableRowCount {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${quoteIdentifier(table)} LIMIT ${cap + 1})`)
    .get()
  const counted = Number(row?.count ?? 0)
  return counted > cap ? { kind: 'atLeast', rows: cap } : { kind: 'exact', rows: counted }
}

function listTables(db: DatabaseSync, limit: number): TableSummary[] {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE"
    )
    .all()
    .slice(0, limit)
  const estimates = loadRowEstimates(db)
  return names.map((row) => {
    const name = String(row.name)
    const estimate = estimates.get(name)
    // Trust the planner only when it says the table is too large to count cheaply.
    const count: TableRowCount =
      estimate !== undefined && estimate > ROW_COUNT_PROBE_CAP
        ? { kind: 'estimate', rows: estimate }
        : probeRowCount(db, name, ROW_COUNT_PROBE_CAP)
    return { name, count }
  })
}

function formatRowCount(count: TableRowCount) {
  if (count.kind === 'exact') return `${count.rows} rows`
  if (count.kind === 'estimate') return `~${count.rows} rows`
  return `${count.rows}+ rows`
}

/** Truncates to `MAX_RENDER_WIDTH` code points with a trailing ellipsis. */
function truncateLine(text: string) {
  const points = [...text]
  return points.length <= MAX_RENDER_WIDTH ? text : `${points.slice(0, MAX_RENDER_WIDTH - 1).join('')}…`
}

function renderTableList(tables: TableSummary[]) {
  if (tables.length === 0) return '(no tables)'
  return tables
    .map((table) => truncateLine(`${table.name} (${formatRowCount(table.count)})`.replaceAll('\t', TAB_SPACES)))
    .join('\n')
}

/** Table list with row counts for a downloaded database; the temp copy is always removed. */
export async function renderSqlite(bytes: Uint8Array, limit: number, signal: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), 'omreader-sqlite-'))
  try {
    const filePath = join(directory, 'payload.sqlite')
    await writeFile(filePath, bytes, { signal })
    signal.throwIfAborted()
    const db = openReadConnection(filePath, bytes)
    try {
      return renderTableList(listTables(db, limit))
    } finally {
      db.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
