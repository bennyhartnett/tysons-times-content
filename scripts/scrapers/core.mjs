import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export const DEFAULT_USER_AGENT =
  process.env.TYSONS_SCRAPER_USER_AGENT ||
  "TysonsTimesResearchBot/0.1 (+https://tysonstimes.org/; research collection)";

const lastRequestByOrigin = new Map();

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function asIsoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function asDay(value) {
  return asIsoDate(value)?.slice(0, 10) || null;
}

export function nextDay(day) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function inRange(value, range) {
  if (!value) return true;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return true;
  return timestamp >= Date.parse(range.start) && timestamp < Date.parse(range.endExclusive);
}

export function normalizeUrl(value, baseUrl) {
  if (!value || /^(data|blob|javascript|mailto|tel):/i.test(value)) return null;
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function slugify(value) {
  return String(value || "article")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "article";
}

export function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function cleanText(value) {
  return decodeEntities(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function uniqueBy(items, selector) {
  const seen = new Set();
  return items.filter((item) => {
    const key = selector(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function throttle(url, delayMs) {
  if (!delayMs) return;
  const origin = new URL(url).origin;
  const elapsed = Date.now() - (lastRequestByOrigin.get(origin) || 0);
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastRequestByOrigin.set(origin, Date.now());
}

export async function request(url, options = {}) {
  const {
    delayMs = 0,
    timeoutMs = 25_000,
    retries = 2,
    retryDelayMs = 500,
    headers = {},
    ...fetchOptions
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await throttle(url, delayMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        ...fetchOptions,
        headers: {
          "user-agent": DEFAULT_USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.8",
          ...headers,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000;
        await sleep(Math.max(retryAfter, retryDelayMs * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(response.status + " " + response.statusText + " for " + url);
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function fetchText(url, options) {
  const response = await request(url, options);
  return { text: await response.text(), response };
}

export async function fetchJson(url, options) {
  const response = await request(url, options);
  return { json: await response.json(), response };
}

export async function fetchBuffer(url, options) {
  const response = await request(url, options);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, response };
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function parseDateFromText(value) {
  const text = cleanText(value);
  const iso = text.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/)?.[0];
  if (iso) return asIsoDate(iso + "T12:00:00Z");
  const numeric = text.match(/\b(0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])[-/](20\d{2})\b/);
  if (numeric) {
    return asIsoDate(
      numeric[3] +
        "-" +
        numeric[1].padStart(2, "0") +
        "-" +
        numeric[2].padStart(2, "0") +
        "T12:00:00Z",
    );
  }
  const named = text.match(
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},\s+20\d{2}\b/i,
  )?.[0];
  return named ? asIsoDate(named) : null;
}

export function parseLastDateFromText(value) {
  const text = cleanText(value);
  const matches =
    text.match(
      /\b(?:20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])[-/]20\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},\s+20\d{2})/gi,
    ) || [];
  return matches.length ? parseDateFromText(matches.at(-1)) : null;
}

export function rangeMonths(range) {
  const results = [];
  const cursor = new Date(range.start);
  cursor.setUTCDate(1);
  const end = new Date(range.endExclusive);
  while (cursor < end) {
    results.push({
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      yyyymm: String(cursor.getUTCFullYear()) + String(cursor.getUTCMonth() + 1).padStart(2, "0"),
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return results;
}
