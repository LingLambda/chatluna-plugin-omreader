import type { Scraper } from './types'
import { asString } from './utils'

const ALLOWED_HOSTS: Record<string, true> = { 'choosealicense.com': true, 'www.choosealicense.com': true }
const LICENSE_PATH = /^\/licenses\/([^/]+)\/?$/i
const APPENDIX_PATH = /^\/appendix\/?$/i

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  return []
}

function formatLabel(value: string): string {
  const cleaned = value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return value
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

function formatSection(title: string, items: string[]): string {
  let md = `## ${title}\n\n`
  if (items.length === 0) {
    md += '- None listed\n\n'
    return md
  }
  for (const item of items) {
    md += `- ${formatLabel(item)}\n`
  }
  md += '\n'
  return md
}

function parseScalar(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  // Plain scalars end at a ` #` comment.
  return value.replace(/\s+#.*$/, '')
}

/**
 * The YAML subset choosealicense.com frontmatter uses: top-level `key: scalar` (with folded continuation
 * lines), flow `[a, b]` lists and `- item` block lists; nested maps are skipped. Kebab-case keys become
 * camelCase.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---')) return { frontmatter: {}, body: normalized }
  const endIndex = normalized.indexOf('\n---', 3)
  if (endIndex === -1) return { frontmatter: {}, body: normalized }

  const metadata = normalized.slice(4, endIndex)
  const body = normalized.slice(endIndex + 4).trim()
  const frontmatter: Record<string, unknown> = {}

  let currentKey: string | null = null
  let blockList: string[] | null = null
  for (const line of metadata.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue

    if (/^\s/.test(line)) {
      if (!currentKey) continue
      const item = line.match(/^\s*-\s+(.*)$/)
      if (item) {
        if (!blockList) {
          blockList = []
          frontmatter[currentKey] = blockList
        }
        blockList.push(parseScalar(item[1]!))
      } else if (typeof frontmatter[currentKey] === 'string' && frontmatter[currentKey] !== '') {
        frontmatter[currentKey] = `${frontmatter[currentKey] as string} ${line.trim()}`
      }
      continue
    }

    const match = line.match(/^([\w-]+):\s*(.*)$/)
    blockList = null
    if (!match) {
      currentKey = null
      continue
    }
    currentKey = match[1]!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    const raw = match[2]!.trim()
    if (!raw) {
      frontmatter[currentKey] = null
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      frontmatter[currentKey] = raw
        .slice(1, -1)
        .split(',')
        .map((item) => parseScalar(item))
        .filter((item) => item.length > 0)
    } else {
      frontmatter[currentKey] = parseScalar(raw)
    }
  }

  return { frontmatter, body }
}

/** choosealicense.com license and appendix pages from the site's GitHub sources. */
export const scrapeChooseALicense: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (!ALLOWED_HOSTS[parsed.hostname]) return null

    const licenseMatch = parsed.pathname.match(LICENSE_PATH)
    const isAppendix = APPENDIX_PATH.test(parsed.pathname)
    if (!licenseMatch && !isAppendix) return null

    const licenseSlug = licenseMatch ? decodeURIComponent(licenseMatch[1]!).toLowerCase() : 'appendix'
    const rawUrl = licenseMatch
      ? `https://raw.githubusercontent.com/github/choosealicense.com/gh-pages/_licenses/${licenseSlug}.txt`
      : 'https://raw.githubusercontent.com/github/choosealicense.com/gh-pages/_pages/appendix.md'

    const result = await ctx.loadPage(rawUrl, { headers: { Accept: 'text/plain' } })
    if (!result.ok) return null

    const { frontmatter, body } = parseFrontmatter(result.content)

    const title = asString(frontmatter.title) ?? formatLabel(licenseSlug)
    const spdxId = asString(frontmatter.spdxId) ?? 'Unknown'
    const description = asString(frontmatter.description)
    const permissions = normalizeList(frontmatter.permissions)
    const conditions = normalizeList(frontmatter.conditions)
    const limitations = normalizeList(frontmatter.limitations)

    let md = `# ${title}\n\n`
    if (description) md += `${description}\n\n`

    md += `**SPDX ID:** ${spdxId}\n`
    md += `**Source:** https://choosealicense.com${isAppendix ? '/appendix' : `/licenses/${licenseSlug}/`}\n\n`

    md += formatSection('Permissions', permissions)
    md += formatSection('Conditions', conditions)
    md += formatSection('Limitations', limitations)

    const licenseText = body.trim()
    if (licenseText.length > 0) {
      md += `---\n\n## License Text\n\n${licenseText}\n`
    }

    return { content: md, method: 'choosealicense', notes: ['Fetched via Choose a License'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
