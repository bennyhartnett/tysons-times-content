import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  candidateScore,
  discoverSourceBundles,
  ingestBundles,
  incrementClusterFailure,
  parseOptions,
  runPipeline,
  validateSchema,
} from "./editorial-pipeline.mjs";

async function makeBundle(inputRoot, source = "sample", slug = "story", url = "https://example.com/story") {
  const articleDir = path.join(inputRoot, source, "unprocessed-articles", "2026-07-27", slug);
  await mkdir(articleDir, { recursive: true });
  await writeFile(path.join(articleDir, "metadata.json"), JSON.stringify({
    title: "Fairfax board approves Tysons project",
    canonical_url: url,
    source_name: "Example News",
    published_at: "2026-07-27T14:00:00-04:00",
  }));
  await writeFile(path.join(articleDir, "article.txt"), "The Fairfax County board approved a mixed-use project in Tysons. The vote occurred Monday.");
  return articleDir;
}

async function initializeWorkflow(workflowRoot) {
  for (const folder of ["ingested", "accepted", "held", "rejected", "clusters", "staging", "needs-review", "failed"]) {
    await mkdir(path.join(workflowRoot, folder), { recursive: true });
  }
  await writeFile(path.join(workflowRoot, "ingest-index.json"), JSON.stringify({ version: 1, by_canonical_url: {}, by_content_hash: {} }));
}

test("pipeline options default to subscription auto-routing and a bounded call count", () => {
  const options = parseOptions([]);
  assert.equal(options.provider, "auto");
  assert.equal(options.maxAiCalls, 12);
  assert.equal(options.attempts, 2);
});

test("discovery only selects scraper unprocessed article bundles", async () => {
  const inputRoot = await mkdtemp(path.join(os.tmpdir(), "pipeline-input-"));
  await makeBundle(inputRoot);
  const processed = path.join(inputRoot, "sample", "processed-articles", "2026-07-27", "old");
  await mkdir(processed, { recursive: true });
  await writeFile(path.join(processed, "metadata.json"), "{}");
  const bundles = await discoverSourceBundles(inputRoot);
  assert.equal(bundles.length, 1);
  assert.match(bundles[0].relative, /unprocessed-articles/);
});

test("ingestion is idempotent by canonical URL and content hash", async () => {
  const inputRoot = await mkdtemp(path.join(os.tmpdir(), "pipeline-input-"));
  const workflowRoot = await mkdtemp(path.join(os.tmpdir(), "pipeline-workflow-"));
  await initializeWorkflow(workflowRoot);
  await makeBundle(inputRoot, "one", "first", "https://example.com/story?utm_source=test");
  await makeBundle(inputRoot, "two", "second", "https://example.com/story");
  const options = { inputRoot, workflowRoot, dryRun: false };
  const first = await ingestBundles(options);
  const second = await ingestBundles(options);
  assert.equal(first.ingested, 1);
  assert.equal(first.duplicates, 1);
  assert.equal(second.ingested, 0);
  assert.equal(second.duplicates, 2);
  const index = JSON.parse(await readFile(path.join(workflowRoot, "ingest-index.json"), "utf8"));
  assert.equal(Object.keys(index.by_content_hash).length, 1);
});

test("local candidate scoring favors shared event details", () => {
  const article = {
    metadata: { title: "Fairfax approves Tysons mixed-use project" },
    review: {
      locations: ["Tysons"],
      people: [],
      organizations: ["Fairfax County Board"],
      event_summary: "The board approved the mixed-use project.",
      event_date: "2026-07-26",
    },
  };
  const related = {
    working_title: "Tysons project approved by Fairfax board",
    entities: ["Tysons", "Fairfax County Board"],
    event_summary: "Fairfax board approved a mixed-use project.",
    event_dates: ["2026-07-26"],
  };
  const unrelated = {
    working_title: "Summer concert series begins",
    entities: ["Vienna"],
    event_summary: "Musicians will perform outdoors.",
    event_dates: ["2026-08-01"],
  };
  assert.ok(candidateScore(article, related) > candidateScore(article, unrelated));
  assert.ok(candidateScore(article, related) > 0.5);
});

test("schema validation rejects missing and extra structured fields", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["decision"],
    properties: { decision: { type: "string", enum: ["accept", "reject"] } },
  };
  assert.deepEqual(validateSchema({ decision: "accept" }, schema), { decision: "accept" });
  assert.throws(() => validateSchema({}, schema), /required/);
  assert.throws(() => validateSchema({ decision: "accept", surprise: true }, schema), /unexpected/);
});

test("dry run does not initialize or mutate the workflow root", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pipeline-dry-"));
  const inputRoot = path.join(parent, "input");
  const workflowRoot = path.join(parent, "workflow-does-not-exist");
  await makeBundle(inputRoot);
  const base = parseOptions([]);
  const result = await runPipeline({ ...base, inputRoot, workflowRoot, dryRun: true });
  assert.equal(result.ingest.discovered, 1);
  await assert.rejects(readFile(path.join(workflowRoot, "ingest-index.json")), /ENOENT/);
});

test("a malformed QA call is distinct from a valid editorial QA failure", async () => {
  const workflowRoot = await mkdtemp(path.join(os.tmpdir(), "pipeline-qa-"));
  const clusterDir = path.join(workflowRoot, "clusters", "cluster_test");
  await mkdir(clusterDir, { recursive: true });
  await writeFile(path.join(clusterDir, "cluster.json"), JSON.stringify({
    cluster_id: "cluster_test",
    state: "QA_PENDING",
    failures: {},
  }));
  await incrementClusterFailure(clusterDir, "qa", new Error("malformed JSON"), workflowRoot, "QA_CALL_FAILED");
  const cluster = JSON.parse(await readFile(path.join(clusterDir, "cluster.json"), "utf8"));
  assert.equal(cluster.state, "QA_CALL_FAILED");
  assert.equal(cluster.failures.qa, 1);
});
