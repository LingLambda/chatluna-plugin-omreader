// IACR ePrint Archive metadata, full text for PDF links.
import { parseHTML } from 'linkedom'
import type { Scraper } from './types'

export const scrapeIacr: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'eprint.iacr.org') return null

    // Paper ID from /year/number or /year/number.pdf
    const match = parsed.pathname.match(/\/(\d{4})\/(\d+)(?:\.pdf)?$/)
    if (!match) return null

    const paperId = `${match[1]}/${match[2]}`
    const notes: string[] = []

    // The HTML page carries the metadata
    const result = await ctx.loadPage(`https://eprint.iacr.org/${paperId}`)
    if (!result.ok) return null

    const doc = parseHTML(result.content).document

    const title =
      doc.querySelector('h3.mb-3')?.textContent?.trim() ||
      doc.querySelector('meta[name="citation_title"]')?.getAttribute('content')
    const authors = Array.from(doc.querySelectorAll('meta[name="citation_author"]'))
      .map((m) => m.getAttribute('content'))
      .filter((author): author is string => Boolean(author))
    // The abstract is the <p> after <h5>Abstract</h5>
    const abstractHeading = Array.from(doc.querySelectorAll('h5')).find((h) => h.textContent?.includes('Abstract'))
    const abstract =
      abstractHeading?.parentElement?.querySelector('p')?.textContent?.trim() ||
      doc.querySelector('meta[name="description"]')?.getAttribute('content')
    const keywords = doc.querySelector('.keywords')?.textContent?.replace('Keywords:', '').trim()
    const pubDate = doc.querySelector('meta[name="citation_publication_date"]')?.getAttribute('content')

    let md = `# ${title || 'IACR ePrint Paper'}\n\n`
    if (authors.length) md += `**Authors:** ${authors.join(', ')}\n`
    if (pubDate) md += `**Date:** ${pubDate}\n`
    md += `**ePrint:** ${paperId}\n`
    if (keywords) md += `**Keywords:** ${keywords}\n`
    md += `\n---\n\n## Abstract\n\n${abstract || 'No abstract available.'}\n\n`

    // PDF links get the converted full text
    if (parsed.pathname.endsWith('.pdf')) {
      notes.push('Fetching PDF for full content...')
      const pdfResult = await ctx.loadBinary(`https://eprint.iacr.org/${paperId}.pdf`)
      if (pdfResult.ok) {
        const converted = await ctx.convertDocument(pdfResult.bytes, '.pdf')
        if (converted && converted.length > 500) {
          md += `---\n\n## Full Paper\n\n${converted}\n`
          notes.push('PDF converted to Markdown')
        }
      }
    }

    return { content: md, method: 'iacr', notes: notes.length ? notes : ['Fetched from IACR ePrint Archive'] }
  } catch {}

  return null
}
