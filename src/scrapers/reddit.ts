// Reddit posts and listings via the `.json` endpoints.
import type { Scraper } from './types'
import { formatIsoDate, tryParseJson } from './utils'

interface RedditPost {
  title: string
  selftext: string
  author: string
  score: number
  num_comments: number
  created_utc: number
  subreddit: string
  url: string
  is_self: boolean
}

interface RedditComment {
  body: string
  author: string
  score: number
  created_utc: number
  replies?: { data: { children: { data: RedditComment }[] } }
}

interface RedditListing<T> {
  data?: { children?: { kind?: string; data: T }[] }
}

export const scrapeReddit: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (!parsed.hostname.includes('reddit.com')) return null
    const url = parsed.href

    // Append .json to get the JSON response
    let jsonUrl = `${url.replace(/\/$/, '')}.json`
    if (parsed.search) jsonUrl = `${url.replace(/\/$/, '').replace(parsed.search, '')}.json${parsed.search}`

    const result = await ctx.loadPage(jsonUrl)
    if (!result.ok) return null

    const data = tryParseJson<unknown>(result.content)
    if (!data) return null
    let md = ''

    if (Array.isArray(data) && data.length >= 1) {
      // Post page (with comments)
      const [postListing, commentListing] = data as [RedditListing<RedditPost>?, RedditListing<RedditComment>?]
      const postData = postListing?.data?.children?.[0]?.data
      if (postData) {
        md = `# ${postData.title}\n\n`
        md += `**r/${postData.subreddit}** · u/${postData.author} · ${postData.score} points · ${postData.num_comments} comments\n`
        md += `*${formatIsoDate(postData.created_utc * 1000)}*\n\n`

        if (postData.is_self && postData.selftext) md += `---\n\n${postData.selftext}\n\n`
        else if (!postData.is_self) md += `**Link:** ${postData.url}\n\n`

        const commentChildren = data.length >= 2 ? commentListing?.data?.children : undefined
        if (commentChildren) {
          md += `---\n\n## Top Comments\n\n`
          const comments = commentChildren.filter((c) => c.kind === 't1').slice(0, 10)

          for (const { data: comment } of comments) {
            md += `### u/${comment.author} · ${comment.score} points\n\n`
            md += `${comment.body}\n\n---\n\n`
          }
        }
      }
    } else {
      const children = (data as RedditListing<RedditPost>).data?.children
      if (children) {
        // Subreddit or listing page
        const posts = children.slice(0, 20)
        const subreddit = posts[0]?.data?.subreddit

        md = `# r/${subreddit || 'Reddit'}\n\n`
        for (const { data: post } of posts) {
          md += `- **${post.title}** (${post.score} pts, ${post.num_comments} comments)\n`
          md += `  by u/${post.author}\n\n`
        }
      }
    }

    if (!md) return null

    return { content: md, method: 'reddit', notes: ['Fetched via Reddit JSON API'] }
  } catch {}

  return null
}
