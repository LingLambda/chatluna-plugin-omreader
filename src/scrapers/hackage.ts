import type { Scraper } from './types'
import { tryParseJson } from './utils'

type HackageVersionMap = Record<string, string>

interface ParsedCabal {
  name?: string | undefined
  version?: string | undefined
  synopsis?: string | undefined
  description?: string | undefined
  license?: string | undefined
  author?: string | undefined
  maintainer?: string | undefined
  homepage?: string | undefined
  bugReports?: string | undefined
  category?: string | undefined
  stability?: string | undefined
}

const DIGITS = /^\d+$/

/** Exact integer comparison of digit strings, avoiding float overflow. */
function compareDigits(a: string, b: string): number {
  const na = a.replace(/^0+/, '') || '0'
  const nb = b.replace(/^0+/, '') || '0'
  if (na.length !== nb.length) return na.length < nb.length ? -1 : 1
  if (na < nb) return -1
  if (na > nb) return 1
  return 0
}

/**
 * Version comparison: an optional leading `v` and `+build` are ignored, dotted segments compare
 * numerically (missing or malformed count as 0), and a SemVer prerelease sorts before the plain release.
 */
function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const trimmed = version.trim()
    const stripped = trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed
    const plusIndex = stripped.indexOf('+')
    const withoutBuild = plusIndex === -1 ? stripped : stripped.slice(0, plusIndex)
    const dashIndex = withoutBuild.indexOf('-')
    if (dashIndex === -1) return { core: withoutBuild.split('.'), prerelease: null }
    return {
      core: withoutBuild.slice(0, dashIndex).split('.'),
      prerelease: withoutBuild.slice(dashIndex + 1).split('.')
    }
  }
  const pa = parse(a)
  const pb = parse(b)

  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const sa = pa.core[i]
    const sb = pb.core[i]
    const result = compareDigits(
      sa !== undefined && DIGITS.test(sa) ? sa : '0',
      sb !== undefined && DIGITS.test(sb) ? sb : '0'
    )
    if (result !== 0) return result
  }

  // A plain release (null prerelease) wins
  const ra = pa.prerelease
  const rb = pb.prerelease
  if (ra === null || rb === null) return ra === rb ? 0 : ra === null ? 1 : -1
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const ia = ra[i]
    const ib = rb[i]
    if (ia === undefined) return -1
    if (ib === undefined) return 1
    const aNumeric = DIGITS.test(ia)
    const bNumeric = DIGITS.test(ib)
    if (aNumeric && bNumeric) {
      const result = compareDigits(ia, ib)
      if (result !== 0) return result
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1
    }
  }
  return 0
}

function extractCabalField(content: string, fieldName: string): string | undefined {
  const pattern = new RegExp(`^${fieldName}:\\s*(.*)$`, 'im')
  const match = content.match(pattern)
  if (!match) return undefined
  return match[1].trim()
}

function extractCabalDescription(content: string): string | undefined {
  const lines = content.split('\n')
  const start = lines.findIndex((line) => line.toLowerCase().startsWith('description:'))
  if (start < 0) return undefined
  const value = lines[start].replace(/^description:\s*/i, '').trim()
  const chunks: string[] = [value]
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('  ')) break
    chunks.push(line.trim())
  }
  const description = chunks.join('\n').trim()
  return description || undefined
}

function parseCabal(content: string): ParsedCabal {
  return {
    name: extractCabalField(content, 'name'),
    version: extractCabalField(content, 'version'),
    synopsis: extractCabalField(content, 'synopsis'),
    description: extractCabalDescription(content),
    license: extractCabalField(content, 'license'),
    author: extractCabalField(content, 'author'),
    maintainer: extractCabalField(content, 'maintainer'),
    homepage: extractCabalField(content, 'homepage'),
    bugReports: extractCabalField(content, 'bug-reports'),
    category: extractCabalField(content, 'category'),
    stability: extractCabalField(content, 'stability')
  }
}

/** Hackage (Haskell) package pages via the version map and the latest .cabal file. */
export const scrapeHackage: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'hackage.haskell.org') return null

    // /package/{name} or /package/{name}-{version}
    const match = parsed.pathname.match(/^\/package\/([^/]+)(?:\/|$)/)
    if (!match) return null

    const packageId = decodeURIComponent(match[1])

    // Version endpoint: a map of version -> status
    const versionUrl = `https://hackage.haskell.org/package/${encodeURIComponent(packageId)}.json`
    const versionResult = await ctx.loadPage(versionUrl, { headers: { Accept: 'application/json' } })

    if (!versionResult.ok) return null

    const versionMap = tryParseJson<HackageVersionMap>(versionResult.content)
    if (!versionMap) return null
    const latestVersion = Object.keys(versionMap).sort(compareVersions).at(-1)
    if (!latestVersion) return null

    // Latest cabal file for package metadata
    const cabalUrl = `https://hackage.haskell.org/package/${encodeURIComponent(packageId)}-${latestVersion}/${encodeURIComponent(packageId)}.cabal`
    const cabalResult = await ctx.loadPage(cabalUrl, { headers: { Accept: 'text/plain' } })

    if (!cabalResult.ok) return null

    const pkg = parseCabal(cabalResult.content)

    let md = `# ${pkg.name || packageId}\n\n`
    if (pkg.synopsis) md += `${pkg.synopsis}\n\n`

    md += `**Version:** ${pkg.version || latestVersion}`
    if (pkg.license) md += ` · **License:** ${pkg.license}`
    md += '\n'

    if (pkg.author) md += `**Author:** ${pkg.author}\n`
    if (pkg.maintainer) md += `**Maintainer:** ${pkg.maintainer}\n`
    if (pkg.category) md += `**Category:** ${pkg.category}\n`
    if (pkg.stability) md += `**Stability:** ${pkg.stability}\n`
    if (pkg.homepage) md += `**Homepage:** ${pkg.homepage}\n`
    if (pkg.bugReports) md += `**Bug Reports:** ${pkg.bugReports}\n`

    if (pkg.description) {
      md += `\n## Description\n\n${pkg.description}\n`
    }

    return { content: md, method: 'hackage', notes: ['Fetched via Hackage API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
