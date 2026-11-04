import { scrapeArxiv } from './arxiv'
import { scrapeBiorxiv } from './biorxiv'
import { scrapeCisaKev } from './cisa-kev'
import { scrapeCoinGecko } from './coingecko'
import { scrapeCrossref } from './crossref'
import { scrapeHuggingFace } from './huggingface'
import { scrapeIacr } from './iacr'
import { scrapeNvd } from './nvd'
import { scrapeOllama } from './ollama'
import { scrapeOpenCorporates } from './opencorporates'
import { scrapeOrcid } from './orcid'
import { scrapeOsv } from './osv'
import { scrapePubMed } from './pubmed'
import { scrapeRfc } from './rfc'
import { scrapeSecEdgar } from './sec-edgar'
import { scrapeSemanticScholar } from './semantic-scholar'
import type { Scraper } from './types'

/** ML/AI, academic, security, crypto and business scrapers, in dispatch order. */
export const researchScrapers: readonly Scraper[] = [
  // ML/AI
  scrapeHuggingFace,
  scrapeOllama,
  // Academic
  scrapeArxiv,
  scrapeBiorxiv,
  scrapeCrossref,
  scrapeIacr,
  scrapeOrcid,
  scrapeSemanticScholar,
  scrapePubMed,
  scrapeRfc,
  // Security
  scrapeCisaKev,
  scrapeNvd,
  scrapeOsv,
  // Crypto
  scrapeCoinGecko,
  // Business
  scrapeOpenCorporates,
  scrapeSecEdgar
]
