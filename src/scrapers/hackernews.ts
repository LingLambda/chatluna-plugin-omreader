// Hacker News items and listings via the Firebase API.
import type { PageLoader } from '../types'
import type { Scraper } from './types'
import { decodeHtmlEntities, formatIsoDate, tryParseJson } from './utils'

/** Comment threads rendered at once; each fetches up to 10 replies in parallel. */
const HN_CHILD_THREAD_CONCURRENCY = 2

interface HNItem {
  id: number
  deleted?: boolean
  type?: 'job' | 'story' | 'comment' | 'poll' | 'pollopt'
  by?: string
  time?: number
  text?: string
  dead?: boolean
  parent?: number
  poll?: number
  kids?: number[]
  url?: string
  score?: number
  title?: string
  parts?: number[]
  descendants?: number
}

const API_BASE = 'https://hacker-news.firebaseio.com/v0'

/** Ordered results of `fn` over `items`, at most `limit` in flight. */
async function mapWithConcurrencyLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function fetchItem(loadPage: PageLoader, id: number): Promise<HNItem | null> {
  const { content, ok } = await loadPage(`${API_BASE}/item/${id}.json`)
  if (!ok) return null
  return tryParseJson<HNItem>(content)
}

async function fetchItems(loadPage: PageLoader, ids: number[], limit = 20): Promise<HNItem[]> {
  const results = await Promise.all(ids.slice(0, limit).map((id) => fetchItem(loadPage, id)))
  return results.filter((item): item is HNItem => item !== null && !item.deleted && !item.dead)
}

function decodeHNText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<p>/g, '\n\n')
      .replace(/<\/p>/g, '')
      .replace(/<pre><code>/g, '\n```\n')
      .replace(/<\/code><\/pre>/g, '\n```\n')
      .replace(/<code>/g, '`')
      .replace(/<\/code>/g, '`')
      .replace(/<i>/g, '*')
      .replace(/<\/i>/g, '*')
      .replace(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g, '[$2]($1)')
      .replace(/<[^>]+>/g, '')
  ).trim()
}

function formatTimestamp(unixTime: number): string {
  const diff = Date.now() - unixTime * 1000
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(hours / 24)

  if (days > 7) return formatIsoDate(unixTime * 1000)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  const minutes = Math.floor(diff / (1000 * 60))
  return `${minutes}m ago`
}

async function renderStory(loadPage: PageLoader, item: HNItem, depth = 0): Promise<string> {
  let output = ''

  if (depth === 0) {
    output += `# ${item.title}\n\n`
    if (item.url) output += `**URL:** ${item.url}\n\n`
    output += `**Posted by:** ${item.by} | **Score:** ${item.score ?? 0} | **Time:** ${formatTimestamp(item.time ?? 0)}`
    if (item.descendants) output += ` | **Comments:** ${item.descendants}`
    output += '\n\n'
  }

  if (item.text) output += `${decodeHNText(item.text)}\n\n`

  if (item.kids && item.kids.length > 0 && depth < 2) {
    const topComments = item.kids.slice(0, depth === 0 ? 20 : 10)
    const comments = await fetchItems(loadPage, topComments, topComments.length)

    if (comments.length > 0) {
      if (depth === 0) output += '---\n\n## Comments\n\n'

      // Child threads are independent: render a couple at a time (each fetches up to
      // 10 replies concurrently, so this stays near the top level's 20 requests), stitched in order.
      const childOutputs = await mapWithConcurrencyLimit(comments, HN_CHILD_THREAD_CONCURRENCY, (comment) =>
        comment.kids && comment.kids.length > 0 && depth < 1
          ? renderStory(loadPage, comment, depth + 1)
          : Promise.resolve('')
      )

      const indent = '  '.repeat(depth)
      for (let i = 0; i < comments.length; i++) {
        const comment = comments[i]!
        output += `${indent}**${comment.by}** (${formatTimestamp(comment.time ?? 0)})`
        if (comment.score !== undefined) output += ` [${comment.score}]`
        output += '\n'
        if (comment.text) {
          const lines = decodeHNText(comment.text).split('\n')
          output += `${lines.map((line) => `${indent}${line}`).join('\n')}\n\n`
        }
        output += childOutputs[i] ?? ''
      }
    }
  }

  return output
}

async function renderListing(loadPage: PageLoader, ids: number[], title: string): Promise<string> {
  let output = `# ${title}\n\n`
  const stories = await fetchItems(loadPage, ids, 20)

  for (let i = 0; i < stories.length; i++) {
    const story = stories[i]!
    output += `${i + 1}. **${story.title}**\n`
    if (story.url) output += `   ${story.url}\n`
    output += `   ${story.score ?? 0} points by ${story.by} | ${formatTimestamp(story.time ?? 0)}`
    if (story.descendants) output += ` | ${story.descendants} comments`
    output += `\n   https://news.ycombinator.com/item?id=${story.id}\n\n`
  }

  return output
}

export const scrapeHackerNews: Scraper = async (ctx) => {
  const parsed = ctx.url
  if (!parsed.hostname.includes('news.ycombinator.com')) return null

  const loadPage = ctx.loadPage
  const notes: string[] = []
  let content = ''

  try {
    const itemId = parsed.searchParams.get('id')

    if (itemId) {
      const item = await fetchItem(loadPage, Number.parseInt(itemId, 10))
      if (!item) throw new Error(`Failed to fetch item ${itemId}`)

      content = await renderStory(loadPage, item, 0)
      notes.push(`Fetched HN item ${itemId} with top-level comments (depth 2)`)
    } else if (parsed.pathname === '/' || parsed.pathname === '/news') {
      const { content: raw, ok } = await loadPage(`${API_BASE}/topstories.json`)
      if (!ok) throw new Error('Failed to fetch top stories')
      const ids = tryParseJson<number[]>(raw)
      if (!ids) throw new Error('Failed to parse top stories')
      content = await renderListing(loadPage, ids, 'Hacker News - Top Stories')
      notes.push('Fetched top 20 stories from HN front page')
    } else if (parsed.pathname === '/newest') {
      const { content: raw, ok } = await loadPage(`${API_BASE}/newstories.json`)
      if (!ok) throw new Error('Failed to fetch new stories')
      const ids = tryParseJson<number[]>(raw)
      if (!ids) throw new Error('Failed to parse new stories')
      content = await renderListing(loadPage, ids, 'Hacker News - New Stories')
      notes.push('Fetched top 20 new stories')
    } else if (parsed.pathname === '/best') {
      const { content: raw, ok } = await loadPage(`${API_BASE}/beststories.json`)
      if (!ok) throw new Error('Failed to fetch best stories')
      const ids = tryParseJson<number[]>(raw)
      if (!ids) throw new Error('Failed to parse best stories')
      content = await renderListing(loadPage, ids, 'Hacker News - Best Stories')
      notes.push('Fetched top 20 best stories')
    } else {
      return null
    }

    return { content, method: 'hackernews', notes }
  } catch (err) {
    ctx.signal.throwIfAborted()
    const errorMsg = err instanceof Error ? err.message : String(err)
    notes.push(`Error: ${errorMsg}`)
    return { content: `# Error fetching Hacker News content\n\n${errorMsg}`, method: 'hackernews', notes }
  }
}
