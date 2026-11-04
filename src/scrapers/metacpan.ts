import type { ScrapeContext, Scraper, ScrapeResult } from './types'
import { formatIsoDate, tryParseJson } from './utils'

interface ModuleResponse {
  name: string
  version: string
  abstract?: string
  author: string
  distribution: string
  release: string
  path: string
  pod?: string
}

interface ReleaseDependency {
  module: string
  version: string
  phase: string
  relationship: string
}

interface ReleaseResponse {
  name: string
  version: string
  abstract?: string
  author: string
  distribution: string
  license?: string[]
  stat?: { mtime: number }
  download_url?: string
  dependency?: ReleaseDependency[]
  metadata?: {
    resources?: {
      repository?: { url?: string; web?: string }
      homepage?: string
      bugtracker?: { web?: string }
    }
  }
}

/** MetaCPAN module and release pages via fastapi.metacpan.org. */
export const scrapeMetaCPAN: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'metacpan.org' && parsed.hostname !== 'www.metacpan.org') return null

    // /pod/Module::Name
    const podMatch = parsed.pathname.match(/^\/pod\/(.+?)(?:\/|$)/)
    if (podMatch) {
      const moduleName = decodeURIComponent(podMatch[1])
      return await fetchModule(ctx, moduleName)
    }

    // /release/AUTHOR/Distribution
    const releaseMatch = parsed.pathname.match(/^\/release\/([^/]+)\/([^/]+)/)
    if (releaseMatch) {
      const distribution = decodeURIComponent(releaseMatch[2])
      return await fetchRelease(ctx, distribution)
    }

    // /release/Distribution (without author)
    const simpleReleaseMatch = parsed.pathname.match(/^\/release\/([^/]+)$/)
    if (simpleReleaseMatch) {
      const distribution = decodeURIComponent(simpleReleaseMatch[1])
      return await fetchRelease(ctx, distribution)
    }

    return null
  } catch {
    // Fall through to the generic path.
  }

  return null
}

async function fetchModule(ctx: ScrapeContext, moduleName: string): Promise<ScrapeResult | null> {
  const apiUrl = `https://fastapi.metacpan.org/v1/module/${moduleName}`
  const result = await ctx.loadPage(apiUrl)

  if (!result.ok) return null

  const module = tryParseJson<ModuleResponse>(result.content)
  if (!module) return null

  // Release info for dependencies and metadata
  const releaseUrl = `https://fastapi.metacpan.org/v1/release/${module.distribution}`
  const releaseResult = await ctx.loadPage(releaseUrl, { timeoutMs: 5000 })

  let release: ReleaseResponse | null = null
  if (releaseResult.ok) {
    release = tryParseJson<ReleaseResponse>(releaseResult.content)
  }

  return { content: formatModuleMarkdown(module, release), method: 'metacpan', notes: ['Fetched via MetaCPAN API'] }
}

async function fetchRelease(ctx: ScrapeContext, distribution: string): Promise<ScrapeResult | null> {
  const apiUrl = `https://fastapi.metacpan.org/v1/release/${distribution}`
  const result = await ctx.loadPage(apiUrl)

  if (!result.ok) return null

  const release = tryParseJson<ReleaseResponse>(result.content)
  if (!release) return null

  return { content: formatReleaseMarkdown(release), method: 'metacpan', notes: ['Fetched via MetaCPAN API'] }
}

function formatModuleMarkdown(module: ModuleResponse, release: ReleaseResponse | null): string {
  let md = `# ${module.name}\n\n`
  if (module.abstract) md += `${module.abstract}\n\n`

  md += `**Version:** ${module.version}`
  md += ` · **Distribution:** ${module.distribution}`
  md += ` · **Author:** [${module.author}](https://metacpan.org/author/${module.author})\n`

  if (release) {
    if (release.license?.length) {
      md += `**License:** ${release.license.join(', ')}\n`
    }

    const resources = release.metadata?.resources
    if (resources?.repository?.web || resources?.repository?.url) {
      const repoUrl = resources.repository.web || resources.repository.url
      md += `**Repository:** ${repoUrl}\n`
    }
    if (resources?.homepage) {
      md += `**Homepage:** ${resources.homepage}\n`
    }
    if (resources?.bugtracker?.web) {
      md += `**Issues:** ${resources.bugtracker.web}\n`
    }

    const runtimeDeps = release.dependency?.filter(
      (d) => d.phase === 'runtime' && d.relationship === 'requires' && d.module !== 'perl'
    )
    if (runtimeDeps?.length) {
      md += `\n## Dependencies\n\n`
      for (const dep of runtimeDeps.slice(0, 20)) {
        md += `- **${dep.module}**`
        if (dep.version && dep.version !== '0') md += ` >= ${dep.version}`
        md += '\n'
      }
      if (runtimeDeps.length > 20) {
        md += `\n[…${runtimeDeps.length - 20} dependencies elided…]\n`
      }
    }
  }

  md += `\n## Installation\n\n\`\`\`bash\ncpanm ${module.name}\n\`\`\`\n`

  return md
}

function formatReleaseMarkdown(release: ReleaseResponse): string {
  let md = `# ${release.distribution}\n\n`
  if (release.abstract) md += `${release.abstract}\n\n`

  md += `**Version:** ${release.version}`
  md += ` · **Author:** [${release.author}](https://metacpan.org/author/${release.author})\n`

  if (release.license?.length) {
    md += `**License:** ${release.license.join(', ')}\n`
  }

  if (release.stat?.mtime) {
    const date = formatIsoDate(release.stat.mtime * 1000)
    md += `**Released:** ${date}\n`
  }

  const resources = release.metadata?.resources
  if (resources?.repository?.web || resources?.repository?.url) {
    const repoUrl = resources.repository.web || resources.repository.url
    md += `**Repository:** ${repoUrl}\n`
  }
  if (resources?.homepage) {
    md += `**Homepage:** ${resources.homepage}\n`
  }
  if (resources?.bugtracker?.web) {
    md += `**Issues:** ${resources.bugtracker.web}\n`
  }

  const runtimeDeps = release.dependency?.filter(
    (d) => d.phase === 'runtime' && d.relationship === 'requires' && d.module !== 'perl'
  )
  if (runtimeDeps?.length) {
    md += `\n## Dependencies\n\n`
    for (const dep of runtimeDeps.slice(0, 20)) {
      md += `- **${dep.module}**`
      if (dep.version && dep.version !== '0') md += ` >= ${dep.version}`
      md += '\n'
    }
    if (runtimeDeps.length > 20) {
      md += `\n[…${runtimeDeps.length - 20} dependencies elided…]\n`
    }
  }

  md += `\n## Installation\n\n\`\`\`bash\ncpanm ${release.distribution}\n\`\`\`\n`

  return md
}
