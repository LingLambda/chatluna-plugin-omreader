// URL rendering: site scrapers first, then the generic fetch with
// image, document and binary-payload branches, then text shaping and the HTML pipeline.
import type { Context } from 'cordis'
import {
  convertDocument,
  CONVERTIBLE_EXTENSIONS,
  CONVERTIBLE_MIMES,
  isConvertible,
  PAYLOAD_MIMES,
  payloadHint,
  renderPayload
} from './documents'
import { feedMarkdown, type HtmlEnv, looksLikeHtml, renderHtml } from './html'
import { MAX_IMAGE_SOURCE_BYTES, prepareImage } from './image'
import { htmlToMarkdown } from './markdown'
import { extensionHint, GENERIC_BINARY_MIMES, imageMimeOf, INLINE_IMAGE_MIMES, normalizeMime } from './mime'
import type { ReaderEntry } from './readers'
import { type ScrapeContext, scrapers } from './scrapers'
import { finalizeOutput, formatBytes } from './scrapers/utils'
import type { BinaryLoader, BinaryPage, LoadedPage, PageLoader, RenderedPage } from './types'

export interface RenderEnv {
  readonly ctx: Context
  readonly loadPage: PageLoader
  readonly loadBinary: BinaryLoader
  readonly signal: AbortSignal
  /** Epoch ms of the call's deadline; optional probes stop short of it. */
  readonly deadline: number
  readonly readers: readonly ReaderEntry[]
  readonly githubToken?: string | undefined
}

/** Unknown types whose payload is re-fetched as binary; skipping the first read avoids downloading it twice. */
function reFetchedAsBinary(mime: string, requestExtension: string) {
  return (
    CONVERTIBLE_MIMES[mime] === true ||
    PAYLOAD_MIMES[mime] === true ||
    INLINE_IMAGE_MIMES[mime] === true ||
    (GENERIC_BINARY_MIMES[mime] === true && CONVERTIBLE_EXTENSIONS[requestExtension] === true)
  )
}

/** Replacement characters or NUL in a decoded sample: the "text" was binary. */
function sampleLooksBinary(text: string) {
  const limit = Math.min(text.length, 4096)
  let replacements = 0
  for (let index = 0; index < limit; index++) {
    const code = text.charCodeAt(index)
    if (code === 0) return true
    if (code === 0xfffd) replacements++
  }
  return replacements >= 3 && replacements / limit > 0.01
}

export async function renderUrl(env: RenderEnv, url: URL, raw: boolean): Promise<RenderedPage> {
  const { signal, ctx } = env
  const notes: string[] = []
  const convert = async (bytes: Uint8Array, extension: string) => {
    const result = await convertDocument(bytes, extension, signal)
    if (result.ok) return result.content
    notes.push(`Document conversion failed: ${result.error}`)
    return null
  }
  const result = (
    body: string,
    method: string,
    finalUrl: string,
    contentType: string,
    extra: Partial<RenderedPage> = {}
  ): RenderedPage => ({
    body,
    method,
    finalUrl,
    contentType,
    notes,
    truncated: false,
    ...extra
  })

  if (!raw) {
    const scrapeContext: ScrapeContext = {
      url,
      signal,
      loadPage: env.loadPage,
      loadBinary: env.loadBinary,
      htmlToMarkdown: (html) => htmlToMarkdown(html, signal),
      convertDocument: convert,
      githubToken: env.githubToken,
      logger: ctx.logger
    }
    for (const scraper of scrapers) {
      signal.throwIfAborted()
      try {
        const scraped = await scraper(scrapeContext)
        if (scraped === null) continue
        notes.push(...(scraped.notes ?? []))
        return result(
          finalizeOutput(scraped.content),
          scraped.method,
          scraped.finalUrl ?? url.href,
          scraped.contentType ?? 'text/markdown',
          { truncated: scraped.truncated ?? false }
        )
      } catch (error) {
        signal.throwIfAborted()
        // A broken site API falls through to the generic path instead of failing the call.
        ctx.logger.debug('scraper failed for %s: %s', url.href, error instanceof Error ? error.message : String(error))
      }
    }
  }

  const requestExtension = extensionHint(url.href)
  const page = await env.loadPage(url.href, { skipBody: (mime) => reFetchedAsBinary(mime, requestExtension) })
  notes.push(...page.notes)
  if (!page.ok) {
    notes.push(page.error ?? (page.status === undefined ? 'Failed to fetch URL' : `HTTP ${page.status}`))
    return result(page.content, 'failed', page.finalUrl, page.contentType, { status: page.status })
  }
  if (page.status === 204) {
    notes.push('HTTP 204 No Content')
    return result('', 'no-content', page.finalUrl, page.contentType, { status: 204 })
  }
  const { finalUrl } = page
  const mime = page.contentType
  const extension = extensionHint(finalUrl)
  const base = { status: page.status, truncated: page.truncated }
  const binaryNotice = (bytes?: number) =>
    `[Binary content: ${mime || 'application/octet-stream'}, ${bytes === undefined ? 'unknown size' : formatBytes(bytes)}] ${finalUrl}`

  let skipConvertible = false
  const imageMime = imageMimeOf(mime, extension)
  if (imageMime !== null) {
    skipConvertible = true
    if (INLINE_IMAGE_MIMES[imageMime] !== true) {
      notes.push(`Image type ${imageMime} cannot be sent inline; returning text only`)
    } else {
      const binary = await env.loadBinary(finalUrl, { maxBytes: MAX_IMAGE_SOURCE_BYTES })
      if (binary.ok) {
        const prepared = prepareImage(binary.bytes, imageMime)
        if (prepared.ok) {
          const resized =
            prepared.width !== prepared.originalWidth
              ? `, resized from ${prepared.originalWidth}x${prepared.originalHeight}`
              : ''
          return result(
            `Fetched image content (${prepared.image.mediaType}, ${prepared.width}x${prepared.height}${resized}).`,
            'image',
            finalUrl,
            prepared.image.mediaType,
            { ...base, image: prepared.image }
          )
        }
        notes.push(
          prepared.reason === 'invalid'
            ? `Payload could not be decoded as ${imageMime}`
            : 'Image is too large to send inline even after resizing'
        )
        return result(
          `Fetched image content (${imageMime}), but it cannot be sent inline.`,
          prepared.reason === 'invalid' ? 'image-invalid' : 'image-too-large',
          finalUrl,
          imageMime,
          base
        )
      }
      notes.push(`Image fetch failed: ${binary.error}`)
      if (binary.error.includes('exceeds')) {
        return result(
          `Fetched image content (${imageMime}), but it is too large to send inline.`,
          'image-too-large',
          finalUrl,
          imageMime,
          base
        )
      }
    }
  }

  let documentBinary: BinaryPage | undefined
  if (!skipConvertible && isConvertible(mime, extension)) {
    documentBinary = await env.loadBinary(finalUrl)
    if (documentBinary.ok) {
      const documentExtension = extensionHint(finalUrl, documentBinary.contentDisposition) || extension
      const converted = await convert(documentBinary.bytes, documentExtension)
      if (converted !== null && converted.trim().length > 50) {
        notes.push('Converted document to Markdown')
        return result(finalizeOutput(converted), 'document', finalUrl, mime, base)
      }
      if (converted !== null) notes.push('Document conversion produced no usable output')
    } else {
      notes.push(`Document fetch failed: ${documentBinary.error}`)
    }
  }

  const hint = payloadHint(mime, extension)
  const looksBinary = page.bodySkipped === true || sampleLooksBinary(page.content)
  if (hint !== undefined || looksBinary) {
    // A failed document download was already noted.
    const binary = documentBinary ?? (await env.loadBinary(finalUrl))
    if (!binary.ok) {
      if (documentBinary === undefined) notes.push(`Binary fetch failed: ${binary.error}`)
      return result(binaryNotice(), 'binary', finalUrl, mime || 'application/octet-stream', base)
    }
    const binaryExtension = extensionHint(finalUrl, binary.contentDisposition) || extension
    try {
      const rendered = await renderPayload(binary.bytes, mime, binaryExtension, finalUrl, signal)
      if (rendered !== null) {
        return result(
          finalizeOutput(rendered.content),
          rendered.method,
          finalUrl,
          mime || 'application/octet-stream',
          base
        )
      }
    } catch (error) {
      signal.throwIfAborted()
      notes.push(`Rendering ${hint ?? 'payload'} failed: ${error instanceof Error ? error.message : String(error)}`)
      return result(binaryNotice(binary.bytes.length), 'binary', finalUrl, mime || 'application/octet-stream', base)
    }
    if (looksBinary) {
      return result(binaryNotice(binary.bytes.length), 'binary', finalUrl, mime || 'application/octet-stream', base)
    }
  }

  if (raw) return result(page.content, 'raw', finalUrl, mime, base)
  if (mime.includes('json')) {
    try {
      return result(JSON.stringify(JSON.parse(page.content), null, 2), 'json', finalUrl, mime, base)
    } catch {
      notes.push('Invalid JSON; preserving original response text')
      return result(page.content, 'text', finalUrl, mime, base)
    }
  }
  if (/(?:xml|rss|atom|feed)/.test(mime) && !mime.includes('html')) {
    const feed = feedMarkdown(page.content)
    return result(feed?.content ?? page.content, feed === null ? 'text' : 'feed', finalUrl, mime, base)
  }
  // Text and Markdown resources may contain literal HTML on purpose.
  if (mime.startsWith('text/') && mime !== 'text/html')
    return result(finalizeOutput(page.content), 'text', finalUrl, mime, base)
  if (!mime.includes('html') && !looksLikeHtml(page.content))
    return result(finalizeOutput(page.content), 'text', finalUrl, mime, base)

  const htmlEnv: HtmlEnv = {
    ctx,
    loadPage: env.loadPage,
    loadBinary: env.loadBinary,
    signal,
    deadline: env.deadline,
    readers: env.readers,
    convertDocument: convert
  }
  const rendered = await renderHtml(page, htmlEnv, notes)
  const source: LoadedPage = rendered.source ?? page
  notes.push(...(source === page ? [] : source.notes))
  return result(
    finalizeOutput(rendered.body),
    rendered.method,
    source.finalUrl,
    rendered.contentType ?? normalizeMime(source.contentType),
    { status: source.status, truncated: source.truncated }
  )
}
