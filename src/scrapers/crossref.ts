// DOI links resolved via the CrossRef works API.
import type { Scraper } from './types'
import { tryParseJson } from './utils'

interface CrossrefAuthor {
  given?: string
  family?: string
  name?: string
}

interface CrossrefDate {
  'date-parts'?: number[][]
}

interface CrossrefMessage {
  title?: string[]
  author?: CrossrefAuthor[]
  'container-title'?: string[]
  'short-container-title'?: string[]
  publisher?: string
  published?: CrossrefDate
  'published-print'?: CrossrefDate
  'published-online'?: CrossrefDate
  issued?: CrossrefDate
  created?: CrossrefDate
  DOI?: string
  abstract?: string
  type?: string
}

interface CrossrefResponse {
  message?: CrossrefMessage
}

const DOI_HOSTS: Record<string, true> = { 'doi.org': true, 'dx.doi.org': true, 'www.doi.org': true }

function formatAuthors(authors?: CrossrefAuthor[]): string | null {
  if (!authors || authors.length === 0) return null
  const names = authors
    .map((author) => {
      if (author.name) return author.name
      const parts = [author.given, author.family].filter(Boolean)
      return parts.length > 0 ? parts.join(' ') : null
    })
    .filter((name): name is string => Boolean(name))
  if (names.length === 0) return null
  return names.join(', ')
}

function formatDate(date?: CrossrefDate): string | null {
  const parts = date?.['date-parts']?.[0]
  if (!parts || parts.length === 0) return null
  const [year, month, day] = parts
  if (!year) return null
  return [String(year), month ? String(month).padStart(2, '0') : '', day ? String(day).padStart(2, '0') : '']
    .filter(Boolean)
    .join('-')
}

export const scrapeCrossref: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (DOI_HOSTS[parsed.hostname.toLowerCase()] !== true) return null

    const rawDoi = parsed.pathname.replace(/^\/+/, '')
    if (!rawDoi) return null
    const doi = decodeURIComponent(rawDoi)

    const result = await ctx.loadPage(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { Accept: 'application/json' }
    })
    if (!result.ok) return null

    const message = tryParseJson<CrossrefResponse>(result.content)?.message
    if (!message) return null

    const title = message.title?.[0]?.trim() || 'CrossRef Record'
    const authors = formatAuthors(message.author)
    const journal = message['container-title']?.[0] || message['short-container-title']?.[0]
    const publisher = message.publisher
    const published =
      formatDate(message.published) ||
      formatDate(message['published-print']) ||
      formatDate(message['published-online']) ||
      formatDate(message.issued) ||
      formatDate(message.created)
    const doiValue = message.DOI || doi
    const type = message.type?.replace(/-/g, ' ')

    // JATS paragraphs become HTML paragraphs before conversion
    let abstract: string | null = null
    if (message.abstract) {
      const normalized = message.abstract.replace(/<\/?jats:p[^>]*>/g, (match) =>
        match.startsWith('</') ? '</p>' : '<p>'
      )
      const markdown = await ctx.htmlToMarkdown(normalized)
      if (markdown.trim().length > 0) abstract = markdown
    }

    let md = `# ${title}\n\n`
    if (authors) md += `**Authors:** ${authors}\n`
    if (journal) md += `**Journal:** ${journal}\n`
    if (publisher) md += `**Publisher:** ${publisher}\n`
    if (published) md += `**Published:** ${published}\n`
    md += `**DOI:** ${doiValue}\n`
    if (type) md += `**Type:** ${type}\n`
    md += '\n---\n\n'
    md += '## Abstract\n\n'
    md += abstract || 'No abstract available.'
    md += '\n'

    return { content: md, method: 'crossref', notes: ['Fetched via CrossRef API'] }
  } catch {}

  return null
}
