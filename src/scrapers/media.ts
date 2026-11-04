import { scrapeBluesky } from './bluesky'
import { scrapeDiscogs } from './discogs'
import { scrapeDiscourse } from './discourse'
import { scrapeHackerNews } from './hackernews'
import { scrapeLemmy } from './lemmy'
import { scrapeLobsters } from './lobsters'
import { scrapeMastodon } from './mastodon'
import { scrapeMusicBrainz } from './musicbrainz'
import { scrapeRawg } from './rawg'
import { scrapeReddit } from './reddit'
import { scrapeSpotify } from './spotify'
import type { Scraper } from './types'
import { scrapeVimeo } from './vimeo'

/** Video/media, games and social/news scrapers in dispatch order (YouTube and X/Twitter are not supported). */
export const mediaScrapers: readonly Scraper[] = [
  scrapeVimeo,
  scrapeSpotify,
  scrapeDiscogs,
  scrapeMusicBrainz,
  scrapeRawg,
  scrapeBluesky,
  scrapeMastodon,
  scrapeLemmy,
  scrapeHackerNews,
  scrapeLobsters,
  scrapeReddit,
  scrapeDiscourse
]
