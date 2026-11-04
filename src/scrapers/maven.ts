import type { Scraper } from './types'
import { formatIsoDate, formatNumber, tryParseJson } from './utils'

interface MavenDoc {
  id: string
  /** groupId */
  g: string
  /** artifactId */
  a: string
  latestVersion: string
  repositoryId: string
  /** packaging */
  p: string
  timestamp: number
  versionCount: number
  text?: string[]
  /** extensions/classifiers */
  ec?: string[]
}

interface MavenResponse {
  response: {
    numFound: number
    docs: MavenDoc[]
  }
}

/** Maven Central artifacts (search.maven.org, mvnrepository.com) via the Solr API. */
export const scrapeMaven: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    const hostname = parsed.hostname

    const isSearchMaven = hostname === 'search.maven.org'
    const isMvnRepository = hostname === 'mvnrepository.com' || hostname === 'www.mvnrepository.com'

    if (!isSearchMaven && !isMvnRepository) return null

    let groupId: string | null = null
    let artifactId: string | null = null
    let version: string | null = null

    if (isSearchMaven) {
      // /artifact/{groupId}/{artifactId}[/{version}[/{packaging}]]
      const match = parsed.pathname.match(/^\/artifact\/([^/]+)\/([^/]+)(?:\/([^/]+))?/)
      if (!match) return null
      groupId = match[1]
      artifactId = match[2]
      version = match[3] || null
    } else if (isMvnRepository) {
      // /artifact/{groupId}/{artifactId}[/{version}]
      const match = parsed.pathname.match(/^\/artifact\/([^/]+)\/([^/]+)(?:\/([^/]+))?/)
      if (!match) return null
      groupId = match[1]
      artifactId = match[2]
      version = match[3] || null
    }

    if (!groupId || !artifactId) return null

    const apiUrl = `https://search.maven.org/solrsearch/select?q=g:${encodeURIComponent(groupId)}+AND+a:${encodeURIComponent(artifactId)}&wt=json&rows=1`
    const result = await ctx.loadPage(apiUrl, { headers: { Accept: 'application/json' } })

    if (!result.ok) return null

    const data = tryParseJson<MavenResponse>(result.content)
    if (!data) return null

    if (data.response.numFound === 0) return null

    const doc = data.response.docs[0]
    const displayVersion = version || doc.latestVersion

    let md = `# ${doc.g}:${doc.a}\n\n`
    md += `**Group ID:** ${doc.g}\n`
    md += `**Artifact ID:** ${doc.a}\n`
    md += `**Latest Version:** ${doc.latestVersion}`
    if (version && version !== doc.latestVersion) {
      md += ` (viewing ${version})`
    }
    md += '\n'

    if (doc.p) md += `**Packaging:** ${doc.p}\n`
    if (doc.versionCount) md += `**Versions:** ${formatNumber(doc.versionCount)}\n`
    if (doc.timestamp) {
      md += `**Last Updated:** ${formatIsoDate(doc.timestamp)}\n`
    }

    md += `\n## Maven Dependency\n\n`
    md += '```xml\n'
    md += `<dependency>\n`
    md += `    <groupId>${doc.g}</groupId>\n`
    md += `    <artifactId>${doc.a}</artifactId>\n`
    md += `    <version>${displayVersion}</version>\n`
    md += `</dependency>\n`
    md += '```\n'

    md += `\n## Gradle Dependency\n\n`
    md += '```groovy\n'
    md += `implementation '${doc.g}:${doc.a}:${displayVersion}'\n`
    md += '```\n'

    md += `\n## Gradle (Kotlin DSL)\n\n`
    md += '```kotlin\n'
    md += `implementation("${doc.g}:${doc.a}:${displayVersion}")\n`
    md += '```\n'

    if (doc.ec && doc.ec.length > 0) {
      const extensions = doc.ec.filter((e) => e && e !== '-')
      if (extensions.length > 0) {
        md += `\n## Available Extensions\n\n`
        md += `${extensions.map((e) => `- ${e}`).join('\n')}\n`
      }
    }

    md += `\n## Links\n\n`
    md += `- [Maven Central](https://search.maven.org/artifact/${doc.g}/${doc.a}/${displayVersion}/jar)\n`
    md += `- [MVN Repository](https://mvnrepository.com/artifact/${doc.g}/${doc.a}/${displayVersion})\n`

    return { content: md, method: 'maven', notes: ['Fetched via Maven Central API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
