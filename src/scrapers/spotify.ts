// Spotify podcasts, tracks, albums and playlists via oEmbed and Open Graph metadata (no authentication).
import type { Scraper } from './types'
import { formatMediaDuration } from './utils'

interface SpotifyOEmbedResponse {
  title?: string
  thumbnail_url?: string
  provider_name?: string
  html?: string
  width?: number
  height?: number
}

interface OpenGraphData {
  title?: string
  description?: string
  audio?: string
  image?: string
  type?: string
  duration?: string
  album?: string
  musician?: string
  artist?: string
  releaseDate?: string
}

function parseOpenGraph(html: string): OpenGraphData {
  const og: OpenGraphData = {}

  const metaPattern = /<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"[^>]*>/gi
  for (const [, property, content] of html.matchAll(metaPattern)) {
    if (property === 'og:title') og.title = content
    else if (property === 'og:description') og.description = content
    else if (property === 'og:audio') og.audio = content
    else if (property === 'og:image') og.image = content
    else if (property === 'og:type') og.type = content
    else if (property === 'music:duration') og.duration = content
    else if (property === 'music:album') og.album = content
    else if (property === 'music:musician') og.musician = content
    else if (property === 'music:release_date') og.releaseDate = content
    else if (property === 'twitter:audio:artist_name') og.artist = content
  }

  return og
}

/** Content type from the URL path. */
function getContentType(url: string): string | null {
  if (url.includes('/episode/')) return 'podcast-episode'
  if (url.includes('/show/')) return 'podcast-show'
  if (url.includes('/track/')) return 'track'
  if (url.includes('/album/')) return 'album'
  if (url.includes('/playlist/')) return 'playlist'
  return null
}

function formatDuration(seconds: string | undefined): string | null {
  if (!seconds) return null
  const num = Number.parseInt(seconds, 10)
  if (Number.isNaN(num)) return null
  return formatMediaDuration(num)
}

function formatOutput(contentType: string, oEmbed: SpotifyOEmbedResponse, og: OpenGraphData, url: string): string {
  const sections: string[] = []

  const title = og.title || oEmbed.title || 'Unknown'
  sections.push(`# ${title}\n`)

  sections.push(`**Type**: ${contentType}\n`)

  if (og.description) sections.push(`**Description**: ${og.description}\n`)

  if (contentType === 'track' || contentType === 'podcast-episode') {
    if (og.artist || og.musician) sections.push(`**Artist**: ${og.artist || og.musician}\n`)
    if (og.album) sections.push(`**Album**: ${og.album}\n`)
    if (og.duration) {
      const formatted = formatDuration(og.duration)
      if (formatted) sections.push(`**Duration**: ${formatted}\n`)
    }
  }

  if (contentType === 'album' && og.releaseDate) sections.push(`**Release Date**: ${og.releaseDate}\n`)

  // Note about limited information
  sections.push('\n---\n')
  if (contentType === 'playlist') {
    sections.push(
      '**Note**: Playlist details (tracks, creator, follower count) require authentication. ' +
        'Only basic metadata is available without Spotify API credentials.\n'
    )
  } else if (contentType === 'album') {
    sections.push(
      '**Note**: Track listing and detailed album information require authentication. ' +
        'Only basic metadata is available without Spotify API credentials.\n'
    )
  } else if (contentType === 'podcast-show') {
    sections.push(
      '**Note**: Episode listing and detailed show information require authentication. ' +
        'Only basic metadata is available without Spotify API credentials.\n'
    )
  }

  sections.push(`**URL**: ${url}\n`)

  if (oEmbed.thumbnail_url) sections.push(`**Thumbnail**: ${oEmbed.thumbnail_url}\n`)
  else if (og.image) sections.push(`**Image**: ${og.image}\n`)

  return sections.join('\n')
}

export const scrapeSpotify: Scraper = async (ctx) => {
  const url = ctx.url.href
  if (!url.includes('open.spotify.com/')) return null

  const contentType = getContentType(url)
  if (!contentType) return null

  const notes: string[] = []
  let oEmbedData: SpotifyOEmbedResponse = {}
  let ogData: OpenGraphData = {}

  try {
    const oEmbedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`
    const response = await ctx.loadPage(oEmbedUrl)

    if (response.ok) {
      oEmbedData = JSON.parse(response.content) as SpotifyOEmbedResponse
      notes.push('Retrieved metadata via Spotify oEmbed API')
    } else {
      notes.push(`oEmbed API returned status ${response.status || 'error'}`)
    }
  } catch (err) {
    ctx.signal.throwIfAborted()
    notes.push(`Failed to fetch oEmbed data: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Page HTML for Open Graph metadata
  try {
    const pageResponse = await ctx.loadPage(url)

    if (pageResponse.ok) {
      ogData = parseOpenGraph(pageResponse.content)
      notes.push('Parsed Open Graph metadata from page HTML')
    } else {
      notes.push(`Page fetch returned status ${pageResponse.status || 'error'}`)
    }
  } catch (err) {
    ctx.signal.throwIfAborted()
    notes.push(`Failed to fetch page HTML: ${err instanceof Error ? err.message : String(err)}`)
  }

  const output = formatOutput(contentType, oEmbedData, ogData, url)
  return { content: output, method: 'spotify', notes }
}
