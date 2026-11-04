import type { Scraper } from './types'
import { formatNumber, tryParseJson } from './utils'

interface OpenVsxFileLinks {
  readme?: string
}

interface OpenVsxExtension {
  name: string
  namespace: string
  version: string
  displayName?: string
  description?: string
  downloadCount?: number
  averageRating?: number
  reviewCount?: number
  repository?: string | { url?: string }
  license?: string
  categories?: string[]
  homepage?: string
  files?: OpenVsxFileLinks
}

/** Open VSX extension pages via the Open VSX API. */
export const scrapeOpenVsx: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'open-vsx.org' && parsed.hostname !== 'www.open-vsx.org') return null

    const match = parsed.pathname.match(/^\/extension\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/)
    if (!match) return null

    const namespace = decodeURIComponent(match[1])
    const extension = decodeURIComponent(match[2])
    const version = match[3] ? decodeURIComponent(match[3]) : null

    const baseUrl = `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(extension)}`
    const apiUrl = version ? `${baseUrl}/${encodeURIComponent(version)}` : baseUrl

    const result = await ctx.loadPage(apiUrl)
    if (!result.ok) return null

    const data = tryParseJson<OpenVsxExtension>(result.content)
    if (!data) return null

    let readme: string | null = null
    const readmeUrl = data.files?.readme
    if (readmeUrl) {
      try {
        const readmeResult = await ctx.loadPage(readmeUrl, { timeoutMs: 10_000 })
        if (readmeResult.ok) readme = readmeResult.content
      } catch {
        // Continue without the README
      }
    }

    const displayName = data.displayName || data.name || `${namespace}/${extension}`
    const displayNamespace = data.namespace || namespace
    const displayVersion = data.version || version || 'unknown'
    const downloads = typeof data.downloadCount === 'number' ? data.downloadCount : null
    const rating = typeof data.averageRating === 'number' ? data.averageRating : null
    const reviews = typeof data.reviewCount === 'number' ? data.reviewCount : null
    const repository = typeof data.repository === 'string' ? data.repository : data.repository?.url || null

    let md = `# ${displayName}\n\n`
    if (data.description) md += `${data.description}\n\n`

    md += `**Namespace:** ${displayNamespace}\n`
    md += `**Extension:** ${data.name || extension}\n`
    md += `**Version:** ${displayVersion}`
    if (data.license) md += ` | **License:** ${data.license}`
    md += '\n'

    if (downloads !== null) {
      md += `**Downloads:** ${formatNumber(downloads)}\n`
    }

    if (rating !== null) {
      const reviewSuffix = reviews !== null ? ` (${reviews} reviews)` : ''
      md += `**Rating:** ${rating}${reviewSuffix}\n`
    }

    if (repository) {
      const cleanedRepo = repository.replace(/^git\+/, '').replace(/\.git$/, '')
      md += `**Repository:** ${cleanedRepo}\n`
    }

    if (data.homepage) md += `**Homepage:** ${data.homepage}\n`
    if (data.categories?.length) md += `**Categories:** ${data.categories.join(', ')}\n`

    if (readme) {
      md += '\n---\n\n## README\n\n'
      md += `${readme}\n`
    }

    return { content: md, method: 'open-vsx', notes: ['Fetched via Open VSX API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
