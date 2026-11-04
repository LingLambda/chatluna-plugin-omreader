import { parseHTML } from 'linkedom'
import type { Scraper } from './types'
import { tryParseJson } from './utils'

interface GoModuleInfo {
  Version: string
  Time: string
}

/** pkg.go.dev pages via the module proxy plus page parsing. */
export const scrapeGoPkg: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'pkg.go.dev') return null

    // Patterns: /module, /module@version, /module/subpackage
    const pathname = parsed.pathname.slice(1)
    if (!pathname) return null

    let modulePath: string
    let version = 'latest'

    const atIndex = pathname.indexOf('@')
    if (atIndex !== -1) {
      const beforeAt = pathname.slice(0, atIndex)
      const afterAt = pathname.slice(atIndex + 1)

      // A subpackage may follow the version
      const slashIndex = afterAt.indexOf('/')
      if (slashIndex !== -1) {
        version = afterAt.slice(0, slashIndex)
        modulePath = beforeAt
      } else {
        version = afterAt
        modulePath = beforeAt
      }
    } else {
      // No version: treat the whole path as the module path (refined from the page)
      modulePath = pathname
    }

    const notes: string[] = []
    const sections: string[] = []

    let moduleInfo: GoModuleInfo | null = null
    let actualModulePath = modulePath

    if (version === 'latest') {
      try {
        const proxyUrl = `https://proxy.golang.org/${encodeURIComponent(modulePath)}/@latest`
        const proxyResult = await ctx.loadPage(proxyUrl)

        if (proxyResult.ok) {
          moduleInfo = tryParseJson<GoModuleInfo>(proxyResult.content)
          if (moduleInfo) {
            version = moduleInfo.Version
          }
        }
      } catch {
        // @latest fails for subpackages; the page supplies the version
      }
    } else {
      try {
        const proxyUrl = `https://proxy.golang.org/${encodeURIComponent(modulePath)}/@v/${encodeURIComponent(version)}.info`
        const proxyResult = await ctx.loadPage(proxyUrl)

        if (proxyResult.ok) {
          moduleInfo = tryParseJson<GoModuleInfo>(proxyResult.content)
        }
      } catch {
        // Proxy lookup failed; rely on page data
      }
    }

    const pageResult = await ctx.loadPage(parsed.href)
    if (!pageResult.ok) {
      return {
        content: `Failed to fetch pkg.go.dev page (status: ${pageResult.status ?? 'unknown'})`,
        method: 'go-pkg',
        finalUrl: pageResult.finalUrl,
        contentType: 'text/plain',
        notes: ['error']
      }
    }

    const doc = parseHTML(pageResult.content).document

    // Actual module path from the breadcrumb
    const breadcrumb = doc.querySelector('.go-Breadcrumb')
    if (breadcrumb) {
      const moduleLink = breadcrumb.querySelector("a[href^='/']")
      if (moduleLink) {
        const href = moduleLink.getAttribute('href')
        if (href) {
          actualModulePath = href.slice(1).split('@')[0]
        }
      }
    }

    // Version from the page when the proxy gave none
    if (!moduleInfo) {
      const versionBadge = doc.querySelector('.go-Chip')
      if (versionBadge) {
        const versionText = versionBadge.textContent?.trim()
        if (versionText?.startsWith('v')) {
          version = versionText
        }
      }
    }

    const licenseLink = doc.querySelector("a[data-test-id='UnitHeader-license']")
    const license = licenseLink?.textContent?.trim() || 'Unknown'

    const importPathInput = doc.querySelector("input[data-test-id='UnitHeader-importPath']")
    const importPath = importPathInput?.getAttribute('value') || actualModulePath

    sections.push(`# ${importPath}`)
    sections.push('')
    sections.push(`**Module:** ${actualModulePath}`)
    sections.push(`**Version:** ${version}`)
    sections.push(`**License:** ${license}`)
    sections.push('')

    const synopsis = doc.querySelector('.go-Main-headerContent p')
    if (synopsis) {
      const synopsisText = synopsis.textContent?.trim()
      if (synopsisText) {
        sections.push(`## Synopsis`)
        sections.push('')
        sections.push(synopsisText)
        sections.push('')
      }
    }

    const docSection = doc.querySelector('#section-documentation')
    if (docSection) {
      sections.push('## Documentation')
      sections.push('')

      const overview = docSection.querySelector('.go-Message')
      if (overview) {
        const overviewMd = await ctx.htmlToMarkdown(overview.innerHTML)
        sections.push(overviewMd)
        sections.push('')
      }

      // First few paragraphs of package-level documentation
      const docContent = docSection.querySelector('.Documentation-content')
      if (docContent) {
        const paragraphs = docContent.querySelectorAll('p')
        const docParts: string[] = []
        for (let i = 0; i < Math.min(3, paragraphs.length); i++) {
          const p = paragraphs[i]
          const text = (await ctx.htmlToMarkdown(p.innerHTML)).trim()
          if (text) {
            docParts.push(text)
          }
        }

        if (docParts.length > 0) {
          sections.push(docParts.join('\n\n'))
          sections.push('')
        }
      }
    }

    // Index of exported identifiers
    const indexSection = doc.querySelector('#section-index')
    if (indexSection) {
      const indexList = indexSection.querySelector('.Documentation-indexList')
      if (indexList) {
        sections.push('## Index')
        sections.push('')

        const items = indexList.querySelectorAll('li')
        const exported: string[] = []

        for (const item of items) {
          const link = item.querySelector('a')
          if (link) {
            const name = link.textContent?.trim()
            if (name) {
              exported.push(`- ${name}`)
            }
          }
        }

        if (exported.length > 0) {
          sections.push(exported.slice(0, 50).join('\n'))
          if (exported.length > 50) {
            notes.push(`showing 50 of ${exported.length} exports`)
            sections.push(`\n[…${exported.length - 50} exports elided…]`)
          }
          sections.push('')
        }
      }
    }

    const importsSection = doc.querySelector('#section-imports')
    if (importsSection) {
      const importsList = importsSection.querySelector('.go-Message')
      if (importsList) {
        sections.push('## Imports')
        sections.push('')

        const links = importsList.querySelectorAll('a')
        const imports: string[] = []

        for (const link of links) {
          const imp = link.textContent?.trim()
          if (imp) {
            imports.push(`- ${imp}`)
          }
        }

        if (imports.length > 0) {
          sections.push(imports.slice(0, 20).join('\n'))
          if (imports.length > 20) {
            notes.push(`showing 20 of ${imports.length} imports`)
            sections.push(`\n[…${imports.length - 20} imports elided…]`)
          }
          sections.push('')
        }
      }
    }

    if (moduleInfo) {
      notes.push(`published ${moduleInfo.Time}`)
    }

    return { content: sections.join('\n'), method: 'go-pkg', finalUrl: pageResult.finalUrl, notes }
  } catch {
    return null
  }
}
