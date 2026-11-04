import type { Scraper } from './types'
import { formatNumber, tryParseJson } from './utils'

/** npm package pages via the registry API. */
export const scrapeNpm: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'www.npmjs.com' && parsed.hostname !== 'npmjs.com') return null

    // Package name from /package/[scope/]name
    const match = parsed.pathname.match(/^\/package\/(.+?)(?:\/|$)/)
    if (!match) return null

    let packageName = decodeURIComponent(match[1])
    // Scoped packages: /package/@scope/name
    if (packageName.startsWith('@')) {
      const scopeMatch = parsed.pathname.match(/^\/package\/(@[^/]+\/[^/]+)/)
      if (scopeMatch) packageName = decodeURIComponent(scopeMatch[1])
    }

    // The /latest endpoint keeps the response small
    const latestUrl = `https://registry.npmjs.org/${packageName}/latest`
    const downloadsUrl = `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(packageName)}`

    const [result, downloadsResult] = await Promise.all([
      ctx.loadPage(latestUrl),
      ctx.loadPage(downloadsUrl, { timeoutMs: 5000 })
    ])

    if (!result.ok) return null

    let weeklyDownloads: number | null = null
    if (downloadsResult.ok) {
      const dlData = tryParseJson<{ downloads?: number }>(downloadsResult.content)
      if (dlData) weeklyDownloads = dlData.downloads ?? null
    }

    const pkg = tryParseJson<{
      name: string
      version: string
      description?: string
      license?: string | { type: string }
      homepage?: string
      repository?: { url: string } | string
      keywords?: string[]
      maintainers?: { name: string }[]
      dependencies?: Record<string, string>
      readme?: string
    }>(result.content)
    if (!pkg) return null

    let md = `# ${pkg.name}\n\n`
    if (pkg.description) md += `${pkg.description}\n\n`

    md += `**Latest:** ${pkg.version || 'unknown'}`
    if (pkg.license) {
      const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license.type ?? String(pkg.license))
      md += ` · **License:** ${license}`
    }
    md += '\n'
    if (weeklyDownloads !== null) {
      md += `**Weekly Downloads:** ${formatNumber(weeklyDownloads)}\n`
    }
    md += '\n'

    if (pkg.homepage) md += `**Homepage:** ${pkg.homepage}\n`
    const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    if (repoUrl) md += `**Repository:** ${repoUrl.replace(/^git\+/, '').replace(/\.git$/, '')}\n`
    if (pkg.keywords?.length) md += `**Keywords:** ${pkg.keywords.join(', ')}\n`
    if (pkg.maintainers?.length) md += `**Maintainers:** ${pkg.maintainers.map((m) => m.name).join(', ')}\n`

    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      md += `\n## Dependencies\n\n`
      for (const [dep, version] of Object.entries(pkg.dependencies)) {
        md += `- ${dep}: ${version}\n`
      }
    }

    if (pkg.readme) {
      md += `\n---\n\n## README\n\n${pkg.readme}\n`
    }

    return { content: md, method: 'npm', notes: ['Fetched via npm registry'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
