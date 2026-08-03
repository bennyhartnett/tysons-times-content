import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

export const LOCAL_ORIGIN = "http://127.0.0.1:5173";
export const PROD_ORIGIN = "https://tysonstimes.org";
export const FEED_ORIGIN = "https://bennyhartnett.github.io/tysons-times-content";

export function isWithin(root, target, allowRoot = false) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (allowRoot && relative === "") || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function requireIsoDate(value, label = "date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) throw new Error(`${label} must use YYYY-MM-DD.`);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${label} is not a valid calendar date.`);
  }
  return value;
}

export function addCalendarDays(value, days) {
  requireIsoDate(value);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function validateDateRange(start, endInclusive) {
  requireIsoDate(start, "Start date");
  requireIsoDate(endInclusive, "End date");
  if (start > endInclusive) throw new Error("Start date must be on or before the end date.");
  return { start, endInclusive, endExclusive: addCalendarDays(endInclusive, 1) };
}

export function positiveInteger(value, label, maximum = 500) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${label} must be a whole number from 1 to ${maximum}.`);
  }
  return number;
}

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function findNamedFiles(directory, filename) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const results = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await findNamedFiles(target, filename));
    else if (entry.isFile() && entry.name === filename) results.push(target);
  }
  return results.sort();
}

export function articleLinks(slug) {
  return {
    localUrl: `${LOCAL_ORIGIN}/#/article/${encodeURIComponent(slug)}`,
    productionUrl: `${PROD_ORIGIN}/#/article/${encodeURIComponent(slug)}`,
  };
}

function compactText(value, maximum = 180) {
  const clean = String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 3).trim()}...`;
}

export async function readScrapeHistory(historyPath) {
  let text;
  try {
    text = await readFile(historyPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      const record = JSON.parse(line);
      return { ...record, historyLine: index + 1 };
    } catch (error) {
      return { historyLine: index + 1, invalid: true, error: error.message, raw: compactText(line) };
    }
  }).reverse();
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function scanUnprocessed(inputRoot) {
  const records = [];
  for (const file of await findNamedFiles(inputRoot, "metadata.json")) {
    const relative = path.relative(inputRoot, file);
    const parts = relative.split(path.sep);
    const queueIndex = parts.indexOf("unprocessed-articles");
    if (queueIndex < 0) continue;
    const metadata = await readJson(file);
    const directory = path.dirname(file);
    const details = await stat(file);
    records.push({
      id: relative.replaceAll(path.sep, "/"),
      path: directory,
      sourceId: metadata.source_id || parts[0],
      sourceName: metadata.source_name || parts[0],
      title: compactText(metadata.title || path.basename(directory)),
      published: String(metadata.publication_day || metadata.published_at || "").slice(0, 10),
      sourceUrl: metadata.canonical_url || metadata.source_url || null,
      images: Array.isArray(metadata.images) ? metadata.images.length : 0,
      words: metadata.quality?.words || null,
      updatedAt: details.mtime.toISOString(),
    });
  }
  return records.sort((a, b) => (b.published || b.updatedAt).localeCompare(a.published || a.updatedAt));
}

export async function scanArticleQueue(contentRoot, gitChangedPaths = new Set()) {
  const staging = [];
  const ready = [];
  for (const file of await findNamedFiles(contentRoot, "article.md")) {
    const parsed = matter(await readFile(file, "utf8"));
    const relative = path.relative(contentRoot, file).replaceAll(path.sep, "/");
    const slug = path.basename(path.dirname(file));
    const record = {
      id: relative,
      path: file,
      directory: path.dirname(file),
      slug,
      section: relative.split("/")[0],
      title: compactText(parsed.data.title || slug),
      published: String(parsed.data.published || "").slice(0, 10),
      status: parsed.data.status || "unknown",
      ...articleLinks(slug),
    };
    if (record.status === "rewrite") staging.push(record);
    else if (record.status === "published") {
      const directoryPrefix = path.posix.dirname(relative);
      if ([...gitChangedPaths].some((changed) => changed === relative || changed.startsWith(`${directoryPrefix}/`))) ready.push(record);
    }
  }
  const sort = (a, b) => (b.published || "").localeCompare(a.published || "") || a.title.localeCompare(b.title);
  return { staging: staging.sort(sort), ready: ready.sort(sort) };
}

export function publicJob(job) {
  if (!job) return null;
  const { child, ...safe } = job;
  return safe;
}

export function sourceGroup(source) {
  const id = source.id;
  if (/school|highlander|saxon|rank-and-file|fcps/.test(id)) return "Schools";
  if (/county|city-of|town-of|fcpd|wmata/.test(id)) return "Public agencies";
  if (/community|mclean|tysons-community/.test(id)) return "Community";
  return "Local news";
}
