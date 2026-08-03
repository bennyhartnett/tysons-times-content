# Editorial workflow data

This directory is the durable state machine for the hourly editorial pipeline.
The program creates and moves one article or story directory at a time:

```text
ingested -> accepted | held | rejected
accepted -> clusters/<cluster>/sources
clusters -> staging | needs-review
```

`ingest-index.json` prevents re-ingestion by canonical URL and normalized content
hash. `cluster.json` and each article's `state.json` are the machine-readable
source of truth. Original scraper bundles remain untouched under `input/`; the
workflow stores normalized text and references to the archived source media.

Files in `staging/` have passed factual/style/media QA. They are not published
automatically.
