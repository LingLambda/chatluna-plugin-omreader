// Ollama model pages plus the public tags index.
import type { LoadedPage } from '../types'
import type { Scraper, ScrapeResult } from './types'
import { decodeHtmlEntities, formatBytes, tryParseJson } from './utils'

interface OllamaTagDetails {
  parent_model?: string
  format?: string
  family?: string
  families?: string[] | null
  parameter_size?: string
  quantization_level?: string
}

interface OllamaTagModel {
  name?: string
  model?: string
  modified_at?: string
  size?: number
  digest?: string
  details?: OllamaTagDetails
}

interface OllamaTagsResponse {
  models?: OllamaTagModel[]
}

const VALID_HOSTNAMES: Record<string, true> = { 'ollama.com': true, 'www.ollama.com': true }
const RESERVED_ROOTS: Record<string, true> = {
  library: true,
  models: true,
  blog: true,
  docs: true,
  download: true,
  cloud: true,
  signin: true,
  signout: true,
  search: true,
  api: true,
  terms: true,
  privacy: true,
  license: true,
  settings: true,
  pricing: true,
  account: true
}

function extractMetaDescription(html: string): string | null {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']twitter:description["'][^>]*content=["']([^"']+)["']/i
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return decodeHtmlEntities(match[1].trim())
  }

  return null
}

function extractParameterSizes(html: string): string[] {
  const sizes = new Set<string>()
  for (const match of html.matchAll(/x-test-size[^>]*>([^<]+)<\/span>/gi)) {
    const raw = match[1]?.trim()
    if (raw) sizes.add(raw.toUpperCase())
  }
  return Array.from(sizes)
}

function extractTagsFromHtml(html: string, baseRef: string): string[] {
  const tags = new Set<string>()
  for (const match of html.matchAll(/href=["']\/library\/([^"']+)["']/gi)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    const decoded = decodeHtmlEntities(raw)
    if (decoded === baseRef || decoded.startsWith(`${baseRef}:`)) tags.add(decoded)
  }
  return Array.from(tags)
}

function buildModelPath(parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join('/')
}

function parseOllamaUrl(
  parsed: URL
): { modelRef: string; baseRef: string; pageUrl: string; shorthand: boolean } | null {
  if (VALID_HOSTNAMES[parsed.hostname] !== true) return null

  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts.length === 0) return null

  if (parts[0] === 'library' && parts.length >= 2) {
    const modelRef = decodeURIComponent(parts[1]!)
    const baseRef = modelRef.split(':')[0] ?? modelRef
    const pageUrl = `${parsed.origin}/${buildModelPath(['library', baseRef])}`
    return { modelRef, baseRef, pageUrl, shorthand: false }
  }

  const baseRoot = parts[0]!.split(':')[0]!
  // Single-segment shorthands (ollama.com/<model>) share the root namespace with marketing routes, so the
  // scraper confirms the candidate against the tags index before fetching its page; a missing model yields
  // no tags match, which maps to null (generic fallback).
  if (parts.length === 1 && RESERVED_ROOTS[baseRoot] !== true) {
    const modelRef = decodeURIComponent(parts[0]!)
    const baseRef = modelRef.split(':')[0] ?? modelRef
    const pageUrl = `${parsed.origin}/${buildModelPath(['library', baseRef])}`
    return { modelRef, baseRef, pageUrl, shorthand: true }
  }

  if (parts.length >= 2 && RESERVED_ROOTS[baseRoot] !== true) {
    const namespace = decodeURIComponent(parts[0]!)
    const model = decodeURIComponent(parts[1]!)
    const modelBase = model.split(':')[0] ?? model
    const modelRef = `${namespace}/${model}`
    const baseRef = `${namespace}/${modelBase}`
    const pageUrl = `${parsed.origin}/${buildModelPath([namespace, modelBase])}`
    return { modelRef, baseRef, pageUrl, shorthand: false }
  }

  return null
}

function sortTags(tags: string[]): string[] {
  return tags.sort((a, b) => {
    const aLatest = a.endsWith(':latest')
    const bLatest = b.endsWith(':latest')
    if (aLatest && !bLatest) return -1
    if (!aLatest && bLatest) return 1
    return a.localeCompare(b)
  })
}

function formatTagList(tags: string[], maxItems: number): string {
  const formatted = tags
    .slice(0, maxItems)
    .map((tag) => `\`${tag}\``)
    .join(', ')
  if (tags.length > maxItems) return `${formatted} […${tags.length - maxItems} tags elided…]`
  return formatted
}

function collectParameterSizes(models: OllamaTagModel[], htmlSizes: string[]): string[] {
  const sizes = new Set<string>()
  for (const model of models) {
    const param = model.details?.parameter_size?.trim()
    if (param) sizes.add(param.toUpperCase())
  }
  for (const size of htmlSizes) sizes.add(size)
  return Array.from(sizes)
}

function matchTagsModels(baseRef: string, tagsIndex: OllamaTagModel[] | null): OllamaTagModel[] {
  const baseLower = baseRef.toLowerCase()
  return (tagsIndex ?? []).filter((model) => {
    const name = (model.model ?? model.name ?? '').toLowerCase()
    return name === baseLower || name.startsWith(`${baseLower}:`)
  })
}

function renderOllamaModel(args: {
  url: string
  modelRef: string
  baseRef: string
  tagsResult: { ok: boolean }
  matchingModels: OllamaTagModel[]
  pageResult: { ok: boolean; content: string; finalUrl: string }
}): ScrapeResult | null {
  const { url, modelRef, baseRef, tagsResult, matchingModels, pageResult } = args
  const html = pageResult.ok ? pageResult.content : ''
  const description = html ? extractMetaDescription(html) : null
  const htmlParameterSizes = html ? extractParameterSizes(html) : []
  const htmlTags = html ? extractTagsFromHtml(html, baseRef) : []

  if (!pageResult.ok && (!tagsResult.ok || matchingModels.length === 0)) return null

  const tagRef = modelRef.includes(':') ? modelRef : null
  const selectedTag = tagRef ? matchingModels.find((model) => (model.model ?? model.name ?? '') === tagRef) : null

  const availableTagsRaw = matchingModels
    .map((model) => model.model ?? model.name ?? '')
    .filter((tag) => tag.length > 0)
  const availableTags = sortTags(Array.from(new Set(availableTagsRaw)))

  const fallbackTags = sortTags(Array.from(new Set(htmlTags)))
  const tagsToUse = availableTags.length > 0 ? availableTags : fallbackTags

  const parameterSizes = collectParameterSizes(selectedTag ? [selectedTag] : matchingModels, htmlParameterSizes)

  const sizes = matchingModels.map((model) => model.size).filter((size): size is number => typeof size === 'number')
  let sizeLine: string | null = null

  if (selectedTag?.size) {
    sizeLine = formatBytes(selectedTag.size)
  } else if (sizes.length > 0) {
    const minSize = Math.min(...sizes)
    const maxSize = Math.max(...sizes)
    sizeLine = minSize === maxSize ? formatBytes(minSize) : `${formatBytes(minSize)} - ${formatBytes(maxSize)}`
  }

  let md = `# ${baseRef}\n\n`
  if (description) md += `${description}\n\n`

  md += `**Model:** ${baseRef}\n`
  if (tagRef) md += `**Tag:** ${tagRef}\n`
  if (parameterSizes.length > 0) md += `**Parameters:** ${parameterSizes.join(', ')}\n`
  if (sizeLine) {
    const label = sizeLine.includes(' - ') ? 'Size Range' : 'Size'
    md += `**${label}:** ${sizeLine}\n`
  }
  if (tagsToUse.length > 0) md += `**Available Tags:** ${formatTagList(tagsToUse, 40)}\n`

  return {
    content: md,
    method: 'ollama',
    finalUrl: pageResult.ok ? pageResult.finalUrl : url,
    notes: ['Fetched via Ollama API']
  }
}

const TAGS_URL = 'https://ollama.com/api/tags'
const TAGS_OPTIONS = { headers: { Accept: 'application/json' } }

function parseTagsIndex(tagsResult: LoadedPage): OllamaTagModel[] | null {
  const tagsData = tagsResult.ok ? tryParseJson<OllamaTagsResponse>(tagsResult.content) : null
  return Array.isArray(tagsData?.models) ? tagsData.models : null
}

export const scrapeOllama: Scraper = async (ctx) => {
  try {
    const parsed = parseOllamaUrl(ctx.url)
    if (!parsed) return null
    const { modelRef, baseRef, pageUrl, shorthand } = parsed
    const url = ctx.url.href

    // Ambiguous single-segment shorthands share the root namespace with marketing routes, so confirm them
    // against the small (~5 KiB) tags index before spending a page fetch on paths like /turbo. Only a parsed
    // index with a models array can reject; a failed fetch or malformed payload falls through to the page.
    // Canonical and namespaced URLs fetch tags and page in parallel.
    if (shorthand) {
      const tagsResult = await ctx.loadPage(TAGS_URL, TAGS_OPTIONS)
      const tagsIndex = parseTagsIndex(tagsResult)
      const matchingModels = matchTagsModels(baseRef, tagsIndex)
      if (tagsIndex && matchingModels.length === 0) return null
      // A tagged shorthand names an exact tag; reject when the index lists the model but not the tag.
      const tagRef = modelRef.includes(':') ? modelRef.toLowerCase() : null
      const tagKnown =
        !tagRef || matchingModels.some((model) => (model.model ?? model.name ?? '').toLowerCase() === tagRef)
      if (tagsIndex && !tagKnown) return null
      const pageResult = await ctx.loadPage(pageUrl)
      return renderOllamaModel({ url, modelRef, baseRef, tagsResult, matchingModels, pageResult })
    }

    const [tagsResult, pageResult] = await Promise.all([ctx.loadPage(TAGS_URL, TAGS_OPTIONS), ctx.loadPage(pageUrl)])
    const matchingModels = matchTagsModels(baseRef, parseTagsIndex(tagsResult))
    return renderOllamaModel({ url, modelRef, baseRef, tagsResult, matchingModels, pageResult })
  } catch {}

  return null
}
