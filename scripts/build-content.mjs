import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import sharp from "sharp";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.resolve(process.env.CONTENT_ARTICLES_DIR || path.join(rootDir, "content", "articles"));
const distDir = path.resolve(process.env.CONTENT_DIST_DIR || path.join(rootDir, "dist"));
const publicArticleDir = path.join(distDir, "articles");
const publicMediaDir = path.join(distDir, "media", "articles");
const generatedIndexPath = path.join(distDir, "index.json");
const checkOnly = process.argv.includes("--check");
const previewMode = process.env.CONTENT_PREVIEW === "1";
const contentBaseUrl = String(process.env.CONTENT_BASE_URL || "").replace(/\/+$/, "");

const publication = JSON.parse(await readFile(path.join(rootDir, "publication.json"), "utf8"));
const allowedSections = new Set(publication.sections.map((section) => section.id));
const allowedStatuses = new Set(["rewrite", "draft", "published"]);
const allowedTypes = new Set(["analysis", "brief", "opinion", "photo-essay", "profile", "review", "standard"]);
const sourceImageExtensions = new Set([".avif", ".jpeg", ".jpg", ".png", ".webp"]);
const imageWidths = [480, 960, 1440];
const imagePipelineVersion = "v1";
const maxSourceImageBytes = 12 * 1024 * 1024;
const inlineMarkerPattern = /\{\{image:([a-z0-9-]+)\}\}/g;
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });

const rules = {
  title: [12, 88],
  homeTitle: [6, 38],
  dek: [60, 190],
  author: [2, 60],
  location: [2, 60],
  alt: [12, 180],
  caption: [20, 220],
  credit: [2, 80],
  bodyWords: [120, 6000],
  paragraph: [20, 1600],
  h2: [4, 80],
  h3: [4, 70],
  tag: [2, 28],
};

const minimumWordsByType = {
  analysis: 400,
  brief: 120,
  opinion: 300,
  "photo-essay": 150,
  profile: 300,
  review: 250,
  standard: 250,
};

const errors = [];

function fail(source, message) {
  errors.push(`${path.relative(rootDir, source)}: ${message}`);
}

function asDateString(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  return String(value || "").trim();
}

function checkString(source, label, value, [min, max], { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return;
  if (typeof value !== "string") {
    fail(source, `${label} must be text`);
    return;
  }
  const length = value.trim().length;
  if (length < min || length > max) fail(source, `${label} must be ${min}-${max} characters (found ${length})`);
}

function plainInline(value) {
  return String(value || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(value) {
  return plainInline(value).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length || 0;
}

async function findArticleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return findArticleFiles(target);
      return entry.isFile() && entry.name === "article.md" ? [target] : [];
    }),
  );
  return nested.flat().sort();
}

function validatePath(source, published) {
  const parts = path.relative(contentDir, source).split(path.sep);
  if (parts.length !== 5 || parts.at(-1) !== "article.md") {
    fail(source, "expected content/articles/<section>/<YYYY>/<MM>/<slug>/article.md");
    return {};
  }

  const [section, year, month, slug] = parts;
  if (!allowedSections.has(section)) fail(source, `unknown section '${section}'`);
  if (!/^\d{4}$/.test(year)) fail(source, "year folder must use YYYY");
  if (!/^(0[1-9]|1[0-2])$/.test(month)) fail(source, "month folder must use MM");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    fail(source, "slug folder must be lower-case kebab-case and no more than 80 characters");
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(published) && `${year}-${month}` !== published.slice(0, 7)) {
    fail(source, `folder date ${year}/${month} does not match published date ${published}`);
  }
  return { section, year, month, slug, directory: path.dirname(source) };
}

function validateFrontMatter(source, data, pathInfo) {
  const allowedKeys = new Set([
    "author",
    "dek",
    "hero",
    "homeTitle",
    "images",
    "location",
    "published",
    "status",
    "tags",
    "title",
    "type",
    "updated",
  ]);
  Object.keys(data).forEach((key) => {
    if (!allowedKeys.has(key)) fail(source, `unknown front-matter field '${key}'`);
  });

  checkString(source, "title", data.title, rules.title);
  checkString(source, "homeTitle", data.homeTitle, rules.homeTitle, { optional: true });
  checkString(source, "dek", data.dek, rules.dek);
  checkString(source, "author", data.author, rules.author);
  checkString(source, "location", data.location, rules.location);

  if (!allowedStatuses.has(data.status)) fail(source, "status must be rewrite, draft, or published");
  if (!allowedTypes.has(data.type)) fail(source, `type must be one of: ${[...allowedTypes].join(", ")}`);

  const published = asDateString(data.published);
  const updated = asDateString(data.updated || data.published);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(published) || Number.isNaN(Date.parse(`${published}T12:00:00Z`))) {
    fail(source, "published must be a valid YYYY-MM-DD date");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated) || Number.isNaN(Date.parse(`${updated}T12:00:00Z`))) {
    fail(source, "updated must be a valid YYYY-MM-DD date");
  }
  if (published && updated && updated < published) fail(source, "updated cannot be earlier than published");
  if (!previewMode && data.status === "published" && published > new Date().toISOString().slice(0, 10)) {
    fail(source, "published articles cannot use a future date; keep them as draft until release");
  }

  if (!Array.isArray(data.tags) || data.tags.length < 2 || data.tags.length > 6) {
    fail(source, "tags must contain 2-6 values");
  } else {
    const normalized = data.tags.map((tag) => String(tag).toLowerCase().trim());
    normalized.forEach((tag, index) => checkString(source, `tags[${index}]`, tag, rules.tag));
    if (new Set(normalized).size !== normalized.length) fail(source, "tags must be unique");
  }

  validateImageConfig(source, "hero", data.hero);
  if (data.images !== undefined && !Array.isArray(data.images)) fail(source, "images must be a list");
  if ((data.images?.length || 0) > 6) fail(source, "an article may contain at most 6 inline images plus its hero");
  (data.images || []).forEach((image, index) => validateImageConfig(source, `images[${index}]`, image, true));

  return { ...pathInfo, published, updated };
}

function validateImageConfig(source, label, image, needsId = false) {
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    fail(source, `${label} must be an image object`);
    return;
  }
  const allowedKeys = new Set(needsId ? ["alt", "caption", "credit", "file", "id"] : ["alt", "caption", "credit", "file"]);
  Object.keys(image).forEach((key) => {
    if (!allowedKeys.has(key)) fail(source, `unknown ${label} field '${key}'`);
  });
  if (needsId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(image.id || ""))) {
    fail(source, `${label}.id must be lower-case kebab-case`);
  }
  if (typeof image.file !== "string" || path.basename(image.file) !== image.file || !sourceImageExtensions.has(path.extname(image.file).toLowerCase())) {
    fail(source, `${label}.file must be a local JPG, PNG, WebP, or AVIF filename beside article.md`);
  }
  checkString(source, `${label}.alt`, image.alt, rules.alt);
  checkString(source, `${label}.caption`, image.caption, rules.caption);
  checkString(source, `${label}.credit`, image.credit, rules.credit);
}

function validateBody(source, data, body) {
  if (/^#\s+/m.test(body)) fail(source, "do not use an H1 in article text; the title already supplies it");
  if (/!\[[^\]]*\]\([^)]*\)/.test(body)) {
    fail(source, "use front-matter images plus {{image:id}} markers instead of Markdown image syntax");
  }

  const stripped = body.replace(inlineMarkerPattern, " ");
  const words = wordCount(stripped);
  if (previewMode) return words;
  const minimum = minimumWordsByType[data.type] || rules.bodyWords[0];
  if (words < minimum || words > rules.bodyWords[1]) {
    fail(source, `${data.type || "article"} body must be ${minimum}-${rules.bodyWords[1]} words (found ${words})`);
  }

  const headingCount = (stripped.match(/^##{1,2}\s+/gm) || []).length;
  if (headingCount > 12) fail(source, "article body may contain at most 12 subheadings");
  stripped.split(/\n{2,}/).forEach((block) => {
    const trimmed = block.trim();
    if (!trimmed || /^[-*+]\s/m.test(trimmed) || /^\d+\.\s/m.test(trimmed) || /^>\s/m.test(trimmed)) return;
    if (trimmed.startsWith("### ")) return checkString(source, "H3", plainInline(trimmed.slice(4)), rules.h3);
    if (trimmed.startsWith("## ")) return checkString(source, "H2", plainInline(trimmed.slice(3)), rules.h2);
    checkString(source, "paragraph", plainInline(trimmed), rules.paragraph);
  });

  const configuredIds = (data.images || []).map((image) => image.id);
  if (new Set(configuredIds).size !== configuredIds.length) fail(source, "inline image ids must be unique");
  const markers = [...body.matchAll(inlineMarkerPattern)].map((match) => match[1]);
  markers.forEach((id) => {
    if (!configuredIds.includes(id)) fail(source, `{{image:${id}}} has no matching front-matter image`);
  });
  configuredIds.forEach((id) => {
    const uses = markers.filter((marker) => marker === id).length;
    if (uses !== 1) fail(source, `inline image '${id}' must appear exactly once in the body (found ${uses})`);
  });
  return words;
}

function validateRewriteDraft(source, data, body) {
  const allowedKeys = new Set(["published", "status", "title"]);
  Object.keys(data).forEach((key) => {
    if (!allowedKeys.has(key)) fail(source, `rewrite draft cannot contain front-matter field '${key}'`);
  });
  checkString(source, "title", data.title, rules.title);
  const published = asDateString(data.published);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(published) || Number.isNaN(Date.parse(`${published}T12:00:00Z`))) {
    fail(source, "published must be a valid YYYY-MM-DD date");
  }
  if (!body.trim()) fail(source, "rewrite draft body cannot be empty");
  if (/^#\s+/m.test(body)) fail(source, "do not use an H1 in article text; the title already supplies it");
  if (/!\[[^\]]*\]\([^)]*\)/.test(body)) fail(source, "rewrite drafts cannot contain Markdown images");
  if (/https?:\/\/|www\./i.test(body)) fail(source, "rewrite drafts cannot contain source URLs");
}

async function validateSourceImage(source, articleDirectory, label, image) {
  if (!image?.file) return null;
  const sourcePath = path.join(articleDirectory, image.file);
  try {
    const fileStat = await stat(sourcePath);
    if (fileStat.size > maxSourceImageBytes) fail(source, `${label} source file exceeds 12 MB`);
    const metadata = await sharp(sourcePath).metadata();
    if (!metadata.width || !metadata.height) fail(source, `${label} has unreadable dimensions`);
    if ((metadata.width || 0) < 1200 || (metadata.height || 0) < 700) {
      fail(source, `${label} must be at least 1200x700 pixels`);
    }
    const ratio = metadata.width / metadata.height;
    if (ratio < 1.25 || ratio > 2.1) fail(source, `${label} aspect ratio must be between 1.25:1 and 2.1:1`);
    return { sourcePath, metadata, fileStat };
  } catch (error) {
    fail(source, `${label} file '${image.file}' could not be read (${error.message})`);
    return null;
  }
}

async function buildImage(article, image, sourceInfo, key) {
  if (!sourceInfo) return null;
  const { slug } = article;
  const outputDirectory = path.join(publicMediaDir, slug);
  const originalWidth = sourceInfo.metadata.width;
  const originalHeight = sourceInfo.metadata.height;
  const widths = imageWidths.filter((width) => width <= originalWidth);
  if (!widths.includes(originalWidth) && originalWidth < imageWidths.at(-1)) widths.push(originalWidth);
  const webp = [];

  if (!checkOnly) await mkdir(outputDirectory, { recursive: true });
  for (const width of widths) {
    const filename = `${key}-${imagePipelineVersion}-${width}.webp`;
    const publicPath = `${contentBaseUrl}/media/articles/${slug}/${filename}`;
    if (!checkOnly) {
      const outputPath = path.join(outputDirectory, filename);
      let shouldBuild = true;
      try {
        const outputStat = await stat(outputPath);
        shouldBuild = outputStat.mtimeMs < sourceInfo.fileStat.mtimeMs;
      } catch {
        shouldBuild = true;
      }
      if (shouldBuild) {
        await sharp(sourceInfo.sourcePath)
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: 78, effort: 4 })
          .toFile(outputPath);
      }
    }
    webp.push({ src: publicPath, width });
  }

  const fallback = webp.find((item) => item.width === 960) || webp.at(-1);
  return {
    alt: image.alt.trim(),
    caption: image.caption.trim(),
    credit: image.credit.trim(),
    width: originalWidth,
    height: originalHeight,
    src: fallback.src,
    srcSet: webp.map((item) => `${item.src} ${item.width}w`).join(", "),
  };
}

function previewParagraphs(body, limit = 4) {
  const tokens = markdown.parse(body.replace(inlineMarkerPattern, ""), {});
  const paragraphs = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].type === "paragraph_open" && tokens[index + 1]?.type === "inline") {
      const value = plainInline(tokens[index + 1].content);
      if (value) paragraphs.push(value);
    }
    if (paragraphs.length === limit) break;
  }
  return paragraphs;
}

function bodyParagraphs(body) {
  const tokens = markdown.parse(body.replace(inlineMarkerPattern, ""), {});
  return tokens
    .filter((token, index) => token.type === "inline" && tokens[index - 1]?.type === "paragraph_open")
    .map((token) => plainInline(token.content))
    .filter(Boolean);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInlineImage(image) {
  return `<figure class="article-inline-image">
    <picture>
      <source type="image/webp" srcset="${escapeHtml(image.srcSet)}" sizes="(max-width: 700px) 100vw, 720px">
      <img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt)}" width="${image.width}" height="${image.height}" loading="lazy" decoding="async">
    </picture>
    <figcaption>${escapeHtml(image.caption)} <span>Photo: ${escapeHtml(image.credit)}</span></figcaption>
  </figure>`;
}

function renderBody(body, images) {
  const imageMap = new Map(images.map((image) => [image.id, image.asset]));
  const chunks = body.split(inlineMarkerPattern);
  return chunks
    .map((chunk, index) => {
      if (index % 2 === 1) return renderInlineImage(imageMap.get(chunk));
      return markdown.render(chunk);
    })
    .join("\n");
}

async function parseArticle(source) {
  const raw = await readFile(source, "utf8");
  let parsed;
  try {
    parsed = matter(raw);
  } catch (error) {
    fail(source, `front matter could not be parsed (${error.message})`);
    return null;
  }

  const published = asDateString(parsed.data.published);
  const pathInfo = validatePath(source, published);
  if (parsed.data.status === "rewrite") {
    validateRewriteDraft(source, parsed.data, parsed.content);
    return null;
  }
  const normalizedPath = validateFrontMatter(source, parsed.data, pathInfo);
  const words = validateBody(source, parsed.data, parsed.content);
  const heroSource = await validateSourceImage(source, pathInfo.directory, "hero", parsed.data.hero);
  const inlineSources = await Promise.all(
    (parsed.data.images || []).map((image, index) => validateSourceImage(source, pathInfo.directory, `images[${index}]`, image)),
  );

  return { source, data: parsed.data, body: parsed.content.trim(), words, heroSource, inlineSources, ...normalizedPath };
}

async function compileArticle(article) {
  const hero = await buildImage(article, article.data.hero, article.heroSource, "hero");
  const images = [];
  for (let index = 0; index < (article.data.images || []).length; index += 1) {
    const config = article.data.images[index];
    images.push({ id: config.id, asset: await buildImage(article, config, article.inlineSources[index], config.id) });
  }

  const summary = {
    id: article.slug,
    section: article.section,
    title: article.data.title.trim(),
    ...(article.data.homeTitle ? { homeTitle: article.data.homeTitle.trim() } : {}),
    dek: article.data.dek.trim(),
    author: article.data.author.trim(),
    location: article.data.location.trim(),
    date: article.published,
    updated: article.updated,
    type: article.data.type,
    tags: article.data.tags.map((tag) => String(tag).toLowerCase().trim()),
    hero,
    body: previewParagraphs(article.body),
    wordCount: article.words,
  };

  return {
    summary,
    full: {
      ...summary,
      body: bodyParagraphs(article.body),
      bodyHtml: renderBody(article.body, images),
      images: images.map(({ id, asset }) => ({ id, ...asset })),
      sourcePath: path.relative(rootDir, article.source).replaceAll(path.sep, "/"),
    },
  };
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function cleanupGeneratedMedia(expectedPublicPaths) {
  let generatedFiles = [];
  try {
    generatedFiles = await findAllFiles(publicMediaDir);
  } catch {
    return;
  }
  const expectedFiles = new Set(expectedPublicPaths);
  await Promise.all(generatedFiles.filter((file) => !expectedFiles.has(file)).map((file) => unlink(file)));
}

async function findAllFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return findAllFiles(target);
      return entry.isFile() ? [target] : [];
    }),
  );
  return nested.flat();
}

function generatedMediaPaths(compiledArticles) {
  const images = compiledArticles.flatMap(({ full }) => [full.hero, ...(full.images || [])]).filter(Boolean);
  return images.flatMap((image) =>
    image.srcSet.split(",").map((candidate) => {
      const source = candidate.trim().split(" ")[0];
      const marker = "/media/articles/";
      const markerIndex = source.indexOf(marker);
      const relativePath = source.slice(markerIndex + marker.length);
      return path.join(publicMediaDir, ...relativePath.split("/"));
    }),
  );
}

let articleFiles = [];
try {
  articleFiles = await findArticleFiles(contentDir);
} catch (error) {
  fail(contentDir, `article directory could not be read (${error.message})`);
}

if (!articleFiles.length) fail(contentDir, "no article.md files found");
const parsedArticles = (await Promise.all(articleFiles.map(parseArticle))).filter(Boolean);
const duplicateSlugs = parsedArticles.filter((article, index, all) => all.findIndex((item) => item.slug === article.slug) !== index);
duplicateSlugs.forEach((article) => fail(article.source, `duplicate slug '${article.slug}'`));

if (errors.length) {
  console.error(`Content validation failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:\n`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

const publishedArticles = parsedArticles.filter((article) => article.data.status === "published");
if (!checkOnly) {
  await rm(distDir, { recursive: true, force: true });
  await rm(publicArticleDir, { recursive: true, force: true });
}
const compiled = await Promise.all(publishedArticles.map(compileArticle));
compiled.sort((a, b) => b.summary.date.localeCompare(a.summary.date) || a.summary.title.localeCompare(b.summary.title));
compiled.forEach((article, index) => {
  article.summary.priority = index + 1;
  article.full.priority = index + 1;
});

if (!checkOnly) {
  await Promise.all(compiled.map(({ full }) => writeJson(path.join(publicArticleDir, `${full.id}.json`), full)));
  await writeJson(generatedIndexPath, compiled.map(({ summary }) => summary));
  await writeJson(path.join(distDir, "manifest.json"), {
    name: publication.name,
    schemaVersion: 1,
    articleCount: compiled.length,
    lastUpdated: compiled.map(({ summary }) => summary.updated).sort().at(-1),
    index: `${contentBaseUrl}/index.json`,
    articles: `${contentBaseUrl}/articles/{slug}.json`,
    media: `${contentBaseUrl}/media/articles/`,
  });
  await writeFile(path.join(distDir, ".nojekyll"), "", "utf8");
  await writeFile(
    path.join(distDir, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${publication.name} content feed</title><body><main><h1>${publication.name} content feed</h1><p>This repository serves the publication's article data and images.</p><p><a href="./index.json">Article index</a> · <a href="./manifest.json">Feed manifest</a></p></main></body></html>\n`,
    "utf8",
  );
  await cleanupGeneratedMedia(generatedMediaPaths(compiled));
}

const totalWords = compiled.reduce((sum, article) => sum + article.summary.wordCount, 0);
console.log(`${checkOnly ? "Validated" : "Built"} ${compiled.length} published article${compiled.length === 1 ? "" : "s"} (${totalWords.toLocaleString()} words).`);
