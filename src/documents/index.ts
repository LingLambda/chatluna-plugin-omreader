// Binary-document handling: cached document conversion and the notebook / SQLite / archive payload renderers.
import { archiveFormatHint, listArchiveRoot, sniffArchiveFormat } from './archive'
import { conversionCacheKey, readConversionCache, writeConversionCache } from './cache'
import { convertEpub } from './epub'
import { renderNotebook } from './notebook'
import { convertDocx, convertPptx, convertXlsx } from './office'
import { convertPdf } from './pdf'
import { looksLikeSqlite, renderSqlite } from './sqlite'

/** MIME types with a converter; legacy `application/msword`, `application/vnd.ms-*` and RTF have none. */
export const CONVERTIBLE_MIMES: Record<string, true> = {
  'application/pdf': true,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': true,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': true,
  'application/epub+zip': true
}

/** Extensions with a converter, one per converter below. */
export const CONVERTIBLE_EXTENSIONS: Record<string, true> = {
  '.pdf': true,
  '.docx': true,
  '.pptx': true,
  '.xlsx': true,
  '.epub': true
}

export function isConvertible(mime: string, extension: string) {
  return CONVERTIBLE_MIMES[mime] === true || CONVERTIBLE_EXTENSIONS[extension] === true
}

export type ConvertResult = { ok: true; content: string } | { ok: false; error: string }

interface Converter {
  name: string
  convert(bytes: Uint8Array, signal: AbortSignal): Promise<string>
}

const CONVERTERS: Record<string, Converter> = {
  '.pdf': { name: 'pdf', convert: convertPdf },
  '.docx': { name: 'docx', convert: convertDocx },
  '.pptx': { name: 'pptx', convert: convertPptx },
  '.xlsx': { name: 'xlsx', convert: convertXlsx },
  '.epub': { name: 'epub', convert: convertEpub }
}

/** Settles with `task`, or rejects as soon as `signal` aborts (synchronous library work cannot be interrupted). */
async function untilAborted<T>(signal: AbortSignal, task: Promise<T>) {
  signal.throwIfAborted()
  const { promise, reject } = Promise.withResolvers<never>()
  const onAbort = () => reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([task, promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Markdown from document bytes; cached by sha256(bytes)+extension in a bounded in-memory LRU (~64 MiB of output). */
export async function convertDocument(
  bytes: Uint8Array,
  extension: string,
  signal: AbortSignal
): Promise<ConvertResult> {
  const trimmed = extension.trim().toLowerCase()
  const normalized = !trimmed ? '.bin' : trimmed.startsWith('.') ? trimmed : `.${trimmed}`
  signal.throwIfAborted()
  const key = conversionCacheKey(bytes, normalized)
  const cached = readConversionCache(key)
  if (cached !== undefined) return { ok: true, content: cached }

  const converter = CONVERTERS[normalized]
  if (!converter) return { ok: false, error: `Unsupported format: ${normalized}` }
  let content: string
  try {
    content = await untilAborted(signal, converter.convert(bytes, signal))
  } catch (error) {
    signal.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `Conversion failed:\n  ${converter.name}: ${message}`.trim() }
  }
  if (content.length === 0) return { ok: false, error: 'Conversion produced no output' }
  writeConversionCache(key, content)
  return { ok: true, content }
}

const NOTEBOOK_MIMES: Record<string, true> = { 'application/x-ipynb+json': true }
const NOTEBOOK_EXTENSIONS: Record<string, true> = { '.ipynb': true }

const SQLITE_MIMES: Record<string, true> = {
  'application/vnd.sqlite3': true,
  'application/x-sqlite3': true,
  'application/sqlite3': true,
  'application/sqlite': true
}
const SQLITE_EXTENSIONS: Record<string, true> = { '.sqlite': true, '.sqlite3': true, '.db': true, '.db3': true }

const ARCHIVE_MIMES: Record<string, true> = {
  'application/zip': true,
  'application/x-zip-compressed': true,
  'application/x-tar': true,
  'application/tar': true,
  'application/gzip': true,
  'application/x-gzip': true
}
const ARCHIVE_EXTENSIONS: Record<string, true> = {
  '.zip': true,
  '.tar': true,
  '.tar.gz': true,
  '.tgz': true,
  '.gz': true
}

export const PAYLOAD_MIMES: Record<string, true> = { ...NOTEBOOK_MIMES, ...SQLITE_MIMES, ...ARCHIVE_MIMES }

export type PayloadKind = 'notebook' | 'sqlite' | 'archive'

/** Listing caps for rendered SQLite tables and archive entries. */
const LIST_LIMIT = 500

/** Kind hinted by mime/extension, before downloading. */
export function payloadHint(mime: string, extension: string): PayloadKind | undefined {
  if (NOTEBOOK_MIMES[mime] === true || NOTEBOOK_EXTENSIONS[extension] === true) return 'notebook'
  if (SQLITE_MIMES[mime] === true || SQLITE_EXTENSIONS[extension] === true) return 'sqlite'
  if (ARCHIVE_MIMES[mime] === true || ARCHIVE_EXTENSIONS[extension] === true) return 'archive'
  return undefined
}

/**
 * Renders a downloaded payload: hint first, then sniffing (sqlite magic, archive magic — archive sniffing skipped
 * when isConvertible). null = not a recognized payload. Throws on render failure.
 */
export async function renderPayload(
  bytes: Uint8Array,
  mime: string,
  extension: string,
  url: string,
  signal: AbortSignal
): Promise<{ method: PayloadKind; content: string } | null> {
  const hint = payloadHint(mime, extension)
  if (hint === 'notebook') return { method: 'notebook', content: renderNotebook(bytes, url) }
  if (hint === 'sqlite' || looksLikeSqlite(bytes)) {
    return { method: 'sqlite', content: await renderSqlite(bytes, LIST_LIMIT, signal) }
  }
  const format =
    archiveFormatHint(mime, extension) ?? (isConvertible(mime, extension) ? undefined : sniffArchiveFormat(bytes))
  if (format === undefined) return null
  return { method: 'archive', content: listArchiveRoot(bytes, format, LIST_LIMIT, signal) }
}
