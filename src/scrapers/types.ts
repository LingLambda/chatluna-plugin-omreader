import type { Context } from 'cordis'
import type { BinaryLoader, PageLoader } from '../types'

/** Everything a site scraper may use; all network access goes through the policy-checked loaders. */
export interface ScrapeContext {
  /** The requested URL, already normalized (scheme added). */
  readonly url: URL
  /** The whole call's signal: the configured timeout plus caller cancellation. */
  readonly signal: AbortSignal
  readonly loadPage: PageLoader
  readonly loadBinary: BinaryLoader
  /** HTML → Markdown with the shared WASM converter (same output as the generic HTML path). */
  htmlToMarkdown(html: string): Promise<string>
  /** Document bytes → Markdown by extension (`.pdf`, `.docx`, `.pptx`, `.xlsx`, `.epub`); null when unsupported or failed. */
  convertDocument(bytes: Uint8Array, extension: string): Promise<string | null>
  /** Configured GitHub token; raises rate limits and unlocks Actions logs. */
  readonly githubToken?: string | undefined
  readonly logger: Context['logger']
}

export interface ScrapeResult {
  /** Markdown; blank-line runs are collapsed by the caller. */
  readonly content: string
  /** Scraper name shown as `Method:` (e.g. `github`, `npm`). */
  readonly method: string
  /** Defaults to the requested URL. */
  readonly finalUrl?: string | undefined
  /** Defaults to `text/markdown`. */
  readonly contentType?: string | undefined
  readonly notes?: readonly string[] | undefined
  /** Set when `content` embeds a fetched body that was cut at the loader's byte limit. */
  readonly truncated?: boolean | undefined
}

/** Returns null for URLs it does not own (or when its API yields nothing usable), so the generic path runs. */
export type Scraper = (ctx: ScrapeContext) => Promise<ScrapeResult | null>
