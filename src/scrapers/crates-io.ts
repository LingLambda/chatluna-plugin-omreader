import type { Scraper } from './types'
import { formatNumber, looksLikeHtml, tryParseJson } from './utils'

/** crates.io crate pages via the crates.io API, plus the README from docs.rs. */
export const scrapeCratesIo: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'crates.io' && parsed.hostname !== 'www.crates.io') return null

    // Crate name from /crates/name or /crates/name/version
    const match = parsed.pathname.match(/^\/crates\/([^/]+)/)
    if (!match) return null

    const crateName = decodeURIComponent(match[1])

    // crates.io requires an identifying User-Agent
    const apiUrl = `https://crates.io/api/v1/crates/${crateName}`
    const result = await ctx.loadPage(apiUrl, { headers: { 'User-Agent': 'chatluna-plugin-omreader' } })

    if (!result.ok) return null

    const data = tryParseJson<{
      crate: {
        name: string
        description: string | null
        downloads: number
        recent_downloads: number
        max_version: string
        repository: string | null
        homepage: string | null
        documentation: string | null
        categories: string[]
        keywords: string[]
        created_at: string
        updated_at: string
      }
      versions: {
        num: string
        downloads: number
        created_at: string
        license: string | null
        rust_version: string | null
      }[]
    }>(result.content)
    if (!data) return null

    const crate = data.crate
    const latestVersion = data.versions?.[0]

    let md = `# ${crate.name}\n\n`
    if (crate.description) md += `${crate.description}\n\n`

    md += `**Latest:** ${crate.max_version}`
    if (latestVersion?.license) md += ` · **License:** ${latestVersion.license}`
    if (latestVersion?.rust_version) md += ` · **MSRV:** ${latestVersion.rust_version}`
    md += '\n'
    md += `**Downloads:** ${formatNumber(crate.downloads)} total · ${formatNumber(crate.recent_downloads)} recent\n\n`

    if (crate.repository) md += `**Repository:** ${crate.repository}\n`
    if (crate.homepage && crate.homepage !== crate.repository) md += `**Homepage:** ${crate.homepage}\n`
    if (crate.documentation) md += `**Docs:** ${crate.documentation}\n`
    if (crate.keywords?.length) md += `**Keywords:** ${crate.keywords.join(', ')}\n`
    if (crate.categories?.length) md += `**Categories:** ${crate.categories.join(', ')}\n`

    if (data.versions?.length > 0) {
      md += `\n## Recent Versions\n\n`
      for (const ver of data.versions.slice(0, 5)) {
        const date = ver.created_at.split('T')[0]
        md += `- **${ver.num}** (${date}) - ${formatNumber(ver.downloads)} downloads\n`
      }
    }

    // README from docs.rs
    const docsRsUrl = `https://docs.rs/crate/${crateName}/${crate.max_version}/source/README.md`
    const readmeResult = await ctx.loadPage(docsRsUrl, { timeoutMs: 5000 })
    if (readmeResult.ok && readmeResult.content.length > 100 && !looksLikeHtml(readmeResult.content)) {
      md += `\n---\n\n## README\n\n${readmeResult.content}\n`
    }

    return { content: md, method: 'crates.io', notes: ['Fetched via crates.io API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
