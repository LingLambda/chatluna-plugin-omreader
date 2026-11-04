import { scrapeCheatSh } from './cheatsh'
import { scrapeChooseALicense } from './choosealicense'
import { scrapeDevTo } from './devto'
import { scrapeDocsRs } from './docs-rs'
import { scrapeGitHub } from './github'
import { scrapeGitHubGist } from './github-gist'
import { scrapeGitLab } from './gitlab'
import { scrapeMDN } from './mdn'
import { scrapeOpenLibrary } from './openlibrary'
import { scrapeReadTheDocs } from './readthedocs'
import { scrapeSearchcode } from './searchcode'
import { scrapeSourcegraph } from './sourcegraph'
import { scrapeSpdx } from './spdx'
import { scrapeStackOverflow } from './stackoverflow'
import { scrapeTldr } from './tldr'
import type { Scraper } from './types'
import { scrapeW3c } from './w3c'
import { scrapeWikidata } from './wikidata'
import { scrapeWikipedia } from './wikipedia'

export const gitScrapers: readonly Scraper[] = [scrapeGitHubGist, scrapeGitHub, scrapeGitLab]

export const developerScrapers: readonly Scraper[] = [
  scrapeStackOverflow,
  scrapeDevTo,
  scrapeMDN,
  scrapeDocsRs,
  scrapeReadTheDocs,
  scrapeSearchcode,
  scrapeSourcegraph,
  scrapeTldr,
  scrapeCheatSh
]

export const referenceScrapers: readonly Scraper[] = [
  scrapeOpenLibrary,
  scrapeChooseALicense,
  scrapeW3c,
  scrapeSpdx,
  scrapeWikidata,
  scrapeWikipedia
]
