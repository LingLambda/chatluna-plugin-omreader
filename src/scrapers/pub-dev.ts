import type { Scraper } from './types'
import { formatNumber, tryParseJson } from './utils'

/** pub.dev (Dart/Flutter) package pages via the pub.dev API. */
export const scrapePubDev: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'pub.dev' && parsed.hostname !== 'www.pub.dev') return null

    // Package name from /packages/{package}
    const match = parsed.pathname.match(/^\/packages\/([^/]+)/)
    if (!match) return null

    const packageName = decodeURIComponent(match[1])

    const apiUrl = `https://pub.dev/api/packages/${encodeURIComponent(packageName)}`
    const result = await ctx.loadPage(apiUrl)

    if (!result.ok) return null

    const data = tryParseJson<{
      name: string
      latest: {
        version: string
        pubspec: {
          description?: string
          homepage?: string
          repository?: string
          documentation?: string
          environment?: Record<string, string>
          dependencies?: Record<string, unknown>
          dev_dependencies?: Record<string, unknown>
        }
      }
      publisherId?: string
      metrics?: {
        score?: {
          likeCount?: number
          grantedPoints?: number
          maxPoints?: number
          popularityScore?: number
        }
      }
    }>(result.content)
    if (!data) return null

    const { name, latest, publisherId, metrics } = data
    const pubspec = latest.pubspec

    let md = `# ${name}\n\n`
    if (pubspec.description) md += `${pubspec.description}\n\n`

    md += `**Latest:** ${latest.version}`
    if (publisherId) md += ` · **Publisher:** ${publisherId}`
    md += '\n'

    const score = metrics?.score
    if (score) {
      const likes = score.likeCount
      const points = score.grantedPoints
      const maxPoints = score.maxPoints
      const popularity = score.popularityScore

      if (likes !== undefined) md += `**Likes:** ${formatNumber(likes)}`
      if (points !== undefined && maxPoints !== undefined) {
        md += ` · **Pub Points:** ${points}/${maxPoints}`
      }
      if (popularity !== undefined) {
        md += ` · **Popularity:** ${Math.round(popularity * 100)}%`
      }
      md += '\n'
    }

    md += '\n'

    if (pubspec.homepage) md += `**Homepage:** ${pubspec.homepage}\n`
    if (pubspec.repository) md += `**Repository:** ${pubspec.repository}\n`
    if (pubspec.documentation) md += `**Documentation:** ${pubspec.documentation}\n`

    // SDK constraints
    if (pubspec.environment) {
      const constraints: string[] = []
      for (const [key, value] of Object.entries(pubspec.environment)) {
        constraints.push(`${key}: ${value}`)
      }
      if (constraints.length > 0) {
        md += `**SDK:** ${constraints.join(', ')}\n`
      }
    }

    md += '\n'

    if (pubspec.dependencies) {
      const deps = Object.keys(pubspec.dependencies)
      if (deps.length > 0) {
        md += `## Dependencies (${deps.length})\n\n`
        for (const dep of deps.slice(0, 20)) {
          const constraint = pubspec.dependencies[dep]
          const constraintStr =
            typeof constraint === 'string' ? constraint : typeof constraint === 'object' ? 'complex' : ''
          md += `- ${dep}`
          if (constraintStr) md += `: ${constraintStr}`
          md += '\n'
        }
        if (deps.length > 20) {
          md += `\n[…${deps.length - 20} dependencies elided…]\n`
        }
        md += '\n'
      }
    }

    // README from the pub.dev page
    const readmeUrl = `https://pub.dev/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(latest.version)}/readme`
    try {
      const readmeResult = await ctx.loadPage(readmeUrl, { timeoutMs: 10_000 })
      if (readmeResult.ok) {
        const readmeMatch = readmeResult.content.match(
          /<div[^>]*class="[^"]*markdown-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i
        )
        if (readmeMatch) {
          const readme = await ctx.htmlToMarkdown(readmeMatch[1])

          if (readme.length > 100) {
            md += `## README\n\n${readme}\n`
          }
        }
      }
    } catch {
      // Continue without the README
    }

    return { content: md, method: 'pub.dev', notes: ['Fetched via pub.dev API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
