// MDN docs via the `index.json` document API.
import type { ScrapeContext, Scraper } from './types'
import { tryParseJson } from './utils'

interface MDNSection {
  type: string
  value: {
    id?: string
    title?: string
    content?: string
    isH3?: boolean
    code?: string
    language?: string
    items?: { term: string; description: string }[]
    rows?: string[][]
  }
}

interface MDNDoc {
  doc: {
    title: string
    summary: string
    mdn_url: string
    body: MDNSection[]
    browserCompat?: unknown
  }
}

/** MDN body sections → Markdown. */
async function convertMDNBody(ctx: ScrapeContext, sections: MDNSection[]): Promise<string> {
  const parts: string[] = []

  for (const section of sections) {
    const { type, value } = section

    switch (type) {
      case 'prose':
        if (value.content) {
          const markdown = await ctx.htmlToMarkdown(value.content)
          if (value.title) {
            const level = value.isH3 ? '###' : '##'
            parts.push(`${level} ${value.title}\n\n${markdown}`)
          } else {
            parts.push(markdown)
          }
        }
        break

      case 'browser_compatibility':
        if (value.title) {
          parts.push(`## ${value.title}\n\n(See browser compatibility data at MDN)`)
        }
        break

      case 'specifications':
        if (value.title) {
          parts.push(`## ${value.title}\n\n(See specifications at MDN)`)
        }
        break

      case 'code_example':
        if (value.title) {
          parts.push(`### ${value.title}`)
        }
        if (value.code) {
          const lang = value.language || ''
          parts.push(`\`\`\`${lang}\n${value.code}\n\`\`\``)
        }
        break

      case 'definition_list':
        if (value.items) {
          for (const item of value.items) {
            parts.push(`**${item.term}**`)
            parts.push(await ctx.htmlToMarkdown(item.description))
          }
        }
        break

      case 'table':
        if (value.rows && value.rows.length > 0) {
          const headerRow = value.rows[0]!
          const header = (await Promise.all(headerRow.map((cell) => ctx.htmlToMarkdown(cell)))).join(' | ')
          const separator = headerRow.map(() => '---').join(' | ')
          const bodyRows = await Promise.all(
            value.rows
              .slice(1)
              .map(async (row) => (await Promise.all(row.map((cell) => ctx.htmlToMarkdown(cell)))).join(' | '))
          )

          parts.push(`| ${header} |`)
          parts.push(`| ${separator} |`)
          for (const row of bodyRows) {
            parts.push(`| ${row} |`)
          }
        }
        break

      default:
        // Unknown section types are skipped
        break
    }
  }

  return parts.join('\n\n')
}

export const scrapeMDN: Scraper = async (ctx) => {
  const urlObj = ctx.url

  // Only developer.mozilla.org docs paths
  if (!urlObj.hostname.includes('developer.mozilla.org')) return null
  if (!urlObj.pathname.includes('/docs/')) return null

  const notes: string[] = []
  const jsonUrl = ctx.url.href.replace(/\/?$/, '/index.json')

  try {
    const result = await ctx.loadPage(jsonUrl, { headers: { Accept: 'application/json' } })
    if (!result.ok) return null

    const data = tryParseJson<MDNDoc>(result.content)
    if (!data?.doc?.title) return null

    const { doc } = data
    const parts: string[] = []

    parts.push(`# ${doc.title}`)

    if (doc.summary) {
      parts.push(await ctx.htmlToMarkdown(doc.summary))
    }

    if (doc.body && doc.body.length > 0) {
      parts.push(await convertMDNBody(ctx, doc.body))
    }

    return {
      content: parts.join('\n\n'),
      method: 'mdn',
      finalUrl: doc.mdn_url || result.finalUrl,
      notes
    }
  } catch {
    return null
  }
}
