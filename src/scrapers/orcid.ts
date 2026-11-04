// Researcher profiles via the ORCID public API.
import type { Scraper } from './types'
import { tryParseJson } from './utils'

const MAX_WORKS = 50
const ORCID_PATTERN = /\/(\d{4}-\d{4}-\d{4}-\d{3}[\dXx])(?:\/|$)/

interface OrcidName {
  'given-names'?: { value?: string }
  'family-name'?: { value?: string }
  'credit-name'?: { value?: string }
}

interface OrcidBiography {
  content?: string
}

interface OrcidPerson {
  name?: OrcidName
  biography?: OrcidBiography
}

interface OrcidSummaryDate {
  year?: { value?: string }
  month?: { value?: string }
  day?: { value?: string }
}

interface OrcidOrganizationAddress {
  city?: string
  region?: string
  country?: string
}

interface OrcidOrganization {
  name?: string
  address?: OrcidOrganizationAddress
}

interface OrcidAffiliationSummary {
  organization?: OrcidOrganization
  'role-title'?: string
  'department-name'?: string
  'start-date'?: OrcidSummaryDate
  'end-date'?: OrcidSummaryDate
}

interface OrcidAffiliationGroupSummary {
  'employment-summary'?: OrcidAffiliationSummary
  'education-summary'?: OrcidAffiliationSummary
}

interface OrcidAffiliationGroup {
  summaries?: OrcidAffiliationGroupSummary[]
}

interface OrcidAffiliationsContainer {
  'affiliation-group'?: OrcidAffiliationGroup[]
  'employment-summary'?: OrcidAffiliationSummary[]
  'education-summary'?: OrcidAffiliationSummary[]
}

interface OrcidWorkTitle {
  title?: { value?: string }
}

interface OrcidWorkSummary {
  title?: OrcidWorkTitle
}

interface OrcidWorkGroup {
  'work-summary'?: OrcidWorkSummary[]
}

interface OrcidWorksContainer {
  group?: OrcidWorkGroup[]
}

interface OrcidActivitiesSummary {
  employments?: OrcidAffiliationsContainer
  educations?: OrcidAffiliationsContainer
  works?: OrcidWorksContainer
}

interface OrcidRecord {
  'orcid-identifier'?: { path?: string; uri?: string }
  person?: OrcidPerson
  'activities-summary'?: OrcidActivitiesSummary
}

function formatName(name?: OrcidName): string | null {
  const credit = name?.['credit-name']?.value?.trim()
  if (credit) return credit

  const given = name?.['given-names']?.value?.trim()
  const family = name?.['family-name']?.value?.trim()
  if (given && family) return `${given} ${family}`
  return given || family || null
}

function formatDate(date?: OrcidSummaryDate): string | null {
  const year = date?.year?.value
  if (!year) return null

  const month = date?.month?.value
  const day = date?.day?.value
  if (month && day) return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  if (month) return `${year}-${month.padStart(2, '0')}`
  return year
}

function collectAffiliations(
  container: OrcidAffiliationsContainer | undefined,
  key: 'employment-summary' | 'education-summary'
): OrcidAffiliationSummary[] {
  const summaries: OrcidAffiliationSummary[] = []
  if (!container) return summaries

  const direct = container[key]
  if (direct?.length) summaries.push(...direct)

  for (const group of container['affiliation-group'] ?? []) {
    for (const summary of group.summaries || []) {
      const entry = summary[key]
      if (entry) summaries.push(entry)
    }
  }

  return summaries
}

function formatAffiliation(summary: OrcidAffiliationSummary): string | null {
  const organization = summary.organization?.name?.trim()
  const role = summary['role-title']?.trim()
  const department = summary['department-name']?.trim()

  const address = summary.organization?.address
  const locationParts = [address?.city, address?.region, address?.country].filter(Boolean) as string[]
  const location = locationParts.length > 0 ? locationParts.join(', ') : null

  const start = formatDate(summary['start-date'])
  const end = formatDate(summary['end-date'])
  let dates: string | null = null
  if (start && end) dates = `${start} - ${end}`
  else if (start) dates = `${start} - Present`
  else if (end) dates = `Until ${end}`

  const label = organization || role || department
  if (!label) return null

  const details: string[] = []
  if (organization && role) details.push(role)
  if (!organization && role && department) details.push(department)
  if (organization && department) details.push(`Dept: ${department}`)
  if (location) details.push(`Location: ${location}`)
  if (dates) details.push(`Dates: ${dates}`)

  if (details.length === 0) return label
  return `${label} (${details.join('; ')})`
}

function collectWorkTitles(container: OrcidWorksContainer | undefined): string[] {
  const titles: string[] = []
  const seen = new Set<string>()

  for (const group of container?.group || []) {
    for (const summary of group['work-summary'] || []) {
      const title = summary.title?.title?.value?.trim()
      if (!title || seen.has(title)) continue
      seen.add(title)
      titles.push(title)
      if (titles.length >= MAX_WORKS) return titles
    }
  }

  return titles
}

export const scrapeOrcid: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'orcid.org' && parsed.hostname !== 'www.orcid.org') return null

    const orcid = parsed.pathname.match(ORCID_PATTERN)?.[1]
    if (!orcid) return null

    const result = await ctx.loadPage(`https://pub.orcid.org/v3.0/${orcid}/record`, {
      headers: { Accept: 'application/json' }
    })
    if (!result.ok || !result.content) return null

    const record = tryParseJson<OrcidRecord>(result.content)
    if (!record) return null

    const personName = formatName(record.person?.name)
    const biography = record.person?.biography?.content?.trim()

    const activities = record['activities-summary']
    const employments = collectAffiliations(activities?.employments, 'employment-summary')
    const educations = collectAffiliations(activities?.educations, 'education-summary')
    const works = collectWorkTitles(activities?.works)

    let md = `# ${personName || 'ORCID Profile'}\n\n`
    md += `**ORCID:** ${orcid}\n`
    md += `**ORCID Profile:** https://orcid.org/${orcid}\n\n`

    md += '## Biography\n\n'
    md += biography ? `${biography}\n\n` : 'No biography available.\n\n'

    md += '## Affiliations\n\n'

    if (employments.length > 0) {
      md += '### Employment\n\n'
      for (const summary of employments) {
        const line = formatAffiliation(summary)
        if (line) md += `- ${line}\n`
      }
      md += '\n'
    }

    if (educations.length > 0) {
      md += '### Education\n\n'
      for (const summary of educations) {
        const line = formatAffiliation(summary)
        if (line) md += `- ${line}\n`
      }
      md += '\n'
    }

    if (employments.length === 0 && educations.length === 0) md += 'No affiliations available.\n\n'

    md += '## Works\n\n'
    if (works.length > 0) {
      for (const title of works) md += `- ${title}\n`
    } else {
      md += 'No works available.\n'
    }

    return { content: md, method: 'orcid-api', notes: ['Fetched via ORCID Public API'] }
  } catch {
    return null
  }
}
