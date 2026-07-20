---
title: "A Clear Headline That Fits the Newspaper Layout"
homeTitle: "Short Home Headline"
dek: "Write a one-sentence summary between 60 and 190 characters that adds useful context instead of repeating the headline."
author: "Reporter Name"
location: "Tysons"
published: "2026-07-10"
updated: "2026-07-10"
status: draft
type: standard
tags:
  - first topic
  - second topic
hero:
  file: "hero.webp"
  alt: "Describe the visible subject and action for someone who cannot see the image"
  caption: "State what the photograph shows, where it was made, and why it matters to this article."
  credit: "Photographer Name / Tysons Times"
images:
  - id: "supporting-view"
    file: "supporting-view.webp"
    alt: "Describe the second image with concrete visible details and no editorial interpretation"
    caption: "Give the supporting image enough context to stand on its own when shared or archived."
    credit: "Photographer Name / Tysons Times"
---

Open with the most important verified information. A standard article needs at least 250 words, while briefs may be shorter and analysis pieces must be longer.

Add context in a second paragraph. Keep each paragraph focused and comfortably below the 1,600-character hard limit.

## A useful subheading

Use subheadings to help readers scan a long article. Do not add a `#` heading because the front-matter title already supplies the page's H1.

{{image:supporting-view}}

Place every configured inline image exactly once. Remove the entire `images` field when the article only needs its required hero.

> Blockquotes work well for a short, accurately transcribed quotation with clear attribution in the surrounding text.

## Facts readers may scan

- Lists are supported for timelines, key facts, and service information.
- Links use normal Markdown and should point to primary source documents when possible.
- Set `status: published` only after editing, fact-checking, image permissions, and a final local validation.
