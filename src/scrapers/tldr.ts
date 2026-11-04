// tldr.sh / tldr.ostera.io command pages from the tldr-pages repo.
import type { Scraper } from './types'

const TLDR_BASE = 'https://raw.githubusercontent.com/tldr-pages/tldr/main/pages'
const PLATFORMS = ['common', 'linux', 'osx'] as const

export const scrapeTldr: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'tldr.sh' && parsed.hostname !== 'tldr.ostera.io') return null

    // Command from the path (e.g. /tar -> tar)
    const command = parsed.pathname.replace(/^\//, '').replace(/\.md$/, '')
    if (!command || command.includes('/')) return null

    // Platforms in order: common, linux, osx
    for (const platform of PLATFORMS) {
      const rawUrl = `${TLDR_BASE}/${platform}/${command}.md`
      const result = await ctx.loadPage(rawUrl)

      if (result.ok && result.content.trim()) {
        return {
          content: result.content,
          method: 'tldr',
          finalUrl: rawUrl,
          notes: [`Fetched from tldr-pages (${platform})`]
        }
      }
    }

    return null
  } catch {
    // Fall through to the generic path.
  }

  return null
}
