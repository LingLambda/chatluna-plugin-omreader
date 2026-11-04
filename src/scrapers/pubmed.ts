// PubMed article metadata, abstract and MeSH terms via NCBI E-utilities.
import type { LoadedPage } from '../types'
import type { Scraper, ScrapeResult } from './types'
import { tryParseJson } from './utils'

const NCBI_HEADERS = {
  Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
  'User-Agent': 'chatluna-plugin-omreader'
}

const MESH_TIMEOUT_MS = 5_000

interface PubMedSummary {
  result?: Record<
    string,
    {
      title?: string
      authors?: { name: string }[]
      fulljournalname?: string
      pubdate?: string
      volume?: string
      issue?: string
      pages?: string
      /** DOI. */
      elocationid?: string
      articleids?: { idtype: string; value: string }[]
    }
  >
}

export const scrapePubMed: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url

    // pubmed.ncbi.nlm.nih.gov/{pmid} or ncbi.nlm.nih.gov/pubmed/{pmid}
    if (
      parsed.hostname !== 'pubmed.ncbi.nlm.nih.gov' &&
      !(parsed.hostname === 'ncbi.nlm.nih.gov' && parsed.pathname.startsWith('/pubmed'))
    ) {
      return null
    }

    const pmid =
      parsed.hostname === 'pubmed.ncbi.nlm.nih.gov'
        ? parsed.pathname.match(/\/(\d+)/)?.[1]
        : parsed.pathname.match(/\/pubmed\/(\d+)/)?.[1]
    if (!pmid) return null

    const notes: string[] = []
    const buildFallback = (fallbackNotes: string[]): ScrapeResult => ({
      content: `# PubMed Article\n\n**PMID:** ${pmid}\n\n---\n\n## Abstract\n\nNo abstract available.\n`,
      method: 'pubmed',
      notes: fallbackNotes
    })

    // One retry on failure
    const fetchWithRetry = async (requestUrl: string, acceptJson = true): Promise<LoadedPage> => {
      const options = {
        headers: { ...NCBI_HEADERS, Accept: acceptJson ? 'application/json' : 'text/plain, */*;q=0.8' }
      }
      const response = await ctx.loadPage(requestUrl, options)
      return response.ok ? response : ctx.loadPage(requestUrl, options)
    }

    const summaryResult = await fetchWithRetry(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`
    )
    if (!summaryResult.ok) return buildFallback(['Failed to fetch PubMed summary metadata'])

    const summaryData = tryParseJson<PubMedSummary>(summaryResult.content)
    if (!summaryData) return buildFallback(['Failed to parse PubMed summary metadata'])

    const article = summaryData.result?.[pmid]
    if (!article) return buildFallback(['PubMed record unavailable from E-utilities summary endpoint'])

    const abstractResult = await fetchWithRetry(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=text`,
      false
    )

    let abstractText = ''
    if (abstractResult.ok) {
      abstractText = abstractResult.content.trim()
      notes.push('Fetched abstract via NCBI E-utilities')
    }

    let doi = ''
    let pmcid = ''
    for (const id of article.articleids ?? []) {
      if (id.idtype === 'doi') doi = id.value
      if (id.idtype === 'pmc') pmcid = id.value
    }
    if (!doi && article.elocationid) doi = article.elocationid

    let md = `# ${article.title || 'PubMed Article'}\n\n`

    if (article.authors && article.authors.length > 0) {
      md += `**Authors:** ${article.authors.map((a) => a.name).join(', ')}\n`
    }

    if (article.fulljournalname) {
      md += `**Journal:** ${article.fulljournalname}`
      if (article.pubdate) md += ` (${article.pubdate})`
      md += '\n'
    }

    const citation: string[] = []
    if (article.volume) citation.push(`Vol ${article.volume}`)
    if (article.issue) citation.push(`Issue ${article.issue}`)
    if (article.pages) citation.push(`pp ${article.pages}`)
    if (citation.length > 0) md += `**Citation:** ${citation.join(', ')}\n`

    md += `**PMID:** ${pmid}\n`
    if (doi) md += `**DOI:** ${doi}\n`
    if (pmcid) md += `**PMCID:** ${pmcid}\n`

    md += '\n---\n\n'

    md += abstractText ? `## Abstract\n\n${abstractText}\n` : `## Abstract\n\nNo abstract available.\n`

    // MeSH terms are optional
    try {
      const meshResult = await ctx.loadPage(
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=medline&retmode=text`,
        { timeoutMs: MESH_TIMEOUT_MS, headers: { ...NCBI_HEADERS, Accept: 'text/plain, */*;q=0.8' } }
      )

      if (meshResult.ok) {
        const meshTerms: string[] = []
        for (const line of meshResult.content.split('\n')) {
          if (line.startsWith('MH  - ')) meshTerms.push(line.slice(6).trim())
        }

        if (meshTerms.length > 0) {
          md += `\n## MeSH Terms\n\n`
          for (const term of meshTerms) md += `- ${term}\n`
          notes.push('Fetched MeSH terms via NCBI E-utilities')
        }
      }
    } catch {}

    return { content: md, method: 'pubmed', notes: notes.length > 0 ? notes : ['Fetched via NCBI E-utilities'] }
  } catch {
    return null
  }
}
