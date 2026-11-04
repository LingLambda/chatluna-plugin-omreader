// Page loading: body decoding, bot-block detection, Retry-After parsing and the rotating user agents.
import type { BinaryLoader, LoadedPage, PageLoader, Requester } from './types'

/** Text bodies past this are cut and flagged `truncated`. */
const MAX_BYTES = 10 * 1024 * 1024
/** Binary payloads (images, documents, archives) past this are refused whole. */
const MAX_BINARY_BYTES = 50 * 1024 * 1024
const USER_AGENTS = [
  'curl/8.0',
  'Mozilla/5.0 (compatible; TextBot/1.0)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
]

/** Policy violations stop the call instead of being retried with another user agent. */
export class TargetPolicyError extends Error {}

export function validateTarget(target: URL, allowedHosts: readonly string[]) {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new TargetPolicyError('Only HTTP and HTTPS URLs are supported')
  }
  if (target.username || target.password) throw new TargetPolicyError('URL credentials are not supported')
  if (allowedHosts.length === 0) return
  const hostname = target.hostname.toLowerCase().replace(/\.$/, '')
  const allowed = allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  if (!allowed) throw new TargetPolicyError(`Host is not allowed: ${target.hostname}`)
}

/** Trimmed, lowercased, trailing-dot-free host list; blanks dropped. */
export function normalizeHosts(hosts: readonly string[]) {
  return hosts.map((host) => host.trim().toLowerCase().replace(/\.$/, '')).filter((host) => host !== '')
}

// Cleanup is deliberately fire-and-forget: a failing cancel() must not mask the HTTP/policy error.
function cancel(body: { cancel(reason?: unknown): Promise<unknown> } | null | undefined, reason?: unknown) {
  try {
    void body?.cancel(reason).catch(() => {})
  } catch {
    // Keep the primary result.
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const aborted = () => {
    onAbort?.()
    reject(signal.reason)
  }
  if (signal.aborted) aborted()
  else signal.addEventListener('abort', aborted, { once: true })
  void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  return promise
}

async function delay(ms: number, signal: AbortSignal) {
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, ms)
  try {
    await abortable(promise, signal)
  } finally {
    clearTimeout(timer)
  }
}

function parseRetryAfterMs(value: string | null) {
  if (!value?.trim()) return 1000
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 10_000) : 1000
}

function isText(contentType: string) {
  return (
    !contentType ||
    contentType.startsWith('text/') ||
    /^(?:application\/(?:json|xml|xhtml\+xml|javascript|x-javascript|ld\+json|rss\+xml|atom\+xml|yaml|x-yaml)|image\/svg\+xml)$/.test(
      contentType
    ) ||
    /^application\/[^;]+\+(?:json|xml)$/.test(contentType)
  )
}

function declaredCharset(value: string) {
  // Whole parameters only, so `x-charset` or `charset` inside a quoted value never match.
  for (const match of value.matchAll(/;\s*([^=;\s]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/g)) {
    if (match[1]!.toLowerCase() === 'charset') return match[2] ?? match[3] ?? match[4]
  }
  return undefined
}

function htmlCharset(bytes: Uint8Array) {
  const prefix = new TextDecoder('windows-1252').decode(bytes.subarray(0, 2048))
  // Comments and raw-text elements are skipped so examples inside them are not taken as declarations.
  const tags =
    /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<meta\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi
  for (const tag of prefix.matchAll(tags)) {
    if (tag[2] === undefined) continue
    const attributes = new Map<string, string>()
    for (const attr of tag[2].matchAll(/([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = attr[1]!.toLowerCase()
      if (!attributes.has(name)) attributes.set(name, attr[2] ?? attr[3] ?? attr[4] ?? '')
    }
    const charset = attributes.get('charset')
    if (charset) return charset
    if (attributes.get('http-equiv')?.toLowerCase() === 'content-type') {
      const label = declaredCharset(attributes.get('content') ?? '')
      if (label) return label
    }
  }
  return undefined
}

function looksBinary(bytes: Uint8Array, content: string) {
  // High-bit magic numbers are checked on bytes before UTF-8 replacement; NUL after decoding so UTF-16 text passes.
  return (
    (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ||
    (bytes[0] === 0x1f && bytes[1] === 0x8b) ||
    content.startsWith('%PDF-') ||
    content.startsWith('PK\x03\x04') ||
    /^GIF8[79]a/.test(content) ||
    content.slice(0, 2048).includes('\x00')
  )
}

function decodeBody(bytes: Uint8Array, header: string, notes: string[], truncated: boolean) {
  // A Unicode BOM wins over a conflicting declared charset.
  let label: string | undefined
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = 'utf-8'
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be'
  label ??= declaredCharset(header)
  if (!label && (!header || /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(header))) {
    label = htmlCharset(bytes)
  }
  try {
    // A truncated prefix is not EOF: no replacement character for a split sequence.
    return new TextDecoder(label ?? 'utf-8').decode(bytes, { stream: truncated })
  } catch {
    notes.push(`Unsupported charset ${label}; decoded as UTF-8.`)
    return new TextDecoder().decode(bytes, { stream: truncated })
  }
}

async function readBody(response: Response, signal: AbortSignal, maxBytes: number) {
  const reader = response.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(), truncated: false }
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await abortable(reader.read(), signal, () => cancel(reader, signal.reason))
      signal.throwIfAborted()
      if (done) break
      const remaining = maxBytes - size
      if (value.length > remaining) {
        // Copy only the kept prefix so the oversized buffer is not retained.
        if (remaining) chunks.push(value.slice(0, remaining))
        size += remaining
        truncated = true
        cancel(reader)
        break
      }
      if (value.length) chunks.push(value)
      size += value.length
    }
  } catch (error) {
    cancel(reader, error)
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // An in-flight cancel holds the lock.
    }
  }
  if (chunks.length === 1) return { bytes: chunks[0]!, truncated }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes, truncated }
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  // cordis http wraps network failures (ECONNRESET, ENOTFOUND, TLS…) in `cause`.
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Walks redirects by hand so every hop passes the host policy; credentials never cross origins. */
async function follow(
  request: Requester,
  initial: URL,
  init: { headers: Headers; method: string; body?: string | undefined },
  allowedHosts: readonly string[],
  signal: AbortSignal
) {
  let target = initial
  let { method, body } = init
  for (let redirects = 0; ; redirects++) {
    validateTarget(target, allowedHosts)
    signal.throwIfAborted()
    const pending = request(target.href, { headers: init.headers, method, body, signal })
    // A request that settles after abort still owns a body to release.
    void pending.then(
      (late) => {
        if (signal.aborted) cancel(late.body)
      },
      () => {}
    )
    const response = await abortable(pending, signal)
    const finalUrl = response.url || target.href
    validateTarget(new URL(finalUrl), allowedHosts)
    if (!REDIRECT_STATUSES.has(response.status) || !response.headers.has('location')) return { response, finalUrl }
    cancel(response.body)
    const next = new URL(response.headers.get('location')!, target)
    validateTarget(next, allowedHosts)
    if (redirects >= 10) throw new TargetPolicyError('Too many HTTP redirects (maximum 10)')
    if (next.origin !== target.origin) {
      init.headers.delete('authorization')
      init.headers.delete('cookie')
      init.headers.delete('proxy-authorization')
    }
    // 303, and 301/302 after POST, switch to a bodyless GET as browsers do.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET'
      body = undefined
    }
    target = next
  }
}

/** Combines the call signal with an optional per-request budget; `done` clears the timer. */
function budget(signal: AbortSignal, timeoutMs: number | undefined) {
  const local = new AbortController()
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => local.abort(new DOMException('Request timed out', 'TimeoutError')), Math.max(0, timeoutMs))
  return { signal: AbortSignal.any([signal, local.signal]), local: local.signal, done: () => clearTimeout(timer) }
}

export function createPageLoader(request: Requester, allowedHosts: readonly string[], signal: AbortSignal): PageLoader {
  return async (url, options = {}) => {
    const initial = new URL(url)
    validateTarget(initial, allowedHosts)
    signal.throwIfAborted()
    const scope = budget(signal, options.timeoutMs)
    const requestSignal = scope.signal
    const maxBytes = options.maxBytes ?? MAX_BYTES
    let retried429 = false
    let last: LoadedPage = {
      content: '',
      contentType: '',
      finalUrl: initial.href,
      ok: false,
      truncated: false,
      notes: []
    }
    let observed: LoadedPage | undefined
    try {
      for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
        let response: Response | undefined
        try {
          requestSignal.throwIfAborted()
          const headers = new Headers({
            'User-Agent': USER_AGENTS[attempt]!,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5'
          })
          for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value)
          // Cloudflare Markdown-for-Agents returns corrupted bytes under compression.
          headers.set('Accept-Encoding', 'identity')
          const followed = await follow(
            request,
            initial,
            { headers, method: options.method ?? 'GET', body: options.body },
            allowedHosts,
            requestSignal
          )
          response = followed.response
          const rawType = response.headers.get('content-type') ?? ''
          const contentType = rawType.split(';', 1)[0]!.trim().toLowerCase()
          last = {
            content: '',
            contentType,
            finalUrl: followed.finalUrl,
            ok: response.ok,
            status: response.status,
            truncated: false,
            notes: last.notes
          }
          observed = last
          if (!response.ok) last.error = `HTTP ${response.status}`
          if (response.status === 429 && !retried429) {
            retried429 = true
            cancel(response.body)
            await delay(parseRetryAfterMs(response.headers.get('retry-after')), requestSignal)
            attempt--
            continue
          }
          if (!isText(contentType) || options.skipBody?.(contentType)) {
            cancel(response.body)
            last.bodySkipped = true
            return last
          }
          const { bytes, truncated } = await readBody(response, requestSignal, maxBytes)
          last.content = decodeBody(bytes, rawType, last.notes, truncated)
          last.truncated = truncated
          if (looksBinary(bytes, last.content)) {
            last.content = ''
            last.bodySkipped = true
            return last
          }
          if (
            (response.status === 403 || response.status === 503) &&
            /cloudflare|captcha|challenge|blocked|access denied|bot detection/i.test(last.content) &&
            attempt < USER_AGENTS.length - 1
          ) {
            continue
          }
          return last
        } catch (error) {
          cancel(response?.body, error)
          if (signal.aborted) throw signal.reason
          if (error instanceof TargetPolicyError) throw error
          const message = errorMessage(error)
          // An observed HTTP failure outranks a later body read error.
          if (response && !response.ok) {
            return {
              ...last,
              ok: false,
              status: response.status,
              error: `HTTP ${response.status}`,
              notes: [...last.notes, message]
            }
          }
          last = { ...last, content: '', ok: false, error: message }
          if ((scope.local.aborted || attempt === USER_AGENTS.length - 1) && observed) {
            return { ...observed, ok: false, error: observed.error ?? message, notes: [...observed.notes, message] }
          }
          if (scope.local.aborted) return last
        }
      }
      return last
    } finally {
      scope.done()
    }
  }
}

/** Downloads a payload whole; a body over `maxBytes` fails instead of being cut, since a partial document is unusable. */
export function createBinaryLoader(
  request: Requester,
  allowedHosts: readonly string[],
  signal: AbortSignal
): BinaryLoader {
  return async (url, options = {}) => {
    const initial = new URL(url)
    validateTarget(initial, allowedHosts)
    signal.throwIfAborted()
    const scope = budget(signal, options.timeoutMs)
    const maxBytes = options.maxBytes ?? MAX_BINARY_BYTES
    let response: Response | undefined
    try {
      const headers = new Headers({ 'User-Agent': USER_AGENTS[1]!, 'Accept-Encoding': 'identity' })
      for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value)
      const followed = await follow(request, initial, { headers, method: 'GET' }, allowedHosts, scope.signal)
      response = followed.response
      const base = {
        finalUrl: followed.finalUrl,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        contentDisposition: response.headers.get('content-disposition') ?? undefined
      }
      if (!response.ok) {
        cancel(response.body)
        return { ...base, ok: false, error: `HTTP ${response.status}` }
      }
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) {
        cancel(response.body)
        return { ...base, ok: false, error: `Content-Length ${declared} exceeds ${maxBytes} bytes` }
      }
      const { bytes, truncated } = await readBody(response, scope.signal, maxBytes)
      if (truncated) return { ...base, ok: false, error: `Response exceeds ${maxBytes} bytes` }
      return { ...base, ok: true, bytes }
    } catch (error) {
      cancel(response?.body, error)
      if (signal.aborted) throw signal.reason
      if (error instanceof TargetPolicyError) throw error
      return {
        ok: false,
        finalUrl: initial.href,
        contentType: '',
        error: scope.local.aborted ? 'Request timed out' : errorMessage(error)
      }
    } finally {
      scope.done()
    }
  }
}
