import type { Scraper } from './types'
import { formatMediaDuration, tryParseJson } from './utils'

interface VimeoOEmbed {
  title: string
  author_name: string
  author_url: string
  description?: string
  duration: number
  thumbnail_url: string
  upload_date: string
  video_id: number
}

interface VimeoVideoConfig {
  video?: {
    title?: string
    duration?: number
    owner?: {
      name?: string
      url?: string
    }
    thumbs?: {
      base?: string
    }
  }
  request?: {
    files?: {
      progressive?: {
        quality: string
        width: number
        height: number
        fps: number
      }[]
    }
  }
}

/** Video ID from the various Vimeo URL formats. */
function extractVideoId(parsed: URL): string | null {
  // player.vimeo.com/video/{id}
  if (parsed.hostname === 'player.vimeo.com') {
    const match = parsed.pathname.match(/^\/video\/(\d+)/)
    return match?.[1] ?? null
  }

  // vimeo.com/{id} or vimeo.com/{user}/{id}
  if (parsed.hostname === 'vimeo.com' || parsed.hostname === 'www.vimeo.com') {
    const parts = parsed.pathname.split('/').filter(Boolean)
    // The last segment is the video ID
    const lastPart = parts[parts.length - 1]
    if (lastPart && /^\d+$/.test(lastPart)) return lastPart
  }

  return null
}

/** Vimeo videos via the oEmbed API. */
export const scrapeVimeo: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (!parsed.hostname.includes('vimeo.com')) return null

    const videoId = extractVideoId(parsed)
    if (!videoId) return null

    // Canonical URL for oEmbed (handles staffpicks and other URL formats)
    const canonicalUrl = `https://vimeo.com/${videoId}`
    const oembedUrl = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(canonicalUrl)}`
    const oembedResult = await ctx.loadPage(oembedUrl)

    if (!oembedResult.ok) return null

    const oembed = tryParseJson<VimeoOEmbed>(oembedResult.content)
    if (!oembed) return null

    let md = `# ${oembed.title}\n\n`
    md += `**Author:** [${oembed.author_name}](${oembed.author_url})\n`
    md += `**Duration:** ${formatMediaDuration(oembed.duration)}\n`

    if (oembed.upload_date) md += `**Uploaded:** ${oembed.upload_date}\n`

    md += `**Video ID:** ${videoId}\n\n`

    if (oembed.description) md += `---\n\n## Description\n\n${oembed.description}\n\n`

    md += `---\n\n**Thumbnail:** ${oembed.thumbnail_url}\n`

    // Extra details from the player config are optional
    try {
      const configUrl = `https://player.vimeo.com/video/${videoId}/config`
      const configResult = await ctx.loadPage(configUrl, { timeoutMs: 5_000 })

      if (configResult.ok) {
        const config = tryParseJson<VimeoVideoConfig>(configResult.content)

        const progressive = config?.request?.files?.progressive
        if (progressive && progressive.length > 0) {
          md += `\n**Available Qualities:**\n`
          for (const quality of progressive.slice(0, 5)) {
            md += `- ${quality.quality}: ${quality.width}x${quality.height} @ ${quality.fps}fps\n`
          }
        }
      }
    } catch {
      // Continue without the config
    }

    return { content: md, method: 'vimeo', notes: ['Fetched via Vimeo oEmbed API'] }
  } catch {
    return null
  }
}
