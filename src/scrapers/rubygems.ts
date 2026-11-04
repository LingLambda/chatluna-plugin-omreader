import type { Scraper } from './types'
import { formatNumber, tryParseJson } from './utils'

interface RubyGemsDependency {
  name: string
  requirements: string
}

interface RubyGemsResponse {
  name: string
  version: string
  version_created_at?: string
  authors?: string
  info?: string
  licenses?: string[]
  homepage_uri?: string
  source_code_uri?: string
  documentation_uri?: string
  project_uri?: string
  downloads: number
  version_downloads?: number
  gem_uri?: string
  dependencies?: {
    development?: RubyGemsDependency[]
    runtime?: RubyGemsDependency[]
  }
  metadata?: Record<string, string>
}

/** RubyGems gem pages via the RubyGems API. */
export const scrapeRubyGems: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'rubygems.org' && parsed.hostname !== 'www.rubygems.org') return null

    // Gem name from /gems/{name}
    const match = parsed.pathname.match(/^\/gems\/([^/]+)/)
    if (!match) return null

    const gemName = decodeURIComponent(match[1])

    const apiUrl = `https://rubygems.org/api/v1/gems/${encodeURIComponent(gemName)}.json`
    const result = await ctx.loadPage(apiUrl, { headers: { Accept: 'application/json' } })

    if (!result.ok) return null

    const gem = tryParseJson<RubyGemsResponse>(result.content)
    if (!gem) return null

    let md = `# ${gem.name}\n\n`
    if (gem.info) md += `${gem.info}\n\n`

    md += `**Version:** ${gem.version}`
    if (gem.licenses?.length) md += ` · **License:** ${gem.licenses.join(', ')}`
    md += '\n'

    md += `**Total Downloads:** ${formatNumber(gem.downloads)}`
    if (gem.version_downloads) md += ` · **Version Downloads:** ${formatNumber(gem.version_downloads)}`
    md += '\n\n'

    if (gem.homepage_uri) md += `**Homepage:** ${gem.homepage_uri}\n`
    if (gem.source_code_uri) md += `**Source Code:** ${gem.source_code_uri}\n`
    if (gem.documentation_uri) md += `**Documentation:** ${gem.documentation_uri}\n`
    if (gem.authors) md += `**Authors:** ${gem.authors}\n`

    const runtimeDeps = gem.dependencies?.runtime
    if (runtimeDeps && runtimeDeps.length > 0) {
      md += `\n## Runtime Dependencies\n\n`
      for (const dep of runtimeDeps) {
        md += `- ${dep.name} ${dep.requirements}\n`
      }
    }

    const devDeps = gem.dependencies?.development
    if (devDeps && devDeps.length > 0) {
      md += `\n## Development Dependencies\n\n`
      for (const dep of devDeps) {
        md += `- ${dep.name} ${dep.requirements}\n`
      }
    }

    return { content: md, method: 'rubygems', notes: ['Fetched via RubyGems API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
