// Archive root listing and format sniffing for the formats fetch hints at: zip, tar, tar.gz.
import { posix } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { formatBytes } from '../scrapers/utils'
import { normalizeEntryPath, normalizeLookupPath } from './paths'
import { findEocd, MAX_IN_MEMORY_BYTES, readZipDirectory, readZipMember, sniffZip } from './zip'

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz'

const BLOCK_SIZE = 512
const NAME_OFFSET = 0
const NAME_LENGTH = 100
const SIZE_OFFSET = 124
const SIZE_LENGTH = 12
const CHECKSUM_OFFSET = 148
const CHECKSUM_LENGTH = 8
const TYPEFLAG_OFFSET = 156
const LINKNAME_OFFSET = 157
const LINKNAME_LENGTH = 100
const MAGIC_OFFSET = 257
const VERSION_OFFSET = 263
const PREFIX_OFFSET = 345
const PREFIX_LENGTH = 155
const GNU_SPARSE_ISEXTENDED_OFFSET = 482
const GNU_SPARSE_CONT_ISEXTENDED_OFFSET = 504
const MAX_LINK_DEPTH = 40
const TEXT_DECODER = new TextDecoder()

interface IndexEntry {
  path: string
  isDirectory: boolean
  size: number
  /** Archive-root-relative target; `resolve: false` for targets outside the root. */
  link?: { target: string; resolve: boolean }
}

/** Archive format named by the MIME type or extension. */
export function archiveFormatHint(mime: string, extension: string): ArchiveFormat | undefined {
  if (extension === '.zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed') return 'zip'
  if (extension === '.tar' || mime === 'application/x-tar' || mime === 'application/tar') return 'tar'
  if (
    extension === '.tar.gz' ||
    extension === '.tgz' ||
    extension === '.gz' ||
    mime === 'application/gzip' ||
    mime === 'application/x-gzip'
  ) {
    return 'tar.gz'
  }
  return undefined
}

function readTarString(buffer: Uint8Array, offset: number, length: number) {
  let end = offset
  const limit = Math.min(offset + length, buffer.byteLength)
  while (end < limit && buffer[end] !== 0) end++
  return TEXT_DECODER.decode(buffer.subarray(offset, end))
}

function readTarNumeric(buffer: Uint8Array, offset: number, length: number) {
  const first = buffer[offset]!
  let value = 0n
  if ((first & 0x80) !== 0) {
    // GNU base-256 encoding.
    value = BigInt(first & 0x7f)
    for (let index = 1; index < length; index++) value = (value << 8n) | BigInt(buffer[offset + index]!)
    if ((first & 0x40) !== 0) value -= 1n << BigInt(length * 8 - 1)
  } else {
    for (let index = 0; index < length; index++) {
      const byte = buffer[offset + index]!
      if (byte >= 0x30 && byte <= 0x37) value = value * 8n + BigInt(byte - 0x30)
    }
  }
  return Number(value)
}

function readTarSize(buffer: Uint8Array, offset: number) {
  const size = readTarNumeric(buffer, offset, SIZE_LENGTH)
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid tar member size')
  return size
}

function paddedSize(size: number) {
  const remainder = size % BLOCK_SIZE
  return size + (remainder === 0 ? 0 : BLOCK_SIZE - remainder)
}

function isZeroBlock(buffer: Uint8Array, offset: number) {
  for (let index = 0; index < BLOCK_SIZE; index++) {
    if (buffer[offset + index] !== 0) return false
  }
  return true
}

function checksumMatches(buffer: Uint8Array, offset: number) {
  const stored = readTarNumeric(buffer, offset + CHECKSUM_OFFSET, CHECKSUM_LENGTH)
  let unsigned = 0
  let signed = 0
  for (let index = 0; index < BLOCK_SIZE; index++) {
    const inChecksum = index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + CHECKSUM_LENGTH
    const byte = inChecksum ? 0x20 : (buffer[offset + index] ?? 0)
    unsigned += byte
    signed += (byte << 24) >> 24
  }
  return stored === unsigned || stored === signed
}

/** Detects a tar header, including legacy pre-ustar archives, by its checksum. */
function sniffTar(bytes: Uint8Array) {
  if (bytes.byteLength < BLOCK_SIZE) return false
  if (isZeroBlock(bytes, 0)) return true
  try {
    if (readTarString(bytes, NAME_OFFSET, NAME_LENGTH).length === 0) return false
    readTarSize(bytes, SIZE_OFFSET)
    return checksumMatches(bytes, 0)
  } catch {
    return false
  }
}

function isGzip(bytes: Uint8Array) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/**
 * Sniffs zip, gzip (reported as `tar.gz`; a non-tar payload lists as one member) and tar, then the bounded ZIP-EOCD
 * tail scan for zips with prepended data, in that order.
 */
export function sniffArchiveFormat(bytes: Uint8Array): ArchiveFormat | undefined {
  if (sniffZip(bytes)) return 'zip'
  if (isGzip(bytes)) return 'tar.gz'
  if (sniffTar(bytes)) return 'tar'
  return bytes.byteLength >= 22 && findEocd(bytes) >= 0 ? 'zip' : undefined
}

function parsePaxRecords(data: Uint8Array) {
  const attrs = new Map<string, string>()
  let pos = 0
  while (pos < data.byteLength) {
    let space = pos
    while (space < data.byteLength && data[space] !== 0x20) space++
    if (space === pos || space >= data.byteLength || space - pos > 16) throw new Error('Invalid tar PAX record')
    const digits = TEXT_DECODER.decode(data.subarray(pos, space))
    if (!/^\d+$/.test(digits)) throw new Error('Invalid tar PAX record')
    const length = Number(digits)
    if (length <= 0 || pos + length > data.byteLength || data[pos + length - 1] !== 0x0a) {
      throw new Error('Invalid tar PAX record')
    }
    const record = TEXT_DECODER.decode(data.subarray(space + 1, pos + length - 1))
    const equals = record.indexOf('=')
    if (equals >= 0) {
      const key = record.slice(0, equals)
      const value = record.slice(equals + 1)
      if (key.startsWith('GNU.sparse.')) {
        if (key === 'GNU.sparse.name') attrs.set('GNU.sparse.name', value)
        else if (key === 'GNU.sparse.realsize' || key === 'GNU.sparse.size') attrs.set('GNU.sparse.realsize', value)
      } else if (key === 'path' || key === 'linkpath' || key === 'size') {
        attrs.set(key, value)
      }
    }
    pos += length
  }
  return attrs
}

function parsePaxSize(value: string, field: string) {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid tar ${field}`)
  const size = Number(value)
  if (!Number.isSafeInteger(size)) throw new Error(`Invalid tar ${field}`)
  return size
}

/** Files replace directories of the same path, directories never shadow files, later duplicates win. */
function upsert(entries: Map<string, IndexEntry>, entry: IndexEntry) {
  const existing = entries.get(entry.path)
  if (existing && !existing.isDirectory && entry.isDirectory) return
  entries.set(entry.path, entry)
}

/** Walks tar headers with GNU long-name/link, ustar prefix and PAX path/linkpath/size handling. */
function readTarEntries(buffer: Uint8Array, signal: AbortSignal) {
  const entries: IndexEntry[] = []
  let longName: string | undefined
  let longLink: string | undefined
  let localPax: Map<string, string> | undefined
  const globalPax = new Map<string, string>()
  const pax = (key: string) => (localPax?.has(key) ? localPax.get(key) : globalPax.get(key))
  let sawTerminator = false
  let pos = 0

  const readData = (size: number, what: string) => {
    if (pos + size > buffer.byteLength) throw new Error(`Archive ${what} is truncated`)
    const data = buffer.subarray(pos, pos + size)
    pos += paddedSize(size)
    return data
  }

  for (let headers = 0; pos + BLOCK_SIZE <= buffer.byteLength; headers++) {
    if (headers % 1024 === 0) signal.throwIfAborted()
    const header = buffer.subarray(pos, pos + BLOCK_SIZE)
    pos += BLOCK_SIZE
    if (isZeroBlock(header, 0)) {
      sawTerminator = true
      break
    }
    if (!checksumMatches(header, 0)) throw new Error('Invalid or corrupt tar archive header')
    const typeFlag = String.fromCharCode(header[TYPEFLAG_OFFSET] || 0x30)
    let size = readTarSize(header, SIZE_OFFSET)
    let name = readTarString(header, NAME_OFFSET, NAME_LENGTH)
    if (readTarString(header, MAGIC_OFFSET, 6) === 'ustar' && readTarString(header, VERSION_OFFSET, 2) === '00') {
      const prefix = readTarString(header, PREFIX_OFFSET, PREFIX_LENGTH)
      if (prefix) name = `${prefix}/${name}`
    }
    let linkName = readTarString(header, LINKNAME_OFFSET, LINKNAME_LENGTH)

    if (typeFlag === 'L' || typeFlag === 'K') {
      const data = readData(size, 'GNU long-name metadata')
      const nul = data.indexOf(0)
      const value = TEXT_DECODER.decode(data.subarray(0, nul === -1 ? data.byteLength : nul))
      if (typeFlag === 'L') longName = value
      else longLink = value
      continue
    }
    if (typeFlag === 'N') {
      // Old-GNU rename records only adjust names of earlier members; their payload is skipped.
      readData(size, 'old-GNU name metadata')
      continue
    }
    if (typeFlag === 'x' || typeFlag === 'X') {
      localPax = parsePaxRecords(readData(size, 'tar PAX metadata'))
      continue
    }
    if (typeFlag === 'g') {
      for (const [key, value] of parsePaxRecords(readData(size, 'tar PAX metadata'))) {
        if (value === '') globalPax.delete(key)
        else globalPax.set(key, value)
      }
      continue
    }
    if (typeFlag === 'M') throw new Error('GNU multi-volume tar members are not supported')

    if (longName !== undefined) name = longName
    if (longLink !== undefined) linkName = longLink
    name = pax('path') ?? name
    linkName = pax('linkpath') ?? linkName
    const paxSize = pax('size')
    if (paxSize !== undefined) size = parsePaxSize(paxSize, 'member size')
    name = pax('GNU.sparse.name') ?? name
    const realSize = pax('GNU.sparse.realsize')
    const displaySize = realSize === undefined ? size : parsePaxSize(realSize, 'sparse real size')
    if (typeFlag === 'S' && header[GNU_SPARSE_ISEXTENDED_OFFSET] === 1) {
      for (let extended = true; extended;) {
        if (pos + BLOCK_SIZE > buffer.byteLength) throw new Error('Archive sparse metadata is truncated')
        extended = buffer[pos + GNU_SPARSE_CONT_ISEXTENDED_OFFSET] === 1
        pos += BLOCK_SIZE
      }
    }
    if (pos + size > buffer.byteLength) throw new Error(`Archive member '${name}' is truncated`)
    pos += paddedSize(size)
    longName = undefined
    longLink = undefined
    localPax = undefined

    const normalized = normalizeEntryPath(name)
    if (normalized === undefined) continue
    if (typeFlag === '5' || name.endsWith('/')) {
      entries.push({ path: normalized, isDirectory: true, size: 0 })
      continue
    }
    if (typeFlag === '1' || typeFlag === '2') {
      const portable = linkName.replace(/\\/g, '/')
      const target =
        typeFlag === '1'
          ? normalizeEntryPath(portable)
          : posix.isAbsolute(portable)
            ? undefined
            : normalizeLookupPath(posix.join(posix.dirname(normalized), portable))
      entries.push({
        path: normalized,
        isDirectory: false,
        size: 0,
        link: target === undefined ? { target: portable, resolve: false } : { target, resolve: true }
      })
      continue
    }
    if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '7' && typeFlag !== 'S') continue
    entries.push({ path: normalized, isDirectory: false, size: displaySize })
  }
  if (!sawTerminator) throw new Error('Not a valid tar archive: missing terminating zero block')
  return entries
}

function readZipEntries(bytes: Uint8Array, signal: AbortSignal) {
  const entries: IndexEntry[] = []
  for (const entry of readZipDirectory(bytes)) {
    if (!entry.isSymlink) {
      entries.push({ path: entry.path, isDirectory: entry.isDirectory, size: entry.size })
      continue
    }
    signal.throwIfAborted()
    const portable = TEXT_DECODER.decode(readZipMember(bytes, entry)).replace(/\\/g, '/')
    const absolute = posix.isAbsolute(portable) || /^[A-Za-z]:/.test(portable) || portable.includes('\0')
    const target = absolute ? undefined : normalizeLookupPath(posix.join(posix.dirname(entry.path), portable))
    entries.push({
      path: entry.path,
      isDirectory: false,
      size: 0,
      link: target === undefined ? { target: portable, resolve: false } : { target, resolve: true }
    })
  }
  return entries
}

function readGzipEntries(bytes: Uint8Array, signal: AbortSignal) {
  let inner: Uint8Array
  try {
    inner = gunzipSync(bytes, { maxOutputLength: MAX_IN_MEMORY_BYTES })
  } catch (error) {
    // zlib reports an output past maxOutputLength as a RangeError (ERR_BUFFER_TOO_LARGE).
    if (error instanceof RangeError) {
      throw new Error(
        `Archive is too large to read in memory (decompressed > ${formatBytes(MAX_IN_MEMORY_BYTES)} limit)`
      )
    }
    throw error
  }
  signal.throwIfAborted()
  if (sniffTar(inner)) return readTarEntries(inner, signal)
  // A bare `.gz` lists as its single stem-named member; in-memory payloads have no stem.
  return [{ path: 'data', isDirectory: false, size: inner.byteLength }]
}

/** Follows link aliases of an exact path; `undefined` for dangling or cyclic links. */
function resolveEntry(entries: Map<string, IndexEntry>, entryPath: string) {
  let current = entries.get(entryPath)
  for (let depth = 0; current?.link?.resolve === true; depth++) {
    if (depth >= MAX_LINK_DEPTH || current.link.target === '') return undefined
    current = entries.get(current.link.target)
  }
  return current
}

/** Top-level entries of an in-memory archive, one per line: `name/` for dirs, `name (size)` for files. */
export function listArchiveRoot(bytes: Uint8Array, format: ArchiveFormat, limit: number, signal: AbortSignal) {
  const indexed =
    format === 'zip'
      ? readZipEntries(bytes, signal)
      : format === 'tar'
        ? readTarEntries(bytes, signal)
        : readGzipEntries(bytes, signal)
  signal.throwIfAborted()

  const entries = new Map<string, IndexEntry>()
  for (const entry of indexed) upsert(entries, entry)
  // Containers that omit directory records (ZIP, most tars) still list their top-level directories.
  for (const entry of [...entries.values()]) {
    const cut = entry.path.indexOf('/')
    if (cut > 0 && !entries.has(entry.path.slice(0, cut))) {
      entries.set(entry.path.slice(0, cut), { path: entry.path.slice(0, cut), isDirectory: true, size: 0 })
    }
  }

  const rows: { name: string; isDirectory: boolean; size: number }[] = []
  for (const entry of entries.values()) {
    if (entry.path.includes('/')) continue
    const resolved = resolveEntry(entries, entry.path)
    const isDirectory = resolved?.isDirectory === true
    rows.push({ name: entry.path, isDirectory, size: isDirectory ? 0 : (resolved?.size ?? entry.size) })
  }
  rows.sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()))

  const lines = rows
    .slice(0, limit)
    .map((row) =>
      row.isDirectory ? `${row.name}/` : row.size > 0 ? `${row.name} (${formatBytes(row.size)})` : row.name
    )
  return lines.length > 0 ? lines.join('\n') : '(empty archive directory)'
}
