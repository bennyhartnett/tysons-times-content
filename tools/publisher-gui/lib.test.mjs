import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addCalendarDays, articleLinks, isWithin, readScrapeHistory, scanArticleQueue, validateDateRange } from "./lib.mjs";

test("inclusive UI ranges become correct exclusive scraper ranges", () => {
  assert.deepEqual(validateDateRange("2026-07-20", "2026-07-26"), {
    start: "2026-07-20",
    endInclusive: "2026-07-26",
    endExclusive: "2026-07-27",
  });
  assert.equal(addCalendarDays("2024-02-28", 1), "2024-02-29");
  assert.throws(() => validateDateRange("2026-07-27", "2026-07-20"), /on or before/);
  assert.throws(() => validateDateRange("2026-02-30", "2026-03-02"), /valid calendar/);
});

test("article links target the local and production hash routes", () => {
  assert.deepEqual(articleLinks("a-story"), {
    localUrl: "http://127.0.0.1:5173/#/article/a-story",
    productionUrl: "https://tysonstimes.org/#/article/a-story",
  });
});

test("path containment rejects siblings and the root itself", () => {
  const root = path.resolve("C:/example/content");
  assert.equal(isWithin(root, path.join(root, "articles", "story")), true);
  assert.equal(isWithin(root, root), false);
  assert.equal(isWithin(root, path.resolve(root, "..", "outside")), false);
});

test("history parser keeps valid and invalid records visible", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "publisher-history-"));
  const file = path.join(directory, "runs.jsonl");
  await writeFile(file, '{"run_id":"one"}\nnot-json\n{"run_id":"two"}\n', "utf8");
  const history = await readScrapeHistory(file);
  assert.equal(history.length, 3);
  assert.equal(history[0].run_id, "two");
  assert.equal(history[1].invalid, true);
  assert.equal(history[2].run_id, "one");
});

test("article queue separates rewrite drafts from prepared worktree articles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publisher-queue-"));
  const staged = path.join(root, "local", "2026", "07", "staged-story");
  const prepared = path.join(root, "civic", "2026", "07", "prepared-story");
  await mkdir(staged, { recursive: true });
  await mkdir(prepared, { recursive: true });
  await writeFile(path.join(staged, "article.md"), '---\ntitle: Staged Story\npublished: "2026-07-20"\nstatus: rewrite\n---\n\nDraft.\n');
  await writeFile(path.join(prepared, "article.md"), '---\ntitle: Prepared Story\npublished: "2026-07-20"\nstatus: published\n---\n\nReady.\n');
  const queue = await scanArticleQueue(root, new Set(["civic/2026/07/prepared-story/article.md"]));
  assert.equal(queue.staging.length, 1);
  assert.equal(queue.ready.length, 1);
  assert.equal(queue.ready[0].slug, "prepared-story");
});
