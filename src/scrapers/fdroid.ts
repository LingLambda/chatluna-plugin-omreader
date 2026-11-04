import type { Scraper } from './types'
import type { LocalizedText } from './utils'
import { getLocalizedText, tryParseJson } from './utils'

interface FdroidPackage {
  packageName?: string
  name?: LocalizedText
  summary?: LocalizedText
  description?: LocalizedText
  author?: string | { name?: string; email?: string }
  authorName?: string
  authorEmail?: string
  license?: string
  categories?: string[]
  antiFeatures?: string[]
  sourceCode?: string
  packages?: {
    versionName?: string
    versionCode?: number
    added?: number
    antiFeatures?: string[]
  }[]
  suggestedVersionCode?: number
  suggestedVersionName?: string
}

function normalizeAuthor(data: FdroidPackage): string | undefined {
  if (data.authorName) return data.authorName
  if (typeof data.author === 'string') return data.author
  if (data.author && typeof data.author !== 'string' && typeof data.author.name === 'string') return data.author.name
  if (data.authorEmail) return data.authorEmail
  return undefined
}

function normalizeAuthorEmail(data: FdroidPackage): string | undefined {
  if (data.authorEmail) return data.authorEmail
  if (data.author && typeof data.author !== 'string' && typeof data.author.email === 'string') return data.author.email
  return undefined
}

function collectAntiFeatures(data: FdroidPackage): string[] {
  const values = new Set<string>()
  for (const feature of data.antiFeatures ?? []) values.add(feature)
  for (const pkg of data.packages ?? []) {
    for (const feature of pkg.antiFeatures ?? []) values.add(feature)
  }
  return Array.from(values)
}

function resolveSuggestedVersion(data: FdroidPackage): string | undefined {
  if (data.suggestedVersionName) return data.suggestedVersionName
  if (data.suggestedVersionCode) {
    const match = data.packages?.find((pkg) => pkg.versionCode === data.suggestedVersionCode)
    if (match?.versionName) return match.versionName
  }
  return data.packages?.[0]?.versionName
}

/** F-Droid package pages via the F-Droid API. */
export const scrapeFdroid: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'f-droid.org' && parsed.hostname !== 'www.f-droid.org') return null

    // Package name from /packages/{packageName} or /en/packages/{packageName}
    const match = parsed.pathname.match(/^\/(?:en\/)?packages\/([^/]+)/)
    if (!match) return null

    const packageName = decodeURIComponent(match[1])
    const apiUrl = `https://f-droid.org/api/v1/packages/${encodeURIComponent(packageName)}`

    const result = await ctx.loadPage(apiUrl, { headers: { Accept: 'application/json' } })

    if (!result.ok) return null

    const data = tryParseJson<FdroidPackage>(result.content)
    if (!data) return null

    const displayName = getLocalizedText(data.name) ?? packageName
    const summary = getLocalizedText(data.summary)
    const description = getLocalizedText(data.description)
    const author = normalizeAuthor(data)
    const authorEmail = normalizeAuthorEmail(data)
    const antiFeatures = collectAntiFeatures(data)
    const latestVersion = resolveSuggestedVersion(data)

    let md = `# ${displayName}\n\n`
    if (summary) md += `${summary}\n\n`

    md += `**Package:** ${packageName}`
    if (latestVersion) md += ` · **Latest:** ${latestVersion}`
    if (data.license) md += ` · **License:** ${data.license}`
    md += '\n'

    if (author) {
      md += `**Author:** ${author}`
      if (authorEmail && authorEmail !== author) md += ` <${authorEmail}>`
      md += '\n'
    }

    if (data.sourceCode) md += `**Source Code:** ${data.sourceCode}\n`
    if (data.categories?.length) md += `**Categories:** ${data.categories.join(', ')}\n`
    if (antiFeatures.length) md += `**Anti-Features:** ${antiFeatures.join(', ')}\n`

    if (description) {
      md += `\n## Description\n\n${description}\n`
    }

    if (data.packages?.length) {
      md += '\n## Version History\n\n'
      for (const version of data.packages.slice(0, 10)) {
        const label = version.versionName ?? 'unknown'
        const code = version.versionCode ? ` (${version.versionCode})` : ''
        md += `- ${label}${code}\n`
      }
    }

    return { content: md, method: 'fdroid', notes: ['Fetched via F-Droid API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
