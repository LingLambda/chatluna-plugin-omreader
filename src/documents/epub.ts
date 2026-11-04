// EPUB conversion (adapted from markit-ai, MIT): OPF metadata header, then spine chapters
// (XHTML) through the WASM HTML converter.
import { htmlToMarkdown } from '../markdown'
import { child, children, normalizeTablesHtml, parseXml } from './xml'
import { ZipPackage } from './zip'

const METADATA_FIELDS: readonly (readonly [label: string, tagName: string])[] = [
  ['Title', 'dc:title'],
  ['Authors', 'dc:creator'],
  ['Language', 'dc:language'],
  ['Publisher', 'dc:publisher'],
  ['Date', 'dc:date'],
  ['Description', 'dc:description']
]

export async function convertEpub(bytes: Uint8Array, signal: AbortSignal) {
  const zip = new ZipPackage(bytes)
  // content.opf path from container.xml
  const containerXml = zip.readText('META-INF/container.xml')
  if (!containerXml) throw new Error('Invalid EPUB: missing container.xml')
  const rootfile = child(child(parseXml(containerXml), 'rootfiles'), 'rootfile')
  const opfPath = rootfile?.getAttribute('full-path')
  if (!opfPath) throw new Error('Invalid EPUB: missing rootfile path')
  const opfXml = zip.readText(opfPath)
  if (!opfXml) throw new Error('Invalid EPUB: missing content.opf')
  const opf = parseXml(opfXml)

  const sections: string[] = []
  // Metadata header; creators join into one Authors line, other fields use their first value
  const metadata = child(opf, 'metadata')
  const metaLines: string[] = []
  for (const [label, tagName] of METADATA_FIELDS) {
    const values = children(metadata, tagName)
      .map((element) => element.textContent?.trim() ?? '')
      .filter(Boolean)
    const value = tagName === 'dc:creator' ? values.join(', ') : values[0]
    if (value) metaLines.push(`**${label}:** ${value}`)
  }
  if (metaLines.length > 0) sections.push(metaLines.join('\n'))

  // Manifest id → href, spine order
  const manifest = new Map<string, string>()
  for (const item of children(child(opf, 'manifest'), 'item')) {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    if (id !== null && href !== null) manifest.set(id, href)
  }
  const basePath = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  for (const itemref of children(child(opf, 'spine'), 'itemref')) {
    signal.throwIfAborted()
    const href = manifest.get(itemref.getAttribute('idref') ?? '')
    if (!href) continue
    const html = zip.readText(basePath ? `${basePath}/${href}` : href)
    if (!html) continue
    const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    const markdown = (await htmlToMarkdown(normalizeTablesHtml(cleaned), signal)).trim()
    if (markdown) sections.push(markdown)
  }
  return sections.join('\n\n').trim()
}
