# Project instructions

## Article rewrite queue

- Collected source bundles enter
  `input/<source-id>/unprocessed-articles/<publication-day>/<stable-slug>/`.
- Follow `ARTICLE_REWRITE.md` exactly for every AI rewrite.
- AI output is stored as `rewrite.md` and as a `status: rewrite` draft under
  `content/articles`. It must contain only the new headline and rewritten body,
  with no source, author, byline, URL, or generation commentary.
- After a rewrite succeeds and validates, move the complete raw bundle to the
  matching path under `processed-articles`. Never move it after a failed run.
- Preserve the original metadata, text, HTML, PDFs, and images beside the
  rewrite so a human editor can verify and finish the article.

## Article collection runs

- Always run production collection with an explicit inclusive start and exclusive end date. Record that exact half-open time range; never describe an unrecorded range as “last week.”
- Always cap or record the requested per-source article limit.
- Every production scraper run must append one JSON object to `input/scrape-runs.jsonl`. Never overwrite or silently remove earlier entries.
- Each run-log entry must include timestamps, the requested range, every requested source (including sources with zero matches), the article count from each source, extraction/source failures, total article count, and total stored data/image bytes.
- Always attempt lossless compression for downloaded media when the format has a verified lossless path. Accept an optimized file only when it is smaller and its decoded pixels are identical. Keep unsupported, animated, failed, or non-smaller files byte-for-byte; never resize or use lossy re-encoding in the research archive.
- After a run, check `.cache/scrape-run-summary.json` and the new line in `input/scrape-runs.jsonl`, then run `npm run scrape:test` and the collection audit appropriate to the requested date range.
