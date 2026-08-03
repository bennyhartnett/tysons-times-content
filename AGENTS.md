# Project instructions

## Article rewrite queue

- Collected source bundles enter
  `input/<source-id>/unprocessed-articles/<publication-day>/<stable-slug>/`.
- Write each AI draft into `content/articles/<section>/<YYYY>/<MM>/<slug>/article.md`
  with only `title`, `published`, and `status: rewrite` front matter. The build
  validates but does not publish this intermediate status.
- Follow `ARTICLE_REWRITE.md` exactly when rewriting a collected article.
- A successful rewrite is stored as `rewrite.md` inside the bundle, then the
  complete bundle is moved to the matching path under `processed-articles`.
- Do not move a bundle when generation or validation fails.
- The generated `rewrite.md` contains only a new H1 title and rewritten body.
  Do not add source, author, byline, URL, attribution metadata, or front matter.
- Preserve `metadata.json`, `article.txt`, `article.html`, PDFs, and images in
  the processed bundle so an editor can verify the rewrite against the archive.

## Article collection runs

- Always run production collection with an explicit inclusive start and
  exclusive end date. Record that exact half-open time range; never describe an
  unrecorded range as "last week."
- Always cap or record the requested per-source article limit.
- Every production scraper run must append one JSON object to
  `input/scrape-runs.jsonl`.
- Always attempt verified lossless compression for downloaded media.
- After a run, inspect `.cache/scrape-run-summary.json`, inspect the appended run
  log entry, and run `npm run scrape:test`.
