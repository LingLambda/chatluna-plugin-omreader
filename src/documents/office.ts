// DOCX, PPTX and XLSX conversion (adapted from markit-ai, MIT). OOXML parts are read from a
// lazily inflated ZipPackage and parsed with linkedom; DOCX goes through mammoth HTML, then the WASM converter.
import mammoth from 'mammoth'
import { htmlToMarkdown } from '../markdown'
import { child, children, normalizeTablesHtml, parseXml, path } from './xml'
import { ZipPackage } from './zip'

function toBuffer(bytes: Uint8Array) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** `Relationship` Id → Target of a `.rels` part. */
function readRelationships(zip: ZipPackage, partPath: string) {
  const relationships = new Map<string, string>()
  const xml = zip.readText(partPath)
  if (!xml) return relationships
  for (const relationship of children(parseXml(xml), 'Relationship')) {
    const id = relationship.getAttribute('Id')
    const target = relationship.getAttribute('Target')
    if (id !== null && target !== null) relationships.set(id, target)
  }
  return relationships
}

function markdownTable(rows: string[][]) {
  const [header = [], ...body] = rows
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  for (const row of body) lines.push(`| ${row.join(' | ')} |`)
  return lines.join('\n')
}

export async function convertDocx(bytes: Uint8Array, signal: AbortSignal) {
  let imageCount = 0
  const convertImage = mammoth.images.imgElement(async (image) => {
    imageCount++
    // The data URI is replaced by a placeholder below, so the payload is never read.
    const attributes = { src: `data:${image.contentType || 'image/png'};base64,`, alt: `image_${imageCount}` }
    return attributes
  })
  const { value: html } = await mammoth.convertToHtml({ buffer: toBuffer(bytes) }, { convertImage })
  signal.throwIfAborted()
  const markdown = await htmlToMarkdown(normalizeTablesHtml(html), signal)
  return markdown.replace(/!\[([^\]]*)\]\(data:[^)]*\)/g, '<!-- image: $1 -->').trim()
}

/** `a:t` texts of the `a:r` runs directly under one `a:p`. */
function runText(paragraph: Element) {
  const parts: string[] = []
  for (const run of children(paragraph, 'a:r')) {
    const text = child(run, 'a:t')
    if (text) parts.push(text.textContent ?? '')
  }
  return parts
}

function extractShapeText(shape: Element) {
  const lines: string[] = []
  for (const paragraph of children(child(shape, 'p:txBody'), 'a:p')) {
    const parts = runText(paragraph)
    if (parts.length > 0) lines.push(parts.join(''))
  }
  return lines.join('\n').trim()
}

function extractTable(frame: Element) {
  const table = path(frame, 'a:graphic', 'a:graphicData', 'a:tbl')
  if (!table) return null
  const rows: string[][] = []
  for (const row of children(table, 'a:tr')) {
    const cells: string[] = []
    for (const cell of children(row, 'a:tc')) {
      const body = child(cell, 'a:txBody')
      cells.push(body ? children(body, 'a:p').flatMap(runText).join(' ') : '')
    }
    rows.push(cells)
  }
  if (rows.length === 0) return null
  const width = rows[0]!.length
  for (const row of rows.slice(1)) {
    while (row.length < width) row.push('')
  }
  return markdownTable(rows)
}

function normalizeZipPath(memberPath: string) {
  const parts: string[] = []
  for (const segment of memberPath.split('/')) {
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

function slideNumber(memberPath: string) {
  return Number.parseInt(/slide(\d+)/.exec(memberPath)?.[1] ?? '0', 10)
}

export async function convertPptx(bytes: Uint8Array, signal: AbortSignal) {
  const zip = new ZipPackage(bytes)
  // Slide order from presentation.xml
  const presentationXml = zip.readText('ppt/presentation.xml')
  if (!presentationXml) throw new Error('Invalid PPTX: missing presentation.xml')
  const slideIds = children(path(parseXml(presentationXml), 'p:sldIdLst'), 'p:sldId')
  const relationships = readRelationships(zip, 'ppt/_rels/presentation.xml.rels')
  const slidePaths: string[] = []
  for (const slideId of slideIds) {
    const target = relationships.get(slideId.getAttribute('r:id') ?? '')
    if (target) slidePaths.push(`ppt/${target}`)
  }
  // Unresolvable rels: fall back to the slide files themselves
  if (slidePaths.length === 0) {
    const slideFiles = [...zip.members()].filter((member) => /^ppt\/slides\/slide\d+\.xml$/.test(member))
    slidePaths.push(...slideFiles.sort((a, b) => slideNumber(a) - slideNumber(b)))
  }

  const sections: string[] = []
  let imageCount = 0
  for (const [index, slidePath] of slidePaths.entries()) {
    signal.throwIfAborted()
    const slideXml = zip.readText(slidePath)
    if (!slideXml) continue
    const tree = path(parseXml(slideXml), 'p:cSld', 'p:spTree')
    if (!tree) continue
    const slideRelationships = readRelationships(zip, `${slidePath.replace('slides/slide', 'slides/_rels/slide')}.rels`)
    const lines = [`<!-- Slide ${index + 1} -->`]
    let isTitle = true
    for (const shape of children(tree, 'p:sp')) {
      const text = extractShapeText(shape)
      if (!text) continue
      lines.push(isTitle ? `# ${text}` : text)
      isTitle = false
    }
    // Embedded images
    for (const picture of children(tree, 'p:pic')) {
      const embed = path(picture, 'p:blipFill', 'a:blip')?.getAttribute('r:embed')
      if (!embed) continue
      const target = slideRelationships.get(embed)
      if (!target) continue
      const imagePath = normalizeZipPath(target.startsWith('/') ? target.slice(1) : `ppt/slides/${target}`)
      if (!zip.has(imagePath)) continue
      imageCount++
      const name =
        path(picture, 'p:nvSpPr', 'p:cNvPr')?.getAttribute('name') ||
        path(picture, 'p:nvPicPr', 'p:cNvPr')?.getAttribute('name') ||
        `image_${imageCount}`
      lines.push(`<!-- image: ${name} (slide ${index + 1}) -->`)
    }
    // Tables
    for (const frame of children(tree, 'p:graphicFrame')) {
      const table = extractTable(frame)
      if (table) lines.push(table)
    }
    // Slide notes
    const notesXml = zip.readText(slidePath.replace('slides/slide', 'notesSlides/notesSlide'))
    const notesTree = notesXml ? path(parseXml(notesXml), 'p:cSld', 'p:spTree') : undefined
    if (notesTree) {
      const notes: string[] = []
      for (const shape of children(notesTree, 'p:sp')) {
        // Skip the slide image placeholder
        if (path(shape, 'p:nvSpPr', 'p:nvPr', 'p:ph')?.getAttribute('type') === 'sldImg') continue
        const text = extractShapeText(shape)
        if (text) notes.push(text)
      }
      if (notes.length > 0) lines.push('\n### Notes:', notes.join('\n'))
    }
    sections.push(lines.join('\n'))
  }
  return sections.join('\n\n').trim()
}

/** Text of a shared-string item or inline string: its `t`, else its rich-text runs. */
function stringItemText(item: Element | undefined) {
  if (!item) return ''
  const text = child(item, 't')
  if (text) return text.textContent ?? ''
  return children(item, 'r')
    .map((run) => child(run, 't')?.textContent ?? '')
    .join('')
}

function cellValue(cell: Element, shared: Element[]) {
  const type = cell.getAttribute('t')
  const value = child(cell, 'v')?.textContent
  if (type === 's') return stringItemText(shared[Number(value)])
  if (type === 'inlineStr') return stringItemText(child(cell, 'is'))
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE'
  // Number or formula result, verbatim: coercion would round long digit strings and strip leading zeros.
  return value ?? ''
}

export async function convertXlsx(bytes: Uint8Array, signal: AbortSignal) {
  const zip = new ZipPackage(bytes)
  const sharedXml = zip.readText('xl/sharedStrings.xml')
  const shared = sharedXml ? children(parseXml(sharedXml), 'si') : []
  const workbookXml = zip.readText('xl/workbook.xml')
  if (!workbookXml) throw new Error('Invalid XLSX: missing workbook.xml')
  const sheets = children(child(parseXml(workbookXml), 'sheets'), 'sheet')
  const relationships = readRelationships(zip, 'xl/_rels/workbook.xml.rels')

  const sections: string[] = []
  for (const sheet of sheets) {
    signal.throwIfAborted()
    const target = relationships.get(sheet.getAttribute('r:id') ?? '')
    if (!target) continue
    const sheetXml = zip.readText(target.startsWith('/') ? target.slice(1) : `xl/${target}`)
    if (!sheetXml) continue
    const rows = children(child(parseXml(sheetXml), 'sheetData'), 'row')
    if (rows.length === 0) continue
    const table = rows.map((row) => children(row, 'c').map((cell) => cellValue(cell, shared)))
    // Normalize column count
    const width = table.reduce((max, row) => Math.max(max, row.length), 0)
    for (const row of table) {
      while (row.length < width) row.push('')
    }
    sections.push(`## ${sheet.getAttribute('name') ?? ''}`, markdownTable(table))
  }
  return sections.join('\n\n')
}
