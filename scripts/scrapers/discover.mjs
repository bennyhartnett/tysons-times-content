import * as cheerio from "cheerio";
import {
  asIsoDate,
  fetchJson,
  fetchText,
  inRange,
  normalizeUrl,
  parseDateFromText,
  parseLastDateFromText,
  rangeMonths,
  uniqueBy,
} from "./core.mjs";
import { renderedPdfLinks } from "./browser.mjs";

const monthNumbers = new Map(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map(
    (month, index) => [month, index + 1],
  ),
);

function normalizeDateValue(value) {
  if (!value) return null;
  if (typeof value === "number") {
    return asIsoDate(value < 10_000_000_000 ? value * 1000 : value);
  }
  return asIsoDate(value);
}

function urlDate(source, url) {
  if (!source.urlDatePattern) return null;
  const match = url.match(source.urlDatePattern);
  if (!match) return null;
  let [, year, month, day] = match;
  if (/^[a-z]{3}$/i.test(month)) month = monthNumbers.get(month.toLowerCase());
  if (!month) return null;
  return asIsoDate(
    String(year) +
      "-" +
      String(month).padStart(2, "0") +
      "-" +
      String(day).padStart(2, "0") +
      "T12:00:00Z",
  );
}

function termsFromWordpress(post) {
  const groups = post._embedded?.["wp:term"] || [];
  return groups.flat().map((term) => ({
    id: term.id,
    name: term.name,
    slug: term.slug,
    taxonomy: term.taxonomy,
  }));
}

function wordpressCandidate(source, post) {
  let url = post.link;
  if (source.forceOrigin && url) {
    const parsed = new URL(url);
    const origin = new URL(source.forceOrigin);
    parsed.protocol = origin.protocol;
    parsed.host = origin.host;
    url = parsed.href;
  }
  const author = post._embedded?.author?.[0];
  const featured = post._embedded?.["wp:featuredmedia"]?.[0];
  return {
    url,
    id: String(post.id),
    title: post.title?.rendered,
    excerpt: post.excerpt?.rendered,
    publishedAt: normalizeDateValue(post.date_gmt ? post.date_gmt + "Z" : post.date),
    publicationDay: post.date?.slice(0, 10) || null,
    publisherLocalDate: post.date || null,
    modifiedAt: normalizeDateValue(post.modified_gmt ? post.modified_gmt + "Z" : post.modified),
    prefetchedHtml: post.content?.rendered || null,
    author: author?.name || null,
    terms: termsFromWordpress(post),
    leadImage: featured?.source_url
      ? {
          url: featured.source_url,
          alt: featured.alt_text || "",
          caption: featured.caption?.rendered || "",
          credit: featured.caption?.rendered || "",
        }
      : null,
    rawMetadata: {
      wordpress_id: post.id,
      categories: post.categories || [],
      tags: post.tags || [],
    },
  };
}

async function discoverWordpress(source, range, options) {
  const results = [];
  let page = 1;
  const maximum = options.candidateLimit;
  while (results.length < maximum) {
    const url = new URL(source.apiBase);
    url.searchParams.set("after", range.start);
    url.searchParams.set("before", range.endExclusive);
    url.searchParams.set("per_page", String(Math.min(100, Math.max(10, maximum - results.length))));
    url.searchParams.set("page", String(page));
    url.searchParams.set("orderby", "date");
    url.searchParams.set("order", "desc");
    url.searchParams.set("_embed", "1");
    if (source.categories?.length) url.searchParams.set("categories", source.categories.join(","));
    if (source.tags?.length && (!source.optionalScope || options.strictScope)) {
      url.searchParams.set("tags", source.tags.join(","));
    }

    let json;
    let response;
    try {
      ({ json, response } = await fetchJson(url.href, { delayMs: source.delayMs }));
    } catch (error) {
      if (page > 1 && /400|rest_post_invalid_page_number/i.test(String(error))) break;
      if (page === 1 && source.fallbackFeedUrl) {
        return discoverRss({ ...source, feedUrl: source.fallbackFeedUrl }, range, options);
      }
      throw error;
    }
    const posts = Array.isArray(json) ? json : [];
    results.push(...posts.map((post) => wordpressCandidate(source, post)));
    const totalPages = Number(response.headers.get("x-wp-totalpages") || 1);
    if (!posts.length || page >= totalPages) break;
    page += 1;
  }
  return results.slice(0, maximum);
}

function findGhostKey(html) {
  const $ = cheerio.load(html);
  const attributeKeys = [];
  $("[data-key], [data-ghost-search-key], [data-content-key]").each((_, element) => {
    attributeKeys.push(
      $(element).attr("data-key"),
      $(element).attr("data-ghost-search-key"),
      $(element).attr("data-content-key"),
    );
  });
  const candidates = [
    ...attributeKeys,
    ...[...html.matchAll(/(?:contentApiKey|content_api_key|searchKey|data-key)["':=\s]+([a-f0-9]{20,})/gi)].map(
      (match) => match[1],
    ),
    ...[...html.matchAll(/[?&]key=([a-f0-9]{20,})/gi)].map((match) => match[1]),
  ];
  return candidates.find((key) => /^[a-f0-9]{20,}$/i.test(String(key || ""))) || null;
}

async function discoverGhost(source, range, options) {
  const { text: homeHtml } = await fetchText(source.homeUrl, { delayMs: source.delayMs });
  const key = findGhostKey(homeHtml);
  if (!key) throw new Error("Could not find the public Ghost Content API key.");
  const url = new URL(source.apiBase);
  url.searchParams.set("key", key);
  url.searchParams.set(
    "filter",
    "published_at:>='" + range.start + "'+published_at:<'" + range.endExclusive + "'",
  );
  url.searchParams.set("limit", String(Math.min(100, options.candidateLimit)));
  url.searchParams.set("include", "tags,authors");
  url.searchParams.set("formats", "html,plaintext");
  const { json } = await fetchJson(url.href, { delayMs: source.delayMs });
  return (json.posts || []).map((post) => ({
    url: post.url,
    id: post.id,
    title: post.title,
    excerpt: post.custom_excerpt || post.excerpt,
    publishedAt: normalizeDateValue(post.published_at),
    publicationDay: post.published_at?.slice(0, 10) || null,
    publisherLocalDate: post.published_at || null,
    modifiedAt: normalizeDateValue(post.updated_at),
    prefetchedHtml: post.html,
    prefetchedText: post.plaintext,
    author: post.primary_author?.name || post.authors?.[0]?.name || null,
    terms: (post.tags || []).map((tag) => ({ name: tag.name, slug: tag.slug, taxonomy: "tag" })),
    leadImage: post.feature_image
      ? {
          url: post.feature_image,
          alt: post.feature_image_alt || "",
          caption: post.feature_image_caption || "",
        }
      : null,
    rawMetadata: { ghost_id: post.id },
  }));
}

async function sitemapEntries(url, source) {
  const { text } = await fetchText(url, { delayMs: source.delayMs });
  const $ = cheerio.load(text, { xmlMode: true });
  const childSitemaps = $("sitemap > loc")
    .map((_, element) => $(element).text().trim())
    .get();
  const entries = $("url")
    .map((_, element) => ({
      url: $(element).find("loc").first().text().trim(),
      lastmod: $(element).find("lastmod").first().text().trim() || null,
    }))
    .get();
  return { childSitemaps, entries };
}

async function discoverSitemap(source, range, options) {
  const root = await sitemapEntries(source.sitemapUrl, source);
  const maps = root.childSitemaps.length
    ? root.childSitemaps.filter((url) => !source.sitemapMatch || source.sitemapMatch.test(url))
    : [];
  const results = [];
  const addEntries = (entries) => {
    const ordered = [...entries].sort((left, right) => {
      const leftDate = urlDate(source, left.url) || normalizeDateValue(left.lastmod);
      const rightDate = urlDate(source, right.url) || normalizeDateValue(right.lastmod);
      return Date.parse(rightDate || 0) - Date.parse(leftDate || 0);
    });
    for (const entry of ordered) {
      const url = normalizeUrl(entry.url, source.homeUrl);
      if (!url || (source.articleMatch && !source.articleMatch.test(url))) continue;
      const publishedAt = urlDate(source, url);
      const changedAt = normalizeDateValue(entry.lastmod);
      if (publishedAt && !inRange(publishedAt, range)) continue;
      if (!publishedAt && changedAt && source.filterByLastmod && !inRange(changedAt, range)) continue;
      if (!publishedAt && changedAt && Date.parse(changedAt) < Date.parse(range.start) - 366 * 86_400_000) {
        continue;
      }
      results.push({ url, publishedAt, modifiedAt: changedAt });
      if (results.length >= options.candidateLimit) break;
    }
  };

  addEntries(root.entries);
  if (source.globalSitemapSort) {
    const groups = [];
    for (const mapUrl of maps) groups.push((await sitemapEntries(mapUrl, source)).entries);
    addEntries(groups.flat());
  } else {
    for (const mapUrl of maps) {
      if (results.length >= options.candidateLimit) break;
      addEntries((await sitemapEntries(mapUrl, source)).entries);
    }
  }
  return uniqueBy(results, (item) => item.url);
}

function listingLinks(html, baseUrl, source) {
  const $ = cheerio.load(html);
  const results = [];
  const scope = source.listingSelector ? $(source.listingSelector) : $.root();
  scope.find("a[href]").each((_, anchor) => {
    const url = normalizeUrl($(anchor).attr("href"), baseUrl);
    if (!url || (source.articleMatch && !source.articleMatch.test(url))) return;
    const container = $(anchor).closest(
      source.cardSelector ||
        "article, li, .views-row, .c-card, .card, .news-item, .item, .field__item",
    );
    const time = container.find("time").first();
    const listingText = container.text().replace(/\s+/g, " ").trim();
    const publishedAt =
      normalizeDateValue(time.attr("datetime")) ||
      parseDateFromText(time.text()) ||
      (source.useLastListingDate ? parseLastDateFromText(listingText) : parseDateFromText(listingText));
    results.push({
      url,
      title: $(anchor).attr("title") || $(anchor).text().trim(),
      publishedAt,
      listingText,
    });
  });
  return uniqueBy(results, (item) => item.url);
}

async function discoverMonthly(source, range, options) {
  const results = [];
  for (const month of rangeMonths(range)) {
    for (let page = 0; page < 30 && results.length < options.candidateLimit; page += 1) {
      const base = source.monthUrl.replace("{yyyymm}", month.yyyymm);
      const url = new URL(base);
      if (page) {
        url.searchParams.set("monthly/" + month.yyyymm, "");
        url.searchParams.set("page", String(page));
      }
      const { text } = await fetchText(url.href, { delayMs: source.delayMs });
      const items = listingLinks(text, url.href, source);
      const unseen = items.filter((item) => !results.some((known) => known.url === item.url));
      results.push(...unseen.filter((item) => !item.publishedAt || inRange(item.publishedAt, range)));
      if (!unseen.length || items.length === 0) break;
    }
  }
  return results.slice(0, options.candidateLimit);
}

async function discoverSingleIndex(source, range, options) {
  const { text } = await fetchText(source.indexUrl, { delayMs: source.delayMs });
  return listingLinks(text, source.indexUrl, source)
    .filter((item) =>
      source.requireListingDate
        ? item.publishedAt && inRange(item.publishedAt, range)
        : !item.publishedAt || inRange(item.publishedAt, range),
    )
    .slice(0, options.candidateLimit);
}

async function discoverPaginated(source, range, options) {
  const results = [];
  let page = source.startPage || 0;
  for (let requestCount = 0; requestCount < 100 && results.length < options.candidateLimit; requestCount += 1) {
    const url = source.listingUrl.replace("{page}", String(page));
    const { text } = await fetchText(url, { delayMs: source.delayMs });
    const items = listingLinks(text, url, source);
    const unseen = items.filter((item) => !results.some((known) => known.url === item.url));
    const inWindow = unseen.filter((item) => !item.publishedAt || inRange(item.publishedAt, range));
    results.push(...inWindow);
    const dated = items.map((item) => item.publishedAt).filter(Boolean).map(Date.parse);
    const oldest = dated.length ? Math.min(...dated) : null;
    if (!unseen.length || !items.length || (oldest && oldest < Date.parse(range.start))) break;
    page += 1;
  }
  return results.slice(0, options.candidateLimit);
}

async function discoverFcpsBoard(source, range, options) {
  const candidates = await discoverPaginated(source, range, {
    ...options,
    candidateLimit: Math.max(options.candidateLimit, 50),
  });
  const obvious = candidates.filter((item) => source.recordFilter.test(item.listingText || ""));
  return [...obvious, ...candidates.filter((item) => !obvious.includes(item))].slice(
    0,
    Math.max(options.candidateLimit, 50),
  );
}

async function discoverPatch(source, range, options) {
  const results = [];
  for (let page = 1; page <= 50 && results.length < options.candidateLimit; page += 1) {
    const url = source.listingUrl.replace("{page}", String(page));
    const { text } = await fetchText(url, { delayMs: source.delayMs });
    const $ = cheerio.load(text);
    const raw = $("#__NEXT_DATA__").text();
    if (!raw) throw new Error("Patch page did not contain __NEXT_DATA__.");
    const data = JSON.parse(raw);
    const feed = data.props?.pageProps?.mainContent?.newsfeed || [];
    const items = feed
      .filter((item) => item.type === "article")
      .filter((item) => !source.localAlias || item.patch?.alias === source.localAlias)
      .map((item) => ({
        url: normalizeUrl(item.canonicalUrl || item.url, source.homeUrl),
        id: String(item.id || ""),
        title: item.title,
        excerpt: item.description || item.dek,
        publishedAt: normalizeDateValue(item.created),
        modifiedAt: normalizeDateValue(item.updated),
        author: item.author?.name || item.byline || null,
        rawMetadata: { patch: item.patch, patch_id: item.id },
      }))
      .filter((item) => item.url && (!item.publishedAt || inRange(item.publishedAt, range)));
    results.push(...items);
    const dates = feed.map((item) => normalizeDateValue(item.created)).filter(Boolean).map(Date.parse);
    if (!feed.length || (dates.length && Math.min(...dates) < Date.parse(range.start))) break;
  }
  return uniqueBy(results, (item) => item.url).slice(0, options.candidateLimit);
}

async function discoverWmata(source, range, options) {
  const url = new URL(source.apiUrl);
  url.searchParams.set("offset", "0");
  url.searchParams.set("limit", String(Math.min(100, options.candidateLimit)));
  url.searchParams.set("dateRangeStart", range.start.slice(0, 10));
  url.searchParams.set("dateRangeEnd", new Date(Date.parse(range.endExclusive) - 1).toISOString().slice(0, 10));
  const { json } = await fetchJson(url.href, { delayMs: source.delayMs });
  const items = json.results || json.items || [];
  return items
    .map((item) => ({
      url: normalizeUrl(item.url || item.path || item.properties?.url, source.homeUrl),
      title: item.title || item.properties?.title,
      excerpt: item.description || item.properties?.description,
      publishedAt: normalizeDateValue(
        item.properties?.publishedDateEpoch || item.properties?.publishedDate || item.publishedDate,
      ),
      rawMetadata: { wmata: item.properties || {} },
    }))
    .filter((item) => item.url && (!item.publishedAt || inRange(item.publishedAt, range)))
    .slice(0, options.candidateLimit);
}

async function discoverRenderedPdfs(source, range, options) {
  const links = await renderedPdfLinks(source.homeUrl, new Date(range.endExclusive).getUTCFullYear());
  return uniqueBy(
    links
      .map((item) => {
        const url = normalizeUrl(item.url, source.homeUrl);
        return {
          url,
          title: item.title,
          publishedAt:
            parseDateFromText(item.context) ||
            parseDateFromText(item.title) ||
            parseDateFromText(decodeURIComponent(url || "")),
          documentType: "pdf",
        };
      })
      .filter((item) => item.url && source.linkMatch.test(item.url))
      .filter((item) => item.publishedAt && inRange(item.publishedAt, range)),
    (item) => item.url,
  ).slice(0, options.candidateLimit);
}

async function discoverRss(source, range, options) {
  const { text } = await fetchText(source.feedUrl, { delayMs: source.delayMs });
  const $ = cheerio.load(text, { xmlMode: true });
  return $("item")
    .map((_, item) => {
      const node = $(item);
      const publishedAt = normalizeDateValue(node.find("pubDate").first().text());
      return {
        url: normalizeUrl(node.find("link").first().text(), source.homeUrl),
        title: node.find("title").first().text(),
        excerpt: node.find("description").first().text(),
        publishedAt,
        prefetchedHtml: node.find("content\\:encoded").first().text() || null,
        rawMetadata: { guid: node.find("guid").first().text() || null },
      };
    })
    .get()
    .filter((item) => item.url && (!item.publishedAt || inRange(item.publishedAt, range)))
    .slice(0, options.candidateLimit);
}

function likelyArchivedArticle(original) {
  try {
    const url = new URL(original);
    const path = url.pathname.toLowerCase();
    if (path === "/" || path === "") return false;
    if (
      /\/(feed|tag|category|author|page|wp-json|search|about|contact|account|directory|business|classifieds)\//.test(
        path,
      )
    ) {
      return false;
    }
    if (/\.(jpg|jpeg|png|gif|webp|css|js|xml|pdf)$/i.test(path)) return false;
    return path.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

function archivedOriginalDate(original) {
  try {
    const match = new URL(original).pathname.match(/\/(20\d{2})\/(\d{2})\/(\d{2})\//);
    return match ? asIsoDate(match[1] + "-" + match[2] + "-" + match[3] + "T12:00:00Z") : null;
  } catch {
    return null;
  }
}

async function discoverWayback(source, range, options) {
  const patterns = [];
  if (source.archiveUrlByPublicationYear) {
    const startYear = new Date(range.start).getUTCFullYear();
    const endYear = new Date(Date.parse(range.endExclusive) - 1).getUTCFullYear();
    for (let year = startYear; year <= endYear; year += 1) {
      patterns.push(source.archiveUrlByPublicationYear.replace("{year}", String(year)));
    }
  } else {
    patterns.push(source.archiveUrlPattern || source.archiveHost + "/*");
  }

  const rows = [];
  for (const pattern of patterns) {
    const url = new URL("https://web.archive.org/cdx/search/cdx");
    url.searchParams.set("url", pattern);
    if (!source.archiveUrlByPublicationYear) {
      url.searchParams.set("from", range.start.slice(0, 10).replaceAll("-", ""));
      url.searchParams.set(
        "to",
        new Date(Date.parse(range.endExclusive) - 1).toISOString().slice(0, 10).replaceAll("-", ""),
      );
    }
    url.searchParams.set("output", "json");
    url.searchParams.append("filter", "statuscode:200");
    url.searchParams.append("filter", "mimetype:text/html");
    url.searchParams.set("collapse", "urlkey");
    url.searchParams.set("fl", "timestamp,original,statuscode,mimetype,digest");
    url.searchParams.set("limit", String(Math.max(100, options.candidateLimit * 20)));
    const { json } = await fetchJson(url.href, {
      timeoutMs: 60_000,
      retries: 4,
      retryDelayMs: 3_000,
      delayMs: source.delayMs,
    });
    if (Array.isArray(json)) rows.push(...json.slice(1));
    if (rows.length >= options.candidateLimit) break;
  }

  return rows
    .map(([timestamp, original]) => ({
      url: "https://web.archive.org/web/" + timestamp + "id_/" + original,
      originalUrl: original,
      publishedAt: archivedOriginalDate(original),
      archiveCapturedAt: asIsoDate(
        timestamp.slice(0, 4) +
          "-" +
          timestamp.slice(4, 6) +
          "-" +
          timestamp.slice(6, 8) +
          "T" +
          timestamp.slice(8, 10) +
          ":" +
          timestamp.slice(10, 12) +
          ":" +
          timestamp.slice(12, 14) +
          "Z",
      ),
    }))
    .filter((item) => likelyArchivedArticle(item.originalUrl))
    .filter((item) => !item.publishedAt || inRange(item.publishedAt, range))
    .filter(
      (item, index, items) =>
        items.findIndex((candidate) => candidate.originalUrl === item.originalUrl) === index,
    )
    .slice(0, options.candidateLimit);
}

async function discoverReferencePages(source, _range, options) {
  return source.referenceUrls.slice(0, options.candidateLimit).map((url) => ({ url }));
}

export async function discover(source, range, options = {}) {
  const settings = {
    candidateLimit: Math.max(1, options.candidateLimit || 20),
    strictScope: Boolean(options.strictScope),
  };
  switch (source.strategy) {
    case "wordpress":
      return discoverWordpress(source, range, settings);
    case "ghost":
      return discoverGhost(source, range, settings);
    case "sitemap":
      return discoverSitemap(source, range, settings);
    case "monthly-html":
      return discoverMonthly(source, range, settings);
    case "single-index":
      return discoverSingleIndex(source, range, settings);
    case "paginated-html":
      return discoverPaginated(source, range, settings);
    case "fcps-board":
      return discoverFcpsBoard(source, range, settings);
    case "patch-next":
      return discoverPatch(source, range, settings);
    case "wmata":
      return discoverWmata(source, range, settings);
    case "rendered-pdf-links":
      return discoverRenderedPdfs(source, range, settings);
    case "rss":
      return discoverRss(source, range, settings);
    case "wayback":
      return discoverWayback(source, range, settings);
    case "reference-pages":
      return discoverReferencePages(source, range, settings);
    default:
      throw new Error("Unsupported discovery strategy: " + source.strategy);
  }
}

export const discoveryInternals = {
  findGhostKey,
  listingLinks,
  likelyArchivedArticle,
  urlDate,
};
