// Mastodon/Fediverse posts and profiles via the instance's REST API.
import type { LoadedPage, PageLoader } from '../types'
import type { ScrapeContext, Scraper } from './types'
import { formatNumber, isConclusiveProbeStatus, PlatformProbeCache, tryParseJson } from './utils'

interface MastodonAccount {
  id: string
  username: string
  acct: string
  display_name: string
  note: string
  url: string
  avatar: string
  header: string
  followers_count: number
  following_count: number
  statuses_count: number
  created_at: string
  bot: boolean
  fields?: { name: string; value: string }[]
}

interface MastodonMediaAttachment {
  id: string
  type: 'image' | 'video' | 'gifv' | 'audio' | 'unknown'
  url: string
  preview_url?: string
  description?: string
}

interface MastodonStatus {
  id: string
  created_at: string
  content: string
  url: string
  account: MastodonAccount
  reblogs_count: number
  favourites_count: number
  replies_count: number
  reblog?: MastodonStatus
  media_attachments: MastodonMediaAttachment[]
  spoiler_text?: string
  sensitive: boolean
  visibility: 'public' | 'unlisted' | 'private' | 'direct'
  in_reply_to_id?: string
  poll?: {
    options: { title: string; votes_count: number }[]
    votes_count: number
    expired: boolean
  }
}

const mastodonProbes = new PlatformProbeCache()

/** Shared probe deadline; fixed so no single caller's budget decides the verdict for all. */
const MASTODON_PROBE_TIMEOUT_MS = 5_000

/**
 * Whether a host runs Mastodon, probing its API once; conclusive verdicts are memoized per host.
 * Concurrent callers share one probe; each caller's abort or deadline ends only its own wait.
 */
function isMastodonInstance(hostname: string, loadPage: PageLoader, signal: AbortSignal): Promise<boolean> {
  const waitSignal = AbortSignal.any([signal, AbortSignal.timeout(MASTODON_PROBE_TIMEOUT_MS)])
  waitSignal.throwIfAborted()
  const verdict = mastodonProbes.resolve(hostname, async () => {
    let result: LoadedPage
    try {
      result = await loadPage(`https://${hostname}/api/v1/instance`, {
        timeoutMs: MASTODON_PROBE_TIMEOUT_MS,
        headers: { Accept: 'application/json' }
      })
    } catch {
      return undefined
    }
    if (!result.ok) return isConclusiveProbeStatus(result.status) ? false : undefined
    // Mastodon instances return a uri/domain field
    const data = tryParseJson<{ uri?: unknown; domain?: unknown; title?: unknown }>(result.content)
    return !!(data?.uri || data?.domain || data?.title)
  })
  const { promise, resolve, reject } = Promise.withResolvers<boolean>()
  const onAbort = () => reject(waitSignal.reason)
  waitSignal.addEventListener('abort', onAbort, { once: true })
  void verdict.then(resolve, reject).finally(() => waitSignal.removeEventListener('abort', onAbort))
  return promise
}

function formatDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return isoDate
  }
}

async function formatStatus(status: MastodonStatus, ctx: ScrapeContext, isReblog = false): Promise<string> {
  // Reblogs (boosts)
  if (status.reblog && !isReblog) {
    let md = `🔁 **${status.account.display_name || status.account.username}** boosted:\n\n`
    md += await formatStatus(status.reblog, ctx, true)
    return md
  }

  const account = status.account
  let md = ''

  if (!isReblog) md += `# Post by ${account.display_name || account.username}\n\n`

  md += `**@${account.acct}**`
  if (account.bot) md += ' 🤖'
  md += ` · ${formatDate(status.created_at)}`
  if (status.visibility !== 'public') md += ` · ${status.visibility}`
  md += '\n\n'

  // Content warning / spoiler
  if (status.spoiler_text) md += `> ⚠️ **CW:** ${status.spoiler_text}\n\n`

  const content = await ctx.htmlToMarkdown(status.content)
  md += `${content}\n\n`

  if (status.poll) {
    md += '**Poll:**\n'
    for (const option of status.poll.options) {
      const pct = status.poll.votes_count > 0 ? ((option.votes_count / status.poll.votes_count) * 100).toFixed(1) : '0'
      md += `- ${option.title} (${pct}%, ${option.votes_count} votes)\n`
    }
    md += `Total: ${status.poll.votes_count} votes${status.poll.expired ? ' (closed)' : ''}\n\n`
  }

  if (status.media_attachments.length > 0) {
    md += '**Attachments:**\n'
    for (const media of status.media_attachments) {
      const desc = media.description ? ` - ${media.description}` : ''
      md += `- [${media.type}](${media.url})${desc}\n`
    }
    md += '\n'
  }

  md += `---\n`
  md += `💬 ${formatNumber(status.replies_count)} replies · `
  md += `🔁 ${formatNumber(status.reblogs_count)} boosts · `
  md += `⭐ ${formatNumber(status.favourites_count)} favorites\n`

  return md
}

async function formatAccount(account: MastodonAccount, ctx: ScrapeContext): Promise<string> {
  let md = `# ${account.display_name || account.username}\n\n`

  md += `**@${account.acct}**`
  if (account.bot) md += ' 🤖 Bot'
  md += '\n\n'

  if (account.note) {
    const bio = await ctx.htmlToMarkdown(account.note)
    if (bio && bio !== account.display_name) md += `${bio}\n\n`
  }

  md += `**Followers:** ${formatNumber(account.followers_count)} · `
  md += `**Following:** ${formatNumber(account.following_count)} · `
  md += `**Posts:** ${formatNumber(account.statuses_count)}\n\n`

  md += `**Joined:** ${formatDate(account.created_at)}\n`
  md += `**Profile:** ${account.url}\n`

  // Profile fields (links, pronouns, etc.)
  if (account.fields && account.fields.length > 0) {
    md += '\n**Profile Fields:**\n'
    for (const field of account.fields) {
      const value = await ctx.htmlToMarkdown(field.value)
      md += `- **${field.name}:** ${value}\n`
    }
  }

  return md
}

/** Mastodon/Fediverse `/@user` and `/@user/{id}` URLs. */
export const scrapeMastodon: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    const url = parsed.href

    const postMatch = parsed.pathname.match(/^\/@([^/]+)\/(\d+)$/)
    const profileMatch = parsed.pathname.match(/^\/@([^/]+)$/)

    if (!postMatch && !profileMatch) return null

    if (!(await isMastodonInstance(parsed.hostname, ctx.loadPage, ctx.signal))) return null

    const instance = parsed.hostname

    if (postMatch) {
      const statusId = postMatch[2]!
      const apiUrl = `https://${instance}/api/v1/statuses/${statusId}`

      const result = await ctx.loadPage(apiUrl, { headers: { Accept: 'application/json' } })
      if (!result.ok) return null

      const status = tryParseJson<MastodonStatus>(result.content)
      if (!status) return null

      const md = await formatStatus(status, ctx)

      return {
        content: md,
        finalUrl: status.url || url,
        method: 'mastodon',
        notes: [`Fetched via Mastodon API (${instance})`]
      }
    }

    if (profileMatch) {
      // Account by username lookup
      const username = profileMatch[1]!
      const lookupUrl = `https://${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`

      const result = await ctx.loadPage(lookupUrl, { headers: { Accept: 'application/json' } })
      if (!result.ok) return null

      const account = tryParseJson<MastodonAccount>(result.content)
      if (!account) return null

      const statusesUrl = `https://${instance}/api/v1/accounts/${account.id}/statuses?limit=5&exclude_replies=true`
      const statusesResult = await ctx.loadPage(statusesUrl, { headers: { Accept: 'application/json' } })

      let md = await formatAccount(account, ctx)

      if (statusesResult.ok) {
        const statuses = tryParseJson<MastodonStatus[]>(statusesResult.content)
        if (statuses && statuses.length > 0) {
          md += '\n---\n\n## Recent Posts\n\n'
          for (const status of statuses.slice(0, 5)) {
            md += `### ${formatDate(status.created_at)}\n\n`
            const content = await ctx.htmlToMarkdown(status.content)
            md += `${content}\n\n`
            md += `💬 ${status.replies_count} · 🔁 ${status.reblogs_count} · ⭐ ${status.favourites_count}\n\n`
          }
        }
      }

      return {
        content: md,
        finalUrl: account.url || url,
        method: 'mastodon',
        notes: [`Fetched via Mastodon API (${instance})`]
      }
    }
  } catch {}

  return null
}
