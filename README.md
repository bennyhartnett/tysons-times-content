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
