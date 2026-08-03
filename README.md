# Tysons Times Content

The article and image source for [Tysons Times](https://tysonstimes.org). This repository publishes a static, read-only content feed that the website consumes directly.

## Feed

- `index.json` — summaries for every published article
- `articles/<slug>.json` — the complete rendered article
- `media/articles/<slug>/...` — responsive WebP images
- `manifest.json` — feed metadata and endpoint patterns

GitHub Pages publishes the feed at `https://bennyhartnett.github.io/tysons-times-content/` after every push to `main`.

## Publishing an article

Add articles at:

```text
content/articles/<section>/<YYYY>/<MM>/<slug>/article.md
```

Use [content/article-template.md](content/article-template.md) and follow [content/README.md](content/README.md). Then run:

```bash
npm install
npm run check
npm run build
```

The website code does not belong in this repository; this repository contains only the editorial source, validation/build tooling, and the generated article feed.

## Research collection

The input tree contains source-specific article collection notes and a
lightweight scraper for all configured regional sources. See
[scripts/scrapers/README.md](scripts/scrapers/README.md) for date-range
collection, cleaned article output, photo downloads, and live smoke tests.

## AI-assisted rewrite queue

Collected bundles enter `input/<source-id>/unprocessed-articles`. Rewrite them
with an installed, signed-in Codex or Claude Code CLI; the repository does not
call an AI API or depend on an AI SDK:

```bash
# Preview the queue without invoking AI
node scripts/rewrite-articles.mjs --dry-run --all

# Rewrite the newest three articles with Codex
node scripts/rewrite-articles.mjs --provider codex --limit 3

# Rewrite every queued FFXnow article with Claude Code
node scripts/rewrite-articles.mjs --provider claude --source ffxnow --all

# Re-evaluate section placement for existing rewrite drafts
node scripts/rewrite-articles.mjs --reclassify

# Revalidate every processed archived rewrite
node scripts/rewrite-articles.mjs --audit
```

The default is deliberately one article per run. `--provider auto` (the
default) prefers a modern non-interactive Codex CLI, otherwise uses Claude Code,
and uses a legacy Codex CLI only when it is the sole installed option. The
prompt policy lives in [`ARTICLE_REWRITE.md`](ARTICLE_REWRITE.md), not in
JavaScript.

`npm run rewrite` is a shorthand for the default one-article run. Use the
explicit `node` command when passing options so npm versions cannot reinterpret
the CLI flags.

On success, the command writes `rewrite.md` and moves the complete bundle to
the corresponding `processed-articles` path. The generated Markdown contains
only a new, mildly sensationalized H1 and the rewritten body. It has no source,
author, URL, or byline. The command also creates a matching `status: rewrite`
draft under `content/articles`, using a best-effort section classification.
These drafts are excluded from the feed until an editor verifies them, adds the
normal publication metadata and images, and changes the status.

## Hourly editorial workflow

The staged editorial pipeline builds on the scraper queue but keeps orchestration
separate from AI work. It invokes only the installed, signed-in Codex and Claude
CLIs; it has no OpenAI/Anthropic SDK and removes API-key/cloud-provider
environment variables from child processes so calls use subscription sign-in.

```bash
# Inspect the queue and durable state without writing or invoking AI
npm run pipeline:dry-run

# Run up to 12 narrowly scoped AI transformations now
npm run pipeline

# Pin the run to one subscription CLI if desired
node scripts/editorial-pipeline.mjs --provider codex --max-ai-calls 6
node scripts/editorial-pipeline.mjs --provider claude --max-ai-calls 6
```

With `--provider auto`, inexpensive review/dedup/QA steps prefer Claude and
synthesis/rewrite steps prefer Codex. If a preferred CLI fails or returns invalid
JSON, the other installed CLI is the next validation attempt. Every call receives
one versioned prompt plus one input object and is constrained by a JSON Schema.
Neither model chooses the next file, changes files, or moves workflow state.

The durable flow is:

```text
input/*/unprocessed-articles
  -> workflow/ingested
  -> workflow/accepted | held | rejected
  -> workflow/clusters/<cluster>/sources
  -> synthesis -> rewrite -> media plan -> QA
  -> workflow/staging | needs-review
```

Canonical URLs and normalized content hashes in `workflow/ingest-index.json`
prevent a source bundle from being ingested twice. A lock prevents overlapping
hourly executions. Failed AI stages retain their current files and retry on a
later run; after three failed runs, the item moves to `failed/` or
`needs-review/`. QA correction is capped at two passes. Source scraper bundles
are never moved or altered by this pipeline.

On Windows, install the included per-user scheduled task (it runs only while the
same signed-in desktop user is logged in, so subscription credentials are
available):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-editorial-hourly-task.ps1
```

The first run starts about two minutes after installation and repeats hourly.
Logs are written to `.cache/editorial-pipeline/hourly.log`. The task ignores a
new trigger while a prior run is active, and the pipeline has its own filesystem
lock as a second guard.
