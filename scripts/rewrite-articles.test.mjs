import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  completeArticle,
  discoverArticles,
  inferSection,
  parseOptions,
  validateRewrite,
} from "./rewrite-articles.mjs";

async function makeBundle(inputRoot, source = "sample-source", day = "2026-07-25", slug = "sample-story") {
  const articleDir = path.join(inputRoot, source, "unprocessed-articles", day, slug);
  await mkdir(articleDir, { recursive: true });
  const body = Array.from({ length: 80 }, (_, index) => `Reported fact number ${index + 1} remains grounded in the collected text.`).join(" ");
  await writeFile(path.join(articleDir, "metadata.json"), JSON.stringify({
    title: "Original Local Headline",
    author: "Example Reporter",
    publication_day: day,
  }));
  await writeFile(path.join(articleDir, "article.txt"), body);
  return { articleDir, body };
}

test("options default to one article and the auto provider", () => {
  const options = parseOptions([]);
  assert.equal(options.provider, "auto");
  assert.equal(options.limit, 1);
  assert.equal(options.all, false);
});

test("rewrite validation accepts a new headline and clean body", () => {
  const article = {
    title: "Original Local Headline",
    author: "Example Reporter",
    body: Array.from({ length: 100 }, () => "grounded fact").join(" "),
  };
  const output = `# The Local Change That Could Reshape the Entire Week\n\n${Array.from({ length: 40 }, () => "The rewritten report preserves a grounded fact.").join(" ")}`;
  const validated = validateRewrite(output, article);
  assert.match(validated, /^# The Local Change/);
});

test("rewrite validation rejects source metadata, bylines, and URLs", () => {
  const article = {
    title: "Original Local Headline",
    author: "Example Reporter",
    publisher: "Example Newsroom",
    body: Array.from({ length: 40 }, () => "grounded fact").join(" "),
  };
  assert.throws(
    () => validateRewrite("# A Very Different Local Headline\n\nSource: Example News\n\nA sufficiently long rewritten body follows with facts and context for every local reader in the area today.", article),
    /forbidden source/,
  );
  assert.throws(
    () => validateRewrite("# A Very Different Local Headline\n\nBy Example Reporter\n\nA sufficiently long rewritten body follows with facts and context for every local reader in the area today.", article),
    /byline|author/,
  );
  assert.throws(
    () => validateRewrite("# A Very Different Local Headline\n\nRead https://example.com for the sufficiently long rewritten body and all facts relevant to local readers today. The article continues with grounded details, useful context, and clear consequences for the surrounding community.", article),
    /URL/,
  );
  assert.throws(
    () => validateRewrite("# A Very Different Local Headline\n\nExample Newsroom reports a sufficiently long rewritten body with grounded details, useful context, clear consequences, and facts relevant to local readers throughout the surrounding community today.", article),
    /publisher or author/,
  );
});

test("discovery reads unprocessed bundles newest first", async () => {
  const inputRoot = await mkdtemp(path.join(os.tmpdir(), "rewrite-discovery-"));
  await makeBundle(inputRoot, "one", "2026-07-24", "older");
  await makeBundle(inputRoot, "two", "2026-07-26", "newer");
  const articles = await discoverArticles({
    article: null,
    sources: [],
    inputRoot,
    all: true,
    limit: 1,
  });
  assert.equal(articles.length, 2);
  assert.equal(articles[0].publicationDay, "2026-07-26");
  assert.equal(articles[0].sourceId, "two");
});

test("section inference recognizes common local beats", () => {
  assert.equal(inferSection({ title: "FCPS students return to school", body: "Classroom teachers prepare.", metadata: {} }), "schools");
  assert.equal(inferSection({ title: "Little League reaches the championship", body: "The baseball team won.", metadata: {} }), "sports");
  assert.equal(inferSection({ title: "New store opens in Tysons", body: "The retail company hired workers.", metadata: {} }), "business");
  assert.equal(inferSection({ title: "Man sentenced after Springfield assault", body: "A school was mentioned incidentally.", metadata: {} }), "civic");
  assert.equal(inferSection({ title: "Five summer films worth seeing", body: "A student appears in one film.", metadata: {} }), "culture");
});

test("completion writes rewrite.md and atomically moves the original bundle", async () => {
  const inputRoot = await mkdtemp(path.join(os.tmpdir(), "rewrite-complete-"));
  const contentRoot = await mkdtemp(path.join(os.tmpdir(), "rewrite-content-"));
  const { articleDir } = await makeBundle(inputRoot);
  const [article] = await discoverArticles({
    article: articleDir,
    sources: [],
    inputRoot,
    all: false,
    limit: 1,
  });
  const rewrite = "# A New Headline With Real Local Stakes\n\nA clean rewritten body based on the collected facts.\n";
  const completed = await completeArticle(article, rewrite, { contentRoot, section: "local" });
  assert.match(completed.rewritePath, /processed-articles/);
  assert.equal(await readFile(completed.rewritePath, "utf8"), rewrite);
  assert.equal(await readFile(path.join(article.processedDir, "article.txt"), "utf8"), article.body);
  const productionDraft = await readFile(completed.contentPath, "utf8");
  assert.match(productionDraft, /status: rewrite/);
  assert.match(productionDraft, /title: "A New Headline With Real Local Stakes"/);
  assert.doesNotMatch(productionDraft, /author|source/i);
  await assert.rejects(readFile(path.join(articleDir, "article.txt"), "utf8"), /ENOENT/);
});
