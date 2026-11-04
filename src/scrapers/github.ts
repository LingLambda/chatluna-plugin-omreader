// GitHub repos, blobs, trees, commits, issues, PRs and Actions runs/jobs via the API.
import type { ScrapeContext, Scraper } from './types'
import { asRecord, formatMediaDuration, tryParseJson } from './utils'

const USER_AGENT = 'chatluna-plugin-omreader'

interface GitHubUrl {
  type:
    | 'blob'
    | 'tree'
    | 'repo'
    | 'commit'
    | 'issue'
    | 'issues'
    | 'pull'
    | 'pulls'
    | 'discussion'
    | 'discussions'
    | 'actions-run'
    | 'actions-job'
    | 'other'
  owner: string
  repo: string
  ref?: string
  path?: string
  number?: number
  runId?: number
  jobId?: number
}

interface GitHubIssueComment {
  user: { login: string } | null
  created_at: string
  body: string
}

/** Parse a github.com URL into components. */
export function parseGitHubUrl(parsed: URL): GitHubUrl | null {
  if (parsed.hostname !== 'github.com') return null

  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null

  const [owner, repo, ...rest] = parts as [string, string, ...string[]]

  if (rest.length === 0) {
    return { type: 'repo', owner, repo }
  }

  const [section, ...subParts] = rest

  switch (section) {
    case 'blob':
    case 'tree': {
      const [ref, ...pathParts] = subParts
      return { type: section, owner, repo, ref, path: pathParts.join('/') }
    }
    case 'commit':
      if (subParts.length > 0 && subParts[0]) {
        return { type: 'commit', owner, repo, ref: subParts[0] }
      }
      return { type: 'other', owner, repo }
    case 'issues':
      if (subParts.length > 0 && /^\d+$/.test(subParts[0] ?? '')) {
        return { type: 'issue', owner, repo, number: parseInt(subParts[0] ?? '', 10) }
      }
      return { type: 'issues', owner, repo }
    case 'pull':
      if (subParts.length > 0 && /^\d+$/.test(subParts[0] ?? '')) {
        return { type: 'pull', owner, repo, number: parseInt(subParts[0] ?? '', 10) }
      }
      return { type: 'pulls', owner, repo }
    case 'pulls':
      return { type: 'pulls', owner, repo }
    case 'actions': {
      // /actions/runs/{runId}                → run summary + jobs
      // /actions/runs/{runId}/job/{jobId}    → single job (web URL uses singular "job")
      // /actions/runs/{runId}/jobs/{jobId}   → single job (API-style plural)
      if (subParts[0] === 'runs' && /^\d+$/.test(subParts[1] ?? '')) {
        const runId = parseInt(subParts[1] ?? '', 10)
        const seg = subParts[2]
        if ((seg === 'job' || seg === 'jobs') && /^\d+$/.test(subParts[3] ?? '')) {
          return { type: 'actions-job', owner, repo, runId, jobId: parseInt(subParts[3] ?? '', 10) }
        }
        return { type: 'actions-run', owner, repo, runId }
      }
      return { type: 'other', owner, repo }
    }
    case 'discussions':
      if (subParts.length > 0 && /^\d+$/.test(subParts[0] ?? '')) {
        return { type: 'discussion', owner, repo, number: parseInt(subParts[0] ?? '', 10) }
      }
      return { type: 'discussions', owner, repo }
    default:
      return { type: 'other', owner, repo }
  }
}

/** Blob URL → raw.githubusercontent.com URL. */
function toRawGitHubUrl(gh: GitHubUrl): string {
  return `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.ref}/${gh.path}`
}

/** GET a GitHub REST endpoint as JSON; `ok: false` on any HTTP, parse or policy failure (aborts rethrow). */
export async function fetchGitHubApi(ctx: ScrapeContext, endpoint: string): Promise<{ data: unknown; ok: boolean }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': USER_AGENT
  }
  if (ctx.githubToken) {
    headers.Authorization = `Bearer ${ctx.githubToken}`
  }

  try {
    const result = await ctx.loadPage(`https://api.github.com${endpoint}`, { headers })
    if (!result.ok) return { data: null, ok: false }
    const data = tryParseJson(result.content)
    if (data === null) return { data: null, ok: false }
    return { data, ok: true }
  } catch {
    ctx.signal.throwIfAborted()
    return { data: null, ok: false }
  }
}

/** Fetch all issue comments with pagination. */
async function fetchGitHubIssueComments(
  ctx: ScrapeContext,
  owner: string,
  repo: string,
  issueNumber: number,
  expectedCount: number
): Promise<GitHubIssueComment[]> {
  const perPage = 100
  const comments: GitHubIssueComment[] = []

  for (let page = 1; comments.length < expectedCount; page++) {
    const result = await fetchGitHubApi(
      ctx,
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`
    )
    if (!result.ok || !Array.isArray(result.data)) {
      break
    }

    const pageComments = result.data as GitHubIssueComment[]
    if (pageComments.length === 0) {
      break
    }

    comments.push(...pageComments)
    if (pageComments.length < perPage) {
      break
    }
  }

  return comments
}

/** Render a GitHub issue/PR to markdown. */
async function renderGitHubIssue(ctx: ScrapeContext, gh: GitHubUrl): Promise<{ content: string; ok: boolean }> {
  const endpoint =
    gh.type === 'pull'
      ? `/repos/${gh.owner}/${gh.repo}/pulls/${gh.number}`
      : `/repos/${gh.owner}/${gh.repo}/issues/${gh.number}`

  const result = await fetchGitHubApi(ctx, endpoint)
  if (!result.ok || !result.data) return { content: '', ok: false }

  const issue = result.data as {
    title: string
    number: number
    state: string
    user: { login: string } | null
    created_at: string
    updated_at: string
    body: string | null
    labels: { name: string }[]
    comments: number
    html_url: string
  }

  let md = `# ${issue.title}\n\n`
  md += `**#${issue.number}** · ${issue.state} · opened by @${issue.user?.login ?? 'ghost'}\n`
  md += `Created: ${issue.created_at} · Updated: ${issue.updated_at}\n`
  if (issue.labels.length > 0) {
    md += `Labels: ${issue.labels.map((l) => l.name).join(', ')}\n`
  }
  md += `\n---\n\n`
  md += issue.body || '*No description provided.*'
  md += `\n\n---\n\n`

  // Fetch comments if any
  if (issue.comments > 0) {
    const comments = await fetchGitHubIssueComments(ctx, gh.owner, gh.repo, issue.number, issue.comments)
    if (comments.length > 0) {
      const commentCount =
        issue.comments > comments.length ? `${comments.length} of ${issue.comments}` : `${comments.length}`
      md += `## Comments (${commentCount})\n\n`
      for (const comment of comments) {
        md += `### @${comment.user?.login ?? 'ghost'} · ${comment.created_at}\n\n`
        md += `${comment.body}\n\n---\n\n`
      }
    }
  }

  return { content: md, ok: true }
}

interface GitHubCommitFile {
  filename: string
  status: string
  additions: number
  deletions: number
  changes: number
  patch?: string
  previous_filename?: string
}

/**
 * Render a commit (metadata, message, per-file diff). The commits API returns the unified diff inline
 * via `files[].patch`; binary files have no `patch` and are flagged instead.
 */
async function renderGitHubCommit(ctx: ScrapeContext, gh: GitHubUrl): Promise<{ content: string; ok: boolean }> {
  const result = await fetchGitHubApi(ctx, `/repos/${gh.owner}/${gh.repo}/commits/${gh.ref}`)
  if (!result.ok || !result.data) return { content: '', ok: false }

  const commit = result.data as {
    sha: string
    html_url: string
    commit: {
      author?: { name?: string; date?: string } | null
      committer?: { name?: string; date?: string } | null
      message: string
    }
    author?: { login: string } | null
    committer?: { login: string } | null
    parents?: { sha: string }[]
    stats?: { total?: number; additions?: number; deletions?: number }
    files?: GitHubCommitFile[]
  }

  const message = commit.commit.message ?? ''
  const [subject, ...bodyLines] = message.split('\n')
  const authorName = commit.author?.login ? `@${commit.author.login}` : (commit.commit.author?.name ?? 'unknown')
  const authoredAt = commit.commit.author?.date ?? ''

  let md = `# ${subject || commit.sha.slice(0, 7)}\n\n`
  md += `**${commit.sha.slice(0, 12)}** · authored by ${authorName}`
  if (authoredAt) md += ` · ${authoredAt}`
  md += `\n`
  if (commit.stats) {
    const { additions = 0, deletions = 0 } = commit.stats
    const fileCount = commit.files?.length ?? 0
    md += `${fileCount} file${fileCount === 1 ? '' : 's'} changed · +${additions} −${deletions}\n`
  }
  if (commit.parents && commit.parents.length > 0) {
    md += `Parents: ${commit.parents.map((p) => p.sha.slice(0, 12)).join(', ')}\n`
  }

  const body = bodyLines.join('\n').trim()
  if (body) {
    md += `\n${body}\n`
  }

  const files = commit.files ?? []
  if (files.length > 0) {
    md += `\n---\n\n## Files (${files.length})\n\n`
    for (const file of files) {
      const name = file.previous_filename ? `${file.previous_filename} → ${file.filename}` : file.filename
      md += `### ${name}\n\n`
      md += `${file.status} · +${file.additions} −${file.deletions}\n\n`
      if (file.patch) {
        md += `\`\`\`diff\n${file.patch}\n\`\`\`\n\n`
      } else {
        md += `*No textual diff (binary or too large).*\n\n`
      }
    }
  }

  return { content: md, ok: true }
}

/** Render the open-issues list to markdown. */
async function renderGitHubIssuesList(ctx: ScrapeContext, gh: GitHubUrl): Promise<{ content: string; ok: boolean }> {
  const result = await fetchGitHubApi(ctx, `/repos/${gh.owner}/${gh.repo}/issues?state=open&per_page=30`)
  if (!result.ok || !Array.isArray(result.data)) return { content: '', ok: false }

  const issues = result.data as {
    number: number
    title: string
    state: string
    user: { login: string } | null
    created_at: string
    comments: number
    labels: { name: string }[]
    pull_request?: unknown
  }[]

  let md = `# ${gh.owner}/${gh.repo} - Open Issues\n\n`

  for (const issue of issues) {
    if (issue.pull_request) continue // Skip PRs in issues list
    const labels = issue.labels.length > 0 ? ` [${issue.labels.map((l) => l.name).join(', ')}]` : ''
    md += `- **#${issue.number}** ${issue.title}${labels}\n`
    md += `  by @${issue.user?.login ?? 'ghost'} · ${issue.comments} comments · ${issue.created_at}\n\n`
  }

  return { content: md, ok: true }
}

/** Render a tree (directory) listing plus its README. */
async function renderGitHubTree(ctx: ScrapeContext, gh: GitHubUrl): Promise<{ content: string; ok: boolean }> {
  // Repo info first: the default branch fills in a missing ref
  const repoResult = await fetchGitHubApi(ctx, `/repos/${gh.owner}/${gh.repo}`)
  if (!repoResult.ok) return { content: '', ok: false }

  const repo = repoResult.data as {
    full_name: string
    default_branch: string
  }

  const ref = gh.ref || repo.default_branch
  const dirPath = gh.path || ''

  let md = `# ${repo.full_name}/${dirPath || '(root)'}\n\n`
  md += `**Branch:** ${ref}\n\n`

  const contentsResult = await fetchGitHubApi(ctx, `/repos/${gh.owner}/${gh.repo}/contents/${dirPath}?ref=${ref}`)

  if (contentsResult.ok && Array.isArray(contentsResult.data)) {
    const items = contentsResult.data as {
      name: string
      type: 'file' | 'dir' | 'symlink' | 'submodule'
      size?: number
      path: string
    }[]

    // Directories first, then files, alphabetically
    items.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1
      if (a.type !== 'dir' && b.type === 'dir') return 1
      return a.name.localeCompare(b.name)
    })

    md += `## Contents\n\n`
    md += '```\n'
    for (const item of items) {
      const prefix = item.type === 'dir' ? '[dir] ' : '      '
      const size = item.size ? ` (${item.size} bytes)` : ''
      md += `${prefix}${item.name}${item.type === 'file' ? size : ''}\n`
    }
    md += '```\n\n'

    // README in this directory
    const readmeFile = items.find((item) => item.type === 'file' && /^readme\.md$/i.test(item.name))
    if (readmeFile) {
      const readmePath = dirPath ? `${dirPath}/${readmeFile.name}` : readmeFile.name
      const rawUrl = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${ref}/${readmePath}`
      const readmeResult = await ctx.loadPage(rawUrl)
      if (readmeResult.ok) {
        md += `---\n\n## README\n\n${readmeResult.content}`
      }
    }
  }

  return { content: md, ok: true }
}

/** Render a repo (metadata, file list, README). */
async function renderGitHubRepo(ctx: ScrapeContext, gh: GitHubUrl): Promise<{ content: string; ok: boolean }> {
  // Independent requests: `HEAD` resolves to the default branch, so the tree need not wait for `default_branch`
  const [repoResult, treeResult, readmeResult] = await Promise.all([
    fetchGitHubApi(ctx, `/repos/${gh.owner}/${gh.repo}`),
    fetchGitHubApi(ctx, `/repos/${gh.owner}/${gh.repo}/git/trees/HEAD?recursive=1`),
    fetchGitHubApi(ctx, `/repos/${gh.owner}/${gh.repo}/readme`)
  ])
  if (!repoResult.ok) return { content: '', ok: false }

  const repo = repoResult.data as {
    full_name: string
    description: string | null
    stargazers_count: number
    forks_count: number
    open_issues_count: number
    language: string | null
    license: { name: string } | null
  }

  let md = `# ${repo.full_name}\n\n`
  if (repo.description) md += `${repo.description}\n\n`
  md += `Stars: ${repo.stargazers_count} · Forks: ${repo.forks_count} · Issues: ${repo.open_issues_count}\n`
  if (repo.language) md += `Language: ${repo.language}\n`
  if (repo.license) md += `License: ${repo.license.name}\n`
  md += `\n---\n\n`

  // File tree
  const treeItems = asRecord(treeResult.data)?.tree
  if (treeResult.ok && Array.isArray(treeItems)) {
    const tree: { path: string; type: string }[] = treeItems
    md += `## Files\n\n`
    md += '```\n'
    for (const item of tree.slice(0, 100)) {
      const prefix = item.type === 'tree' ? '[dir] ' : '      '
      md += `${prefix}${item.path}\n`
    }
    if (tree.length > 100) {
      md += `[…${tree.length - 100} files elided…]\n`
    }
    md += '```\n\n'
  }

  // README
  if (readmeResult.ok && readmeResult.data) {
    const readme = readmeResult.data as { content: string; encoding: string }
    if (readme.encoding === 'base64') {
      const decoded = Buffer.from(readme.content, 'base64').toString('utf-8')
      md += `## README\n\n${decoded}`
    }
  }

  return { content: md, ok: true }
}

interface GitHubActionsStep {
  name: string
  status: string
  conclusion: string | null
  number: number
  started_at: string | null
  completed_at: string | null
}

interface GitHubActionsJob {
  id: number
  run_id: number
  name: string
  status: string
  conclusion: string | null
  started_at: string | null
  completed_at: string | null
  html_url: string | null
  steps?: GitHubActionsStep[]
  runner_name?: string | null
  labels?: string[]
  workflow_name?: string | null
  head_branch?: string | null
  head_sha?: string
}

interface GitHubActionsRun {
  id: number
  name?: string | null
  display_title?: string
  run_number: number
  run_attempt?: number
  event: string
  status: string
  conclusion: string | null
  head_branch?: string | null
  head_sha?: string
  html_url: string
  created_at: string
  updated_at: string
  run_started_at?: string
  actor?: { login: string }
  triggering_actor?: { login: string }
}

/** Status + conclusion as one label, e.g. `completed (failure)`. */
function statusLabel(status: string, conclusion: string | null | undefined): string {
  return conclusion ? `${status} (${conclusion})` : status
}

/** Wall-clock duration between two ISO timestamps (H:MM:SS / M:SS); empty when unknown. */
function actionDuration(start?: string | null, end?: string | null): string {
  if (!start || !end) return ''
  const ms = Date.parse(end) - Date.parse(start)
  if (!Number.isFinite(ms) || ms < 0) return ''
  return formatMediaDuration(Math.round(ms / 1000))
}

/** Escape `|` so step/job names can't break a markdown table row. */
function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|')
}

/**
 * Strip the ISO-8601 timestamp GitHub prefixes to every job log line, and the leading UTF-8 BOM
 * (otherwise the first line's timestamp survives because `^` no longer sits before a digit).
 */
export function stripActionsLogTimestamps(logs: string): string {
  return logs.replace(/^\uFEFF/, '').replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm, '')
}

/** A job's steps as a markdown table; empty string when there are none. */
function renderActionsSteps(steps?: GitHubActionsStep[]): string {
  if (!steps || steps.length === 0) return ''
  let md = '| # | Step | Status | Conclusion | Duration |\n'
  md += '|---|------|--------|------------|----------|\n'
  for (const step of steps) {
    const dur = actionDuration(step.started_at, step.completed_at) || '-'
    md += `| ${step.number} | ${escapeCell(step.name)} | ${step.status} | ${step.conclusion ?? '-'} | ${dur} |\n`
  }
  return `${md}\n`
}

/** Run-level metadata lines shared by the run and job renderers. */
function renderActionsRunMeta(run: GitHubActionsRun): string {
  let md = `**Workflow:** ${run.name ?? '(unknown)'}\n`
  md += `**Run:** #${run.run_number}`
  if (run.run_attempt && run.run_attempt > 1) md += ` (attempt ${run.run_attempt})`
  md += ` · ${statusLabel(run.status, run.conclusion)}\n`
  if (run.head_branch) {
    md += `**Branch:** ${run.head_branch}${run.head_sha ? ` @ ${run.head_sha.slice(0, 7)}` : ''}\n`
  }
  const actor = run.triggering_actor?.login ?? run.actor?.login
  md += `**Event:** ${run.event}${actor ? ` · by @${actor}` : ''}\n`
  const started = run.run_started_at ?? run.created_at
  const dur = actionDuration(started, run.updated_at)
  md += `Started: ${started}${dur ? ` · Duration: ${dur}` : ''}\n`
  md += `URL: ${run.html_url}\n`
  return md
}

/** A job's plain-text logs; null when unavailable (no token / expired / private). */
async function fetchGitHubJobLogs(
  ctx: ScrapeContext,
  owner: string,
  repo: string,
  jobId: number
): Promise<{ content: string; truncated: boolean } | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (ctx.githubToken) headers.Authorization = `Bearer ${ctx.githubToken}`

  // 302 → signed log URL on another origin; the loader drops Authorization on the cross-origin hop
  const result = await ctx.loadPage(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
    headers
  })
  return result.ok && result.content ? { content: result.content, truncated: Boolean(result.truncated) } : null
}

/** A workflow run: metadata plus per-job breakdown; steps are listed only for jobs that did not succeed. */
async function renderGitHubActionsRun(ctx: ScrapeContext, gh: GitHubUrl): Promise<{ content: string; ok: boolean }> {
  const [runResult, jobsResult] = await Promise.all([
    fetchGitHubApi(ctx, `/repos/${gh.owner}/${gh.repo}/actions/runs/${gh.runId}`),
    fetchGitHubApi(ctx, `/repos/${gh.owner}/${gh.repo}/actions/runs/${gh.runId}/jobs?per_page=100`)
  ])
  if (!runResult.ok || !runResult.data) return { content: '', ok: false }

  const run = runResult.data as GitHubActionsRun
  let md = `# ${run.display_title || run.name || `Run #${run.run_number}`}\n\n`
  md += renderActionsRunMeta(run)
  md += `\n---\n\n`

  if (jobsResult.ok && jobsResult.data) {
    const jobsData = asRecord(jobsResult.data)?.jobs
    const jobs: GitHubActionsJob[] = Array.isArray(jobsData) ? jobsData : []
    md += `## Jobs (${jobs.length})\n\n`
    for (const job of jobs) {
      const dur = actionDuration(job.started_at, job.completed_at)
      md += `### ${escapeCell(job.name)} — ${statusLabel(job.status, job.conclusion)}${dur ? ` (${dur})` : ''}\n\n`
      if (job.conclusion !== 'success') {
        md += renderActionsSteps(job.steps)
      }
    }
  }

  return { content: md, ok: true }
}

/** A single workflow job: run context, step table and the full job logs. */
async function renderGitHubActionsJob(
  ctx: ScrapeContext,
  gh: GitHubUrl
): Promise<{ content: string; ok: boolean; truncated?: boolean }> {
  // The URL already names the run, so its context loads alongside the job
  const runEndpoint = (runId: number | undefined) => `/repos/${gh.owner}/${gh.repo}/actions/runs/${runId}`
  const [jobResult, urlRunResult] = await Promise.all([
    fetchGitHubApi(ctx, `/repos/${gh.owner}/${gh.repo}/actions/jobs/${gh.jobId}`),
    fetchGitHubApi(ctx, runEndpoint(gh.runId))
  ])
  if (!jobResult.ok || !jobResult.data) return { content: '', ok: false }

  const job = jobResult.data as GitHubActionsJob

  // Best-effort run context for nicer headers; the job render stands on its own without it
  const runResult = job.run_id === gh.runId ? urlRunResult : await fetchGitHubApi(ctx, runEndpoint(job.run_id))
  const run = runResult.ok && runResult.data ? (runResult.data as GitHubActionsRun) : null

  let md = `# ${escapeCell(job.name)}\n\n`
  if (run) {
    md += renderActionsRunMeta(run)
  } else if (job.workflow_name) {
    md += `**Workflow:** ${job.workflow_name}\n`
    if (job.head_branch) md += `**Branch:** ${job.head_branch}\n`
  }
  const dur = actionDuration(job.started_at, job.completed_at)
  md += `**Job:** ${escapeCell(job.name)} · ${statusLabel(job.status, job.conclusion)}${dur ? ` · ${dur}` : ''}\n`
  if (job.runner_name) md += `**Runner:** ${job.runner_name}\n`
  if (job.html_url) md += `URL: ${job.html_url}\n`
  md += `\n---\n\n`

  const steps = renderActionsSteps(job.steps)
  if (steps) md += `## Steps\n\n${steps}`

  const logs = await fetchGitHubJobLogs(ctx, gh.owner, gh.repo, job.id)
  md += `## Logs\n\n`
  md += logs
    ? stripActionsLogTimestamps(logs.content)
    : "*Logs unavailable — requires the omreader `githubToken` setting with read access, or the run's logs have expired.*\n"

  return { content: md, ok: true, truncated: logs?.truncated }
}

export const scrapeGitHub: Scraper = async (ctx) => {
  const gh = parseGitHubUrl(ctx.url)
  if (!gh) return null

  const notes: string[] = []

  switch (gh.type) {
    case 'blob': {
      const rawUrl = toRawGitHubUrl(gh)
      notes.push(`Fetched raw: ${rawUrl}`)
      const result = await ctx.loadPage(rawUrl)
      if (result.ok) {
        return {
          content: result.content,
          method: 'github-raw',
          finalUrl: rawUrl,
          notes,
          contentType: 'text/plain',
          truncated: result.truncated
        }
      }
      break
    }

    case 'tree': {
      notes.push(`Fetched via GitHub API`)
      const result = await renderGitHubTree(ctx, gh)
      if (result.ok) return { content: result.content, method: 'github-tree', notes }
      break
    }

    case 'commit': {
      notes.push(`Fetched via GitHub API`)
      const result = await renderGitHubCommit(ctx, gh)
      if (result.ok) return { content: result.content, method: 'github-commit', notes }
      break
    }

    case 'issue':
    case 'pull': {
      notes.push(`Fetched via GitHub API`)
      const result = await renderGitHubIssue(ctx, gh)
      if (result.ok) {
        return { content: result.content, method: gh.type === 'pull' ? 'github-pr' : 'github-issue', notes }
      }
      break
    }

    case 'issues': {
      notes.push(`Fetched via GitHub API`)
      const result = await renderGitHubIssuesList(ctx, gh)
      if (result.ok) return { content: result.content, method: 'github-issues', notes }
      break
    }

    case 'repo': {
      notes.push(`Fetched via GitHub API`)
      const result = await renderGitHubRepo(ctx, gh)
      if (result.ok) return { content: result.content, method: 'github-repo', notes }
      break
    }

    case 'actions-run': {
      notes.push(`Fetched via GitHub API`)
      const result = await renderGitHubActionsRun(ctx, gh)
      if (result.ok) return { content: result.content, method: 'github-actions-run', notes }
      break
    }

    case 'actions-job': {
      notes.push(`Fetched via GitHub API`)
      const result = await renderGitHubActionsJob(ctx, gh)
      if (result.ok) {
        return { content: result.content, method: 'github-actions-job', notes, truncated: result.truncated }
      }
      break
    }
  }

  // Anything else (pulls list, discussions, other sections) falls through to generic rendering
  return null
}
