import { parseHTML } from 'linkedom'
import type { Scraper } from './types'

const SKIPPED_SECTIONS: Record<string, true> = {
  References: true,
  'External links': true,
  'See also': true,
  Notes: true,
  'Further reading': true
}

/** Wikipedia articles via the REST summary and mobile-html APIs. */
export const scrapeWikipedia: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    // Match *.wikipedia.org
    const wikiMatch = parsed.hostname.match(/^(\w+)\.wikipedia\.org$/)
    if (!wikiMatch) return null

    const lang = wikiMatch[1]!
    const titleMatch = parsed.pathname.match(/\/wiki\/(.+)/)
    if (!titleMatch) return null

    const title = decodeURIComponent(titleMatch[1]!)

    // Plain-text extract
    const apiUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
    const summaryResult = await ctx.loadPage(apiUrl)

    let md = ''

    if (summaryResult.ok) {
      const summary = JSON.parse(summaryResult.content) as {
        title: string
        description?: string
        extract: string
      }
      md = `# ${summary.title}\n\n`
      if (summary.description) md += `*${summary.description}*\n\n`
      md += `${summary.extract}\n\n---\n\n`
    }

    // Full article content via mobile-html
    const contentUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/mobile-html/${encodeURIComponent(title)}`
    const contentResult = await ctx.loadPage(contentUrl)

    if (contentResult.ok) {
      const doc = parseHTML(contentResult.content).document

      for (const section of doc.querySelectorAll('section')) {
        const heading = section.querySelector('h2, h3, h4')
        const headingText = heading?.textContent?.trim()
        if (headingText && SKIPPED_SECTIONS[headingText]) continue

        if (headingText) {
          const level = heading?.tagName === 'H2' ? '##' : '###'
          md += `${level} ${headingText}\n\n`
        }

        for (const p of section.querySelectorAll('p')) {
          const text = p.textContent?.trim()
          if (text && text.length > 20) {
            md += `${text}\n\n`
          }
        }
      }
    }

    if (!md) return null

    return { content: md, method: 'wikipedia', notes: ['Fetched via Wikipedia API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
