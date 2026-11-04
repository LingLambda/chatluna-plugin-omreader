// Hugging Face models, datasets, spaces and users via the Hub API.
import type { Scraper } from './types'
import { formatNumber, tryParseJson } from './utils'

interface HfModelData {
  modelId: string
  pipeline_tag?: string
  library_name?: string
  tags?: string[]
  downloads?: number
  likes?: number
  private?: boolean
  gated?: boolean | string
  cardData?: {
    license?: string
    language?: string | string[]
    datasets?: string[]
    metrics?: string[]
  }
}

interface HfDatasetData {
  id: string
  tags?: string[]
  downloads?: number
  likes?: number
  private?: boolean
  gated?: boolean | string
  cardData?: {
    license?: string
    language?: string | string[]
    task_categories?: string[]
    size_categories?: string[]
  }
  description?: string
}

interface HfSpaceData {
  id: string
  author?: string
  title?: string
  sdk?: string
  tags?: string[]
  likes?: number
  private?: boolean
  cardData?: {
    license?: string
    sdk?: string
    app_file?: string
  }
}

interface HfUserData {
  avatarUrl?: string
  fullname?: string
  user?: string
  orgs?: { name: string }[]
  numModels?: number
  numDatasets?: number
  numSpaces?: number
}

const README_TIMEOUT_MS = 5_000

const RESERVED_PATHS: Record<string, true> = {
  docs: true,
  blog: true,
  pricing: true,
  enterprise: true,
  join: true,
  login: true,
  settings: true
}

/**
 * Parses a Hugging Face repo root URL and determines its type. Sub-paths (`/raw/...`, `/resolve/...`,
 * `/blob/...`, `/tree/...`, `/discussions`) return null so the generic fetcher retrieves the actual file/page.
 */
function parseHuggingFaceUrl(parsed: URL): {
  type: 'model' | 'dataset' | 'space' | 'model_or_user'
  /** Full ID (org/name or just name). */
  id: string
} | null {
  if (parsed.hostname !== 'huggingface.co') return null

  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts.length === 0) return null

  // huggingface.co/datasets/{org}/{dataset} or huggingface.co/datasets/{dataset}
  if (parts[0] === 'datasets') {
    if (parts.length !== 2 && parts.length !== 3) return null
    return { type: 'dataset', id: parts.slice(1).join('/') }
  }

  // huggingface.co/spaces/{org}/{space}
  if (parts[0] === 'spaces') {
    if (parts.length !== 3) return null
    return { type: 'space', id: `${parts[1]}/${parts[2]}` }
  }

  if (RESERVED_PATHS[parts[0]!] === true) return null

  // huggingface.co/{org}/{model} (exactly two parts = repo root)
  if (parts.length === 2) return { type: 'model', id: `${parts[0]}/${parts[1]}` }

  // huggingface.co/{id} (single part = could be model or user, try model first)
  if (parts.length === 1) return { type: 'model_or_user', id: parts[0]! }

  return null
}

export const scrapeHuggingFace: Scraper = async (ctx) => {
  const parsed = parseHuggingFaceUrl(ctx.url)
  if (!parsed) return null

  const notes: string[] = []

  try {
    switch (parsed.type) {
      case 'model': {
        const apiUrl = `https://huggingface.co/api/models/${parsed.id}`
        const readmeUrl = `https://huggingface.co/${parsed.id}/raw/main/README.md`

        const [apiResult, readmeResult] = await Promise.all([
          ctx.loadPage(apiUrl),
          ctx.loadPage(readmeUrl, { timeoutMs: README_TIMEOUT_MS })
        ])

        if (!apiResult.ok) return null

        const model = tryParseJson<HfModelData>(apiResult.content)
        if (!model) return null

        let md = `# ${model.modelId}\n\n`

        if (model.pipeline_tag) md += `**Task:** ${model.pipeline_tag}\n`
        if (model.library_name) md += `**Library:** ${model.library_name}\n`
        if (model.downloads !== undefined) md += `**Downloads:** ${formatNumber(model.downloads)}\n`
        if (model.likes !== undefined) md += `**Likes:** ${formatNumber(model.likes)}\n`
        if (model.private) md += `**Visibility:** Private\n`
        if (model.gated) md += `**Access:** Gated\n`

        if (model.cardData) {
          if (model.cardData.license) md += `**License:** ${model.cardData.license}\n`
          if (model.cardData.language) {
            const langs = Array.isArray(model.cardData.language)
              ? model.cardData.language.join(', ')
              : model.cardData.language
            md += `**Language:** ${langs}\n`
          }
          if (model.cardData.datasets?.length) md += `**Datasets:** ${model.cardData.datasets.join(', ')}\n`
          if (model.cardData.metrics?.length) md += `**Metrics:** ${model.cardData.metrics.join(', ')}\n`
        }

        if (model.tags?.length) md += `**Tags:** ${model.tags.join(', ')}\n`

        md += '\n'

        if (readmeResult.ok && readmeResult.content.trim()) md += `## Model Card\n\n${readmeResult.content}`

        return {
          content: md,
          method: 'huggingface',
          finalUrl: apiResult.finalUrl,
          notes,
          truncated: readmeResult.truncated
        }
      }

      case 'dataset': {
        const apiUrl = `https://huggingface.co/api/datasets/${parsed.id}`
        const readmeUrl = `https://huggingface.co/datasets/${parsed.id}/raw/main/README.md`

        const [apiResult, readmeResult] = await Promise.all([
          ctx.loadPage(apiUrl),
          ctx.loadPage(readmeUrl, { timeoutMs: README_TIMEOUT_MS })
        ])

        if (!apiResult.ok) return null

        const dataset = tryParseJson<HfDatasetData>(apiResult.content)
        if (!dataset) return null

        let md = `# ${dataset.id}\n\n`
        if (dataset.description) md += `${dataset.description}\n\n`

        if (dataset.downloads !== undefined) md += `**Downloads:** ${formatNumber(dataset.downloads)}\n`
        if (dataset.likes !== undefined) md += `**Likes:** ${formatNumber(dataset.likes)}\n`
        if (dataset.private) md += `**Visibility:** Private\n`
        if (dataset.gated) md += `**Access:** Gated\n`

        if (dataset.cardData) {
          if (dataset.cardData.license) md += `**License:** ${dataset.cardData.license}\n`
          if (dataset.cardData.language) {
            const langs = Array.isArray(dataset.cardData.language)
              ? dataset.cardData.language.join(', ')
              : dataset.cardData.language
            md += `**Language:** ${langs}\n`
          }
          if (dataset.cardData.task_categories?.length) {
            md += `**Tasks:** ${dataset.cardData.task_categories.join(', ')}\n`
          }
          if (dataset.cardData.size_categories?.length) {
            md += `**Size:** ${dataset.cardData.size_categories.join(', ')}\n`
          }
        }

        if (dataset.tags?.length) md += `**Tags:** ${dataset.tags.join(', ')}\n`

        md += '\n'

        if (readmeResult.ok && readmeResult.content.trim()) md += `## Dataset Card\n\n${readmeResult.content}`

        return {
          content: md,
          method: 'huggingface',
          finalUrl: apiResult.finalUrl,
          notes,
          truncated: readmeResult.truncated
        }
      }

      case 'space': {
        const apiUrl = `https://huggingface.co/api/spaces/${parsed.id}`
        const readmeUrl = `https://huggingface.co/spaces/${parsed.id}/raw/main/README.md`

        const [apiResult, readmeResult] = await Promise.all([
          ctx.loadPage(apiUrl),
          ctx.loadPage(readmeUrl, { timeoutMs: README_TIMEOUT_MS })
        ])

        if (!apiResult.ok) return null

        const space = tryParseJson<HfSpaceData>(apiResult.content)
        if (!space) return null

        let md = `# ${space.id}\n\n`
        if (space.title) md += `${space.title}\n\n`

        if (space.author) md += `**Author:** ${space.author}\n`
        if (space.sdk) md += `**SDK:** ${space.sdk}\n`
        if (space.likes !== undefined) md += `**Likes:** ${formatNumber(space.likes)}\n`
        if (space.private) md += `**Visibility:** Private\n`

        if (space.cardData) {
          if (space.cardData.license) md += `**License:** ${space.cardData.license}\n`
          if (space.cardData.app_file) md += `**App File:** ${space.cardData.app_file}\n`
        }

        if (space.tags?.length) md += `**Tags:** ${space.tags.join(', ')}\n`

        md += '\n'

        if (readmeResult.ok && readmeResult.content.trim()) md += `## Space Info\n\n${readmeResult.content}`

        return {
          content: md,
          method: 'huggingface',
          finalUrl: apiResult.finalUrl,
          notes,
          truncated: readmeResult.truncated
        }
      }

      case 'model_or_user': {
        // Try the model API first
        const modelResult = await ctx.loadPage(`https://huggingface.co/api/models/${parsed.id}`)

        if (modelResult.ok) {
          const model = tryParseJson<HfModelData>(modelResult.content)
          if (model) {
            const readmeUrl = `https://huggingface.co/${parsed.id}/raw/main/README.md`
            const readmeResult = await ctx.loadPage(readmeUrl, { timeoutMs: README_TIMEOUT_MS })

            let md = `# ${model.modelId}\n\n`
            if (model.pipeline_tag) md += `**Task:** ${model.pipeline_tag}\n`
            if (model.library_name) md += `**Library:** ${model.library_name}\n`
            if (model.downloads !== undefined) md += `**Downloads:** ${formatNumber(model.downloads)}\n`
            if (model.likes !== undefined) md += `**Likes:** ${formatNumber(model.likes)}\n`
            if (model.tags?.length) md += `**Tags:** ${model.tags.join(', ')}\n`
            md += '\n'
            if (readmeResult.ok && readmeResult.content.trim()) md += `## Model Card\n\n${readmeResult.content}`

            return {
              content: md,
              method: 'huggingface',
              finalUrl: modelResult.finalUrl,
              notes,
              truncated: readmeResult.truncated
            }
          }
        }

        // Fall back to the user API
        const userResult = await ctx.loadPage(`https://huggingface.co/api/users/${parsed.id}`)
        if (!userResult.ok) return null

        const user = tryParseJson<HfUserData>(userResult.content)
        if (!user) return null

        let md = `# ${user.user || parsed.id}\n\n`
        if (user.fullname) md += `**Name:** ${user.fullname}\n`
        if (user.numModels !== undefined) md += `**Models:** ${formatNumber(user.numModels)}\n`
        if (user.numDatasets !== undefined) md += `**Datasets:** ${formatNumber(user.numDatasets)}\n`
        if (user.numSpaces !== undefined) md += `**Spaces:** ${formatNumber(user.numSpaces)}\n`

        if (user.orgs?.length) md += `**Organizations:** ${user.orgs.map((o) => o.name).join(', ')}\n`

        return { content: md, method: 'huggingface', finalUrl: userResult.finalUrl, notes }
      }

      default:
        return null
    }
  } catch {
    return null
  }
}
