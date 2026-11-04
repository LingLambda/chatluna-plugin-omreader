import type { Scraper } from './types'
import { asRecord, tryParseJson } from './utils'

type JsonRecord = Record<string, unknown>

function getString(record: JsonRecord | null, key: string): string | undefined {
  if (!record) return undefined
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getRecord(record: JsonRecord | null, key: string): JsonRecord | null {
  if (!record) return null
  return asRecord(record[key])
}

function getArray(record: JsonRecord | null, key: string): unknown[] | undefined {
  if (!record) return undefined
  const value = record[key]
  return Array.isArray(value) ? value : undefined
}

function extractShortname(pathname: string): string | null {
  const trimmed = pathname.replace(/\/+$/g, '')
  const segments = trimmed.split('/').filter(Boolean)

  if (segments.length < 2 || segments[0] !== 'TR') return null

  if (segments.length === 2) {
    const shortname = segments[1]!
    if (/^\d{4}$/.test(shortname)) return null
    return decodeURIComponent(shortname)
  }

  if (segments.length >= 3 && /^\d{4}$/.test(segments[1]!)) {
    const version = segments[2]!
    const match = version.match(/^[A-Za-z]+-(.+)-\d{8}$/)
    if (match?.[1]) return decodeURIComponent(match[1])
  }

  return null
}

function normalizeStatus(status?: string): { code?: string; label?: string } {
  if (!status) return {}
  const lower = status.toLowerCase()

  if (lower.includes('working draft')) return { code: 'WD', label: status }
  if (lower.includes('candidate recommendation')) return { code: 'CR', label: status }
  if (lower.includes('proposed recommendation')) return { code: 'PR', label: status }
  if (lower.includes('recommendation')) return { code: 'REC', label: status }

  return { label: status }
}

function extractEditors(editorsPayload: JsonRecord | null): string[] {
  const links = getRecord(editorsPayload, '_links')
  const editors = getArray(links, 'editors') ?? []
  const names: string[] = []

  for (const entry of editors) {
    const record = asRecord(entry)
    const title = getString(record, 'title')
    if (title) names.push(title)
  }

  return names
}

/** W3C Technical Reports (`/TR/...`) via the W3C API. */
export const scrapeW3c: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'www.w3.org' && parsed.hostname !== 'w3.org') return null

    const shortname = extractShortname(parsed.pathname)
    if (!shortname) return null

    const specUrl = `https://api.w3.org/specifications/${encodeURIComponent(shortname)}`
    const latestUrl = `https://api.w3.org/specifications/${encodeURIComponent(shortname)}/versions/latest`

    const [specResult, latestResult] = await Promise.all([
      ctx.loadPage(specUrl, { headers: { Accept: 'application/json' } }),
      ctx.loadPage(latestUrl, { headers: { Accept: 'application/json' } })
    ])

    if (!specResult.ok || !latestResult.ok) return null

    const specPayload = tryParseJson<Record<string, unknown>>(specResult.content)
    const latestPayload = tryParseJson<Record<string, unknown>>(latestResult.content)
    if (!specPayload || !latestPayload) return null

    const title = getString(specPayload, 'title')
    const shortnameValue = getString(specPayload, 'shortname') ?? shortname
    const description = getString(specPayload, 'description') ?? getString(specPayload, 'abstract')
    const abstract = description ? await ctx.htmlToMarkdown(description) : undefined

    const latestVersionUrl =
      getString(latestPayload, 'uri') ?? getString(latestPayload, 'shortlink') ?? getString(specPayload, 'shortlink')

    const latestStatus = getString(latestPayload, 'status')
    const normalizedStatus = normalizeStatus(latestStatus)

    const specLinks = getRecord(specPayload, '_links')
    const historyUrl = getString(getRecord(specLinks, 'version-history'), 'href')

    const latestLinks = getRecord(latestPayload, '_links')
    const editorsUrl = getString(getRecord(latestLinks, 'editors'), 'href')

    let editors: string[] = []
    if (editorsUrl) {
      const editorsResult = await ctx.loadPage(editorsUrl, { timeoutMs: 10_000 })
      if (editorsResult.ok) {
        try {
          const editorsPayload = asRecord(JSON.parse(editorsResult.content))
          editors = editorsPayload ? extractEditors(editorsPayload) : []
        } catch {
          // No editors.
        }
      }
    }

    let md = `# ${title ?? shortnameValue}\n\n`
    if (abstract) md += `## Abstract\n\n${abstract}\n\n`

    md += '## Metadata\n\n'
    md += `**Shortname:** ${shortnameValue}\n`
    if (normalizedStatus.code) {
      md += `**Status:** ${normalizedStatus.code}`
      if (normalizedStatus.label) md += ` (${normalizedStatus.label})`
      md += '\n'
    } else if (normalizedStatus.label) {
      md += `**Status:** ${normalizedStatus.label}\n`
    }
    if (editors.length) md += `**Editors:** ${editors.join(', ')}\n`
    if (latestVersionUrl) md += `**Latest Version:** ${latestVersionUrl}\n`
    if (historyUrl) md += `**History:** ${historyUrl}\n`

    return {
      content: md,
      method: 'w3c-api',
      finalUrl: latestVersionUrl ?? ctx.url.href,
      notes: ['Fetched via W3C API']
    }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
