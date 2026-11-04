// In-memory conversion cache: successful conversions keyed by sha256(bytes) + extension.
import { createHash } from 'node:crypto'

/** Output held across entries, in UTF-16 bytes. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024

// Map iteration order is insertion order: re-inserting on hit makes the first key the least recently used.
const entries = new Map<string, string>()
let totalBytes = 0

export function conversionCacheKey(bytes: Uint8Array, extension: string) {
  const safeExtension = extension.replace(/^\.+/, '').replace(/[^a-z0-9]+/g, '_') || 'bin'
  return `${safeExtension}-${createHash('sha256').update(bytes).digest('hex')}`
}

export function readConversionCache(key: string) {
  const content = entries.get(key)
  if (content === undefined) return undefined
  entries.delete(key)
  entries.set(key, content)
  return content
}

export function writeConversionCache(key: string, content: string) {
  const size = content.length * 2
  if (size > MAX_CACHE_BYTES) return
  const existing = entries.get(key)
  if (existing !== undefined) {
    entries.delete(key)
    totalBytes -= existing.length * 2
  }
  entries.set(key, content)
  totalBytes += size
  for (const [oldest, value] of entries) {
    if (totalBytes <= MAX_CACHE_BYTES) break
    entries.delete(oldest)
    totalBytes -= value.length * 2
  }
}
