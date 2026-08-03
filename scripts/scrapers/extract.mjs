import crypto from "node:crypto";
import path from "node:path";
import * as cheerio from "cheerio";
import {
  asIsoDate,
  cleanText,
  fetchBuffer,
  fetchText,
  normalizeUrl,
  parseDateFromText,
  uniqueBy,
} from "./core.mjs";
import { renderHtml } from "./browser.mjs";

const noiseSelectors = [
  "script",
  "style",
  "noscript",
  "iframe",
  "template",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "canvas",
  "svg",
  "video",
  "audio",
  "nav",
  "aside",
  "footer",
  ".advertisement",
  ".advertising",
  ".ad-container",
  ".ad-wrapper",
  ".ad-slot",
  ".google-auto-placed",
  "[data-ad]",
  "[data-ad-slot]",
  ".social-share",
  ".sharing",
  ".share-tools",
  ".share-buttons",
  ".related-posts",
  ".related-content",
  ".recommended",
  ".newsletter",
  ".newsletter-signup",
  ".subscription",
  ".subscribe",
  ".comments",
  ".comment-list",
  ".cookie",
  ".paywall",
  ".promo",
  ".sponsored",
  ".outbrain",
  ".taboola",
  ".most-read",
  ".trending",
  ".author-box",
  ".post-navigation",
  ".pagination",
  ".tags-links",
  ".screen-reader-text",
];

const allowedTags = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "figure",
  "figcaption",
  "picture",
  "source",
  "img",
  "a",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "br",
  "hr",
  "time",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "dl",
  "dt",
  "dd",
  "sup",
  "sub",
]);

const badImagePattern =
  /(?:logo|icon|avatar|emoji|sprite|spacer|pixel|beacon|tracking|doubleclick|googlesyndication|gravatar|scorecardresearch|\/ads?\/)/i;

function flattenJsonLd(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenJsonLd(item, output));
  } else if (value && typeof value === "object") {
    output.push(value);
    if (value["@graph"]) flattenJsonLd(value["@graph"], output);
  }
  return output;
}

function parseJsonLd($) {
  const objects = [];
  $("script[type='application/ld+json']").each((_, script) => {
    try {
      flattenJsonLd(JSON.parse($(script).text()), objects);
    } catch {
      // Invalid publisher JSON-LD should not prevent article extraction.
    }
  });
  return objects;
}

function typeNames(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean).map(String);
}

function articleJsonLd(objects) {
  const desired = new Set(["Article", "NewsArticle", "Report", "BlogPosting", "ScholarlyArticle"]);
  return (
    objects.find((object) => typeNames(object["@type"]).some((type) => desired.has(type))) ||
    objects.find((object) => object.headline && (object.datePublished || object.articleBody)) ||
    {}
  );
}

function meta($, key, attribute = "property") {
  return (
    $("meta[" + attribute + "='" + key + "']").first().attr("content") ||
    $("meta[name='" + key + "']").first().attr("content") ||
    null
  );
}

function authorName(value) {
  if (Array.isArray(value)) return value.map(authorName).filter(Boolean).join(", ") || null;
  if (value && typeof value === "object") return value.name || null;
  return value ? String(value) : null;
}

function firstDateFromSelectors($, selector) {
  let result = null;
  $(selector).each((_, element) => {
    if (!result) result = parseDateFromText($(element).text());
  });
  return result;
}

function imageFromJsonLd(value) {
  if (Array.isArray(value)) return imageFromJsonLd(value[0]);
  if (value && typeof value === "object") return value.url || value.contentUrl || null;
  return value || null;
}

function candidateRoot($, selectors) {
  const candidates = [];
  for (const selector of selectors || []) {
    $(selector).each((_, element) => {
      const root = $(element);
      const textLength = cleanText(root.text()).length;
      if (textLength < 120) return;
      const linkLength = cleanText(root.find("a").text()).length;
      const paragraphCount = root.find("p").length;
      const imageCount = root.find("img").length;
      const score = textLength - linkLength * 0.65 + paragraphCount * 120 + imageCount * 20;
      candidates.push({ element, score });
    });
    if (candidates.length) break;
  }
  if (!candidates.length) return $("body");
  candidates.sort((a, b) => b.score - a.score);
  return $(candidates[0].element);
}

function bestImageSource($, image, baseUrl) {
  const node = $(image);
  const srcset =
    node.attr("data-srcset") ||
    node.attr("srcset") ||
    node.closest("picture").find("source").last().attr("srcset") ||
    "";
  const srcsetUrl = srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean)
    .at(-1);
  const raw =
    node.attr("data-original") ||
    node.attr("data-lazy-src") ||
    node.attr("data-src") ||
    srcsetUrl ||
    node.attr("src");
  return normalizeUrl(raw, baseUrl);
}

function plainText(value) {
  const raw = String(value || "");
  if (!/[<>]/.test(raw)) return cleanText(raw);
  return cleanText(cheerio.load("<body>" + raw + "</body>")("body").text());
}

function cleanCaption(value) {
  return plainText(
    String(value || "").replace(/\b(?:photo|image)\s*(?:credit|by)\s*[:—-]?\s*/i, ""),
  );
}

function imageMetadata($, image, baseUrl) {
  const node = $(image);
  const url = bestImageSource($, image, baseUrl);
  if (!url || badImagePattern.test(url)) return null;
  const figure = node.closest("figure, .wp-caption, .image, .photo");
  const captionNode = figure.find("figcaption, .wp-caption-text, .caption").first();
  const creditNode = figure.find(".credit, .photo-credit, .image-credit, [class*='credit']").first();
  const width = Number(node.attr("width") || 0);
  const height = Number(node.attr("height") || 0);
  if (width && height && width <= 3 && height <= 3) return null;
  return {
    url,
    alt: plainText(node.attr("alt") || ""),
    caption: plainText(captionNode.text() || node.attr("title") || ""),
    credit: cleanCaption(creditNode.text() || ""),
    width: width || null,
    height: height || null,
  };
}

function cleanLink(value, baseUrl) {
  const normalized = normalizeUrl(value, baseUrl);
  if (!normalized) return null;
  const url = new URL(normalized);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

function sanitizeRoot($, root, baseUrl) {
  root.find(noiseSelectors.join(",")).remove();
  root.find("*").each((_, element) => {
    const node = $(element);
    const tag = String(element.tagName || element.name || "").toLowerCase();
    if (!allowedTags.has(tag)) {
      node.replaceWith(node.contents());
      return;
    }
    const allowedAttributes =
      tag === "a"
        ? new Set(["href", "title"])
        : tag === "img"
          ? new Set(["src", "alt", "title", "width", "height", "loading"])
          : tag === "source"
            ? new Set(["srcset", "type", "media"])
            : tag === "time"
              ? new Set(["datetime"])
              : new Set([]);
    for (const attribute of Object.keys(element.attribs || {})) {
      if (!allowedAttributes.has(attribute)) node.removeAttr(attribute);
    }
    if (tag === "a") {
      const href = cleanLink(node.attr("href"), baseUrl);
      if (href) node.attr("href", href);
      else node.replaceWith(node.contents());
    }
    if (tag === "img") {
      const src = bestImageSource($, element, baseUrl);
      if (!src || badImagePattern.test(src)) node.remove();
      else {
        node.attr("src", src);
        node.attr("loading", "lazy");
      }
    }
  });
  root.find("p, li, blockquote, h1, h2, h3, h4, h5, h6").each((_, element) => {
    if (!cleanText($(element).text()) && !$(element).find("img").length) $(element).remove();
  });
}

function bodyTextFromRoot($, root) {
  const clone = root.clone();
  clone.find("br").replaceWith("\n");
  clone.find("p, li, blockquote, h1, h2, h3, h4, h5, h6, tr, figure").each((_, element) => {
    $(element).append("\n\n");
  });
  return cleanText(clone.text());
}

function mergeTerms(candidate, article, $) {
  const values = [...(candidate.terms || [])];
  const keywords = [
    article.keywords,
    meta($, "article:tag"),
    meta($, "news_keywords", "name"),
    meta($, "keywords", "name"),
  ]
    .flat()
    .filter(Boolean)
    .flatMap((value) => String(value).split(","));
  values.push(...keywords.map((name) => ({ name: cleanText(name), taxonomy: "keyword" })));
  return uniqueBy(
    values.filter((term) => term.name),
    (term) => String(term.taxonomy || "") + ":" + String(term.name).toLowerCase(),
  );
}

function normalizeCandidateImage(image, baseUrl) {
  if (!image) return null;
  const value = typeof image === "string" ? { url: image } : image;
  const url = normalizeUrl(value.url, baseUrl);
  if (!url || badImagePattern.test(url)) return null;
  return {
    url,
    alt: plainText(value.alt || ""),
    caption: plainText(value.caption || ""),
    credit: plainText(value.credit || ""),
    width: value.width || null,
    height: value.height || null,
  };
}

export function extractHtmlArticle(source, candidate, html, finalUrl = candidate.url) {
  const isFragment = Boolean(candidate.prefetchedHtml);
  const documentHtml = isFragment ? "<html><body><article>" + html + "</article></body></html>" : html;
  const $ = cheerio.load(documentHtml);
  const jsonLdObjects = parseJsonLd($);
  const article = articleJsonLd(jsonLdObjects);
  const root = candidateRoot($, isFragment ? ["article"] : source.articleSelectors);

  const contentImages = root
    .find("img")
    .map((_, image) => imageMetadata($, image, finalUrl))
    .get()
    .filter(Boolean);
  const leadImages = [
    normalizeCandidateImage(candidate.leadImage, finalUrl),
    normalizeCandidateImage(imageFromJsonLd(article.image), finalUrl),
    normalizeCandidateImage(meta($, "og:image"), finalUrl),
    normalizeCandidateImage(meta($, "twitter:image", "name"), finalUrl),
  ].filter(Boolean);
  const pagePublishedAt =
    asIsoDate(article.datePublished) ||
    asIsoDate(meta($, "article:published_time")) ||
    asIsoDate($("time[datetime]").first().attr("datetime")) ||
    parseDateFromText($("time").first().text()) ||
    firstDateFromSelectors(
      $,
      ".storymeta, .story-meta, .byline, .post-date, .published-date, .sno-story-byline, .story-info, .time-wrapper",
    ) ||
    parseDateFromText($("body").text().slice(0, 3_000));

  sanitizeRoot($, root, finalUrl);
  const bodyHtml = cleanText(root.html() || "");
  const bodyText = candidate.prefetchedText || bodyTextFromRoot($, root);
  const canonical =
    candidate.originalUrl ||
    normalizeUrl(
      $("link[rel='canonical']").first().attr("href") || article.mainEntityOfPage?.["@id"] || finalUrl,
      finalUrl,
    );
  const title = cleanText(
    candidate.title ||
      article.headline ||
      meta($, "og:title") ||
      $("h1").first().text() ||
      $("title").first().text(),
  );
  const publishedAt = candidate.publishedAt || pagePublishedAt;
  const modifiedAt =
    candidate.modifiedAt ||
    asIsoDate(article.dateModified) ||
    asIsoDate(meta($, "article:modified_time")) ||
    null;
  const images = uniqueBy([...leadImages, ...contentImages], (image) => image.url);
  const record = {
    source_id: source.id,
    source_name: source.name,
    record_type: source.recordType || "article",
    source_url: candidate.originalUrl || candidate.url,
    retrieval_url: finalUrl,
    canonical_url: canonical || candidate.originalUrl || finalUrl,
    publisher_id: candidate.id || candidate.rawMetadata?.guid || null,
    title,
    dek: plainText(candidate.excerpt || article.description || meta($, "description", "name") || ""),
    author: candidate.author || authorName(article.author) || meta($, "author", "name") || null,
    published_at: publishedAt,
    publication_day: candidate.publicationDay || publishedAt?.slice(0, 10) || null,
    publisher_local_date: candidate.publisherLocalDate || null,
    modified_at: modifiedAt,
    section: article.articleSection || null,
    terms: mergeTerms(candidate, article, $),
    body_html: bodyHtml,
    body_text: cleanText(bodyText),
    images,
    archive_captured_at: candidate.archiveCapturedAt || null,
    retrieved_at: new Date().toISOString(),
    raw_metadata: candidate.rawMetadata || {},
  };
  record.content_hash = crypto.createHash("sha256").update(record.body_text).digest("hex");
  record.quality = {
    characters: record.body_text.length,
    words: record.body_text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length || 0,
    images: record.images.length,
  };
  return record;
}

async function extractPdf(source, candidate, buffer, finalUrl) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    verbosity: 0,
  }).promise;
  const metadata = await document.getMetadata().catch(() => ({ info: {}, metadata: null }));
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = [];
    let current = "";
    let previousY = null;
    for (const item of content.items) {
      const y = item.transform?.[5] ?? previousY;
      if (previousY !== null && Math.abs(y - previousY) > 2 && current) {
        lines.push(current);
        current = "";
      }
      current += (current ? " " : "") + item.str;
      previousY = y;
    }
    if (current) lines.push(current);
    pages.push(cleanText(lines.join("\n")));
  }
  const bodyText = cleanText(pages.join("\n\n"));
  const filenameTitle = decodeURIComponent(path.basename(new URL(finalUrl).pathname, ".pdf"))
    .replace(/[-_]+/g, " ")
    .trim();
  const title = cleanText(candidate.title || metadata.info?.Title || filenameTitle);
  const publishedAt =
    candidate.publishedAt ||
    asIsoDate(metadata.info?.CreationDate?.replace(/^D:/, "")) ||
    parseDateFromText(title) ||
    parseDateFromText(bodyText.slice(0, 2_000));
  return {
    source_id: source.id,
    source_name: source.name,
    record_type: source.recordType || "press-release",
    source_url: candidate.url,
    retrieval_url: finalUrl,
    canonical_url: candidate.url,
    publisher_id: null,
    title,
    dek: "",
    author: metadata.info?.Author || null,
    published_at: publishedAt,
    publication_day: candidate.publicationDay || publishedAt?.slice(0, 10) || null,
    publisher_local_date: candidate.publisherLocalDate || null,
    modified_at: null,
    section: null,
    terms: [],
    body_html: "",
    body_text: bodyText,
    images: [],
    document: {
      url: finalUrl,
      media_type: "application/pdf",
      pages: document.numPages,
    },
    retrieved_at: new Date().toISOString(),
    raw_metadata: { pdf_info: metadata.info || {} },
    content_hash: crypto.createHash("sha256").update(bodyText).digest("hex"),
    quality: {
      characters: bodyText.length,
      words: bodyText.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length || 0,
      images: 0,
    },
    _documentBuffer: buffer,
  };
}

async function fetchHtmlWithFallback(source, url) {
  try {
    const { text, response } = await fetchText(url, {
      delayMs: source.delayMs,
      timeoutMs: source.strategy === "wayback" ? 60_000 : 25_000,
      retries: source.strategy === "wayback" ? 3 : 2,
      retryDelayMs: source.strategy === "wayback" ? 2_000 : 500,
    });
    return { html: text, url: response.url, mediaType: response.headers.get("content-type") || "" };
  } catch (error) {
    if (source.strategy === "wayback") throw error;
    const rendered = await renderHtml(url);
    return { html: rendered.html, url: rendered.url, mediaType: "text/html; rendered=playwright" };
  }
}

export async function extractCandidate(source, candidate) {
  if (candidate.documentType === "pdf" || /\.pdf(?:$|\?)/i.test(candidate.url)) {
    const { buffer, response } = await fetchBuffer(candidate.url, {
      delayMs: source.delayMs,
      timeoutMs: 45_000,
    });
    return extractPdf(source, candidate, buffer, response.url);
  }

  if (candidate.prefetchedHtml) {
    return extractHtmlArticle(source, candidate, candidate.prefetchedHtml, candidate.url);
  }

  const fetched = await fetchHtmlWithFallback(source, candidate.url);
  if (/application\/pdf/i.test(fetched.mediaType)) {
    const { buffer, response } = await fetchBuffer(fetched.url, { delayMs: source.delayMs });
    return extractPdf(source, candidate, buffer, response.url);
  }
  return extractHtmlArticle(source, candidate, fetched.html, fetched.url);
}

export const extractionInternals = {
  badImagePattern,
  candidateRoot,
  parseJsonLd,
};
