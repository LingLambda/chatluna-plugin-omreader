import { scrapeArtifactHub } from './artifacthub'
import { scrapeAur } from './aur'
import { scrapeBrew } from './brew'
import { scrapeChocolatey } from './chocolatey'
import { scrapeClojars } from './clojars'
import { scrapeCratesIo } from './crates-io'
import { scrapeDockerHub } from './dockerhub'
import { scrapeFdroid } from './fdroid'
import { scrapeFirefoxAddons } from './firefox-addons'
import { scrapeFlathub } from './flathub'
import { scrapeGoPkg } from './go-pkg'
import { scrapeHackage } from './hackage'
import { scrapeHex } from './hex'
import { scrapeJetBrainsMarketplace } from './jetbrains-marketplace'
import { scrapeMaven } from './maven'
import { scrapeMetaCPAN } from './metacpan'
import { scrapeNpm } from './npm'
import { scrapeNuGet } from './nuget'
import { scrapeOpenVsx } from './open-vsx'
import { scrapePackagist } from './packagist'
import { scrapePubDev } from './pub-dev'
import { scrapePyPI } from './pypi'
import { scrapeRepology } from './repology'
import { scrapeRubyGems } from './rubygems'
import { scrapeSnapcraft } from './snapcraft'
import { scrapeTerraform } from './terraform'
import type { Scraper } from './types'
import { scrapeVscodeMarketplace } from './vscode-marketplace'

/** Package registry scrapers, in dispatch order. */
export const registryScrapers: readonly Scraper[] = [
  scrapeNpm,
  scrapeFirefoxAddons,
  scrapeVscodeMarketplace,
  scrapeNuGet,
  scrapeChocolatey,
  scrapeClojars,
  scrapeBrew,
  scrapePyPI,
  scrapeCratesIo,
  scrapeDockerHub,
  scrapeFdroid,
  scrapeFlathub,
  scrapeGoPkg,
  scrapeHex,
  scrapePackagist,
  scrapePubDev,
  scrapeMaven,
  scrapeJetBrainsMarketplace,
  scrapeOpenVsx,
  scrapeArtifactHub,
  scrapeRubyGems,
  scrapeTerraform,
  scrapeAur,
  scrapeHackage,
  scrapeMetaCPAN,
  scrapeRepology,
  scrapeSnapcraft
]
