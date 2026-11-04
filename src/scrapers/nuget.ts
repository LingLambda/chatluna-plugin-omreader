import type { Scraper } from './types'
import { formatIsoDate, formatNumber, tryParseJson } from './utils'

interface NuGetCatalogEntry {
  id: string
  version: string
  description?: string
  authors?: string
  projectUrl?: string
  licenseUrl?: string
  licenseExpression?: string
  tags?: string[]
  dependencyGroups?: {
    targetFramework?: string
    dependencies?: {
      id: string
      range: string
    }[]
  }[]
  published?: string
}

interface NuGetRegistrationItem {
  catalogEntry: NuGetCatalogEntry
  packageContent?: string
}

interface NuGetRegistrationPage {
  items?: NuGetRegistrationItem[]
  '@id'?: string
}

interface NuGetRegistrationIndex {
  items: NuGetRegistrationPage[]
}

/** NuGet package pages via the v3 registration and search APIs. */
export const scrapeNuGet: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'www.nuget.org' && parsed.hostname !== 'nuget.org') return null

    // Package name and optional version from /packages/name or /packages/name/version
    const match = parsed.pathname.match(/^\/packages\/([^/]+)(?:\/([^/]+))?/i)
    if (!match) return null

    const packageName = decodeURIComponent(match[1])
    const requestedVersion = match[2] ? decodeURIComponent(match[2]) : null

    // The download-stats search is independent of the registration walk; start it now.
    const searchUrl = `https://api.nuget.org/v3/query?q=packageid:${encodeURIComponent(packageName)}&prerelease=true&take=1`
    const searchPromise = ctx.loadPage(searchUrl, { timeoutMs: 5000 })
    // Early returns below leave it unawaited; a rejection is still rethrown where it is awaited.
    searchPromise.catch(() => {})

    // Registration API (package name must be lowercase)
    const apiUrl = `https://api.nuget.org/v3/registration5-gz-semver2/${packageName.toLowerCase()}/index.json`
    const result = await ctx.loadPage(apiUrl)

    if (!result.ok) return null

    const index = tryParseJson<NuGetRegistrationIndex>(result.content)
    if (!index) return null

    if (!index.items?.length) return null

    // Latest page, fetched when not inlined
    let latestPage = index.items[index.items.length - 1]

    if (!latestPage.items && latestPage['@id']) {
      const pageResult = await ctx.loadPage(latestPage['@id'])
      if (!pageResult.ok) return null
      const fetched = tryParseJson<NuGetRegistrationPage>(pageResult.content)
      if (!fetched) return null
      latestPage = fetched
    }

    if (!latestPage.items?.length) return null

    // The requested version, else the latest
    let targetEntry: NuGetCatalogEntry | null = null

    if (requestedVersion) {
      for (const page of index.items) {
        let pageItems = page.items

        if (!pageItems && page['@id']) {
          const pageResult = await ctx.loadPage(page['@id'], { timeoutMs: 5000 })
          if (pageResult.ok) {
            const fetchedPage = tryParseJson<NuGetRegistrationPage>(pageResult.content)
            if (fetchedPage) pageItems = fetchedPage.items
          }
        }

        if (pageItems) {
          const found = pageItems.find(
            (item) => item.catalogEntry.version.toLowerCase() === requestedVersion.toLowerCase()
          )
          if (found) {
            targetEntry = found.catalogEntry
            break
          }
        }
      }
    }

    if (!targetEntry) {
      const latestItem = latestPage.items[latestPage.items.length - 1]
      targetEntry = latestItem.catalogEntry
    }

    let totalDownloads: number | null = null
    const searchResult = await searchPromise

    if (searchResult.ok) {
      const searchData = tryParseJson<{ data?: { totalDownloads?: number }[] }>(searchResult.content)
      if (searchData) totalDownloads = searchData.data?.[0]?.totalDownloads ?? null
    }

    let md = `# ${targetEntry.id}\n\n`
    if (targetEntry.description) md += `${targetEntry.description}\n\n`

    md += `**Version:** ${targetEntry.version}`
    if (targetEntry.licenseExpression) {
      md += ` · **License:** ${targetEntry.licenseExpression}`
    } else if (targetEntry.licenseUrl) {
      md += ` · **License:** [View](${targetEntry.licenseUrl})`
    }
    md += '\n'

    if (totalDownloads !== null) {
      md += `**Total Downloads:** ${formatNumber(totalDownloads)}\n`
    }

    if (targetEntry.authors) md += `**Authors:** ${targetEntry.authors}\n`
    if (targetEntry.projectUrl) md += `**Project URL:** ${targetEntry.projectUrl}\n`
    if (targetEntry.tags?.length) md += `**Tags:** ${targetEntry.tags.join(', ')}\n`
    if (targetEntry.published) {
      md += `**Published:** ${formatIsoDate(targetEntry.published)}\n`
    }

    // Dependencies by target framework
    if (targetEntry.dependencyGroups?.length) {
      const hasAnyDeps = targetEntry.dependencyGroups.some((g) => g.dependencies?.length)
      if (hasAnyDeps) {
        md += `\n## Dependencies\n\n`
        for (const group of targetEntry.dependencyGroups) {
          if (!group.dependencies?.length) continue
          const framework = group.targetFramework || 'All Frameworks'
          md += `### ${framework}\n\n`
          for (const dep of group.dependencies) {
            md += `- ${dep.id} (${dep.range})\n`
          }
          md += '\n'
        }
      }
    }

    // Recent versions from the latest page
    if (latestPage.items && latestPage.items.length > 1) {
      md += `## Recent Versions\n\n`
      const recentVersions = latestPage.items.slice(-5).reverse()
      for (const item of recentVersions) {
        const entry = item.catalogEntry
        const pubDate = formatIsoDate(entry.published) || 'unknown'
        md += `- **${entry.version}** (${pubDate})\n`
      }
    }

    return { content: md, method: 'nuget', notes: ['Fetched via NuGet API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
