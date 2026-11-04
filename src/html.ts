// HTML handling: alternate links, `.md` suffix and content-negotiation probes, feeds, native and remote readers,
// front-matter and data-URI cleanup, LLM endpoint candidates and document links. Every probe of the target site goes
// through the PageLoader.
import type { Context } from 'cordis'
import { DOMParser, parseHTML } from 'linkedom'
import { CONVERTIBLE_EXTENSIONS } from './documents'
import { htmlToMarkdown } from './markdown'
import { extensionHint, normalizeMime } from './mime'
import { type ReaderEntry, readers } from './readers'
import type { BinaryLoader, LoadedPage, PageLoader } from './types'

export function looksLikeHtml(content: string) {
  // Beyond a document-prefix check, also catches mislabeled HTML fragments.
  return /^\s*(?:<!doctype\b|<!--|<\/?(?:html|head|body|div|p|article|main|script|section|h[1-6]|nav|span|table|a)\b)/i.test(
    content
  )
}

function withoutMetadata(content: string) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim()
}

/** JS-gate page. Indexes, lists and tables are short-line by nature; only an explicit gate counts. */
function lowQuality(content: string) {
  const body = withoutMetadata(content)
  return (
    body.length < 500 &&
    body.split(/\n\s*\n/).length <= 2 &&
    /^(?:[#>*_]\s*)*(?:please\s+)?(?:enable javascript|turn on javascript|javascript (?:is )?required|browser not supported)\b/i.test(
      body
    )
  )
}

/** Most lines short: a wrapper page around a linked document (tables, code and lists look the same in a reader). */
function mostlyShortLines(content: string) {
  const lines = content.split('\n').filter((line) => line.trim())
  const short = lines.filter((line) => line.trim().length < 40)
  return lines.length > 10 && short.length / lines.length > 0.7
}

function llmCandidates(url: URL) {
  if (url.pathname === '/') return ['/.well-known/llms.txt', '/llms.txt', '/llms.md'].map((path) => url.origin + path)
  const segments = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
  const depth = url.pathname.endsWith('/') ? segments.length : Math.max(segments.length - 1, 1)
  const endpoints: string[] = []
  for (let i = depth; i >= 1; i--) {
    const scope = `${url.origin}/${segments.slice(0, i).join('/')}/`
    endpoints.push(`${scope}llms.txt`, `${scope}llms.md`)
  }
  return endpoints
}

function htmlDocument(html: string) {
  const document = parseHTML(html).document as unknown as Document
  if (document.documentElement?.localName.toLowerCase() === 'html') return document
  return parseHTML(`<html><head></head><body>${html}</body></html>`).document as unknown as Document
}

function withoutComments(document: Document, original: string) {
  // Upstream preprocessing can leak "-->" from comments containing tags. Only real comment nodes are
  // removed, never comment-like text inside code or strings.
  const walker = document.createTreeWalker(document, 128 /* NodeFilter.SHOW_COMMENT */)
  const comments: Node[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node)
  if (comments.length === 0) return original
  for (const comment of comments) comment.parentNode?.removeChild(comment)
  return document.toString()
}

export function feedMarkdown(content: string) {
  const document = new DOMParser().parseFromString(content, 'text/xml') as unknown as Document
  const root = document.documentElement
  const nameOf = (node: Element) => node.localName.replace(/^.*:/, '').toLowerCase()
  if (!root || !['rss', 'feed', 'rdf'].includes(nameOf(root))) return null
  const descendants = (element: Element, name: string) =>
    Array.from(element.querySelectorAll('*')).filter((node) => nameOf(node) === name)
  const child = (element: Element, name: string) => Array.from(element.children).find((node) => nameOf(node) === name)
  const clean = (text: string) => htmlDocument(text).body.textContent?.replace(/\s+/g, ' ').trim() || ''
  const atom = nameOf(root) === 'feed'
  const channel = atom ? root : descendants(root, 'channel')[0] || root
  const title = clean(child(channel, 'title')?.textContent || (atom ? 'Atom Feed' : 'RSS Feed'))
  let markdown = `# ${title}\n\n`
  const entries = descendants(root, atom ? 'entry' : 'item').slice(0, 10)
  for (const entry of entries) {
    const entryTitle = clean(child(entry, 'title')?.textContent || 'Untitled')
    const linkNode = atom
      ? Array.from(entry.children).find(
          (node) => nameOf(node) === 'link' && (!node.getAttribute('rel') || node.getAttribute('rel') === 'alternate')
        )
      : child(entry, 'link')
    const link = atom ? linkNode?.getAttribute('href') || '' : linkNode?.textContent?.trim() || ''
    const date = clean(child(entry, atom ? 'updated' : 'pubdate')?.textContent || '')
    const summary = clean(
      (child(entry, atom ? 'summary' : 'description') || child(entry, 'content'))?.textContent || ''
    )
    markdown += `## ${entryTitle}\n`
    if (date) markdown += `*${date}*\n\n`
    if (summary) markdown += `${summary.slice(0, 500)}${summary.length > 500 ? '...' : ''}\n\n`
    if (link) markdown += `[Read more](${link})\n\n`
    markdown += '---\n\n'
  }
  return { content: markdown.trim(), entries: entries.length }
}

/**
 * Markdown image whose destination is an inline `data:` URI (inline SVG icons, base64 `<img>`). The label
 * allows backslash escapes; the destination may be bare or `<…>`-wrapped, with an optional title.
 */
const DATA_URI_IMAGE_RE =
  /!\[((?:\\.|[^\\\]])*)\]\(\s*(?:<data:[^>]*>|data:[^)\s]*)(?:\s+(?:"(?:\\.|[^\\"])*"|'(?:\\.|[^\\'])*'|\((?:\\.|[^\\)])*\)))?\s*\)/gi

/** Unreadable to the model and routinely larger than the article; the alt text is kept. */
function stripDataUriImages(markdown: string) {
  return markdown.replace(DATA_URI_IMAGE_RE, (_match, alt: string) => (alt.trim() ? `![${alt}]` : ''))
}

/** `<meta>` names whose front-matter line is worth its tokens; Open Graph, Twitter Card, viewport… are not. */
const READER_META_NAMES: Record<string, true> = {
  description: true,
  author: true,
  'article:published_time': true,
  'article:modified_time': true
}
/** A front-matter key: a plain YAML scalar (no `: `) or a double-quoted one. */
const FRONT_MATTER_KEY_RE = /^(?:("(?:\\.|[^\\"])*")|([^"][^\n]*?)): /
const MAX_OMITTED_META_NAMES = 25
/** Reader output at or under this many characters is no rendering of the page. */
const MIN_RENDERED_CHARS = 100

/** Drops `meta-<name>` front-matter lines outside READER_META_NAMES and names them in one `meta_omitted` line. */
function pruneFrontMatter(markdown: string) {
  if (!markdown.startsWith('---\n')) return markdown
  const end = markdown.indexOf('\n---\n', 3)
  if (end < 0) return markdown
  const kept: string[] = []
  const omitted: string[] = []
  for (const line of markdown.slice(4, end).split('\n')) {
    const key = FRONT_MATTER_KEY_RE.exec(line)
    // No front matter: the body opens with a `---` rule.
    if (!key) return markdown
    let name: string
    try {
      // The converter's double-quoted escapes are JSON's.
      name = key[1] === undefined ? key[2]! : (JSON.parse(key[1]) as string)
    } catch {
      return markdown
    }
    if (name.startsWith('meta-') && READER_META_NAMES[name.slice(5).toLowerCase()] !== true) omitted.push(name.slice(5))
    else kept.push(line)
  }
  if (omitted.length === 0) return markdown
  const rest = markdown.slice(end)
  const head = kept.join('\n')
  // A page whose only content is its <head> is returned whole.
  if ((head ? `---\n${head}${rest}` : rest.slice(5)).trim().length <= MIN_RENDERED_CHARS) return markdown
  const more = omitted.length - MAX_OMITTED_META_NAMES
  const note = `${omitted.slice(0, MAX_OMITTED_META_NAMES).join(', ')}${more > 0 ? ` (+${more} more)` : ''}; fetch with raw for their values`
  // A JSON string is a YAML double-quoted scalar once YAML's extra line breaks are escaped.
  const value = JSON.stringify(note).replace(
    /[\u0085\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
  return `---\n${head ? `${head}\n` : ''}meta_omitted: ${value}${rest}`
}

/** Convertible document links in the page's anchors (first 512 KiB, at most 20). */
function documentLinks(html: string, baseUrl: string) {
  const links: string[] = []
  const seen = new Set<string>()
  for (const tag of html.slice(0, 512 * 1024).match(/<a\b[^>]*>/gi) ?? []) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    const value = href?.[1] ?? href?.[2] ?? href?.[3]
    if (!value) continue
    let resolved: string
    try {
      resolved = new URL(value, baseUrl).href
    } catch {
      continue
    }
    if (CONVERTIBLE_EXTENSIONS[extensionHint(resolved)] !== true || seen.has(resolved)) continue
    seen.add(resolved)
    links.push(resolved)
    if (links.length >= 20) break
  }
  return links
}

/** Link targets a rendering kept, as written and resolved against the page. */
function renderedLinkTargets(markdown: string, baseUrl: string) {
  const targets = new Set<string>()
  for (const match of markdown.matchAll(/\]\(\s*(?:<([^>]*)>|([^)\s]+))/g)) {
    const destination = (match[1] ?? match[2])!
    targets.add(destination)
    try {
      targets.add(new URL(destination, baseUrl).href)
    } catch {
      // Not a URL; the literal target is enough.
    }
  }
  return targets
}

export interface HtmlEnv {
  readonly ctx: Context
  readonly loadPage: PageLoader
  readonly loadBinary: BinaryLoader
  readonly signal: AbortSignal
  /** Epoch ms after which optional probes are skipped so the rendered page still returns in time. */
  readonly deadline: number
  readonly readers: readonly ReaderEntry[]
  convertDocument(bytes: Uint8Array, extension: string): Promise<string | null>
}

export interface HtmlRendering {
  body: string
  method: string
  /** The page a fallback came from, when not the requested one. */
  source?: LoadedPage | undefined
  contentType?: string | undefined
}

/** Per remote reader request, so one stalled endpoint cannot consume the whole budget. */
const REMOTE_READER_MAX_MS = 30_000

export async function renderHtml(page: LoadedPage, env: HtmlEnv, notes: string[]): Promise<HtmlRendering> {
  const { signal, loadPage, ctx } = env
  const document = htmlDocument(page.content)
  // Have a usable local result before optional probes spend the budget.
  let markdown = ''
  let conversionError: string | undefined
  try {
    markdown = stripDataUriImages((await htmlToMarkdown(withoutComments(document, page.content), signal)).trim())
  } catch (error) {
    signal.throwIfAborted()
    conversionError = error instanceof Error ? error.message : String(error)
  }
  const url = new URL(page.finalUrl)
  let baseUrl = url
  const baseHref = document.querySelector('base[href]')?.getAttribute('href')
  if (baseHref) {
    try {
      baseUrl = new URL(baseHref, url)
    } catch {
      // Malformed optional metadata.
    }
  }
  const alternates: { url: string; markdown: boolean }[] = []
  for (const link of document.querySelectorAll('link[rel][href]')) {
    if (!link.getAttribute('rel')!.toLowerCase().split(/\s+/).includes('alternate')) continue
    const href = link.getAttribute('href')!
    const type = link.getAttribute('type')?.toLowerCase() || ''
    if (/RecentChanges|Special:|\/feed\/|action=feed/.test(href)) continue
    try {
      const resolved = new URL(href, baseUrl)
      if (type.includes('markdown')) alternates.push({ url: resolved.href, markdown: true })
      else if (
        /(rss|atom|feed)/.test(type) &&
        (resolved.pathname.includes(url.pathname) || href.includes('comments'))
      ) {
        alternates.push({ url: resolved.href, markdown: false })
      }
    } catch {
      // An invalid alternate does not affect the fetched page.
    }
  }
  const remaining = (cap: number) => Math.min(cap, env.deadline - Date.now() - 250)
  const probe = async (target: string, headers?: Record<string, string>) => {
    signal.throwIfAborted()
    // Leave time to return the rendered page instead of losing it to a probe timeout.
    const timeoutMs = remaining(2000)
    if (timeoutMs <= 0) return null
    try {
      const loaded = await loadPage(target, { timeoutMs, headers })
      signal.throwIfAborted()
      if (!loaded.ok || loaded.bodySkipped) {
        ctx.logger.debug('fallback unavailable: %s (%s)', target, loaded.error ?? loaded.status)
        return null
      }
      return loaded
    } catch (error) {
      signal.throwIfAborted()
      ctx.logger.debug('fallback failed: %s (%s)', target, String(error))
      return null
    }
  }
  const usableMarkdown = (loaded: LoadedPage, min = 100) => {
    const type = normalizeMime(loaded.contentType)
    return (
      withoutMetadata(loaded.content).length > min &&
      !looksLikeHtml(loaded.content) &&
      !/(?:html|json|xml|rss|atom)/.test(type) &&
      (!type || type.startsWith('text/') || type.includes('markdown')) &&
      !lowQuality(loaded.content)
    )
  }
  const select = (loaded: LoadedPage, method: string): HtmlRendering => {
    notes.push(`Used ${method} fallback: ${loaded.finalUrl}`)
    return { body: loaded.content, method, source: loaded }
  }

  const markdownAlternate = alternates.find((alternate) => alternate.markdown)
  if (markdownAlternate) {
    const loaded = await probe(markdownAlternate.url)
    if (loaded && usableMarkdown(loaded)) return select(loaded, 'alternate-markdown')
  }
  const suffix = new URL(url)
  suffix.pathname += url.pathname.endsWith('/') ? 'index.html.md' : '.md'
  const suffixed = await probe(suffix.href)
  if (suffixed && usableMarkdown(suffixed)) return select(suffixed, 'md-suffix')
  const negotiated = await probe(page.finalUrl, { Accept: 'text/markdown, text/plain;q=0.9, text/html;q=0.8' })
  if (
    negotiated &&
    usableMarkdown(negotiated, 0) &&
    /^(text\/plain|text\/markdown)$/.test(normalizeMime(negotiated.contentType))
  ) {
    return select(negotiated, 'content-negotiation')
  }
  for (const alternate of alternates.filter((alternate) => !alternate.markdown).slice(0, 2)) {
    const loaded = await probe(alternate.url)
    if (!loaded || looksLikeHtml(loaded.content)) continue
    const feed = feedMarkdown(loaded.content)
    if (feed && feed.entries > 0) {
      notes.push(`Used feed alternate: ${loaded.finalUrl}`)
      return { body: feed.content, method: 'alternate-feed', source: loaded }
    }
  }

  // Reader chain: the local converter first, then configured remote readers while its output is unusable.
  let rendered = markdown
  let method = 'markdown'
  // Front matter alone (title, meta tags) is no rendering: a JS app shell would otherwise pass.
  const acceptable = (content: string) => withoutMetadata(content).length > MIN_RENDERED_CHARS && !lowQuality(content)
  if (!acceptable(rendered)) {
    for (const [index, entry] of env.readers.entries()) {
      if (!entry.enabled) continue
      const reader = readers.find((item) => item.id === entry.type)
      if (reader === undefined) continue
      const timeoutMs = remaining(REMOTE_READER_MAX_MS)
      if (timeoutMs <= 0) break
      const label =
        env.readers.filter((item) => item.type === entry.type).length > 1 ? `${entry.type}#${index + 1}` : entry.type
      try {
        const content = await reader.read(
          ctx,
          entry,
          page.finalUrl,
          AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        )
        if (content === null) {
          notes.push(`${reader.label} returned no content`)
          continue
        }
        const cleaned = stripDataUriImages(content).trim()
        if (!acceptable(cleaned)) {
          notes.push(`${reader.label} returned no readable body`)
          continue
        }
        rendered = cleaned
        method = label
        notes.push(`Used remote reader: ${reader.label}`)
        break
      } catch (error) {
        signal.throwIfAborted()
        notes.push(`${reader.label} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const hasBody = withoutMetadata(rendered).length > 0
  const gated = !hasBody || lowQuality(rendered)
  // A wrapper page around a PDF/DOCX passes the quality gate; try its document when the link survived rendering.
  const wrapperShaped = !gated && mostlyShortLines(rendered) && rendered.split('\n').length <= 300
  let links = gated || wrapperShaped ? documentLinks(page.content, baseUrl.href) : []
  if (wrapperShaped) {
    const kept = renderedLinkTargets(rendered, baseUrl.href)
    links = links.filter((link) => kept.has(link))
  }
  if (links.length > 0 && remaining(Number.POSITIVE_INFINITY) > 0) {
    const binary = await env.loadBinary(links[0]!, { timeoutMs: remaining(Number.POSITIVE_INFINITY) })
    if (binary.ok) {
      const converted = await env.convertDocument(
        binary.bytes,
        extensionHint(binary.finalUrl, binary.contentDisposition)
      )
      if (converted !== null && converted.trim().length > rendered.length) {
        notes.push(`Extracted and converted document: ${links[0]}`)
        return { body: converted, method: 'extracted-document', contentType: 'application/document' }
      }
    } else {
      notes.push(`Document fetch failed: ${binary.error}`)
    }
  }

  if (gated) {
    for (const target of llmCandidates(url)) {
      const loaded = await probe(target)
      if (!loaded || !usableMarkdown(loaded)) continue
      const scope = new URL('.', target)
      const final = new URL(loaded.finalUrl)
      if (final.origin !== scope.origin || !final.pathname.startsWith(scope.pathname)) {
        ctx.logger.debug('fallback left its path scope: %s -> %s', target, loaded.finalUrl)
        continue
      }
      return select(loaded, 'llms.txt')
    }
    if (hasBody) notes.push('Page text asks to enable JavaScript; returning available content')
    else {
      if (conversionError) notes.push(`HTML conversion failed: ${conversionError}`)
      notes.push('HTML conversion produced no readable body; preserving raw HTML')
    }
  }
  if (!hasBody) return { body: page.content, method: 'raw-html' }
  // Every check above judged the rendering whole; only the returned copy is pruned.
  return { body: method === 'markdown' ? pruneFrontMatter(rendered) : rendered, method }
}
