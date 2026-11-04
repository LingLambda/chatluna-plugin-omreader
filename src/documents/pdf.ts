// PDF conversion: `<!-- Page N -->` markers, font-size headings, reflowed paragraphs and the incomplete-text notice,
// built from pdf.js text items via unpdf.
import { getDocumentProxy } from 'unpdf'

interface Line {
  text: string
  /** Baseline in PDF user space (origin bottom-left). */
  y: number
  size: number
  endX: number
}

interface PageLines {
  lines: Line[]
  hasText: boolean
}

const BULLET = /^[•●▪◦‣∙]\s*/
/** Lines this much larger than the body font become headings (`###` from 1.2x, `##` from 1.5x, `#` from 2x). */
const HEADING_RATIO = 1.2
const MAX_HEADING_LENGTH = 200
/** Vertical gap, in line heights, past which a new paragraph starts. */
const PARAGRAPH_GAP = 1.8

function readLines(items: readonly unknown[]) {
  const lines: Line[] = []
  let current: Line | undefined
  let hasText = false
  const flush = () => {
    if (current) {
      current.text = current.text.replace(/\s+/g, ' ').trim()
      if (current.text) lines.push(current)
    }
    current = undefined
  }
  for (const item of items) {
    // Marked-content records carry no text.
    if (typeof item !== 'object' || item === null || !('str' in item) || typeof item.str !== 'string') continue
    const transform = 'transform' in item && Array.isArray(item.transform) ? item.transform : []
    const x = Number(transform[4] ?? 0)
    const y = Number(transform[5] ?? 0)
    const height = 'height' in item && typeof item.height === 'number' ? item.height : 0
    const width = 'width' in item && typeof item.width === 'number' ? item.width : 0
    const size = Math.hypot(Number(transform[2] ?? 0), Number(transform[3] ?? 0)) || height
    const text = item.str
    if (text.trim()) hasText = true
    if (text) {
      if (current && Math.abs(current.y - y) > Math.max(current.size, size) * 0.5) flush()
      if (!current) {
        current = { text, y, size, endX: x + width }
      } else {
        const gap = x - current.endX
        const joined = /\s$/.test(current.text) || /^\s/.test(text)
        current.text += !joined && gap > size * 0.2 ? ` ${text}` : text
        current.endX = x + width
        current.size = Math.max(current.size, size)
      }
    }
    if ('hasEOL' in item && item.hasEOL === true) flush()
  }
  flush()
  return { lines, hasText }
}

/** The font size carrying the most characters across the document. */
function bodyFontSize(pages: readonly PageLines[]) {
  const weights = new Map<number, number>()
  for (const page of pages) {
    for (const line of page.lines) {
      const size = Math.round(line.size * 2) / 2
      weights.set(size, (weights.get(size) ?? 0) + line.text.length)
    }
  }
  let body = 0
  let best = -1
  for (const [size, weight] of weights) {
    if (weight > best) {
      body = size
      best = weight
    }
  }
  return body
}

function headingLevel(line: Line, bodySize: number) {
  if (bodySize <= 0 || line.text.length > MAX_HEADING_LENGTH) return 0
  const ratio = line.size / bodySize
  if (ratio >= 2) return 1
  if (ratio >= 1.5) return 2
  return ratio >= HEADING_RATIO ? 3 : 0
}

function renderPage(lines: readonly Line[], bodySize: number) {
  const blocks: string[] = []
  let paragraph = ''
  let heading: { level: number; text: string } | undefined
  let previous: Line | undefined
  const flush = () => {
    if (heading) blocks.push(`${'#'.repeat(heading.level)} ${heading.text}`)
    else if (paragraph) blocks.push(paragraph)
    heading = undefined
    paragraph = ''
  }
  for (const line of lines) {
    const gap = previous ? previous.y - line.y : 0
    const close = previous !== undefined && gap >= 0 && gap <= Math.max(previous.size, line.size) * PARAGRAPH_GAP
    const level = headingLevel(line, bodySize)
    if (level > 0) {
      // A title wrapped over several lines stays one heading.
      if (heading && heading.level === level && close) heading.text += ` ${line.text}`
      else {
        flush()
        heading = { level, text: line.text }
      }
    } else if (BULLET.test(line.text)) {
      flush()
      paragraph = `- ${line.text.replace(BULLET, '')}`
    } else if (paragraph && close && !heading) {
      // Rejoin words hyphenated across a line break.
      paragraph =
        paragraph.endsWith('-') && /^\p{Ll}/u.test(line.text)
          ? `${paragraph.slice(0, -1)}${line.text}`
          : `${paragraph} ${line.text}`
    } else {
      flush()
      paragraph = line.text
    }
    previous = line
  }
  flush()
  return blocks
}

export async function convertPdf(bytes: Uint8Array, signal: AbortSignal) {
  // pdf.js takes ownership of the buffer it is given; the caller's bytes stay intact.
  const document = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 }).catch((error: unknown) => {
    throw new Error(`PDF conversion failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  try {
    const pages: PageLines[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      signal.throwIfAborted()
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(readLines(content.items))
      page.cleanup()
    }
    signal.throwIfAborted()

    const bodySize = bodyFontSize(pages)
    const rendered: string[] = []
    const pagesNeedingOcr: number[] = []
    for (const [index, page] of pages.entries()) {
      if (!page.hasText) pagesNeedingOcr.push(index + 1)
      const blocks = renderPage(page.lines, bodySize)
      if (blocks.length > 0) rendered.push(`<!-- Page ${index + 1} -->\n\n${blocks.join('\n\n')}`)
    }
    const markdown = rendered.join('\n\n')
    if (!markdown && pagesNeedingOcr.length === 0) {
      throw new Error('PDF conversion failed: converter returned no Markdown')
    }
    if (pagesNeedingOcr.length === 0) return markdown
    // Incomplete-text notice, without page-image file-path advice, which fetch cannot follow.
    const notice = `Text extraction is incomplete for PDF pages ${pagesNeedingOcr.join(', ')}.`
    return [markdown, notice].filter(Boolean).join('\n\n')
  } finally {
    await document.loadingTask.destroy()
  }
}
