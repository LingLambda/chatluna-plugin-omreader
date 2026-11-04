// Remote reader backends that render a page to text.
// These fetch the page themselves on the operator's account, so their API hosts are not subject to `allowedHosts`.
import { setTimeout as sleep } from 'node:timers/promises'
import type { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import type {} from '@cordisjs/plugin-http'

export interface ReaderEntry {
  readonly type: string
  readonly enabled: boolean
}

interface ReaderDefinition<F extends Schema> {
  readonly id: string
  readonly label: string
  readonly fields: F
  /** Markdown for `url`, or null when the backend returned nothing usable. */
  read(ctx: Context, config: ReturnType<F>, url: string, signal: AbortSignal): Promise<string | null>
}

export interface Reader {
  readonly id: string
  readonly label: string
  readonly schema: Schema
  read(ctx: Context, entry: unknown, url: string, signal: AbortSignal): Promise<string | null>
}

function defineReader<F extends Schema>(def: ReaderDefinition<F>): Reader {
  return {
    id: def.id,
    label: def.label,
    schema: Schema.intersect([Schema.object({ type: Schema.const(def.id).required() }), def.fields]),
    read: (ctx, entry, url, signal) => def.read(ctx, def.fields.parse(entry), url, signal)
  }
}

const JINA_MARKDOWN_MARKER = 'Markdown Content:'
const JINA_READER_MAX_BYTES = 2 * 1024 * 1024

const jina = defineReader({
  id: 'jina',
  label: 'Jina Reader',
  fields: Schema.object({
    apiKey: Schema.string()
      .role('secret')
      .label('API Key')
      .description('可选；不填按匿名额度调用。在 https://jina.ai 获取。')
  }),
  async read(ctx, config, url, signal) {
    const headers: Record<string, string> = { Accept: 'text/markdown', 'X-No-Cache': 'true' }
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    const response = await ctx.http(`https://r.jina.ai/${url}`, { headers, signal })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      return null
    }
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > JINA_READER_MAX_BYTES) {
      void response.body?.cancel().catch(() => {})
      return null
    }
    const body = await response.text()
    const start = body.indexOf(JINA_MARKDOWN_MARKER)
    if (start < 0) return null
    const content = body.slice(start + JINA_MARKDOWN_MARKER.length).trim()
    if (content.length < 100 || content.startsWith('Loading...') || content.startsWith('Please enable JavaScript')) {
      return null
    }
    return content
  }
})

/** Endpoint with an explicit `/v1` or `/v2` suffix kept, otherwise defaulted to `/v2`. */
function firecrawlEndpoint(base: string) {
  const url = new URL(base)
  url.search = ''
  url.hash = ''
  let path = url.pathname.replace(/\/+$/, '')
  if (!/\/v[12]$/i.test(path)) path += '/v2'
  url.pathname = `${path}/scrape`
  return url.href
}

const firecrawl = defineReader({
  id: 'firecrawl',
  label: 'Firecrawl',
  fields: Schema.object({
    apiKey: Schema.string().role('secret').label('API Key').description('自建实例可留空。'),
    endpoint: Schema.string()
      .role('link')
      .default('https://api.firecrawl.dev')
      .label('服务地址')
      .description('自建实例填写其地址。')
  }),
  async read(ctx, config, url, signal) {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    const endpoint = firecrawlEndpoint(config.endpoint)
    const data = JSON.stringify({ url, formats: ['markdown'] })
    let response = await ctx.http(endpoint, { method: 'POST', headers, data, signal })
    // Firecrawl marks 408/429/5xx retryable; one quick retry, honoring a short Retry-After only.
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 1)
      void response.body?.cancel().catch(() => {})
      if (!Number.isFinite(retryAfter) || retryAfter * 1000 > 2000) return null
      await sleep(Math.max(0, retryAfter * 1000), undefined, { signal })
      response = await ctx.http(endpoint, { method: 'POST', headers, data, signal })
    }
    if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const payload = (await response.json()) as {
      success?: boolean
      error?: string | null
      data?: { markdown?: string | null } | null
    }
    if (payload.success === false) throw new Error(payload.error?.trim() || 'Firecrawl scrape failed')
    return payload.data?.markdown ?? null
  }
})

const parallel = defineReader({
  id: 'parallel',
  label: 'Parallel Extract',
  fields: Schema.object({
    apiKey: Schema.string().role('secret').required().label('API Key').description('在 https://parallel.ai 获取。')
  }),
  async read(ctx, config, url, signal) {
    const response = await ctx.http('https://api.parallel.ai/v1beta/extract', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'parallel-beta': 'search-extract-2025-10-10'
      },
      data: JSON.stringify({ urls: [url], objective: 'Extract the main content', excerpts: true, full_content: false }),
      signal
    })
    if (!response.ok) throw new Error(`Parallel HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const payload = (await response.json()) as {
      results?: { url?: string; excerpts?: unknown[]; full_content?: string }[]
    }
    const document = payload.results?.find((item) => typeof item.url === 'string')
    if (document === undefined) return null
    const excerpts = (document.excerpts ?? [])
      .filter((excerpt): excerpt is string => typeof excerpt === 'string' && excerpt.trim().length > 0)
      .join('\n\n')
      .trim()
    return excerpts || document.full_content?.trim() || null
  }
})

/** Order here is only the order of the type picker in the config UI. */
export const readers: readonly Reader[] = [jina, firecrawl, parallel]
