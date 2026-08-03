# Article scrapers

The scraper is one CLI with shared extraction code and 25 small source
configurations. It uses the least expensive route available:

- public WordPress/Ghost/WMATA APIs when they contain full article content;
- RSS, sitemap XML, or publisher archive HTML for discovery;
- ordinary HTTP plus Cheerio for article pages;
- headless Playwright only for Vienna's rendered document folder or as a
  last-resort page fallback;
- PDF.js only for Vienna PDF press releases.

## Quick start

Install dependencies and list the sources:

    npm install
    npm run scrape:list

Collect one publisher-local calendar day:

    node scripts/scrape-sources.mjs --source ffxnow --date 2026-07-24

Collect a date range from several sources:

    node scripts/scrape-sources.mjs \
      --source ffxnow,wtop-fairfax-county,fcpd-tysons-urban-team \
      --start 2026-07-01 \
      --end-exclusive 2026-08-01 \
      --limit 500

Collect all configured sources:

    node scripts/scrape-sources.mjs \
      --all \
      --start 2026-07-01 \
      --end-exclusive 2026-08-01

PowerShell accepts the same command on one line. The explicit Node command is
recommended when passing arguments because npm's argument forwarding differs
between npm releases.

## Output

Normal runs write:

    input/<source-id>/unprocessed-articles/<publication-day>/<stable-slug>/
      metadata.json
      article.html
      article.txt
      article.pdf          # PDF releases only
      images/
        001.jpg
        002.webp

After the local AI rewrite pipeline succeeds, it adds `rewrite.md` and moves
the complete bundle to the matching path under `processed-articles`. See the
root README for rewrite commands. A failed rewrite remains in
`unprocessed-articles`.

The HTML is intentionally narrow. Scripts, forms, ads, share tools, navigation,
related-story widgets, newsletter boxes, comments, and tracking attributes are
removed. Images are selected only from the cleaned article body plus explicit
publisher lead-image metadata.

metadata.json preserves:

- source, retrieval, original archive, and canonical URLs;
- publisher ID, title, dek, author, section, and terms;
- UTC publication/modification timestamps and publisher-local publication day;
- image URLs, captions, credits, dimensions, local paths, media types, and
  download errors;
- archive capture time where applicable;
- body hash and basic word/character/image quality counts.

Photo binaries are downloaded by default. Use --no-download-images to keep only
their URLs and metadata. Each image is capped at 15 MB. PNG and WebP downloads
are always tested with lossless compression; the smaller representation is kept
only after decoded-pixel equality is verified. JPEG, animated, unsupported, and
non-smaller images remain byte-for-byte unchanged.

Every normal collection appends one JSON object to `input/scrape-runs.jsonl`
(or the selected output root). The append-only entry records the exact half-open
date range, the per-source count including zero-result sources, failures, the
source cap, total stored data and image bytes, and lossless-compression savings.
The latest detailed run summary remains in `.cache/scrape-run-summary.json`.

## Useful options

- --source ID[,ID] selects one or more sources.
- --all selects every source.
- --date YYYY-MM-DD selects one publisher-local day.
- --start and --end-exclusive select a half-open date range.
- --limit N caps saved records per source.
- --output PATH changes the output root.
- --max-images N caps article photos; the default is 12.
- --no-download-images skips image binaries.
- --strict-scope enables optional Tysons tags on broad publishers such as
  FFXnow and Falls Church News-Press.

## Testing

Run deterministic extraction tests:

    npm run scrape:test

Re-run safe lossless compression over existing input downloads:

    npm run scrape:compress

Run one bounded live extraction per source:

    npm run scrape:smoke

The smoke test does not download image binaries. Its ignored artifacts and
summary are written to .cache/scraper-smoke. A separate real-download test can
use --output .cache/scraper-photo-test.

## Collection policy

Set a truthful, contact-bearing user agent before production collection:

    $env:TYSONS_SCRAPER_USER_AGENT =
      "TysonsTimesResearchBot/1.0 (+https://tysonstimes.org/contact)"

Re-read each publisher's robots.txt and terms before a run. The configurations
currently avoid the disallowed FCPS facet URLs, use sitemaps instead of query
URLs for the student papers, enforce the observed ten-second FCNP delay and
six-second student-paper delays, and do not follow the live Rank & File redirect.
GazetteLeader and Rank & File are collected only from Internet Archive
snapshots.

Source-specific discovery details remain in input/<source-id>/SOURCE.md and the
machine-readable input/source-url-conventions.json catalog.
