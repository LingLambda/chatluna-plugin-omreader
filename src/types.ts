export interface LoadedPage {
  content: string
  /** Lowercased MIME type without parameters. */
  contentType: string
  finalUrl: string
  ok: boolean
  status?: number | undefined
  truncated: boolean
  notes: string[]
  error?: string | undefined
  /** The body was not read: a binary type, `skipBody` matched, or the bytes sniffed as binary. */
  bodySkipped?: boolean | undefined
}

export interface LoadPageOptions {
  headers?: Record<string, string> | undefined
  /** Local budget for this request; the whole call's signal still applies. */
  timeoutMs?: number | undefined
  method?: 'GET' | 'POST' | undefined
  body?: string | undefined
  /** Text bytes to keep before cutting the body (default 10 MiB). */
  maxBytes?: number | undefined
  /** True for a lowercased MIME type whose body should not be read (it will be re-fetched as binary). */
  skipBody?: ((contentType: string) => boolean) | undefined
}

export type PageLoader = (url: string, options?: LoadPageOptions) => Promise<LoadedPage>

export interface BinaryOptions {
  headers?: Record<string, string> | undefined
  timeoutMs?: number | undefined
  /** Larger bodies fail instead of being cut (default 50 MiB). */
  maxBytes?: number | undefined
}

export type BinaryPage =
  | {
      ok: true
      bytes: Uint8Array
      finalUrl: string
      status: number
      /** Full Content-Type header, parameters included. */
      contentType: string
      contentDisposition?: string | undefined
    }
  | {
      ok: false
      error: string
      finalUrl: string
      status?: number | undefined
      contentType: string
      contentDisposition?: string | undefined
    }

export type BinaryLoader = (url: string, options?: BinaryOptions) => Promise<BinaryPage>

/** One HTTP request without redirect following; the loader walks redirects itself to re-check every hop. */
export type Requester = (
  url: string,
  init: { headers: Headers; method: string; body?: string | undefined; signal: AbortSignal }
) => Promise<Response>

export interface InlineImage {
  /** Base64 payload. */
  data: string
  mediaType: string
}

export interface RenderedPage {
  body: string
  finalUrl: string
  contentType: string
  status?: number | undefined
  /** How the body was produced: `markdown`, `raw`, `json`, a scraper name, a reader name, `failed`… */
  method: string
  notes: string[]
  truncated: boolean
  image?: InlineImage | undefined
}
