// Bluesky posts and profiles via the public AT Protocol AppView.
import type { PageLoader } from '../types'
import type { Scraper } from './types'
import { formatNumber, tryParseJson } from './utils'

const API_BASE = 'https://public.api.bsky.app/xrpc'

interface BlueskyProfile {
  did: string
  handle: string
  displayName?: string
  description?: string
  avatar?: string
  followersCount?: number
  followsCount?: number
  postsCount?: number
  createdAt?: string
}

interface BlueskyPost {
  uri: string
  cid: string
  author: BlueskyProfile
  record: {
    text: string
    createdAt: string
    embed?: {
      $type: string
      external?: { uri: string; title?: string; description?: string }
      images?: { alt?: string; image: unknown }[]
      record?: { uri: string }
    }
    facets?: {
      features: { $type: string; uri?: string; tag?: string; did?: string }[]
      index: { byteStart: number; byteEnd: number }
    }[]
  }
  likeCount?: number
  repostCount?: number
  replyCount?: number
  quoteCount?: number
  embed?: {
    $type: string
    external?: { uri: string; title?: string; description?: string }
    images?: { alt?: string; fullsize?: string; thumb?: string }[]
    record?: { uri: string; value?: { text?: string }; author?: BlueskyProfile }
  }
}

interface ThreadViewPost {
  post: BlueskyPost
  parent?: ThreadViewPost | { $type: string }
  replies?: (ThreadViewPost | { $type: string })[]
}

/** Resolves a handle to its DID via the profile API. */
async function resolveHandle(loadPage: PageLoader, handle: string): Promise<string | null> {
  const url = `${API_BASE}/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`
  const result = await loadPage(url, { headers: { Accept: 'application/json' } })

  if (!result.ok) return null

  const data = tryParseJson<BlueskyProfile>(result.content)
  if (!data) return null
  return data.did
}

function formatPost(post: BlueskyPost, isQuote = false): string {
  const author = post.author
  const name = author.displayName || author.handle
  const handle = `@${author.handle}`
  const date = new Date(post.record.createdAt).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

  let md = ''

  if (isQuote) {
    md += `> **${name}** (${handle}) - ${date}\n>\n`
    md += post.record.text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    md += '\n'
  } else {
    md += `**${name}** (${handle})\n`
    md += `*${date}*\n\n`
    md += `${post.record.text}\n`
  }

  const embed = post.embed
  if (embed) {
    if (embed.$type === 'app.bsky.embed.external#view' && embed.external) {
      const ext = embed.external
      md += `\n📎 [${ext.title || ext.uri}](${ext.uri})`
      if (ext.description) md += `\n*${ext.description}*`
      md += '\n'
    } else if (embed.$type === 'app.bsky.embed.images#view' && embed.images) {
      md += `\n🖼️ ${embed.images.length} image(s)`
      for (const img of embed.images) {
        if (img.alt) md += `\n- Alt: "${img.alt}"`
      }
      md += '\n'
    } else if (
      (embed.$type === 'app.bsky.embed.record#view' || embed.$type === 'app.bsky.embed.recordWithMedia#view') &&
      embed.record
    ) {
      const rec = embed.record
      if (rec.value?.text && rec.author) {
        md += '\n**Quoted post:**\n'
        md += `> **${rec.author.displayName || rec.author.handle}** (@${rec.author.handle})\n`
        md += rec.value.text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
        md += '\n'
      }
    }
  }

  if (!isQuote) {
    const stats: string[] = []
    if (post.likeCount) stats.push(`❤️ ${formatNumber(post.likeCount)}`)
    if (post.repostCount) stats.push(`🔁 ${formatNumber(post.repostCount)}`)
    if (post.replyCount) stats.push(`💬 ${formatNumber(post.replyCount)}`)
    if (post.quoteCount) stats.push(`📝 ${formatNumber(post.quoteCount)}`)
    if (stats.length) md += `\n${stats.join(' • ')}\n`
  }

  return md
}

/** Bluesky post and profile URLs. */
export const scrapeBluesky: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'bsky.app' && parsed.hostname !== 'www.bsky.app') return null

    const pathParts = parsed.pathname.split('/').filter(Boolean)

    // /profile/{handle}
    if (pathParts[0] === 'profile' && pathParts[1]) {
      const handle = pathParts[1]

      // /profile/{handle}/post/{rkey}
      if (pathParts[2] === 'post' && pathParts[3]) {
        const rkey = pathParts[3]

        const did = await resolveHandle(ctx.loadPage, handle)
        if (!did) return null

        const atUri = `at://${did}/app.bsky.feed.post/${rkey}`
        const threadUrl = `${API_BASE}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=6&parentHeight=3`

        const result = await ctx.loadPage(threadUrl, { headers: { Accept: 'application/json' } })
        if (!result.ok) return null

        const data = JSON.parse(result.content) as { thread: ThreadViewPost }
        const thread = data.thread

        if (!thread.post) return null

        let md = `# Bluesky Post\n\n`

        // Parent context
        if (thread.parent && 'post' in thread.parent) {
          md += '**Replying to:**\n'
          md += formatPost(thread.parent.post, true)
          md += '\n---\n\n'
        }

        md += formatPost(thread.post)

        if (thread.replies?.length) {
          md += '\n---\n\n## Replies\n\n'
          let replyCount = 0
          for (const reply of thread.replies) {
            if (replyCount >= 10) break
            if ('post' in reply) {
              md += formatPost(reply.post)
              md += '\n---\n\n'
              replyCount++
            }
          }
        }

        return { content: md, method: 'bluesky-api', notes: [`AT URI: ${atUri}`] }
      }

      // Profile only
      const profileUrl = `${API_BASE}/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`
      const result = await ctx.loadPage(profileUrl, { headers: { Accept: 'application/json' } })
      if (!result.ok) return null

      const profile = JSON.parse(result.content) as BlueskyProfile

      let md = `# ${profile.displayName || profile.handle}\n\n`
      md += `**@${profile.handle}**\n\n`

      if (profile.description) md += `${profile.description}\n\n`

      md += '---\n\n'
      md += `- **Followers:** ${formatNumber(profile.followersCount || 0)}\n`
      md += `- **Following:** ${formatNumber(profile.followsCount || 0)}\n`
      md += `- **Posts:** ${formatNumber(profile.postsCount || 0)}\n`

      if (profile.createdAt) {
        const joined = new Date(profile.createdAt).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })
        md += `- **Joined:** ${joined}\n`
      }

      md += `\n**DID:** \`${profile.did}\`\n`

      return { content: md, method: 'bluesky-api', notes: ['Fetched via AT Protocol API'] }
    }
  } catch {}

  return null
}
