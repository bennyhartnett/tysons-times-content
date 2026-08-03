import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { discoveryInternals } from "./discover.mjs";
import { extractHtmlArticle } from "./extract.mjs";
import { losslesslyCompressImage } from "./media.mjs";
import { createRunLogEntry } from "./run-log.mjs";
import { SOURCES } from "./sources.mjs";

test("source registry contains one adapter for every input source", () => {
  assert.equal(SOURCES.length, 25);
  assert.equal(new Set(SOURCES.map((source) => source.id)).size, 25);
});

test("Ghost public content key is discovered without pinning it", () => {
  const html = '<script data-key="2630110124c7b2aca8d2160827"></script>';
  assert.equal(discoveryInternals.findGhostKey(html), "2630110124c7b2aca8d2160827");
});

test("article extraction keeps editorial content and removes ad junk", () => {
  const source = {
    id: "fixture",
    name: "Fixture",
    articleSelectors: [".entry-content"],
  };
  const candidate = {
    url: "https://example.com/news/test-story",
    excerpt: "<p>A concise editorial summary.</p>",
  };
  const html = [
    "<html><head>",
    '<meta property="og:title" content="A useful local story">',
    '<meta property="article:published_time" content="2026-07-20T09:30:00-04:00">',
    '<link rel="canonical" href="https://example.com/news/test-story">',
    "</head><body><article>",
    '<div class="entry-content">',
    "<p>This is the first paragraph of the actual article, with enough useful reporting to score well.</p>",
    '<div class="advertisement"><p>Buy this unrelated product now.</p><img src="/ads/banner.jpg"></div>',
    '<figure><img src="/photos/story.jpg" alt="People at a local meeting"><figcaption>Residents speak at the meeting. <span class="credit">Photo by A. Reporter</span></figcaption></figure>',
    "<p>This is the second substantive paragraph and it should remain in the cleaned output.</p>",
    '<div class="related-posts"><a href="/other">Ten unrelated stories</a></div>',
    "</div></article></body></html>",
  ].join("");
  const record = extractHtmlArticle(source, candidate, html);
  assert.equal(record.title, "A useful local story");
  assert.equal(record.dek, "A concise editorial summary.");
  assert.equal(record.published_at, "2026-07-20T13:30:00.000Z");
  assert.match(record.body_text, /first paragraph/);
  assert.doesNotMatch(record.body_text, /Buy this unrelated product/);
  assert.doesNotMatch(record.body_text, /Ten unrelated stories/);
  assert.equal(record.images.length, 1);
  assert.equal(record.images[0].url, "https://example.com/photos/story.jpg");
});

test("archive URL screening rejects indexes and media", () => {
  assert.equal(discoveryInternals.likelyArchivedArticle("https://example.com/"), false);
  assert.equal(discoveryInternals.likelyArchivedArticle("https://example.com/feed/"), false);
  assert.equal(discoveryInternals.likelyArchivedArticle("https://example.com/2020/04/story/"), true);
});

test("PNG optimization saves bytes without changing decoded pixels", async () => {
  const pixels = Buffer.alloc(128 * 128 * 4, 127);
  const input = await sharp(pixels, { raw: { width: 128, height: 128, channels: 4 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const result = await losslesslyCompressImage(input, "image/png");
  assert.equal(result.attempted, true);
  assert.equal(result.optimized, true);
  assert.ok(result.bytesSaved > 0);
  const originalPixels = await sharp(input).raw().toBuffer();
  const optimizedPixels = await sharp(result.buffer).raw().toBuffer();
  assert.deepEqual(optimizedPixels, originalPixels);
});

test("run log keeps zero-result sources and total data", () => {
  const summary = {
    started_at: "2026-07-20T12:00:00.000Z",
    collected_at: "2026-07-20T12:01:00.000Z",
    elapsed_ms: 60_000,
    range: { start: "2026-07-20T00:00:00-04:00", endExclusive: "2026-07-27T00:00:00-04:00" },
    limit_per_source: 10,
    selected_sources: ["one", "two"],
    sources_with_articles: 1,
    total_saved: 2,
    data_bytes: 2048,
    image_bytes: 1024,
    failed_sources: [],
    lossless_compression: { optimized_images: 1, bytes_saved: 100 },
    results: [
      {
        source_id: "one",
        name: "One",
        status: "passed",
        discovered: 2,
        failures: [],
        saved: [
          { data_bytes: 1024, image_bytes: 512, lossless_compression: { bytes_saved: 50 } },
          { data_bytes: 1024, image_bytes: 512, lossless_compression: { bytes_saved: 50 } },
        ],
      },
      { source_id: "two", name: "Two", status: "no-matches", discovered: 0, failures: [], saved: [] },
    ],
  };
  const entry = createRunLogEntry(summary, "C:\\repo\\input", "C:\\repo");
  assert.equal(entry.per_source.length, 2);
  assert.equal(entry.per_source[1].articles_saved, 0);
  assert.equal(entry.totals.articles_saved, 2);
  assert.equal(entry.totals.data_bytes, 2048);
});
