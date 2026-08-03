import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { closeBrowser } from "./scrapers/browser.mjs";
import { asDay, inRange, nextDay, writeJson } from "./scrapers/core.mjs";
import { discover } from "./scrapers/discover.mjs";
import { extractCandidate } from "./scrapers/extract.mjs";
import { appendRunLog, createRunLogEntry } from "./scrapers/run-log.mjs";
import { getSource, SOURCES } from "./scrapers/sources.mjs";
import { storeRecord } from "./scrapers/store.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(values) {
  const options = {
    sourceIds: [],
    limit: 100,
    outputRoot: path.join(rootDir, "input"),
    downloadImages: true,
    maxImages: 12,
    strictScope: false,
    smoke: false,
    list: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const next = () => values[++index];
    if (value === "--source") options.sourceIds.push(...String(next()).split(",").filter(Boolean));
    else if (value === "--all") options.sourceIds = SOURCES.map((source) => source.id);
    else if (value === "--date") options.date = next();
    else if (value === "--start") options.start = next();
    else if (value === "--end-exclusive") options.endExclusive = next();
    else if (value === "--limit") options.limit = Number(next());
    else if (value === "--output") options.outputRoot = path.resolve(rootDir, next());
    else if (value === "--max-images") options.maxImages = Number(next());
    else if (value === "--no-download-images") options.downloadImages = false;
    else if (value === "--strict-scope") options.strictScope = true;
    else if (value === "--smoke") options.smoke = true;
    else if (value === "--list") options.list = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error("Unknown argument: " + value);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  npm run scrape:list",
    "  npm run scrape -- --source ffxnow --date 2026-07-20",
    "  npm run scrape -- --all --start 2026-07-01 --end-exclusive 2026-08-01",
    "  npm run scrape:smoke",
    "",
    "Options:",
    "  --source ID[,ID]       Select one or more sources.",
    "  --all                   Select every source.",
    "  --date YYYY-MM-DD       Collect one calendar day.",
    "  --start YYYY-MM-DD      Inclusive range start.",
    "  --end-exclusive DATE    Exclusive range end.",
    "  --limit N               Maximum saved records per source (default 100).",
    "  --output PATH           Output root (default input).",
    "  --max-images N          Maximum photos per article (default 12).",
    "  --no-download-images    Keep photo metadata/URLs without downloading files.",
    "  --strict-scope          Apply optional Tysons tag filters on broad publishers.",
    "",
    "Set TYSONS_SCRAPER_USER_AGENT to a truthful contact-bearing crawler user agent.",
  ].join("\n");
}

function dateRange(options) {
  if (options.date) {
    return {
      start: options.date + "T00:00:00-04:00",
      endExclusive: nextDay(options.date) + "T00:00:00-04:00",
    };
  }
  if (options.start && options.endExclusive) {
    return {
      start: options.start + (options.start.includes("T") ? "" : "T00:00:00-04:00"),
      endExclusive:
        options.endExclusive + (options.endExclusive.includes("T") ? "" : "T00:00:00-04:00"),
    };
  }
  throw new Error("Choose --date or provide both --start and --end-exclusive.");
}

function defaultSmokeRange(source) {
  if (source.smokeRange) return source.smokeRange;
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 550);
  return { start: start.toISOString(), endExclusive: end.toISOString() };
}

function recordMatchesSource(source, record) {
  if (!source.recordFilter) return true;
  const terms = (record.terms || []).map((term) => term.name).join(" ");
  return source.recordFilter.test([record.title, record.dek, terms, record.body_text].join("\n"));
}

function recordMatchesRange(source, record, range) {
  if (source.strategy === "reference-pages") return true;
  if (!record.published_at) return true;
  return inRange(record.published_at, range);
}

async function runSource(source, range, options) {
  if (source.strategy === "reference-pages" && !options.smoke) {
    return {
      source_id: source.id,
      name: source.name,
      strategy: source.strategy,
      range,
      discovered: 0,
      saved: [],
      failures: [],
      status: "no-matches",
    };
  }
  const candidateLimit = Math.max(
    options.limit *
      (source.recordFilter ? 40 : source.strategy === "sitemap" ? 12 : source.strategy === "wayback" ? 5 : 5),
    source.recordFilter ? 50 : source.strategy === "wayback" ? 5 : 20,
  );
  const candidates = await discover(source, range, {
    candidateLimit,
    strictScope: options.strictScope,
  });
  const saved = [];
  const failures = [];

  for (const candidate of candidates) {
    if (saved.length >= options.limit) break;
    try {
      const record = await extractCandidate(source, candidate);
      if (!recordMatchesSource(source, record) || !recordMatchesRange(source, record, range)) continue;
      if (record.quality.characters < 80 && source.strategy !== "reference-pages") {
        throw new Error("Cleaned article body is only " + record.quality.characters + " characters.");
      }
      const stored = await storeRecord(source, record, options);
      saved.push({
        url: record.canonical_url,
        title: record.title,
        published_at: record.published_at,
        characters: record.quality.characters,
        images: record.images.length,
        output: path.relative(rootDir, stored.articleDir),
        data_bytes: stored.stats.total_bytes,
        image_bytes: stored.stats.image_bytes,
        lossless_compression: stored.stats.lossless_compression,
      });
    } catch (error) {
      failures.push({ url: candidate.url, error: String(error.message || error) });
    }
  }

  return {
    source_id: source.id,
    name: source.name,
    strategy: source.strategy,
    range,
    discovered: candidates.length,
    saved,
    failures,
    status: saved.length ? "passed" : options.requireMatch || failures.length ? "failed" : "no-matches",
  };
}

async function runSmoke(options) {
  const smokeRoot = path.join(rootDir, ".cache", "scraper-smoke");
  await mkdir(smokeRoot, { recursive: true });
  const results = [];
  const selectedSources = options.sourceIds.length ? options.sourceIds.map(getSource) : SOURCES;
  for (const [index, source] of selectedSources.entries()) {
    process.stdout.write(
      "[" + (index + 1) + "/" + selectedSources.length + "] " + source.id + " ... ",
    );
    const started = Date.now();
    try {
      const result = await runSource(source, defaultSmokeRange(source), {
        ...options,
        outputRoot: smokeRoot,
        limit: 1,
        maxImages: 3,
        downloadImages: false,
        requireMatch: true,
      });
      result.elapsed_ms = Date.now() - started;
      results.push(result);
      console.log(result.status + " (" + result.discovered + " discovered, " + result.saved.length + " saved)");
    } catch (error) {
      results.push({
        source_id: source.id,
        name: source.name,
        strategy: source.strategy,
        status: "failed",
        discovered: 0,
        saved: [],
        failures: [{ url: source.homeUrl, error: String(error.message || error) }],
        elapsed_ms: Date.now() - started,
      });
      console.log("failed");
    }
  }
  const summary = {
    tested_at: new Date().toISOString(),
    selected_sources: selectedSources.map((source) => source.id),
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
  await writeJson(path.join(smokeRoot, "summary.json"), summary);
  console.log(
    "\nSmoke result: " +
      summary.passed +
      " passed, " +
      summary.failed +
      " failed. Details: " +
      path.relative(rootDir, path.join(smokeRoot, "summary.json")),
  );
  if (summary.failed) process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.list) {
    for (const source of SOURCES) console.log(source.id.padEnd(46) + source.strategy);
    return;
  }
  if (options.smoke) {
    await runSmoke(options);
    return;
  }
  if (!options.sourceIds.length) throw new Error("Choose --source ID or --all.\n\n" + usage());
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("--limit must be at least 1.");
  if (!Number.isInteger(options.maxImages) || options.maxImages < 0) {
    throw new Error("--max-images must be zero or greater.");
  }
  const range = dateRange(options);
  const runStartedAt = new Date();
  const runStarted = Date.now();
  const results = [];
  for (const id of options.sourceIds) {
    const source = getSource(id);
    console.log("Collecting " + source.name + "...");
    let result;
    try {
      result = await runSource(source, range, options);
    } catch (error) {
      result = {
        source_id: source.id,
        name: source.name,
        strategy: source.strategy,
        range,
        discovered: 0,
        saved: [],
        failures: [{ url: source.homeUrl, error: String(error.message || error) }],
        status: "failed",
      };
    }
    results.push(result);
    console.log(
      "  " +
        result.saved.length +
        " saved from " +
        result.discovered +
        " candidates" +
        (result.failures.length ? "; " + result.failures.length + " extraction failures" : ""),
    );
    if (result.status === "failed") process.exitCode = 1;
  }
  const savedRecords = results.flatMap((result) => result.saved);
  const losslessCompression = savedRecords.reduce(
    (total, record) => {
      const compression = record.lossless_compression || {};
      total.images_examined += Number(compression.images_examined || 0);
      total.eligible_images += Number(compression.eligible_images || 0);
      total.optimized_images += Number(compression.optimized_images || 0);
      total.bytes_before += Number(compression.bytes_before || 0);
      total.bytes_after += Number(compression.bytes_after || 0);
      total.bytes_saved += Number(compression.bytes_saved || 0);
      return total;
    },
    {
      images_examined: 0,
      eligible_images: 0,
      optimized_images: 0,
      bytes_before: 0,
      bytes_after: 0,
      bytes_saved: 0,
    },
  );
  const summary = {
    started_at: runStartedAt.toISOString(),
    collected_at: new Date().toISOString(),
    elapsed_ms: Date.now() - runStarted,
    range,
    limit_per_source: options.limit,
    selected_sources: options.sourceIds,
    sources_with_articles: results.filter((result) => result.saved.length).length,
    total_saved: savedRecords.length,
    data_bytes: savedRecords.reduce((total, record) => total + Number(record.data_bytes || 0), 0),
    image_bytes: savedRecords.reduce((total, record) => total + Number(record.image_bytes || 0), 0),
    lossless_compression: losslessCompression,
    failed_sources: results.filter((result) => result.status === "failed").map((result) => result.source_id),
    results,
  };
  const runLogPath = path.join(options.outputRoot, "scrape-runs.jsonl");
  summary.run_log = path.relative(rootDir, runLogPath);
  await appendRunLog(runLogPath, createRunLogEntry(summary, options.outputRoot, rootDir));
  const summaryPath = path.join(rootDir, ".cache", "scrape-run-summary.json");
  await writeJson(summaryPath, summary);
  console.log(
    "\nCollection result: " +
      summary.total_saved +
      " articles from " +
      summary.sources_with_articles +
      " sources; " +
      summary.failed_sources.length +
      " source failures; " +
      (summary.data_bytes / 1024 / 1024).toFixed(2) +
      " MiB stored. Details: " +
      path.relative(rootDir, summaryPath),
  );
  console.log("Run log: " + path.relative(rootDir, runLogPath));
}

try {
  await main();
} finally {
  await closeBrowser();
}
