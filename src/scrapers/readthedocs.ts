// Read the Docs pages, preferring the raw source behind the Edit link.
import { parseHTML } from 'linkedom'
import type { Scraper } from './types'

export const scrapeReadTheDocs: Scraper = async (ctx) => {
  const urlObj = ctx.url
  const isReadTheDocs =
    urlObj.hostname.endsWith('.readthedocs.io') ||
    urlObj.hostname === 'readthedocs.org' ||
    urlObj.hostname === 'www.readthedocs.org'

  if (!isReadTheDocs) return null

  const notes: string[] = []

  const result = await ctx.loadPage(ctx.url.href)
  if (!result.ok) {
    return {
      content: `Failed to fetch Read the Docs page (status: ${result.status ?? 'unknown'})`,
      method: 'readthedocs',
      finalUrl: result.finalUrl,
      contentType: result.contentType,
      truncated: false,
      notes
    }
  }

  // linkedom's document implements the DOM API the standard lib types describe
  const root = parseHTML(result.content).document as unknown as Document

  // Main content from common Read the Docs selectors
  let mainContent =
    root.querySelector('.document') ||
    root.querySelector('[role="main"]') ||
    root.querySelector('main') ||
    root.querySelector('.rst-content') ||
    root.querySelector('.body')

  if (!mainContent) {
    mainContent = root.querySelector('body')
    notes.push('Using full body content (no main content div found)')
  }

  // Drop navigation, sidebar, footer elements
  mainContent
    ?.querySelectorAll('.headerlink, .viewcode-link, nav, .sidebar, footer, .related, .sphinxsidebar, .toctree-wrapper')
    .forEach((el) => {
      el.remove()
    })

  // The requested docs version is the second path segment (/<lang>/<slug>/...). Only follow an Edit link to raw
  // source when its repo ref matches that version: otherwise a versioned page would serve another branch's file
  // (e.g. /en/v3.18.5/ with an Edit link to blob/main). `latest` and `stable` float, so any ref is acceptable.
  const versionSlug = new URL(result.finalUrl).pathname.match(/^\/[^/]+\/([^/]+)\//)?.[1] ?? null

  // Edit on GitHub/GitLab links point at the raw source
  const editLinks = root.querySelectorAll('a[href*="github.com"], a[href*="gitlab.com"]')
  let sourceUrl: string | null = null

  for (const link of editLinks) {
    const href = link.getAttribute('href')
    const text = link.textContent?.toLowerCase() || ''

    if (href && (text.includes('edit') || text.includes('source'))) {
      const ref = href.match(/\/(?:blob|raw|edit)\/([^/]+)\//)?.[1] ?? null
      const refMatches =
        ref !== null &&
        versionSlug !== null &&
        (versionSlug === 'latest' || versionSlug === 'stable' || ref === versionSlug)
      if (!refMatches) {
        notes.push(
          `Skipped raw source from ${href}: repository ref does not match documentation version ${versionSlug ?? '(unknown)'}`
        )
        continue
      }
      // Edit URL → raw URL (same rewrite for GitHub and GitLab)
      if (href.includes('github.com') || href.includes('gitlab.com')) {
        sourceUrl = href.replace('/blob/', '/raw/').replace('/edit/', '/raw/')
      }
      break
    }
  }

  let content = ''
  let fetchedRaw = false

  if (sourceUrl) {
    try {
      const sourceResult = await ctx.loadPage(sourceUrl, { timeoutMs: 10_000 })
      if (sourceResult.ok && sourceResult.content.length > 0 && sourceResult.content.length < 1_000_000) {
        content = sourceResult.content
        fetchedRaw = true
        notes.push(`Fetched raw source from ${sourceUrl}`)
      }
    } catch {
      // Fall back to the HTML
    }
  }

  if (!content && mainContent) {
    content = await ctx.htmlToMarkdown(mainContent.innerHTML)
  }

  if (!content) {
    content = 'No content extracted from Read the Docs page'
    notes.push('Failed to extract content')
  }

  return {
    content,
    method: 'readthedocs',
    finalUrl: result.finalUrl,
    notes,
    contentType: fetchedRaw ? 'text/plain' : 'text/html'
  }
}
