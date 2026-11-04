// arXiv papers: metadata via the arXiv API, full text for PDF links.
import { parseHTML } from 'linkedom'
import type { Scraper } from './types'

export const scrapeArxiv: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'arxiv.org') return null

    // Paper ID from /abs/1234.56789, /pdf/1234.56789, /abs/cs/0123456
    const match = parsed.pathname.match(/\/(abs|pdf)\/(.+?)(?:\.pdf)?$/)
    if (!match) return null

    const paperId = match[2]!
    const notes: string[] = []

    const result = await ctx.loadPage(`https://export.arxiv.org/api/query?id_list=${paperId}`)
    if (!result.ok) return null

    // Parse the Atom feed response
    const doc = parseHTML(result.content).document
    const entry = doc.querySelector('entry')
    if (!entry) return null

    const title = entry.querySelector('title')?.textContent?.trim()?.replace(/\s+/g, ' ')
    const summary = entry.querySelector('summary')?.textContent?.trim()
    const authors = Array.from(entry.querySelectorAll('author name'))
      .map((n) => n.textContent?.trim())
      .filter((name): name is string => Boolean(name))
    const published = entry.querySelector('published')?.textContent?.trim()?.split('T')[0]
    const categories = Array.from(entry.querySelectorAll('category'))
      .map((c) => c.getAttribute('term'))
      .filter((term): term is string => Boolean(term))
    const pdfLink = entry.querySelector('link[title="pdf"]')?.getAttribute('href')

    let md = `# ${title || 'arXiv Paper'}\n\n`
    if (authors.length) md += `**Authors:** ${authors.join(', ')}\n`
    if (published) md += `**Published:** ${published}\n`
    if (categories.length) md += `**Categories:** ${categories.join(', ')}\n`
    md += `**arXiv:** ${paperId}\n\n`
    md += `---\n\n## Abstract\n\n${summary || 'No abstract available.'}\n\n`

    // PDF links get the converted full text
    if ((match[1] === 'pdf' || parsed.pathname.includes('.pdf')) && pdfLink) {
      notes.push('Fetching PDF for full content...')
      const pdfResult = await ctx.loadBinary(pdfLink)
      if (pdfResult.ok) {
        const converted = await ctx.convertDocument(pdfResult.bytes, '.pdf')
        if (converted && converted.length > 500) {
          md += `---\n\n## Full Paper\n\n${converted}\n`
          notes.push('PDF converted to Markdown')
        }
      }
    }

    return { content: md, method: 'arxiv', notes: notes.length ? notes : ['Fetched via arXiv API'] }
  } catch {}

  return null
}
