// Path normalization for archive entries.

/**
 * Normalizes a path inside an archive. Returns `''` for the root, `undefined` when it escapes the root via `..`.
 */
export function normalizeLookupPath(rawPath: string) {
  const parts: string[] = []
  for (const part of rawPath.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') return undefined
    parts.push(part)
  }
  return parts.join('/')
}

/** Normalizes a member path from container metadata; `undefined` for empty or root-escaping paths. */
export function normalizeEntryPath(rawPath: string) {
  const normalized = normalizeLookupPath(rawPath)
  return normalized === '' ? undefined : normalized
}
