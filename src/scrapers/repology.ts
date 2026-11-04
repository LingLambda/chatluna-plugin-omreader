import type { Scraper } from './types'
import { tryParseJson } from './utils'

interface RepologyPackage {
  repo: string
  subrepo?: string
  srcname?: string
  binname?: string
  visiblename?: string
  version: string
  origversion?: string
  status:
    | 'newest'
    | 'devel'
    | 'unique'
    | 'outdated'
    | 'legacy'
    | 'rolling'
    | 'noscheme'
    | 'incorrect'
    | 'untrusted'
    | 'ignored'
  summary?: string
  categories?: string[]
  licenses?: string[]
  maintainers?: string[]
}

/** Emoji indicator for a version status. */
function statusIndicator(status: string): string {
  switch (status) {
    case 'newest':
      return '✅'
    case 'devel':
      return '🚧'
    case 'unique':
      return '🔵'
    case 'outdated':
      return '🔴'
    case 'legacy':
      return '⚠\uFE0F'
    case 'rolling':
      return '🔄'
    default:
      return '➖'
  }
}

const REPO_NAMES: Record<string, string> = {
  arch: 'Arch Linux',
  aur: 'AUR',
  debian_unstable: 'Debian Unstable',
  debian_stable: 'Debian Stable',
  ubuntu_24_04: 'Ubuntu 24.04',
  ubuntu_22_04: 'Ubuntu 22.04',
  fedora_rawhide: 'Fedora Rawhide',
  fedora_40: 'Fedora 40',
  gentoo: 'Gentoo',
  nix_unstable: 'Nixpkgs Unstable',
  nix_stable: 'Nixpkgs Stable',
  homebrew: 'Homebrew',
  macports: 'MacPorts',
  alpine_edge: 'Alpine Edge',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  void_x86_64: 'Void Linux',
  opensuse_tumbleweed: 'openSUSE Tumbleweed',
  msys2_mingw: 'MSYS2',
  chocolatey: 'Chocolatey',
  winget: 'Winget',
  scoop: 'Scoop',
  conda_main: 'Conda',
  pypi: 'PyPI',
  crates_io: 'Crates.io',
  npm: 'npm',
  rubygems: 'RubyGems',
  cpan: 'CPAN',
  hackage: 'Hackage'
}

const STATUS_PRIORITY: Record<string, number> = {
  newest: 0,
  unique: 1,
  devel: 2,
  rolling: 3,
  outdated: 4,
  legacy: 5,
  noscheme: 6,
  incorrect: 7,
  untrusted: 8,
  ignored: 9
}

const STATUS_ORDER = Object.keys(STATUS_PRIORITY)

function prettifyRepo(repo: string): string {
  if (REPO_NAMES[repo]) return REPO_NAMES[repo]

  for (const [key, value] of Object.entries(REPO_NAMES)) {
    if (repo.startsWith(key)) return value
  }

  // Title case with underscores as spaces
  return repo
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Repology project pages via the Repology API. */
export const scrapeRepology: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'repology.org' && parsed.hostname !== 'www.repology.org') return null

    // Package name from /project/{name}/versions or /project/{name}/information
    const match = parsed.pathname.match(/^\/project\/([^/]+)/)
    if (!match) return null

    const packageName = decodeURIComponent(match[1])

    const apiUrl = `https://repology.org/api/v1/project/${encodeURIComponent(packageName)}`
    const result = await ctx.loadPage(apiUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })

    if (!result.ok) return null

    const packages = tryParseJson<RepologyPackage[]>(result.content)
    if (!packages) return null

    // An empty response means the package was not found
    if (!Array.isArray(packages) || packages.length === 0) return null

    const newestVersions = new Set<string>()
    let summary: string | undefined
    let licenses: string[] = []
    const categories = new Set<string>()

    for (const pkg of packages) {
      if (pkg.status === 'newest' || pkg.status === 'unique') {
        newestVersions.add(pkg.version)
      }
      if (!summary && pkg.summary) summary = pkg.summary
      if (pkg.licenses?.length && !licenses.length) licenses = pkg.licenses
      if (pkg.categories) {
        for (const cat of pkg.categories) categories.add(cat)
      }
    }

    // No newest entry: take the first version
    if (newestVersions.size === 0) {
      const versions = packages.map((p) => p.version)
      if (versions.length > 0) newestVersions.add(versions[0])
    }

    const statusCounts: Record<string, number> = {}
    for (const pkg of packages) {
      statusCounts[pkg.status] = (statusCounts[pkg.status] || 0) + 1
    }

    let md = `# ${packageName}\n\n`
    if (summary) md += `${summary}\n\n`

    md += `**Newest Version:** ${Array.from(newestVersions).join(', ') || 'unknown'}\n`
    md += `**Repositories:** ${packages.length}\n`
    if (licenses.length) md += `**License:** ${licenses.join(', ')}\n`
    if (categories.size) md += `**Categories:** ${Array.from(categories).join(', ')}\n`
    md += '\n'

    md += '## Version Status Summary\n\n'
    for (const status of STATUS_ORDER) {
      if (statusCounts[status]) {
        md += `- ${statusIndicator(status)} **${status}**: ${statusCounts[status]} repos\n`
      }
    }
    md += '\n'

    // Newest first, then by repo name
    const sortedPackages = [...packages].sort((a, b) => {
      const aPriority = STATUS_PRIORITY[a.status] ?? 10
      const bPriority = STATUS_PRIORITY[b.status] ?? 10
      if (aPriority !== bPriority) return aPriority - bPriority
      return a.repo.localeCompare(b.repo)
    })

    md += '## Package Versions by Repository\n\n'
    md += '| Repository | Version | Status |\n'
    md += '|------------|---------|--------|\n'

    const shownRepos = new Set<string>()
    let count = 0
    for (const pkg of sortedPackages) {
      // Some repos have multiple entries
      const repoKey = pkg.subrepo ? `${pkg.repo}/${pkg.subrepo}` : pkg.repo
      if (shownRepos.has(repoKey)) continue
      shownRepos.add(repoKey)

      const repoName = prettifyRepo(pkg.repo)
      const version = pkg.origversion || pkg.version
      md += `| ${repoName} | \`${version}\` | ${statusIndicator(pkg.status)} ${pkg.status} |\n`

      count++
      if (count >= 15) break
    }

    if (packages.length > 15) {
      md += `\n[…${packages.length - 15} repositories elided…]\n`
    }

    md += `\n---\n\n[View on Repology](${parsed.href})\n`

    return { content: md, method: 'repology', notes: ['Fetched via Repology API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
