# Repository article system

Every production article lives in this directory. The old mock article array is not imported by the application; Markdown files here are the only article source used by the build.

## Folder controls publication

Use this exact structure:

```text
content/articles/<section>/<YYYY>/<MM>/<slug>/article.md
```

Example:

```text
content/articles/civic/2026/07/new-crossing-plan/article.md
```

- `<section>` must be `local`, `civic`, `schools`, `business`, `culture`, `sports`, or `opinion`.
- `YYYY/MM` must match the `published` date in front matter.
- `<slug>` becomes `/articles/<slug>/` and must be unique lower-case kebab-case.
- `status: draft` validates but stays out of the site.
- `status: published` enters its section, archive, search index, sitemap, RSS feed, and related-story system.
- Archives and section pages sort by `published`, newest first. `updated` changes the modification date without moving an old story to the top.

Start by copying [`article-template.md`](article-template.md) into a correctly named article folder.

## Content rules enforced by the build

The deploy fails with a file-specific message when any rule is broken.

| Field | Rule |
| --- | --- |
| Title | 12-88 characters |
| Home title | Optional, 6-38 characters |
| Description/dek | 60-190 characters |
| Author | 2-60 characters |
| Location | 2-60 characters |
| Tags | 2-6 unique tags, each 2-28 characters |
| Article body | 120-6,000 words; higher minimums apply to analysis, profile, review, opinion, and standard stories |
| Paragraph | 20-1,600 characters |
| H2/H3 | Up to 12 total; H2 4-80 characters, H3 4-70 characters |
| Hero image | Exactly one, at least 1200x700, 1.25:1-2.1:1 aspect ratio, no larger than 12 MB |
| Inline images | Zero to six, each placed exactly once with `{{image:id}}` |
| Alt text | 12-180 characters for every image |
| Caption | 20-220 characters for every image |
| Credit | 2-80 characters for every image |

Raw HTML and ordinary Markdown image syntax are disabled. This prevents an accidental pasted embed from bypassing responsive images or breaking the newspaper layout.

## Supported article parts

Write ordinary Markdown paragraphs, `##` and `###` subheadings, ordered or unordered lists, links, bold/italic text, and blockquotes. Put a configured inline image on its own line:

```md
{{image:meeting-room}}
```

The build replaces it with an accessible responsive `<picture>`, caption, and credit.

## Image workflow

Put source images beside `article.md`. Before committing a new batch, normalize them:

```bash
npm run images:optimize -- content/articles/civic/2026/07/new-crossing-plan
```

This converts JPG/PNG/AVIF sources to a high-quality, repository-friendly WebP and updates `article.md`. The production build creates 480, 960, and 1440 pixel WebP delivery variants. Unchanged variants are reused locally, stale variants are removed, and browsers receive only the size they need.

Do not store original camera archives in Git. Keep those on a separate backed-up drive and commit an edited publication copy.

## Local checks

```bash
npm run content:check
npm run dev
npm run build
```

GitHub Actions runs the same validation before every production deployment. A failed validation prevents publication.
