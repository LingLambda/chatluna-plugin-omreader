// URL reading: fetches and renders a page; long bodies are kept in an in-memory cache and paged by line.
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-http'
import { createBinaryLoader, createPageLoader, validateTarget } from './loader'
import type { ReaderEntry } from './readers'
import { renderUrl } from './render'
import type { InlineImage, RenderedPage, Requester } from './types'

export interface FetchOptions {
  readonly url: string
  /** Return the response text verbatim instead of rendering HTML to Markdown. */
  readonly raw: boolean
  /** 1-based first line to return. */
  readonly offset?: number | undefined
  /** Lines to return; capped at `maxLines`. */
  readonly limit?: number | undefined
  readonly signal: AbortSignal
  readonly timeout: number
  readonly maxBytes: number
  readonly maxLines: number
  /** Normalized host allowlist; empty allows every host. */
  readonly allowedHosts: readonly string[]
  readonly readers: readonly ReaderEntry[]
  readonly githubToken?: string | undefined
}

export interface FetchResult {
  readonly text: string
  readonly url: string
  readonly page: RenderedPage
  readonly image?: InlineImage | undefined
}

const CACHE_TTL_MS = 10 * 60_000
const CACHE_MAX_ENTRIES = 32
/** Total UTF-16 code units of cached bodies. */
const CACHE_MAX_CHARS = 32 * 1024 * 1024

interface CacheEntry {
  readonly page: RenderedPage
  readonly lines: readonly string[]
  readonly expiresAt: number
}

/** Rendered pages by `raw` + URL, so paging through a long body neither refetches it nor sees it change. */
export class PageCache {
  readonly #entries = new Map<string, CacheEntry>()
  #chars = 0

  get(key: string) {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    this.#delete(key, entry)
    if (Date.now() >= entry.expiresAt) return undefined
    this.#entries.set(key, entry)
    this.#chars += entry.page.body.length
    return entry
  }

  set(key: string, page: RenderedPage) {
    const existing = this.#entries.get(key)
    if (existing !== undefined) this.#delete(key, existing)
    const entry: CacheEntry = { page, lines: page.body.split('\n'), expiresAt: Date.now() + CACHE_TTL_MS }
    if (page.body.length > CACHE_MAX_CHARS) return entry
    this.#entries.set(key, entry)
    this.#chars += page.body.length
    for (const [oldest, value] of this.#entries) {
      if (this.#entries.size <= CACHE_MAX_ENTRIES && this.#chars <= CACHE_MAX_CHARS) break
      this.#delete(oldest, value)
    }
    return entry
  }

  #delete(key: string, entry: CacheEntry) {
    this.#entries.delete(key)
    this.#chars -= entry.page.body.length
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Whole lines from `start` (0-based) within the line and UTF-8 byte budgets; a first line over budget is cut. */
function sliceLines(lines: readonly string[], start: number, maxLines: number, maxBytes: number) {
  const kept: string[] = []
  let bytes = 0
  for (let index = start; index < lines.length && kept.length < maxLines; index++) {
    const line = lines[index]!
    const size = encoder.encode(line).length + (kept.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (kept.length === 0) {
        const encoded = encoder.encode(line)
        let end = maxBytes
        while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--
        return { text: decoder.decode(encoded.subarray(0, end)), count: 1, cutLine: true }
      }
      break
    }
    kept.push(line)
    bytes += size
  }
  return { text: kept.join('\n'), count: kept.length, cutLine: false }
}

export async function fetchPage(ctx: Context, cache: PageCache, options: FetchOptions): Promise<FetchResult> {
  const input = options.url.trim()
  if (input === '') throw new Error('url is empty; pass an HTTP/HTTPS URL')
  let target: URL
  try {
    target = new URL(/^www\./i.test(input) ? `https://${input}` : input)
  } catch {
    throw new Error(`Invalid URL: ${input}; only HTTP/HTTPS URLs are supported`)
  }
  validateTarget(target, options.allowedHosts)
  options.signal.throwIfAborted()
  const key = `${options.raw ? 'raw' : 'render'}:${target.href}`
  const started = Date.now()
  let entry = options.offset === undefined ? undefined : cache.get(key)
  if (entry === undefined) {
    const timeout = AbortSignal.timeout(options.timeout)
    const signal = AbortSignal.any([options.signal, timeout])
    // Requests go through ctx.http for its proxy; redirects are walked by the loaders to re-check every hop.
    const request: Requester = (url, init) =>
      ctx.http(url, {
        method: init.method,
        headers: Object.fromEntries(init.headers),
        data: init.body,
        signal: init.signal,
        redirect: 'manual'
      })
    const loadPage = createPageLoader(request, options.allowedHosts, signal)
    const loadBinary = createBinaryLoader(request, options.allowedHosts, signal)
    let page: RenderedPage
    try {
      page = await renderUrl(
        {
          ctx,
          loadPage,
          loadBinary,
          signal,
          deadline: started + options.timeout,
          readers: options.readers,
          githubToken: options.githubToken
        },
        target,
        options.raw
      )
      signal.throwIfAborted()
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason
      if (!timeout.aborted) throw error
      page = {
        body: '',
        finalUrl: target.href,
        contentType: '',
        method: 'failed',
        truncated: false,
        notes: [`Request timed out (${options.timeout} ms)`]
      }
    }
    entry = page.method === 'failed' ? { page, lines: page.body.split('\n'), expiresAt: 0 } : cache.set(key, page)
  }
  const { page, lines } = entry
  const total = lines.length
  const start = Math.min(Math.max((options.offset ?? 1) - 1, 0), Math.max(total - 1, 0))
  const slice = sliceLines(
    lines,
    start,
    Math.min(options.limit ?? options.maxLines, options.maxLines),
    options.maxBytes
  )
  const end = start + slice.count
  const notes = [...page.notes]
  if (page.truncated) notes.push('Source body is incomplete (source byte limit reached)')
  if (slice.cutLine) notes.push(`Line ${start + 1} exceeds ${options.maxBytes} bytes and was cut`)
  const paged = start > 0 || end < total
  if (end < total) notes.push(`More content: call web_read with the same url and offset=${end + 1} to continue`)
  ctx.logger.debug('fetched %s -> %s (%s, %d ms)', target.href, page.finalUrl, page.method, Date.now() - started)
  const text = [
    `URL: ${page.finalUrl}`,
    `Content-Type: ${page.contentType || '(not provided)'}`,
    `Method: ${page.method}`,
    ...(paged ? [`Lines: ${start + 1}-${end} of ${total}`] : []),
    ...(notes.length > 0 ? [`Notes: ${notes.join('; ')}`] : []),
    '',
    '---',
    '',
    slice.text
  ].join('\n')
  return { text, url: target.href, page, image: start === 0 ? page.image : undefined }
}
