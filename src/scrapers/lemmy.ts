// Lemmy posts and comments via the instance's v3 API.
import type { Scraper } from './types'
import { isNonJsonApiResponse, PlatformProbeCache, tryParseJson } from './utils'

/** Origins known (not) to serve the Lemmy API; skips doomed API calls on non-Lemmy hosts. */
const lemmyOrigins = new PlatformProbeCache()

interface LemmyCreator {
  name: string
  actor_id?: string
}

interface LemmyCommunity {
  name: string
  actor_id?: string
}

interface LemmyCounts {
  score: number
  comments?: number
}

interface LemmyPost {
  id: number
  name: string
  body?: string
  url?: string
}

interface LemmyPostView {
  post: LemmyPost
  creator: LemmyCreator
  community: LemmyCommunity
  counts: LemmyCounts
}

interface LemmyPostResponse {
  post_view?: LemmyPostView
}

interface LemmyComment {
  id: number
  content?: string
  path?: string
  parent_id?: number | null
  post_id?: number
}

interface LemmyCommentView {
  comment: LemmyComment
  creator: LemmyCreator
  counts: LemmyCounts
}

interface LemmyCommentListResponse {
  comments?: LemmyCommentView[]
}

interface LemmyCommentResponse {
  comment_view?: LemmyCommentView
}

function formatCommunity(community: LemmyCommunity): string {
  if (community.actor_id) {
    try {
      const host = new URL(community.actor_id).hostname
      return `!${community.name}@${host}`
    } catch {}
  }
  return `!${community.name}`
}

function formatAuthor(creator: LemmyCreator): string {
  if (creator.actor_id) {
    try {
      const host = new URL(creator.actor_id).hostname
      return `@${creator.name}@${host}`
    } catch {}
  }
  return creator.name
}

function renderComments(comments: LemmyCommentView[]): string {
  const childrenByParent = new Map<number, LemmyCommentView[]>()

  const commentIds = new Set(comments.map((view) => view.comment.id))

  for (const commentView of comments) {
    const parentId = commentView.comment.parent_id
    const resolvedParent = parentId && commentIds.has(parentId) ? parentId : 0
    const list = childrenByParent.get(resolvedParent)
    if (list) list.push(commentView)
    else childrenByParent.set(resolvedParent, [commentView])
  }

  const renderThread = (parentId: number, depth: number): string => {
    const items = childrenByParent.get(parentId) ?? []
    let output = ''

    for (const view of items) {
      const author = view.creator?.name ? formatAuthor(view.creator) : 'unknown'
      const score = view.counts?.score ?? 0
      const content = (view.comment.content ?? '').trim()
      const indent = '  '.repeat(depth)

      output += `${indent}- **${author}** · ${score} points\n`
      if (content) {
        output += `${content
          .split('\n')
          .map((line) => `${indent}  ${line}`)
          .join('\n')}\n`
      }

      output += renderThread(view.comment.id, depth + 1)
      output += '\n'
    }

    return output
  }

  return renderThread(0, 0).trim()
}

export const scrapeLemmy: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    const match = parsed.pathname.match(/^\/(post|comment)\/(\d+)/)
    if (!match) return null

    const kind = match[1]
    const id = Number.parseInt(match[2]!, 10)
    if (!Number.isFinite(id)) return null

    const baseUrl = parsed.origin
    if ((await lemmyOrigins.get(baseUrl)) === false) return null

    let postId = id
    if (kind === 'comment') {
      const commentUrl = `${baseUrl}/api/v3/comment?id=${id}`
      const commentResult = await ctx.loadPage(commentUrl)
      if (!commentResult.ok) {
        if (isNonJsonApiResponse(commentResult)) lemmyOrigins.record(baseUrl, false)
        return null
      }

      const commentData = tryParseJson<LemmyCommentResponse>(commentResult.content)
      if (commentData === null) lemmyOrigins.record(baseUrl, false)
      const commentPostId = commentData?.comment_view?.comment?.post_id
      if (!commentPostId) return null
      postId = commentPostId
    }

    const postUrl = `${baseUrl}/api/v3/post?id=${postId}`
    const commentsUrl = `${baseUrl}/api/v3/comment/list?post_id=${postId}`

    const [postResult, commentsResult] = await Promise.all([ctx.loadPage(postUrl), ctx.loadPage(commentsUrl)])

    if (!postResult.ok || !commentsResult.ok) {
      if (!postResult.ok && isNonJsonApiResponse(postResult)) lemmyOrigins.record(baseUrl, false)
      return null
    }

    const postData = tryParseJson<LemmyPostResponse>(postResult.content)
    if (postData === null) lemmyOrigins.record(baseUrl, false)
    const postView = postData?.post_view
    if (!postView) return null
    // Only negatives gate requests; a positive overwrites a negative a concurrent request recorded.
    lemmyOrigins.record(baseUrl, true)

    const commentsData = tryParseJson<LemmyCommentListResponse>(commentsResult.content)
    const comments = commentsData?.comments ?? []

    let md = `# ${postView.post.name}\n\n`

    const communityLabel = formatCommunity(postView.community)
    const authorLabel = formatAuthor(postView.creator)
    const score = postView.counts?.score ?? 0
    const commentCount = postView.counts?.comments ?? comments.length

    md += `**Community:** ${communityLabel} · **Author:** ${authorLabel} · **Score:** ${score} · **Comments:** ${commentCount}\n`
    if (postView.post.url) md += `**Link:** ${postView.post.url}\n`
    md += '\n'

    if (postView.post.body) md += `---\n\n${postView.post.body}\n\n`

    if (comments.length > 0) {
      const threadedComments = renderComments(comments)
      if (threadedComments) md += `---\n\n## Comments\n\n${threadedComments}\n`
    }

    return { content: md, method: 'lemmy-api', notes: ['Fetched via Lemmy API'] }
  } catch {}

  return null
}
