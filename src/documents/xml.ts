import { DOMParser } from 'linkedom'

/** Parses an OOXML/OPF part; linkedom keeps prefixed tag names (`a:t`) and attribute names (`r:id`) verbatim. */
export function parseXml(xml: string) {
  return (new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document).documentElement
}

/** First direct child with the qualified tag name. */
export function child(parent: Element | null | undefined, tagName: string) {
  if (!parent) return undefined
  for (const element of parent.children) {
    if (element.tagName === tagName) return element
  }
  return undefined
}

/** Direct children with the qualified tag name. */
export function children(parent: Element | null | undefined, tagName: string) {
  const found: Element[] = []
  if (!parent) return found
  for (const element of parent.children) {
    if (element.tagName === tagName) found.push(element)
  }
  return found
}

/** Follows a path of direct-child tag names. */
export function path(parent: Element | null | undefined, ...tagNames: string[]) {
  let current: Element | undefined = parent ?? undefined
  for (const tagName of tagNames) {
    current = child(current, tagName)
    if (!current) return undefined
  }
  return current
}

/**
 * Normalizes HTML tables: strips `<p>` inside table cells (joining paragraphs with a
 * space) and wraps the first row in `<thead>` when missing.
 */
export function normalizeTablesHtml(html: string) {
  let result = html.replace(
    /<(td|th)([^>]*)>([\s\S]*?)<\/(td|th)>/gi,
    (_match, tag: string, attrs: string, inner: string, closeTag: string) => {
      const stripped = inner
        .replace(/^\s*<p>/i, '')
        .replace(/<\/p>\s*$/i, '')
        .replace(/<\/p>\s*<p>/gi, ' ')
      return `<${tag}${attrs}>${stripped}</${closeTag}>`
    }
  )
  result = result.replace(
    /<table([^>]*)>\s*(?:<tbody>\s*)?(<tr[\s\S]*?<\/tr>)([\s\S]*?)<\/(?:tbody>\s*<\/)?table>/gi,
    (_match, attrs: string, firstRow: string, rest: string) => {
      const theadRow = firstRow.replace(/<td/gi, '<th').replace(/<\/td>/gi, '</th>')
      return `<table${attrs}><thead>${theadRow}</thead><tbody>${rest}</tbody></table>`
    }
  )
  return result
}
