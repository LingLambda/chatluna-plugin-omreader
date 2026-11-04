// Stack Exchange network questions via the API.
import type { Scraper } from './types'
import { formatIsoDate, tryParseJson } from './utils'

interface SOQuestion {
  title: string
  body: string
  score: number
  owner: { display_name: string }
  creation_date: number
  tags: string[]
  answer_count: number
  is_answered: boolean
}

interface SOAnswer {
  body: string
  score: number
  is_accepted: boolean
  owner: { display_name: string }
  creation_date: number
}

// Standalone SE network sites (not *.stackexchange.com subdomains)
const STANDALONE_SE_SITES: Record<string, string> = {
  'stackoverflow.com': 'stackoverflow',
  'superuser.com': 'superuser',
  'serverfault.com': 'serverfault',
  'askubuntu.com': 'askubuntu',
  'mathoverflow.net': 'mathoverflow',
  'stackapps.com': 'stackapps'
}

/** API `site` parameter for a Stack Exchange hostname; null when not a recognized SE site. */
function getSiteParam(hostname: string): string | null {
  const host = hostname.replace(/^www\./, '')

  if (STANDALONE_SE_SITES[host]) return STANDALONE_SE_SITES[host]

  // *.stackexchange.com subdomains (e.g. unix.stackexchange.com → unix)
  const seMatch = host.match(/^([a-z0-9-]+)\.stackexchange\.com$/)
  if (seMatch) return seMatch[1]!

  return null
}

/** Stack Exchange network questions (stackoverflow.com, *.stackexchange.com, superuser.com, …). */
export const scrapeStackOverflow: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    const site = getSiteParam(parsed.hostname)
    if (!site) return null

    // Question ID from /questions/12345/...
    const match = parsed.pathname.match(/\/questions\/(\d+)/)
    if (!match) return null

    const questionId = match[1]!

    const apiUrl = `https://api.stackexchange.com/2.3/questions/${questionId}?order=desc&sort=votes&site=${site}&filter=withbody`
    const qResult = await ctx.loadPage(apiUrl)

    if (!qResult.ok) return null

    const qData = tryParseJson<{ items: SOQuestion[] }>(qResult.content)
    if (!qData?.items?.length) return null

    const question = qData.items[0]!

    let md = `# ${question.title}\n\n`
    md += `**Score:** ${question.score} · **Answers:** ${question.answer_count}`
    md += question.is_answered ? ' (Answered)' : ''
    md += `\n**Tags:** ${question.tags.join(', ')}\n`
    md += `**Asked by:** ${question.owner.display_name} · ${formatIsoDate(question.creation_date * 1000)}\n\n`
    md += `---\n\n## Question\n\n${await ctx.htmlToMarkdown(question.body)}\n\n`

    const aUrl = `https://api.stackexchange.com/2.3/questions/${questionId}/answers?order=desc&sort=votes&site=${site}&filter=withbody`
    const aResult = await ctx.loadPage(aUrl)

    if (aResult.ok) {
      const aData = tryParseJson<{ items: SOAnswer[] }>(aResult.content)
      if (aData?.items?.length) {
        md += `---\n\n## Answers\n\n`
        for (const answer of aData.items.slice(0, 5)) {
          const accepted = answer.is_accepted ? ' (Accepted)' : ''
          md += `### Score: ${answer.score}${accepted} · by ${answer.owner.display_name}\n\n`
          md += `${await ctx.htmlToMarkdown(answer.body)}\n\n---\n\n`
        }
      }
    }

    return { content: md, method: 'stackexchange', notes: [`Fetched via Stack Exchange API (site=${site})`] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
