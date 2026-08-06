import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflowRoot = path.join(rootDir, "workflow");
const contentRoot = path.join(rootDir, "content", "articles");
const allowedSections = new Set(["local", "civic", "schools", "business", "culture", "sports", "opinion"]);

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function directories(target) {
  try {
    return (await readdir(target, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(target, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function json(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

function safeSlug(value) {
  return String(value || "story")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "story";
}

function siteBody(value) {
  return String(value || "")
    .trim()
    .replace(/^#\s+[^\r\n]+\r?\n(?:\r?\n)?/gm, "")
    .trim();
}

async function publicationDay(stagingDir) {
  const values = [];
  for (const sourceDir of await directories(path.join(stagingDir, "sources"))) {
    const metadata = await json(path.join(sourceDir, "metadata.json"));
    const day = String(metadata.published_at || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) values.push(day);
  }
  return values.sort().at(-1) || new Date().toISOString().slice(0, 10);
}

export async function promoteStaging({ dryRun = false } = {}) {
  const promoted = [];
  for (const stagingDir of await directories(path.join(workflowRoot, "staging"))) {
    const markerPath = path.join(stagingDir, "site-article.json");
    if (await exists(markerPath)) continue;
    const [cluster, draft, qa] = await Promise.all([
      json(path.join(stagingDir, "cluster.json")),
      json(path.join(stagingDir, "draft.json")),
      json(path.join(stagingDir, "qa.json")),
    ]);
    if (cluster.state !== "STAGED" || qa.result !== "pass") continue;
    const sectionCandidate = String(draft.section || "local").toLowerCase();
    const section = allowedSections.has(sectionCandidate) ? sectionCandidate : "local";
    const published = await publicationDay(stagingDir);
    const suffix = String(cluster.cluster_id).replace(/^cluster_/, "").slice(-8);
    const slug = `${safeSlug(draft.slug || draft.headline)}-${suffix}`;
    const articleDir = path.join(contentRoot, section, published.slice(0, 4), published.slice(5, 7), slug);
    const articlePath = path.join(articleDir, "article.md");
    if (!await exists(articlePath)) {
      const body = siteBody(draft.body_markdown);
      if (!body) throw new Error(`${cluster.cluster_id} has no rewritten body.`);
      const markdown = [
        "---",
        `title: ${JSON.stringify(draft.headline)}`,
        `published: ${JSON.stringify(published)}`,
        "status: rewrite",
        "---",
        "",
        body,
        "",
      ].join("\n");
      if (!dryRun) {
        await mkdir(articleDir, { recursive: true });
        await writeFile(articlePath, markdown, "utf8");
      }
    }
    const result = {
      cluster_id: cluster.cluster_id,
      title: draft.headline,
      section,
      published,
      articlePath,
    };
    if (!dryRun) {
      await writeFile(markerPath, `${JSON.stringify({ ...result, promoted_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
    }
    promoted.push(result);
  }
  return promoted;
}

const dryRun = process.argv.includes("--dry-run");
const promoted = await promoteStaging({ dryRun });
console.log(JSON.stringify({ dryRun, promoted }, null, 2));
