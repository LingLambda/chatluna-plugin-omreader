import type { ScrapeContext, Scraper } from './types'
import { tryParseJson } from './utils'

interface OpenLibraryAuthor {
  name?: string
  url?: string
}

interface OpenLibrarySubject {
  name: string
  url?: string
}

interface OpenLibraryPublisher {
  name: string
}

interface OpenLibraryCover {
  small?: string
  medium?: string
  large?: string
}

interface OpenLibraryWork {
  title: string
  authors?: { author: { key: string } }[]
  description?: string | { value: string }
  subjects?: string[]
  subject_places?: string[]
  subject_times?: string[]
  covers?: number[]
  first_publish_date?: string
}

interface OpenLibraryEdition {
  title: string
  authors?: { key: string }[]
  publishers?: string[]
  publish_date?: string
  number_of_pages?: number
  isbn_10?: string[]
  isbn_13?: string[]
  covers?: number[]
  description?: string | { value: string }
  subjects?: string[]
  works?: { key: string }[]
}

interface OpenLibraryBooksApiResponse {
  [key: string]: {
    title: string
    authors?: OpenLibraryAuthor[]
    publishers?: OpenLibraryPublisher[]
    publish_date?: string
    number_of_pages?: number
    subjects?: OpenLibrarySubject[]
    cover?: OpenLibraryCover
    url?: string
    identifiers?: {
      isbn_10?: string[]
      isbn_13?: string[]
      openlibrary?: string[]
    }
  }
}

/** Open Library works, editions and ISBN pages via their API. */
export const scrapeOpenLibrary: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (!parsed.hostname.includes('openlibrary.org')) return null

    const path = parsed.pathname

    const workMatch = path.match(/^\/works\/(OL\d+W)/i)
    const editionMatch = path.match(/^\/books\/(OL\d+M)/i)
    const isbnMatch = path.match(/^\/isbn\/(\d{10}|\d{13})/i)

    let md: string | null = null

    if (workMatch) {
      md = await fetchWork(ctx, workMatch[1]!)
    } else if (editionMatch) {
      md = await fetchEdition(ctx, editionMatch[1]!)
    } else if (isbnMatch) {
      md = await fetchByIsbn(ctx, isbnMatch[1]!)
    }

    if (!md) return null

    return { content: md, method: 'openlibrary', notes: ['Fetched via Open Library API'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}

async function fetchWork(ctx: ScrapeContext, workId: string): Promise<string | null> {
  const apiUrl = `https://openlibrary.org/works/${workId}.json`
  const result = await ctx.loadPage(apiUrl)
  if (!result.ok) return null

  const work = tryParseJson<OpenLibraryWork>(result.content)
  if (!work) return null

  let md = `# ${work.title}\n\n`

  if (work.authors?.length) {
    const authorNames = await fetchAuthorNames(
      ctx,
      work.authors.map((a) => a.author.key)
    )
    if (authorNames.length) {
      md += `**Authors:** ${authorNames.join(', ')}\n`
    }
  }

  if (work.first_publish_date) {
    md += `**First Published:** ${work.first_publish_date}\n`
  }

  if (work.covers?.length) {
    const coverId = work.covers[0]
    md += `**Cover:** https://covers.openlibrary.org/b/id/${coverId}-L.jpg\n`
  }

  md += `**Open Library:** https://openlibrary.org/works/${workId}\n`
  md += '\n'

  const description = extractDescription(work.description)
  if (description) {
    md += `## Description\n\n${description}\n\n`
  }

  if (work.subjects?.length) {
    md += `## Subjects\n\n${work.subjects.slice(0, 20).join(', ')}\n`
  }

  return md
}

async function fetchEdition(ctx: ScrapeContext, editionId: string): Promise<string | null> {
  const apiUrl = `https://openlibrary.org/books/${editionId}.json`
  const result = await ctx.loadPage(apiUrl)
  if (!result.ok) return null

  const edition = tryParseJson<OpenLibraryEdition>(result.content)
  if (!edition) return null

  let md = `# ${edition.title}\n\n`

  if (edition.authors?.length) {
    const authorNames = await fetchAuthorNames(
      ctx,
      edition.authors.map((a) => a.key)
    )
    if (authorNames.length) {
      md += `**Authors:** ${authorNames.join(', ')}\n`
    }
  }

  if (edition.publishers?.length) {
    md += `**Publishers:** ${edition.publishers.join(', ')}\n`
  }

  if (edition.publish_date) {
    md += `**Published:** ${edition.publish_date}\n`
  }

  if (edition.number_of_pages) {
    md += `**Pages:** ${edition.number_of_pages}\n`
  }

  const isbns = [...(edition.isbn_13 || []), ...(edition.isbn_10 || [])]
  if (isbns.length) {
    md += `**ISBN:** ${isbns[0]}\n`
  }

  if (edition.covers?.length) {
    const coverId = edition.covers[0]
    md += `**Cover:** https://covers.openlibrary.org/b/id/${coverId}-L.jpg\n`
  }

  md += `**Open Library:** https://openlibrary.org/books/${editionId}\n`

  if (edition.works?.length) {
    const workKey = edition.works[0]!.key.replace('/works/', '')
    md += `**Work:** https://openlibrary.org/works/${workKey}\n`
  }

  md += '\n'

  const description = extractDescription(edition.description)
  if (description) {
    md += `## Description\n\n${description}\n\n`
  }

  if (edition.subjects?.length) {
    md += `## Subjects\n\n${edition.subjects.slice(0, 20).join(', ')}\n`
  }

  return md
}

async function fetchByIsbn(ctx: ScrapeContext, isbn: string): Promise<string | null> {
  const apiUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`
  let result = await ctx.loadPage(apiUrl)
  if (!result.ok) {
    result = await ctx.loadPage(apiUrl)
  }
  if (!result.ok) {
    return `# Open Library Book\n\n**ISBN:** ${isbn}\n\nBook details are currently unavailable from the Open Library books API.\n`
  }

  const data = tryParseJson<OpenLibraryBooksApiResponse>(result.content)
  if (!data) return null

  const key = `ISBN:${isbn}`
  const book = data[key]
  if (!book) {
    // Fallback: the search endpoint still returns docs when api/books misses a key.
    const searchUrl = `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&limit=1`
    const searchResult = await ctx.loadPage(searchUrl)
    if (!searchResult.ok) {
      return `# Open Library Book\n\n**ISBN:** ${isbn}\n\nBook details are currently unavailable from the Open Library search API.\n`
    }
    const searchData = tryParseJson<{
      docs?: {
        title?: string
        author_name?: string[]
        first_publish_year?: number
        key?: string
      }[]
    }>(searchResult.content)
    const doc = searchData?.docs?.[0]
    if (!doc?.title) {
      return `# Open Library Book\n\n**ISBN:** ${isbn}\n\nBook details are currently unavailable from Open Library.\n`
    }

    let fallbackMd = `# ${doc.title}\n\n`
    if (doc.author_name?.length) {
      fallbackMd += `**Authors:** ${doc.author_name.join(', ')}\n`
    }
    if (doc.first_publish_year) {
      fallbackMd += `**First Published:** ${doc.first_publish_year}\n`
    }
    fallbackMd += `**ISBN:** ${isbn}\n`
    if (doc.key) {
      fallbackMd += `**Open Library:** https://openlibrary.org${doc.key}\n`
    }

    return fallbackMd
  }

  let md = `# ${book.title}\n\n`

  if (book.authors?.length) {
    md += `**Authors:** ${book.authors.map((a) => a.name).join(', ')}\n`
  }

  if (book.publishers?.length) {
    md += `**Publishers:** ${book.publishers.map((p) => p.name).join(', ')}\n`
  }

  if (book.publish_date) {
    md += `**Published:** ${book.publish_date}\n`
  }

  if (book.number_of_pages) {
    md += `**Pages:** ${book.number_of_pages}\n`
  }

  md += `**ISBN:** ${isbn}\n`

  if (book.cover?.large || book.cover?.medium) {
    md += `**Cover:** ${book.cover.large || book.cover.medium}\n`
  }

  if (book.url) {
    md += `**Open Library:** ${book.url}\n`
  }

  md += '\n'

  if (book.subjects?.length) {
    md += `## Subjects\n\n${book.subjects
      .slice(0, 20)
      .map((s) => s.name)
      .join(', ')}\n`
  }

  return md
}

async function fetchAuthorNames(ctx: ScrapeContext, authorKeys: string[]): Promise<string[]> {
  const names: string[] = []

  // Fetch authors in parallel (first 5 only)
  const promises = authorKeys.slice(0, 5).map(async (key) => {
    const authorKey = key.startsWith('/authors/') ? key : `/authors/${key}`
    const apiUrl = `https://openlibrary.org${authorKey}.json`
    try {
      const result = await ctx.loadPage(apiUrl, { timeoutMs: 5000 })
      if (result.ok) {
        const author = JSON.parse(result.content) as { name?: string }
        return author.name || null
      }
    } catch {
      // Skip this author.
    }
    return null
  })

  const results = await Promise.all(promises)
  for (const name of results) {
    if (name) names.push(name)
  }

  return names
}

function extractDescription(desc: string | { value: string } | undefined): string | null {
  if (!desc) return null
  if (typeof desc === 'string') return desc
  return desc.value || null
}
