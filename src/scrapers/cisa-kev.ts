// CISA Known Exploited Vulnerabilities entries from the KEV feed.
import type { Scraper } from './types'
import { tryParseJson } from './utils'

interface KevEntry {
  cveID: string
  vendorProject?: string
  product?: string
  vulnerabilityName?: string
  shortDescription?: string
  requiredAction?: string
  dateAdded?: string
  dueDate?: string
}

interface KevCatalog {
  title?: string
  catalogVersion?: string
  dateReleased?: string
  count?: number
  vulnerabilities?: KevEntry[]
}

const CVE_PATTERN = /CVE-\d{4}-\d{4,7}/i
const KEV_FEED_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'

export const scrapeCisaKev: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (!parsed.hostname.toLowerCase().endsWith('cisa.gov')) return null
    if (!parsed.pathname.toLowerCase().includes('known-exploited-vulnerabilities')) return null

    const cveMatch = parsed.pathname.match(CVE_PATTERN) ?? parsed.search.match(CVE_PATTERN)
    if (!cveMatch) return null

    const cveId = cveMatch[0].toUpperCase()

    const result = await ctx.loadPage(KEV_FEED_URL, { headers: { Accept: 'application/json' } })
    if (!result.ok) return null

    const data = tryParseJson<KevCatalog>(result.content)
    if (!data) return null

    const entry = data.vulnerabilities?.find((item) => item.cveID?.toUpperCase() === cveId)
    if (!entry) return null

    let md = `# ${entry.cveID}\n\n`
    if (entry.vulnerabilityName) md += `${entry.vulnerabilityName}\n\n`

    md += '## Metadata\n\n'
    if (entry.vendorProject) md += `**Vendor:** ${entry.vendorProject}\n`
    if (entry.product) md += `**Product:** ${entry.product}\n`
    if (entry.dateAdded) md += `**Date Added:** ${entry.dateAdded}\n`
    if (entry.dueDate) md += `**Due Date:** ${entry.dueDate}\n`
    md += '\n'

    if (entry.shortDescription) md += `## Description\n\n${entry.shortDescription}\n\n`
    if (entry.requiredAction) md += `## Required Action\n\n${entry.requiredAction}\n\n`

    return { content: md, method: 'cisa-kev', notes: ['Fetched via CISA KEV feed'] }
  } catch {}

  return null
}
