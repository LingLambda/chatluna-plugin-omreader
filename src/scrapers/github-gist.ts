// GitHub gists via the GitHub API.
import { fetchGitHubApi } from './github'
import type { Scraper } from './types'

interface GistData {
  description: string | null
  owner?: { login: string }
  created_at: string
  updated_at: string
  files: Record<string, { filename: string; language: string | null; size: number; content: string }>
  html_url: string
}

export const scrapeGitHubGist: Scraper = async (ctx) => {
  try {
    if (ctx.url.hostname !== 'gist.github.com') return null

    // Gist ID is the last path segment: /username/gistId, or just /gistId for anonymous gists
    const parts = ctx.url.pathname.split('/').filter(Boolean)
    if (parts.length === 0) return null

    const gistId = parts[parts.length - 1]
    if (!gistId || !/^[a-f0-9]+$/i.test(gistId)) return null

    const result = await fetchGitHubApi(ctx, `/gists/${gistId}`)
    if (!result.ok || !result.data) return null

    // Shape documented by the GitHub gists API; a malformed body throws below and yields null
    const gist = result.data as GistData
    const files = Object.values(gist.files)
    const owner = gist.owner?.login || 'anonymous'

    let md = `# Gist by ${owner}\n\n`
    if (gist.description) md += `${gist.description}\n\n`
    md += `**Created:** ${gist.created_at} · **Updated:** ${gist.updated_at}\n`
    md += `**Files:** ${files.length}\n\n`

    for (const file of files) {
      const lang = file.language?.toLowerCase() || ''
      md += `---\n\n## ${file.filename}\n\n`
      md += `\`\`\`${lang}\n${file.content}\n\`\`\`\n\n`
    }

    return { content: md, method: 'github-gist', notes: ['Fetched via GitHub API'] }
  } catch {
    ctx.signal.throwIfAborted()
  }

  return null
}
