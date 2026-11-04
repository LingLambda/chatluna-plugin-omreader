// ZIP reading for the document converters and archive listing:
// central-directory indexing (ZIP64, prepended data, Unicode path extra) and lazy member inflation via fflate.
import { inflateSync } from 'fflate'
import { normalizeEntryPath } from './paths'

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const EOCD_LENGTH = 22
const ZIP64_EOCD_LENGTH = 56
const CENTRAL_HEADER_LENGTH = 46
const LOCAL_HEADER_LENGTH = 30
const MAX_COMMENT_LENGTH = 0xffff
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff
const UTF8_FLAG = 0x0800
const ENCRYPTED_FLAG = 0x0001
const STRONG_ENCRYPTION_FLAG = 0x0040
const UNIX_HOST = 3
const OSX_HOST = 19
const FILE_TYPE_MASK = 0o170000
const DIRECTORY_TYPE = 0o040000
const SYMLINK_TYPE = 0o120000

/** Ceiling on distinct inflated bytes per package. */
export const MAX_IN_MEMORY_BYTES = 256 * 1024 * 1024
/** Ceiling on one member's declared size. */
const MAX_MEMBER_BYTES = 64 * 1024 * 1024

const UTF8_DECODER = new TextDecoder()
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true })
const LEGACY_NAME_DECODER = new TextDecoder('windows-1252')

export interface ZipEntry {
  path: string
  isDirectory: boolean
  isSymlink: boolean
  size: number
  compressedSize: number
  method: number
  /** Local header offset, already corrected for prepended data. */
  localOffset: number
}

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u32(bytes: Uint8Array, offset: number) {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) + bytes[offset + 3]! * 0x1000000
}

function u64(bytes: Uint8Array, offset: number) {
  const value = u32(bytes, offset) + u32(bytes, offset + 4) * 0x100000000
  if (!Number.isSafeInteger(value)) throw new Error('Invalid ZIP archive: 64-bit field out of range')
  return value
}

function need(bytes: Uint8Array, offset: number, length: number, what: string) {
  if (offset < 0 || offset + length > bytes.byteLength) throw new Error(`Invalid ZIP archive: truncated ${what}`)
}

let crcTable: Uint32Array | undefined

function crc32(bytes: Uint8Array) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Detects a ZIP local header, empty-archive end record, or leading data descriptor. */
export function sniffZip(bytes: Uint8Array) {
  if (bytes.byteLength < 4) return false
  const signature = u32(bytes, 0)
  return signature === LOCAL_SIGNATURE || signature === EOCD_SIGNATURE || signature === DATA_DESCRIPTOR_SIGNATURE
}

/** Offset of the end-of-central-directory record, or -1; bounded backward scan over the comment window. */
export function findEocd(bytes: Uint8Array) {
  const start = bytes.byteLength - EOCD_LENGTH
  const stop = Math.max(0, start - MAX_COMMENT_LENGTH)
  for (let offset = start; offset >= stop; offset--) {
    if (u32(bytes, offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

interface Zip64Placeholders {
  size: boolean
  compressedSize: boolean
  localOffset: boolean
}

/** Reads every central-directory entry; paths escaping the root via `..` are dropped. */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength < EOCD_LENGTH) throw new Error('Invalid ZIP archive: missing end of central directory')
  const eocd = findEocd(bytes)
  if (eocd < 0) throw new Error('Invalid ZIP archive: missing end of central directory')
  if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0) {
    throw new Error('Multi-volume ZIP archives are not supported')
  }
  let entries = u16(bytes, eocd + 10)
  let size = u32(bytes, eocd + 12)
  let offset = u32(bytes, eocd + 16)
  let physicalEnd = eocd
  if (entries === U16_MAX || size === U32_MAX || offset === U32_MAX) {
    const locator = eocd - 20
    if (locator < 0 || u32(bytes, locator) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new Error('Invalid ZIP archive: missing ZIP64 central-directory metadata')
    }
    let record = u64(bytes, locator + 8)
    if (record + ZIP64_EOCD_LENGTH > bytes.byteLength || u32(bytes, record) !== ZIP64_EOCD_SIGNATURE) {
      // Prepended data shifts the declared record offset; the record then sits right before the locator.
      record = locator - ZIP64_EOCD_LENGTH
      if (record < 0 || u32(bytes, record) !== ZIP64_EOCD_SIGNATURE) {
        throw new Error('Invalid ZIP archive: missing ZIP64 central-directory metadata')
      }
    }
    entries = u64(bytes, record + 32)
    size = u64(bytes, record + 40)
    offset = u64(bytes, record + 48)
    physicalEnd = record
  }
  if (entries > Math.floor(size / CENTRAL_HEADER_LENGTH)) {
    throw new Error('Invalid ZIP archive: truncated central directory')
  }
  // Self-extractors and installers prepend data: trust the declared offset only when a header sits there.
  let start = offset
  if (entries > 0 && (offset + 4 > bytes.byteLength || u32(bytes, offset) !== CENTRAL_SIGNATURE)) {
    start = physicalEnd - size
  }
  need(bytes, start, size, 'central directory')
  const shift = start - offset

  const result: ZipEntry[] = []
  let cursor = start
  for (let index = 0; index < entries; index++) {
    need(bytes, cursor, CENTRAL_HEADER_LENGTH, 'central directory')
    if (u32(bytes, cursor) !== CENTRAL_SIGNATURE) throw new Error('Invalid ZIP archive: bad central directory entry')
    const versionMadeBy = u16(bytes, cursor + 4)
    const flags = u16(bytes, cursor + 8)
    const method = u16(bytes, cursor + 10)
    const compressedRaw = u32(bytes, cursor + 20)
    const sizeRaw = u32(bytes, cursor + 24)
    const nameLength = u16(bytes, cursor + 28)
    const extraLength = u16(bytes, cursor + 30)
    const commentLength = u16(bytes, cursor + 32)
    const diskRaw = u16(bytes, cursor + 34)
    const externalAttributes = u32(bytes, cursor + 38)
    const localRaw = u32(bytes, cursor + 42)
    const nameStart = cursor + CENTRAL_HEADER_LENGTH
    const end = nameStart + nameLength + extraLength + commentLength
    need(bytes, nameStart, end - nameStart, 'central directory entry')
    const rawName = bytes.subarray(nameStart, nameStart + nameLength)
    const extra = bytes.subarray(nameStart + nameLength, nameStart + nameLength + extraLength)

    const values = { size: sizeRaw, compressedSize: compressedRaw, localOffset: localRaw, disk: diskRaw }
    const placeholders: Zip64Placeholders = {
      size: sizeRaw === U32_MAX,
      compressedSize: compressedRaw === U32_MAX,
      localOffset: localRaw === U32_MAX
    }
    let unicodePath: string | undefined
    for (let pos = 0; pos + 4 <= extra.byteLength;) {
      const id = u16(extra, pos)
      const length = u16(extra, pos + 2)
      const data = extra.subarray(pos + 4, pos + 4 + length)
      if (data.byteLength !== length) throw new Error('Invalid ZIP archive: truncated extra field')
      if (id === 0x0001) {
        let field = 0
        const take = () => {
          if (field + 8 > data.byteLength) throw new Error('Invalid ZIP archive: truncated ZIP64 extra field')
          const value = u64(data, field)
          field += 8
          return value
        }
        if (placeholders.size) values.size = take()
        if (placeholders.compressedSize) values.compressedSize = take()
        if (placeholders.localOffset) values.localOffset = take()
        if (diskRaw === U16_MAX && field + 4 <= data.byteLength) values.disk = u32(data, field)
      } else if (id === 0x7075 && data.byteLength >= 5 && data[0] === 1 && u32(data, 1) === crc32(rawName)) {
        try {
          unicodePath = UTF8_FATAL_DECODER.decode(data.subarray(5))
        } catch {
          // A bad optional Unicode path falls back to the header name.
        }
      }
      pos += 4 + length
    }
    if (values.disk !== 0) throw new Error('Multi-volume ZIP archives are not supported')
    const rawPath = unicodePath ?? ((flags & UTF8_FLAG) !== 0 ? UTF8_DECODER : LEGACY_NAME_DECODER).decode(rawName)
    if ((flags & (ENCRYPTED_FLAG | STRONG_ENCRYPTION_FLAG)) !== 0 || method === 99) {
      throw new Error(`Encrypted ZIP member '${rawPath}' is not supported`)
    }
    const normalized = normalizeEntryPath(rawPath)
    if (normalized !== undefined) {
      const host = versionMadeBy >>> 8
      const mode = host === UNIX_HOST || host === OSX_HOST ? externalAttributes >>> 16 : 0
      const fileType = mode & FILE_TYPE_MASK
      const isDirectory =
        rawPath.endsWith('/') ||
        rawPath.endsWith('\\') ||
        fileType === DIRECTORY_TYPE ||
        (externalAttributes & 0x10) !== 0
      result.push({
        path: normalized,
        isDirectory,
        isSymlink: fileType === SYMLINK_TYPE && !isDirectory,
        size: isDirectory ? 0 : values.size,
        compressedSize: values.compressedSize,
        method,
        localOffset: values.localOffset + shift
      })
    }
    cursor = end
  }
  return result
}

/** Inflates one member; stored and deflated members only, like every OOXML/EPUB writer emits. */
export function readZipMember(bytes: Uint8Array, entry: ZipEntry) {
  if (entry.size > MAX_MEMBER_BYTES) {
    throw new Error(`Archive member '${entry.path}' exceeds the ${MAX_MEMBER_BYTES / 1024 / 1024}MB member limit`)
  }
  need(bytes, entry.localOffset, LOCAL_HEADER_LENGTH, `local header for '${entry.path}'`)
  if (u32(bytes, entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new Error(`Invalid ZIP archive: bad local header for '${entry.path}'`)
  }
  const dataStart =
    entry.localOffset + LOCAL_HEADER_LENGTH + u16(bytes, entry.localOffset + 26) + u16(bytes, entry.localOffset + 28)
  need(bytes, dataStart, entry.compressedSize, `data for '${entry.path}'`)
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method === 8) {
    // A sized output buffer bounds inflation to the declared size, so a lying header cannot inflate further.
    return entry.size === 0 ? new Uint8Array(0) : inflateSync(data, { out: new Uint8Array(entry.size) })
  }
  throw new Error(`Unsupported ZIP compression method ${entry.method} for '${entry.path}'`)
}

/**
 * A ZIP-based document package (OOXML, EPUB) whose members are inflated only when read. Each member counts once
 * toward a cap on total inflated bytes, so a crafted package cannot amplify past the in-memory limit.
 */
export class ZipPackage {
  readonly #bytes: Uint8Array
  readonly #entries = new Map<string, ZipEntry>()
  readonly #counted = new Set<string>()
  #inflated = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
    for (const entry of readZipDirectory(bytes)) {
      if (!entry.isDirectory) this.#entries.set(entry.path, entry)
    }
  }

  /** Whether a file member with this exact path exists. */
  has(memberPath: string) {
    return this.#entries.has(memberPath)
  }

  /** Exact paths of every file member. */
  members() {
    return this.#entries.keys()
  }

  /** Inflates one member, or `undefined` when absent. */
  readBytes(memberPath: string) {
    const entry = this.#entries.get(memberPath)
    if (!entry) return undefined
    const bytes = readZipMember(this.#bytes, entry)
    if (!this.#counted.has(memberPath)) {
      this.#counted.add(memberPath)
      this.#inflated += bytes.byteLength
      if (this.#inflated > MAX_IN_MEMORY_BYTES) {
        throw new Error(`Archive is too large to read in memory (> ${MAX_IN_MEMORY_BYTES / 1024 / 1024}MB limit)`)
      }
    }
    return bytes
  }

  /** Inflates one member as UTF-8 text, or `undefined` when absent. */
  readText(memberPath: string) {
    const bytes = this.readBytes(memberPath)
    return bytes ? UTF8_DECODER.decode(bytes) : undefined
  }
}
