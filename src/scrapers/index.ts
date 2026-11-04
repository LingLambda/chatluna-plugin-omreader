import { developerScrapers, gitScrapers, referenceScrapers } from './developer'
import { mediaScrapers } from './media'
import { registryScrapers } from './registries'
import { researchScrapers } from './research'
import type { Scraper } from './types'

export type { ScrapeContext, ScrapeResult, Scraper } from './types'

/** Dispatch order: the first scraper returning non-null wins. */
export const scrapers: readonly Scraper[] = [
  ...gitScrapers,
  ...mediaScrapers,
  ...developerScrapers,
  ...registryScrapers,
  ...researchScrapers,
  ...referenceScrapers
]
