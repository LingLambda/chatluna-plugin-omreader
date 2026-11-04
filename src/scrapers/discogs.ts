// Discogs releases and masters via the Discogs API (https://www.discogs.com/developers).
import type { Scraper } from './types'
import { tryParseJson } from './utils'

interface DiscogsArtist {
  name: string
  /** Artist name variation. */
  anv?: string
  role?: string
  join?: string
}

interface DiscogsTrack {
  position: string
  title: string
  duration?: string
  artists?: DiscogsArtist[]
  extraartists?: DiscogsArtist[]
}

interface DiscogsLabel {
  name: string
  /** Catalog number. */
  catno?: string
}

interface DiscogsFormat {
  name: string
  qty?: string
  descriptions?: string[]
}

interface DiscogsRelease {
  id: number
  title: string
  artists?: DiscogsArtist[]
  year?: number
  released?: string
  country?: string
  genres?: string[]
  styles?: string[]
  labels?: DiscogsLabel[]
  formats?: DiscogsFormat[]
  tracklist?: DiscogsTrack[]
  extraartists?: DiscogsArtist[]
  notes?: string
  uri?: string
  master_id?: number
  master_url?: string
}

interface DiscogsMaster {
  id: number
  title: string
  artists?: DiscogsArtist[]
  year?: number
  genres?: string[]
  styles?: string[]
  tracklist?: DiscogsTrack[]
  notes?: string
  uri?: string
  main_release?: number
  main_release_url?: string
  versions_url?: string
  num_for_sale?: number
  lowest_price?: number
}

/** Artist names, preferring name variations. */
function formatArtists(artists: DiscogsArtist[] | undefined): string {
  if (!artists?.length) return 'Unknown Artist'
  return artists
    .map((a) => {
      const name = a.anv || a.name
      const join = a.join || ', '
      return name + (a.join ? ` ${join} ` : '')
    })
    .join('')
    .replace(/[,&]\s*$/, '')
    .trim()
}

function formatTrack(track: DiscogsTrack): string {
  let line = track.position ? `${track.position}. ` : '- '
  line += track.title
  if (track.duration) line += ` (${track.duration})`
  if (track.artists?.length) line += ` - ${formatArtists(track.artists)}`
  return line
}

/** Credits grouped by role. */
function formatCredits(extraartists: DiscogsArtist[] | undefined): string {
  if (!extraartists?.length) return ''

  const byRole: Record<string, string[]> = {}
  for (const artist of extraartists) {
    const role = artist.role || 'Other'
    ;(byRole[role] ??= []).push(artist.anv || artist.name)
  }

  const lines: string[] = []
  for (const [role, names] of Object.entries(byRole)) {
    lines.push(`- **${role}**: ${names.join(', ')}`)
  }
  return lines.join('\n')
}

/** Formats such as "2×LP, Album, Reissue". */
function formatFormats(formats: DiscogsFormat[] | undefined): string {
  if (!formats?.length) return ''

  return formats
    .map((f) => {
      const parts: string[] = []
      if (f.qty && Number.parseInt(f.qty, 10) > 1) parts.push(`${f.qty}×`)
      parts.push(f.name)
      if (f.descriptions?.length) parts.push(f.descriptions.join(', '))
      return parts.join(' ')
    })
    .join(' + ')
}

/** Labels with catalog numbers. */
function formatLabels(labels: DiscogsLabel[] | undefined): string {
  if (!labels?.length) return ''
  return labels
    .map((l) => {
      if (l.catno && l.catno !== 'none') return `${l.name} (${l.catno})`
      return l.name
    })
    .join(', ')
}

function buildReleaseMarkdown(release: DiscogsRelease): string {
  const sections: string[] = []

  const artist = formatArtists(release.artists)
  sections.push(`# ${artist} - ${release.title}\n`)

  const meta: string[] = []
  if (release.year) meta.push(`**Year**: ${release.year}`)
  if (release.country) meta.push(`**Country**: ${release.country}`)

  const format = formatFormats(release.formats)
  if (format) meta.push(`**Format**: ${format}`)

  const labels = formatLabels(release.labels)
  if (labels) meta.push(`**Label**: ${labels}`)

  if (release.genres?.length) meta.push(`**Genre**: ${release.genres.join(', ')}`)
  if (release.styles?.length) meta.push(`**Style**: ${release.styles.join(', ')}`)

  if (release.master_id) {
    meta.push(`**Master Release**: [${release.master_id}](https://www.discogs.com/master/${release.master_id})`)
  }

  if (meta.length) sections.push(`${meta.join('\n')}\n`)

  if (release.tracklist?.length) {
    sections.push('## Tracklist\n')
    sections.push(`${release.tracklist.map(formatTrack).join('\n')}\n`)
  }

  const credits = formatCredits(release.extraartists)
  if (credits) {
    sections.push('## Credits\n')
    sections.push(`${credits}\n`)
  }

  if (release.notes) {
    sections.push('## Notes\n')
    sections.push(`${release.notes}\n`)
  }

  return sections.join('\n')
}

function buildMasterMarkdown(master: DiscogsMaster): string {
  const sections: string[] = []

  const artist = formatArtists(master.artists)
  sections.push(`# ${artist} - ${master.title}\n`)
  sections.push('*Master Release*\n')

  const meta: string[] = []
  if (master.year) meta.push(`**Year**: ${master.year}`)
  if (master.genres?.length) meta.push(`**Genre**: ${master.genres.join(', ')}`)
  if (master.styles?.length) meta.push(`**Style**: ${master.styles.join(', ')}`)

  if (master.main_release) {
    meta.push(`**Main Release**: [${master.main_release}](https://www.discogs.com/release/${master.main_release})`)
  }

  if (master.num_for_sale !== undefined && master.num_for_sale > 0) {
    meta.push(`**For Sale**: ${master.num_for_sale} copies`)
    if (master.lowest_price !== undefined) meta.push(`**Lowest Price**: $${master.lowest_price.toFixed(2)}`)
  }

  if (meta.length) sections.push(`${meta.join('\n')}\n`)

  if (master.tracklist?.length) {
    sections.push('## Tracklist\n')
    sections.push(`${master.tracklist.map(formatTrack).join('\n')}\n`)
  }

  if (master.notes) {
    sections.push('## Notes\n')
    sections.push(`${master.notes}\n`)
  }

  return sections.join('\n')
}

export const scrapeDiscogs: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (!parsed.hostname.includes('discogs.com')) return null

    // /release/{id} or /master/{id}, optionally followed by -Artist-Title
    const releaseMatch = parsed.pathname.match(/\/release\/(\d+)/)
    const masterMatch = parsed.pathname.match(/\/master\/(\d+)/)
    const id = releaseMatch?.[1] ?? masterMatch?.[1]
    if (!id) return null

    const isRelease = !!releaseMatch
    const apiUrl = isRelease ? `https://api.discogs.com/releases/${id}` : `https://api.discogs.com/masters/${id}`

    const result = await ctx.loadPage(apiUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'chatluna-plugin-omreader'
      }
    })

    if (!result.ok) return null

    let md: string
    if (isRelease) {
      const release = tryParseJson<DiscogsRelease>(result.content)
      if (!release) return null
      md = buildReleaseMarkdown(release)
    } else {
      const master = tryParseJson<DiscogsMaster>(result.content)
      if (!master) return null
      md = buildMasterMarkdown(master)
    }

    return {
      content: md,
      method: 'discogs',
      notes: [`Fetched via Discogs API (${isRelease ? 'release' : 'master'})`]
    }
  } catch {}

  return null
}
