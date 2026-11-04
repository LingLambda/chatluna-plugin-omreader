// Helpers shared by the scrapers.
import type { LoadedPage } from '../types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

export function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function tryParseJson<T = unknown>(content: string): T | null {
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

/** Collapses blank-line runs and trims; never shortens content. */
export function finalizeOutput(content: string) {
  return content.replace(/\n{3,}/g, '\n\n').trim()
}

/** `999`, `1.5K`, `25K`, `1.5M`, `1.5B`; values below 1,000 print as-is unless `maxFractionDigits` caps decimals. */
export function formatNumber(n: number, maxFractionDigits?: number) {
  const trim1 = (value: number) => value.toFixed(1).replace(/\.0$/, '')
  if (n < 1_000) {
    if (maxFractionDigits === undefined || Number.isInteger(n)) return n.toString()
    return Number(n.toFixed(maxFractionDigits)).toString()
  }
  if (n < 10_000) return `${trim1(n / 1_000)}K`
  if (n < 1_000_000) return `${Math.round(n / 1_000)}K`
  if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`
  if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`
  return `${Math.round(n / 1_000_000_000)}B`
}

/** `512B`, `1.5KB`, `2.3MB`, `1.2GB`. */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

/** `YYYY-MM-DD`; empty string on invalid input. */
export function formatIsoDate(value?: string | number | Date | null) {
  if (value == null) return ''
  if (typeof value === 'string') {
    const prefix = value.match(/^\d{4}-\d{2}-\d{2}/)
    if (prefix) return prefix[0]
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

/** `H:MM:SS` or `M:SS`. */
export function formatMediaDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const secs = Math.floor(totalSeconds % 60)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

export function decodeHtmlEntities(text: string) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

export type LocalizedText = string | Record<string, string | null> | null | undefined

/** Localized value preferring `defaultLocale`, then en-US / en. */
export function getLocalizedText(value: LocalizedText, defaultLocale?: string) {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  if (defaultLocale && value[defaultLocale]) return value[defaultLocale]!
  return (
    value['en-US'] ??
    value.en_US ??
    value.en ??
    Object.values(value).find((item): item is string => typeof item === 'string') ??
    undefined
  )
}

/** Leading-tag check for an HTML document (not fragments). */
export function looksLikeHtml(content: string) {
  const head = content.trimStart().slice(0, 16).toLowerCase()
  return (
    head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<body')
  )
}

/**
 * Whether an HTTP status settles "is this origin platform X?". Transport failures, auth/bot walls,
 * timeouts, rate limits and server errors may be transient and never produce a memoized verdict.
 */
export function isConclusiveProbeStatus(status: number | undefined) {
  return status !== undefined && status < 500 && status !== 401 && status !== 403 && status !== 408 && status !== 429
}

/** A conclusive failure with a non-JSON body: the origin does not run the platform (platforms answer API errors in JSON). */
export function isNonJsonApiResponse(result: LoadedPage) {
  return isConclusiveProbeStatus(result.status) && tryParseJson(result.content) === null
}

const NEGATIVE_VERDICT_TTL_MS = 10 * 60_000

interface ProbeVerdict {
  verdict: Promise<boolean>
  /** `performance.now()` deadline; positive and pending verdicts never expire. */
  expiresAt: number
}

/**
 * Bounded per-origin memo of platform-detection verdicts (negatives expire after 10 minutes), so generic
 * URL shapes (`/@user`, `/post/N`, `/t/slug/N`) do not re-probe a known host. Concurrent lookups share one probe.
 */
export class PlatformProbeCache {
  readonly #verdicts = new Map<string, ProbeVerdict>()

  constructor(readonly max = 256) {}

  get(origin: string): Promise<boolean> | undefined {
    const entry = this.#verdicts.get(origin)
    if (!entry) return undefined
    if (performance.now() >= entry.expiresAt) {
      this.#verdicts.delete(origin)
      return undefined
    }
    // Refresh recency: Map iteration order is insertion order.
    this.#verdicts.delete(origin)
    this.#verdicts.set(origin, entry)
    return entry.verdict
  }

  /** Memoized verdict, or runs `probe` once; a probe resolving `undefined` is inconclusive and not kept. */
  resolve(origin: string, probe: () => Promise<boolean | undefined>): Promise<boolean> {
    const cached = this.get(origin)
    if (cached) return cached
    const entry: ProbeVerdict = { verdict: Promise.resolve(false), expiresAt: Number.POSITIVE_INFINITY }
    entry.verdict = probe().then(
      (verdict) => {
        if (verdict === undefined) this.#forget(origin, entry)
        else if (!verdict) entry.expiresAt = performance.now() + NEGATIVE_VERDICT_TTL_MS
        return verdict ?? false
      },
      (error: unknown) => {
        this.#forget(origin, entry)
        throw error
      }
    )
    this.#set(origin, entry)
    return entry.verdict
  }

  /** Memoizes a verdict learned from a regular request to `origin`. */
  record(origin: string, verdict: boolean) {
    this.#set(origin, {
      verdict: Promise.resolve(verdict),
      expiresAt: verdict ? Number.POSITIVE_INFINITY : performance.now() + NEGATIVE_VERDICT_TTL_MS
    })
  }

  #set(origin: string, entry: ProbeVerdict) {
    this.#verdicts.delete(origin)
    this.#verdicts.set(origin, entry)
    while (this.#verdicts.size > this.max) this.#verdicts.delete(this.#verdicts.keys().next().value!)
  }

  #forget(origin: string, entry: ProbeVerdict) {
    if (this.#verdicts.get(origin) === entry) this.#verdicts.delete(origin)
  }
}
