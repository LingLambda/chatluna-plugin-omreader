// SEC EDGAR company profiles and filings via the data.sec.gov submissions API.
import type { Scraper } from './types'
import { tryParseJson } from './utils'

interface SecFiling {
  accessionNumber: string
  filingDate: string
  reportDate: string
  acceptanceDateTime: string
  form: string
  primaryDocument: string
  primaryDocDescription: string
}

interface SecAddress {
  street1?: string
  street2?: string
  city?: string
  stateOrCountry?: string
  zipCode?: string
}

interface SecCompany {
  cik: string
  entityType: string
  sic: string
  sicDescription: string
  name: string
  tickers: string[]
  exchanges: string[]
  ein: string
  stateOfIncorporation: string
  fiscalYearEnd: string
  addresses: {
    business: SecAddress
    mailing: SecAddress
  }
  filings: {
    recent: {
      accessionNumber: string[]
      filingDate: string[]
      reportDate: string[]
      acceptanceDateTime: string[]
      form: string[]
      primaryDocument: string[]
      primaryDocDescription: string[]
    }
  }
}

const KEY_FORMS = ['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A']

/** CIK padded to 10 digits. */
function normalizeCik(cik: string): string {
  return cik.replace(/\D/g, '').padStart(10, '0')
}

function extractCik(url: URL): string | null {
  const { hostname, pathname, searchParams } = url
  if (!hostname.includes('sec.gov')) return null

  // ?CIK=xxx or ?cik=xxx
  const cikParam = searchParams.get('CIK') || searchParams.get('cik')
  if (cikParam) return normalizeCik(cikParam)

  // /cik/XXXXXXXXXX[/...]
  const cikPathMatch = pathname.match(/\/cik\/(\d+)/i)
  if (cikPathMatch) return normalizeCik(cikPathMatch[1]!)

  // /submissions/CIK*.json
  const submissionsMatch = pathname.match(/\/submissions\/CIK(\d+)\.json/i)
  if (submissionsMatch) return normalizeCik(submissionsMatch[1]!)

  // /cgi-bin/browse-edgar company-name search carries no CIK
  if (pathname.includes('/cgi-bin/browse-edgar') && searchParams.get('company')) return null

  // Filing URLs: /Archives/edgar/data/XXXXXXXXXX/...
  const archivesMatch = pathname.match(/\/Archives\/edgar\/data\/(\d+)/)
  if (archivesMatch) return normalizeCik(archivesMatch[1]!)

  return null
}

function formatAddress(addr: SecAddress): string {
  const parts: string[] = []
  if (addr.street1) parts.push(addr.street1)
  if (addr.street2) parts.push(addr.street2)

  const cityLine: string[] = []
  if (addr.city) cityLine.push(addr.city)
  if (addr.stateOrCountry) cityLine.push(addr.stateOrCountry)
  if (addr.zipCode) cityLine.push(addr.zipCode)
  if (cityLine.length) parts.push(cityLine.join(', '))

  return parts.join('\n')
}

/** Recent filings of the given forms (all forms when empty). */
function getRecentFilings(company: SecCompany, formTypes: string[], limit: number): SecFiling[] {
  const { recent } = company.filings
  const filings: SecFiling[] = []

  for (let i = 0; i < recent.form.length && filings.length < limit; i++) {
    if (formTypes.length === 0 || formTypes.includes(recent.form[i]!)) {
      filings.push({
        accessionNumber: recent.accessionNumber[i]!,
        filingDate: recent.filingDate[i]!,
        reportDate: recent.reportDate[i]!,
        acceptanceDateTime: recent.acceptanceDateTime[i]!,
        form: recent.form[i]!,
        primaryDocument: recent.primaryDocument[i]!,
        primaryDocDescription: recent.primaryDocDescription[i]!
      })
    }
  }

  return filings
}

function renderFilingTable(cik: string, filings: SecFiling[]): string {
  let md = '| Date | Form | Description |\n'
  md += '|------|------|-------------|\n'
  for (const filing of filings) {
    const accessionNoDashes = filing.accessionNumber.replace(/-/g, '')
    const filingUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accessionNoDashes}/${filing.primaryDocument}`
    const desc = filing.primaryDocDescription || filing.form
    md += `| ${filing.filingDate} | [${filing.form}](${filingUrl}) | ${desc} |\n`
  }
  return `${md}\n`
}

export const scrapeSecEdgar: Scraper = async (ctx) => {
  try {
    const cik = extractCik(ctx.url)
    if (!cik) return null

    // SEC requires an identifying User-Agent
    const result = await ctx.loadPage(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': 'chatluna-plugin-omreader', Accept: 'application/json' }
    })
    if (!result.ok) return null

    const company = tryParseJson<SecCompany>(result.content)
    if (!company) return null

    let md = `# ${company.name}\n\n`

    md += `**CIK:** ${company.cik}`
    if (company.tickers?.length) {
      md += ` · **Ticker${company.tickers.length > 1 ? 's' : ''}:** ${company.tickers.join(', ')}`
    }
    if (company.exchanges?.length) md += ` (${company.exchanges.join(', ')})`
    md += '\n'

    if (company.entityType) md += `**Entity Type:** ${company.entityType}\n`
    if (company.sic) md += `**SIC:** ${company.sic} - ${company.sicDescription}\n`
    if (company.stateOfIncorporation) md += `**State of Incorporation:** ${company.stateOfIncorporation}\n`
    if (company.ein) md += `**EIN:** ${company.ein}\n`
    if (company.fiscalYearEnd) {
      const fy = company.fiscalYearEnd
      md += `**Fiscal Year End:** ${fy.slice(0, 2)}/${fy.slice(2)}\n`
    }
    md += '\n'

    if (company.addresses?.business) {
      const addr = formatAddress(company.addresses.business)
      if (addr) md += `## Business Address\n\n${addr}\n\n`
    }

    const keyFilings = getRecentFilings(company, KEY_FORMS, 15)
    if (keyFilings.length) md += `## Recent Filings (10-K, 10-Q, 8-K)\n\n${renderFilingTable(cik, keyFilings)}`

    const allFilings = getRecentFilings(company, [], 20)
    if (allFilings.length) md += `## All Recent Filings\n\n${renderFilingTable(cik, allFilings)}`

    md += `## Links\n\n`
    md += `- [SEC EDGAR Filings](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40)\n`
    md += `- [Company Search](https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(company.name)}&CIK=&type=&owner=include&count=40&action=getcompany)\n`

    return { content: md, method: 'sec-edgar', notes: ['Fetched via SEC EDGAR API'] }
  } catch {}

  return null
}
