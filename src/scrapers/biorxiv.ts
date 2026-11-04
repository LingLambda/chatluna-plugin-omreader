// bioRxiv and medRxiv preprints via their details API.
import type { Scraper } from './types'
import { tryParseJson } from './utils'

interface BiorxivPaper {
  biorxiv_doi?: string
  medrxiv_doi?: string
  title?: string
  authors?: string
  author_corresponding?: string
  author_corresponding_institution?: string
  abstract?: string
  date?: string
  category?: string
  version?: string
  type?: string
  license?: string
  jatsxml?: string
  /** Journal DOI once published. */
  published?: string
  server?: string
}

interface BiorxivResponse {
  collection?: BiorxivPaper[]
  messages?: { status: string; count: number }[]
}

export const scrapeBiorxiv: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    const hostname = parsed.hostname.toLowerCase()

    const isBiorxiv = hostname === 'www.biorxiv.org' || hostname === 'biorxiv.org'
    const isMedrxiv = hostname === 'www.medrxiv.org' || hostname === 'medrxiv.org'
    if (!isBiorxiv && !isMedrxiv) return null

    // DOI from the path: /content/10.1101/2024.01.01.123456
    const match = parsed.pathname.match(/\/content\/(10\.\d{4,}\/[^\s?#]+)/)
    if (!match) return null

    // Drop a version suffix (v1, v2), then a trailing .full or .full.pdf
    const doi = match[1]!.replace(/v\d+$/, '').replace(/\.full(\.pdf)?$/, '')

    const server = isBiorxiv ? 'biorxiv' : 'medrxiv'
    const result = await ctx.loadPage(`https://api.${server}.org/details/${server}/${doi}/na/json`, {
      headers: { Accept: 'application/json' }
    })
    if (!result.ok) return null

    const data = tryParseJson<BiorxivResponse>(result.content)
    if (!data?.collection || data.collection.length === 0) return null

    // The latest version is last
    const paper = data.collection[data.collection.length - 1]
    if (!paper) return null

    const serverName = isBiorxiv ? 'bioRxiv' : 'medRxiv'
    const paperDoi = paper.biorxiv_doi || paper.medrxiv_doi || doi

    let md = `# ${paper.title || 'Untitled Preprint'}\n\n`

    if (paper.authors) md += `**Authors:** ${paper.authors}\n`
    if (paper.author_corresponding) {
      let correspondingLine = `**Corresponding Author:** ${paper.author_corresponding}`
      if (paper.author_corresponding_institution) correspondingLine += ` (${paper.author_corresponding_institution})`
      md += `${correspondingLine}\n`
    }
    if (paper.date) md += `**Posted:** ${paper.date}\n`
    if (paper.category) md += `**Category:** ${paper.category}\n`
    if (paper.version) md += `**Version:** ${paper.version}\n`
    if (paper.license) md += `**License:** ${paper.license}\n`
    md += `**DOI:** [${paperDoi}](https://doi.org/${paperDoi})\n`
    md += `**Server:** ${serverName}\n`

    if (paper.published) {
      md += `\n> **Published in journal:** [${paper.published}](https://doi.org/${paper.published})\n`
    }

    md += `\n---\n\n## Abstract\n\n${paper.abstract || 'No abstract available.'}\n`

    md += `\n---\n\n## Links\n\n`
    md += `- [View on ${serverName}](https://www.${server}.org/content/${paperDoi})\n`
    md += `- [PDF](https://www.${server}.org/content/${paperDoi}.full.pdf)\n`
    if (paper.jatsxml) md += `- [JATS XML](${paper.jatsxml})\n`

    return { content: md, method: server, notes: [`Fetched via ${serverName} API`] }
  } catch {}

  return null
}
