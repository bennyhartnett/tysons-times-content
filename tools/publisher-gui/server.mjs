import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES } from "../../scripts/scrapers/sources.mjs";
import { prepareArticles } from "../../scripts/prepare-publish.mjs";
import {
  FEED_ORIGIN,
  LOCAL_ORIGIN,
  PROD_ORIGIN,
  findNamedFiles,
  isWithin,
  pathExists,
  positiveInteger,
  publicJob,
  readScrapeHistory,
  scanArticleQueue,
  scanUnprocessed,
  sourceGroup,
  validateDateRange,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..", "..");
const contentRoot = path.join(rootDir, "content", "articles");
const inputRoot = path.join(rootDir, "input");
const previewRoot = path.join(rootDir, ".cache", "publisher-preview", "dist");
const siteRoot = path.resolve(rootDir, "..", "tysonstimes.org");
const publicRoot = path.join(here, "public");
const host = "127.0.0.1";
const port = Number(process.env.PUBLISHER_PORT || 4784);
const npmCommand = process.execPath;
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

let currentJob = null;
let lastJob = null;
let lastLinks = [];
let localProcess = null;
let localStartedAt = null;
let shuttingDown = false;

const sourceList = SOURCES.map(({ id, name, homeUrl, strategy }) => ({ id, name, homeUrl, strategy, group: sourceGroup({ id }) }));

function timestamp() {
  return new Date().toISOString();
}

function log(message, kind = "info") {
  if (!currentJob) return;
  const clean = String(message).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").trim();
  if (!clean) return;
  for (const line of clean.split("\n")) currentJob.logs.push({ at: timestamp(), kind, message: line });
  if (currentJob.logs.length > 1200) currentJob.logs.splice(0, currentJob.logs.length - 1200);
}

function step(name, status, detail = "") {
  if (!currentJob) return;
  const existing = currentJob.steps.find((item) => item.name === name);
  if (existing) Object.assign(existing, { status, detail });
  else currentJob.steps.push({ name, status, detail });
}

function run(command, args, { cwd = rootDir, env = {}, label = args.join(" "), allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    log(`› ${label}`, "command");
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (currentJob) currentJob.child = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString("utf8");
      stdout += value;
      log(value, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString("utf8");
      stderr += value;
      log(value, "stderr");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (currentJob?.child === child) currentJob.child = null;
      const result = { code, signal, stdout, stderr };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error((stderr || stdout || `${label} exited with code ${code}.`).trim()));
    });
  });
}

async function commandOutput(command, args, options = {}) {
  return run(command, args, { ...options, label: options.label || `${path.basename(command)} ${args.join(" ")}` });
}

function silentRun(command, args, { cwd = rootDir } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || stdout || `Command exited ${code}`).trim())));
  });
}

async function gitChangedPaths() {
  const result = await silentRun("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "content/articles"]);
  const paths = new Set();
  const relativeToContent = (value) => {
    const normalized = String(value || "").replaceAll("\\", "/");
    return normalized.startsWith("content/articles/") ? normalized.slice("content/articles/".length) : normalized;
  };
  const entries = result.stdout.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    paths.add(relativeToContent(entry.slice(3)));
    if (status.includes("R") || status.includes("C")) paths.add(relativeToContent(entries[++index]));
  }
  return paths;
}

async function queues() {
  const [unprocessed, changed] = await Promise.all([scanUnprocessed(inputRoot), gitChangedPaths()]);
  const articles = await scanArticleQueue(contentRoot, changed);
  return { unprocessed, ...articles };
}

async function state() {
  const [queueState, history] = await Promise.all([
    queues(),
    readScrapeHistory(path.join(inputRoot, "scrape-runs.jsonl")),
  ]);
  return {
    now: timestamp(),
    sources: sourceList,
    queues: queueState,
    history,
    job: publicJob(currentJob || lastJob),
    local: {
      running: Boolean(localProcess && localProcess.exitCode === null),
      startedAt: localStartedAt,
      url: LOCAL_ORIGIN,
    },
    production: { url: PROD_ORIGIN, feedUrl: FEED_ORIGIN },
    links: lastLinks,
  };
}

function newJob(type, title, worker) {
  if (currentJob) throw new Error(`“${currentJob.title}” is already running.`);
  currentJob = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    title,
    status: "running",
    startedAt: timestamp(),
    finishedAt: null,
    summary: "Starting…",
    steps: [],
    logs: [],
    result: null,
    child: null,
    cancelRequested: false,
  };
  const job = currentJob;
  Promise.resolve().then(() => worker(job)).then((result) => {
    if (job.cancelRequested) {
      job.status = "cancelled";
      job.summary = "Cancelled";
    } else {
      job.status = "succeeded";
      job.summary = result?.summary || "Completed successfully";
      job.result = result || null;
    }
  }).catch((error) => {
    job.status = job.cancelRequested ? "cancelled" : "failed";
    job.summary = job.cancelRequested ? "Cancelled" : error.message;
    log(error.stack || error.message, "error");
  }).finally(() => {
    job.finishedAt = timestamp();
    delete job.child;
    lastJob = job;
    if (currentJob === job) currentJob = null;
  });
  return publicJob(job);
}

async function rebuildPreview(imageMode = "source") {
  step("Build local preview", "running", "Preparing production-shaped copies of staged drafts");
  await commandOutput(process.execPath, [path.join(rootDir, "scripts", "build-preview-content.mjs"), "--image-mode", imageMode], {
    label: `Build local preview (${imageMode === "source" ? "source photos" : "house illustration"})`,
  });
  step("Build local preview", "complete", "Preview feed is current");
}

async function rewriteBundles(bundlePaths) {
  const before = new Set((await scanArticleQueue(contentRoot)).staging.map((article) => article.id));
  const created = [];
  step("Rewrite articles", "running", `${bundlePaths.length} source bundle${bundlePaths.length === 1 ? "" : "s"}`);
  for (let index = 0; index < bundlePaths.length; index += 1) {
    if (currentJob?.cancelRequested) throw new Error("Job cancelled.");
    const bundlePath = bundlePaths[index];
    log(`Rewriting ${index + 1} of ${bundlePaths.length}: ${path.basename(bundlePath)}`);
    await commandOutput(process.execPath, [path.join(rootDir, "scripts", "rewrite-articles.mjs"), "--provider", "auto", "--article", bundlePath], {
      label: `Rewrite ${path.basename(bundlePath)}`,
    });
    const staged = (await scanArticleQueue(contentRoot)).staging;
    for (const article of staged) {
      if (!before.has(article.id) && !created.some((item) => item.id === article.id)) created.push(article);
    }
  }
  step("Rewrite articles", "complete", `${created.length} draft${created.length === 1 ? "" : "s"} created`);
  return created;
}

async function verifyLive(ids) {
  step("Verify live feed", "running", "Waiting for every new article ID");
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const response = await fetch(`${FEED_ORIGIN}/index.json?publisher=${Date.now()}`, { cache: "no-store" });
    if (response.ok) {
      const articles = await response.json();
      const liveIds = new Set(articles.map((article) => article.id));
      if (ids.every((id) => liveIds.has(id))) {
        step("Verify live feed", "complete", `${ids.length} article${ids.length === 1 ? "" : "s"} live`);
        return;
      }
    }
    log(`Live feed check ${attempt}/12 is still waiting…`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000 * attempt, 20000)));
  }
  throw new Error("GitHub Pages completed, but one or more article IDs did not appear in the live feed in time.");
}

async function waitForDeployment(sha, ids) {
  step("Publish GitHub Pages", "running", "Waiting for the main-branch workflow");
  let runInfo = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const listed = await commandOutput("gh", ["run", "list", "--workflow", "deploy-pages.yml", "--commit", sha, "--limit", "1", "--json", "databaseId,status,conclusion,url"], {
      label: `Find deployment workflow (${attempt}/12)`,
    });
    const runs = JSON.parse(listed.stdout || "[]");
    if (runs[0]) {
      runInfo = runs[0];
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (!runInfo) throw new Error("The GitHub Pages workflow did not start for the pushed commit.");
  await commandOutput("gh", ["run", "watch", String(runInfo.databaseId), "--exit-status"], { label: `Watch deployment ${runInfo.databaseId}` });
  step("Publish GitHub Pages", "complete", runInfo.url || "Workflow passed");
  await verifyLive(ids);
  return runInfo.url;
}

async function publishArticles(articleRecords, imageMode) {
  if (!articleRecords.length) throw new Error("Select at least one staged article.");
  const unique = [...new Map(articleRecords.map((article) => [article.id, article])).values()];
  for (const article of unique) {
    if (!isWithin(contentRoot, article.path) || path.basename(article.path) !== "article.md") throw new Error("Invalid article selection.");
  }
  const statuses = new Set(unique.map((article) => article.status));
  if (statuses.size > 1) throw new Error("Deploy rewrite drafts and already-prepared articles in separate batches.");
  let prepared;
  if (statuses.has("published")) {
    prepared = {
      prepared: unique.length,
      articles: unique.map((article) => ({
        id: article.slug,
        title: article.title,
        section: article.section,
        published: article.published,
        imageMode: "prepared",
        articlePath: article.path,
        localUrl: article.localUrl,
        productionUrl: article.productionUrl,
      })),
    };
    step("Prepare publication", "complete", `${unique.length} previously prepared article${unique.length === 1 ? "" : "s"} selected`);
  } else {
    step("Prepare publication", "running", `${unique.length} selected article${unique.length === 1 ? "" : "s"}`);
    prepared = await prepareArticles({
      all: false,
      articlePaths: unique.map((article) => article.path),
      contentRoot,
      inputRoot,
      fallbackImage: path.join(here, "assets", "editorial-fallback.webp"),
      imageMode,
      author: "Tysons Times Staff",
      preview: false,
      dryRun: false,
    });
    prepared.articles.forEach((article) => log(`Prepared: ${article.title} (${article.imageMode})`));
    step("Prepare publication", "complete", `${prepared.prepared} production article${prepared.prepared === 1 ? "" : "s"}`);
  }

  step("Validate feed", "running", "Checking article schema, copy, images, and generated feed");
  await commandOutput(npmCommand, [npmCli, "run", "check"], { label: "Validate production content feed" });
  step("Validate feed", "complete", "All publication checks passed");

  const staged = await commandOutput("git", ["diff", "--cached", "--name-only"], { label: "Check Git index safety" });
  if (staged.stdout.trim()) throw new Error("Git already has staged files. Unstage them before using direct deploy so the console cannot include unrelated work.");
  const branch = (await commandOutput("git", ["branch", "--show-current"], { label: "Confirm main branch" })).stdout.trim();
  if (branch !== "main") throw new Error(`Direct deploy requires the main branch; current branch is ${branch || "detached HEAD"}.`);
  await commandOutput("git", ["fetch", "origin", "main"], { label: "Refresh origin/main" });
  const head = (await commandOutput("git", ["rev-parse", "HEAD"], { label: "Read local main revision" })).stdout.trim();
  const remote = (await commandOutput("git", ["rev-parse", "origin/main"], { label: "Read origin/main revision" })).stdout.trim();
  if (head !== remote) throw new Error("Local main and origin/main differ. Reconcile them before direct deploy.");

  const directories = unique.map((article) => article.directory);
  step("Commit selected articles", "running", "Staging only the selected article folders");
  await commandOutput("git", ["add", "--", ...directories], { label: `Stage ${directories.length} selected article folder${directories.length === 1 ? "" : "s"}` });
  const cached = (await commandOutput("git", ["diff", "--cached", "--name-only"], { label: "Verify staged scope" })).stdout.trim().split(/\r?\n/).filter(Boolean);
  const allowedPrefixes = directories.map((directory) => `${path.relative(rootDir, directory).replaceAll("\\", "/")}/`);
  const outside = cached.filter((file) => !allowedPrefixes.some((prefix) => file.replaceAll("\\", "/").startsWith(prefix)));
  if (!cached.length || outside.length) {
    await commandOutput("git", ["restore", "--staged", "--", ...directories], { label: "Safely unstage selected folders", allowFailure: true });
    throw new Error(outside.length ? `Refusing to commit files outside the selection: ${outside.join(", ")}` : "The selected articles produced no Git changes.");
  }
  await commandOutput("git", ["diff", "--cached", "--check"], { label: "Check staged patch" });
  const message = `Publish ${unique.length} article${unique.length === 1 ? "" : "s"} from Publisher Desk`;
  try {
    await commandOutput("git", ["commit", "-m", message], { label: message });
  } catch (error) {
    await commandOutput("git", ["restore", "--staged", "--", ...directories], { label: "Safely unstage selected folders", allowFailure: true });
    throw error;
  }
  const sha = (await commandOutput("git", ["rev-parse", "HEAD"], { label: "Read publication revision" })).stdout.trim();
  step("Commit selected articles", "complete", sha.slice(0, 8));

  step("Push main", "running", "Sending the publication commit to GitHub");
  await commandOutput("git", ["push", "origin", "main"], { label: "Push main to origin" });
  step("Push main", "complete", "GitHub accepted the commit");

  const links = prepared.articles.map((article) => ({ ...article, status: "deploying", productionLive: false }));
  lastLinks = links;
  const workflowUrl = await waitForDeployment(sha, links.map((article) => article.id));
  links.forEach((article) => {
    article.status = "live";
    article.productionLive = true;
  });
  lastLinks = links;
  return { summary: `Published and verified ${links.length} article${links.length === 1 ? "" : "s"}.`, links, sha, workflowUrl };
}

async function scrapeFlow(payload) {
  const range = validateDateRange(payload.start, payload.endInclusive);
  const limit = positiveInteger(payload.limit ?? 10, "Per-site limit", 100);
  const maxImages = positiveInteger(payload.maxImages ?? 6, "Images per article", 24);
  const selectedIds = payload.sourceIds?.length ? [...new Set(payload.sourceIds)] : sourceList.map((source) => source.id);
  const unknown = selectedIds.filter((id) => !sourceList.some((source) => source.id === id));
  if (unknown.length) throw new Error(`Unknown source selection: ${unknown.join(", ")}`);
  if (!selectedIds.length) throw new Error("Select at least one source.");
  const target = payload.target === "main" ? "main" : "staging";
  const imageMode = payload.includeImages === false ? "illustration" : "source";
  const before = new Set((await scanUnprocessed(inputRoot)).map((item) => item.id));

  step("Collect source articles", "running", `${range.start} through ${range.endInclusive}; ${selectedIds.length} sites; limit ${limit}/site`);
  const args = [path.join(rootDir, "scripts", "scrape-sources.mjs"), "--start", range.start, "--end-exclusive", range.endExclusive, "--limit", String(limit), "--max-images", String(maxImages)];
  if (selectedIds.length === sourceList.length) args.push("--all");
  else args.push("--source", selectedIds.join(","));
  if (payload.strictScope !== false) args.push("--strict-scope");
  if (payload.includeImages === false) args.push("--no-download-images");
  await commandOutput(process.execPath, args, { label: `Scrape ${selectedIds.length} source${selectedIds.length === 1 ? "" : "s"}` });
  step("Collect source articles", "complete", "Collection run recorded in scrape history");

  step("Test and compress", "running", "Running scraper regression checks and lossless compression");
  await commandOutput(npmCommand, [npmCli, "run", "scrape:test"], { label: "Run scraper tests" });
  await commandOutput(npmCommand, [npmCli, "run", "scrape:compress"], { label: "Losslessly compress collected media" });
  step("Test and compress", "complete", "Archive validated and compressed");

  const after = await scanUnprocessed(inputRoot);
  const fresh = after.filter((item) => !before.has(item.id));
  log(`Collection produced ${fresh.length} new unprocessed bundle${fresh.length === 1 ? "" : "s"}.`);
  if (!fresh.length) return { summary: "Scrape completed; no new articles matched the selected range.", links: [] };
  const drafts = await rewriteBundles(fresh.map((item) => item.path));
  await rebuildPreview(imageMode);
  const links = drafts.map((article) => ({ ...article, status: "staged", productionLive: false }));
  lastLinks = links;
  if (target === "main") return publishArticles(drafts, imageMode);
  return { summary: `Created ${drafts.length} staged draft${drafts.length === 1 ? "" : "s"}; ready for review or deploy.`, links };
}

async function rewriteFlow(payload) {
  const queue = await scanUnprocessed(inputRoot);
  const selected = queue.filter((item) => (payload.ids || []).includes(item.id));
  if (!selected.length) throw new Error("Select at least one unprocessed article.");
  if (selected.length !== new Set(payload.ids).size) throw new Error("One or more selected source bundles no longer exist.");
  const imageMode = payload.includeImages === false ? "illustration" : "source";
  const drafts = await rewriteBundles(selected.map((item) => item.path));
  await rebuildPreview(imageMode);
  const links = drafts.map((article) => ({ ...article, status: "staged", productionLive: false }));
  lastLinks = links;
  if (payload.target === "main") return publishArticles(drafts, imageMode);
  return { summary: `Moved ${drafts.length} article${drafts.length === 1 ? "" : "s"} into rewrite staging.`, links };
}

async function publishFlow(payload) {
  const queue = await scanArticleQueue(contentRoot);
  const available = [...queue.staging, ...queue.ready];
  const selected = available.filter((item) => (payload.ids || []).includes(item.id));
  if (!selected.length) throw new Error("Select at least one staged article.");
  return publishArticles(selected, payload.includeImages === false ? "illustration" : "source");
}

async function startLocalPreview(imageMode) {
  await rebuildPreview(imageMode);
  if (localProcess && localProcess.exitCode === null) {
    return { summary: "Local preview refreshed and is already running.", url: LOCAL_ORIGIN };
  }
  const vite = path.join(siteRoot, "node_modules", "vite", "bin", "vite.js");
  if (!await pathExists(vite)) throw new Error(`The site dependencies are missing at ${siteRoot}. Run npm install there first.`);
  step("Start local site", "running", LOCAL_ORIGIN);
  localProcess = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
    cwd: siteRoot,
    env: { ...process.env, VITE_CONTENT_BASE_URL: `http://${host}:${port}/preview-content` },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  localStartedAt = timestamp();
  localProcess.stdout.on("data", (chunk) => log(chunk.toString("utf8"), "preview"));
  localProcess.stderr.on("data", (chunk) => log(chunk.toString("utf8"), "stderr"));
  localProcess.once("close", () => {
    localProcess = null;
    localStartedAt = null;
  });
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(LOCAL_ORIGIN);
      if (response.ok) {
        step("Start local site", "complete", LOCAL_ORIGIN);
        return { summary: "Local site is ready.", url: LOCAL_ORIGIN };
      }
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The local site did not become ready on port 5173.");
}

async function stopLocalPreview() {
  if (!localProcess || localProcess.exitCode !== null) return false;
  localProcess.kill();
  localProcess = null;
  localStartedAt = null;
  return true;
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  response.end(body);
}

async function body(request) {
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new Error("Requests must use application/json.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const mime = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".webp", "image/webp"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".svg", "image/svg+xml"],
]);

async function serveFile(response, root, pathname, { cors = false } = {}) {
  const decoded = decodeURIComponent(pathname);
  const target = path.resolve(root, `.${decoded}`);
  if (!isWithin(root, target)) return false;
  try {
    const file = await readFile(target);
    response.writeHead(200, {
      "Content-Type": mime.get(path.extname(target).toLowerCase()) || "application/octet-stream",
      "Content-Length": file.length,
      "Cache-Control": "no-cache",
      ...(cors ? { "Access-Control-Allow-Origin": LOCAL_ORIGIN } : {}),
    });
    response.end(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return false;
    throw error;
  }
}

async function router(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, await state());
  if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true, job: publicJob(currentJob), localRunning: Boolean(localProcess) });
  if (request.method === "POST") {
    const payload = await body(request);
    if (url.pathname === "/api/jobs/scrape") return json(response, 202, newJob("scrape", "Scrape → rewrite → publish", () => scrapeFlow(payload)));
    if (url.pathname === "/api/jobs/rewrite") return json(response, 202, newJob("rewrite", "Process collected articles", () => rewriteFlow(payload)));
    if (url.pathname === "/api/jobs/publish") return json(response, 202, newJob("publish", "Deploy staged articles", () => publishFlow(payload)));
    if (url.pathname === "/api/jobs/validate") return json(response, 202, newJob("validate", "Validate publication workspace", async () => {
      step("Scraper tests", "running");
      await commandOutput(npmCommand, [npmCli, "run", "scrape:test"], { label: "Run scraper tests" });
      step("Scraper tests", "complete");
      step("Rewrite audit", "running");
      await commandOutput(npmCommand, [npmCli, "run", "rewrite:test"], { label: "Run rewrite tests" });
      await commandOutput(process.execPath, [path.join(rootDir, "scripts", "rewrite-articles.mjs"), "--audit"], { label: "Audit processed rewrites" });
      step("Rewrite audit", "complete");
      step("Production feed", "running");
      await commandOutput(npmCommand, [npmCli, "run", "check"], { label: "Validate current production feed" });
      step("Production feed", "complete");
      await rebuildPreview(payload.includeImages === false ? "illustration" : "source");
      return { summary: "Scraper, rewrite archive, production feed, and local preview all passed." };
    }));
    if (url.pathname === "/api/preview/start") return json(response, 202, newJob("preview", "Launch local preview", () => startLocalPreview(payload.includeImages === false ? "illustration" : "source")));
    if (url.pathname === "/api/preview/stop") return json(response, 200, { stopped: await stopLocalPreview() });
    if (url.pathname === "/api/job/cancel") {
      if (!currentJob) return json(response, 200, { cancelled: false });
      currentJob.cancelRequested = true;
      currentJob.child?.kill();
      return json(response, 200, { cancelled: true });
    }
  }
  if (request.method === "GET" && url.pathname.startsWith("/preview-content/")) {
    const relative = url.pathname.slice("/preview-content".length);
    if (await serveFile(response, previewRoot, relative, { cors: true })) return;
  }
  if (request.method === "GET") {
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    if (await serveFile(response, publicRoot, pathname)) return;
  }
  json(response, 404, { error: "Not found" });
}

const server = http.createServer((request, response) => {
  router(request, response).catch((error) => json(response, error instanceof SyntaxError ? 400 : 500, { error: error.message }));
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  currentJob?.child?.kill();
  localProcess?.kill();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => localProcess?.kill());

server.listen(port, host, () => {
  console.log(`Tysons Times Publisher Desk is ready at http://${host}:${port}`);
  if (!process.argv.includes("--no-open")) {
    const script = `Start-Process '${`http://${host}:${port}`.replaceAll("'", "''")}'`;
    spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  }
});
