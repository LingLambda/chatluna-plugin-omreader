import type { Scraper } from './types'
import { formatIsoDate, formatNumber, tryParseJson } from './utils'

/** Hex.pm (Elixir) package pages via the Hex API. */
export const scrapeHex: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'hex.pm' && parsed.hostname !== 'www.hex.pm') return null

    // Package name from /packages/name or /packages/name/version
    const match = parsed.pathname.match(/^\/packages\/([^/]+)/)
    if (!match) return null

    const packageName = decodeURIComponent(match[1])

    const apiUrl = `https://hex.pm/api/packages/${packageName}`
    const result = await ctx.loadPage(apiUrl)

    if (!result.ok) return null

    const data = tryParseJson<{
      name: string
      meta?: {
        description?: string
        links?: Record<string, string>
        licenses?: string[]
      }
      releases?: {
        version: string
        inserted_at: string
      }[]
      downloads?: {
        all?: number
        week?: number
        day?: number
      }
      latest_version?: string
      latest_stable_version?: string
    }>(result.content)
    if (!data) return null

    let md = `# ${data.name}\n\n`
    if (data.meta?.description) md += `${data.meta.description}\n\n`

    const version = data.latest_stable_version || data.latest_version || 'unknown'
    md += `**Latest:** ${version}`
    if (data.meta?.licenses?.length) md += ` · **License:** ${data.meta.licenses.join(', ')}`
    md += '\n'

    if (data.downloads?.all) {
      md += `**Total Downloads:** ${formatNumber(data.downloads.all)}`
      if (data.downloads.week) md += ` · **This Week:** ${formatNumber(data.downloads.week)}`
      md += '\n'
    }
    md += '\n'

    if (data.meta?.links && Object.keys(data.meta.links).length > 0) {
      md += `## Links\n\n`
      for (const [key, value] of Object.entries(data.meta.links)) {
        md += `- **${key}:** ${value}\n`
      }
      md += '\n'
    }

    if (data.releases?.length) {
      const releasesUrl = `https://hex.pm/api/packages/${packageName}/releases/${version}`
      const releaseResult = await ctx.loadPage(releasesUrl, { timeoutMs: 5000 })

      if (releaseResult.ok) {
        const releaseData = tryParseJson<{
          requirements?: Record<string, { app?: string; optional: boolean; requirement: string }>
        }>(releaseResult.content)

        if (releaseData?.requirements && Object.keys(releaseData.requirements).length > 0) {
          md += `## Dependencies (${version})\n\n`
          for (const [dep, info] of Object.entries(releaseData.requirements)) {
            const optional = info.optional ? ' (optional)' : ''
            md += `- ${dep}: ${info.requirement}${optional}\n`
          }
          md += '\n'
        }
      }

      const recentReleases = data.releases.slice(0, 10)
      if (recentReleases.length > 0) {
        md += `## Recent Releases\n\n`
        for (const release of recentReleases) {
          const date = formatIsoDate(release.inserted_at)
          md += `- **${release.version}** (${date})\n`
        }
      }
    }

    return { content: md, method: 'hex', notes: ['Fetched via Hex.pm API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
