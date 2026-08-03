import crypto from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import matter from "gray-matter";
import sharp from "sharp";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultContentRoot = path.join(rootDir, "content", "articles");
const defaultInputRoot = path.join(rootDir, "input");
const defaultFallbackImage = path.join(rootDir, "tools", "publisher-gui", "assets", "editorial-fallback.webp");

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-publish.mjs --article PATH [--article PATH] [options]",
    "  node scripts/prepare-publish.mjs --all [options]",
    "",
    "Options:",
    "  --article PATH                 Rewrite-stage article.md to prepare (repeatable)",
    "  --all                          Prepare every status: rewrite article",
    "  --image-mode source|illustration  Prefer archived source media or use house art",
    "  --author NAME                  Publication byline (default Tysons Times Staff)",
    "  --content-root PATH            Override content/articles root",
    "  --input-root PATH              Override collected bundle root",
    "  --fallback-image PATH          Override the publication illustration",
    "  --preview                      Relax production-length and duplicate checks",
    "  --dry-run                      Validate and report without writing",
    "  --json                         Print a machine-readable result",
  ].join("\n");
}

export function parseOptions(argv) {
  const options = {
    articlePaths: [],
    all: false,
    imageMode: "source",
    author: "Tysons Times Staff",
    contentRoot: defaultContentRoot,
    inputRoot: defaultInputRoot,
    fallbackImage: defaultFallbackImage,
    preview: false,
    dryRun: false,
    json: false,
  };
  const next = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--article") options.articlePaths.push(path.resolve(rootDir, next(index++, flag)));
    else if (flag === "--all") options.all = true;
    else if (flag === "--image-mode") options.imageMode = next(index++, flag).toLowerCase();
    else if (flag === "--author") options.author = next(index++, flag).trim();
    else if (flag === "--content-root") options.contentRoot = path.resolve(rootDir, next(index++, flag));
    else if (flag === "--input-root") options.inputRoot = path.resolve(rootDir, next(index++, flag));
    else if (flag === "--fallback-image") options.fallbackImage = path.resolve(rootDir, next(index++, flag));
    else if (flag === "--preview") options.preview = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.help && options.all === Boolean(options.articlePaths.length)) {
    throw new Error("Choose either --all or one or more --article paths.");
  }
  if (!["source", "illustration"].includes(options.imageMode)) {
    throw new Error("--image-mode must be source or illustration.");
  }
  if (options.author.length < 2 || options.author.length > 60) throw new Error("--author must be 2-60 characters.");
  return options;
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function findNamedFiles(directory, filename) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return findNamedFiles(target, filename);
    return entry.isFile() && entry.name === filename ? [target] : [];
  }));
  return nested.flat().sort();
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function asDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  return String(value || "").slice(0, 10);
}

export function normalizedTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function identitySuffix(sourceId, slug) {
  return crypto.createHash("sha1").update(`${sourceId}/${slug}`).digest("hex").slice(0, 8);
}

function plain(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clipped(value, maximum) {
  const clean = plain(value);
  if (clean.length <= maximum) return clean;
  const prefix = clean.slice(0, maximum - 3);
  const breakAt = Math.max(prefix.lastIndexOf(" "), maximum - 24);
  return `${prefix.slice(0, breakAt)}...`;
}

function bodyWords(body) {
  return body.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length || 0;
}

export function dekFromBody(body) {
  const paragraphs = body.split(/\r?\n\s*\r?\n/).map(plain).filter((value) => value && !value.startsWith("## "));
  let dek = paragraphs[0] || "Tysons Times reports the latest developments affecting residents across Northern Virginia.";
  if (dek.length < 60 && paragraphs[1]) dek = `${dek} ${paragraphs[1]}`;
  if (dek.length < 60) dek = `${dek} The report is part of continuing Tysons Times local coverage.`;
  return clipped(dek, 190);
}

const locationPatterns = [
  ["Seven Corners", /\bseven corners\b/i],
  ["Fairfax Station", /\bfairfax station\b/i],
  ["Falls Church", /\bfalls church\b/i],
  ["Dunn Loring", /\bdunn loring\b/i],
  ["Tysons", /\btysons(?: corner)?\b/i],
  ["McLean", /\bmclean\b/i],
  ["Vienna", /\bvienna\b/i],
  ["Reston", /\breston\b/i],
  ["Herndon", /\bherndon\b/i],
  ["Springfield", /\bspringfield\b/i],
  ["Arlington", /\barlington\b/i],
  ["Oakton", /\boakton\b/i],
  ["Fairfax", /\bfairfax\b/i],
];

export function inferLocation(title, body) {
  const headline = plain(title);
  const text = `${headline} ${plain(body).slice(0, 1800)}`;
  for (const [location, pattern] of locationPatterns) {
    if (pattern.test(headline)) return location;
  }
  for (const [location, pattern] of locationPatterns) {
    if (pattern.test(text)) return location;
  }
  if (/\bmetro|wmata|orange line|silver line\b/i.test(text)) return "Washington Region";
  if (/\bvirginia\b/i.test(text)) return "Virginia";
  return "Northern Virginia";
}

const tagRules = [
  ["Metro", /\bmetro|wmata|orange line|silver line\b/i],
  ["development", /\bdevelopment|developer|construction|zoning|planning\b/i],
  ["public safety", /\bpolice|charged|crash|killed|dies|sentenced|convicted|fire\b/i],
  ["schools", /\bschool|student|teacher|fcps|education\b/i],
  ["business", /\bbusiness|store|retail|restaurant|real estate|employer\b/i],
  ["arts", /\bart|theater|theatre|film|movie|music|festival\b/i],
  ["sports", /\bsports?|soccer|baseball|basketball|athletics|league|fifa\b/i],
  ["environment", /\bwater|groundwater|environment|park|trail\b/i],
  ["transportation", /\btraffic|road|bus|train|transit|transportation\b/i],
  ["local government", /\bcounty|city council|mayor|commissioner|government\b/i],
  ["events", /\bevent|festival|fair|weekend\b/i],
];

export function inferTags(section, location, title, body) {
  const values = [section];
  if (location.length <= 28 && location !== "Northern Virginia" && location !== "Washington Region") values.push(location);
  const text = `${title} ${body}`;
  for (const [tag, pattern] of tagRules) {
    if (pattern.test(text)) values.push(tag);
    if (values.length >= 4) break;
  }
  if (values.length < 2) values.push("Northern Virginia");
  return [...new Set(values.map((value) => value.toLowerCase().trim()))].slice(0, 6);
}

function inferType(section, title, body, words) {
  const text = `${title} ${body.slice(0, 400)}`;
  if (words >= 300 && (section === "opinion" || /\bopinion|editorial|commentary\b/i.test(text))) return "opinion";
  if (words >= 250 && /\bfilms?|movies?|review\b/i.test(text)) return "review";
  return words >= 250 ? "standard" : "brief";
}

function sourceCredit(image, sourceName) {
  const value = plain(image.credit || image.caption);
  const staff = value.match(/staff photo by ([^)]+)/i);
  if (staff) return clipped(`${staff[1]} / ${sourceName}`, 80);
  const wtop = value.match(/WTOP\/([^)]+)/i);
  if (wtop) return clipped(`WTOP / ${wtop[1]}`, 80);
  const getty = value.match(/Getty Images\/([^)]+)/i);
  if (getty) return clipped(`Getty Images / ${getty[1]}`, 80);
  const ap = value.match(/AP Photo\/([^,)]+)/i);
  if (ap) return clipped(`AP / ${ap[1]}`, 80);
  const courtesy = value.match(/Courtesy ([^)]+)/i);
  if (courtesy) return clipped(`Courtesy ${courtesy[1]}`, 80);
  if (/via FCPD/i.test(value)) return "Fairfax County Police";
  if (/via Fairfax County/i.test(value)) return "Fairfax County";
  if (/IMDb/i.test(value)) return "IMDb / archived source capture";
  return clipped(`${sourceName || "Source archive"} / archived source image`, 80);
}

async function bundleMap(inputRoot) {
  const map = new Map();
  for (const metadataPath of await findNamedFiles(inputRoot, "metadata.json")) {
    const parts = path.relative(inputRoot, metadataPath).split(path.sep);
    const queueIndex = parts.indexOf("processed-articles");
    if (queueIndex < 0 || !parts[queueIndex + 2]) continue;
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    map.set(identitySuffix(parts[0], parts[queueIndex + 2]), {
      directory: path.dirname(metadataPath),
      metadata,
    });
  }
  return map;
}

async function selectSourceImage(bundle) {
  for (const image of bundle?.metadata?.images || []) {
    if (!image.local_path || (!plain(image.alt) && !plain(image.caption))) continue;
    const sourcePath = path.join(bundle.directory, ...image.local_path.split("/"));
    try {
      const metadata = await sharp(sourcePath).metadata();
      const ratio = metadata.width / metadata.height;
      if (metadata.width >= 1200 && metadata.height >= 700 && ratio >= 1.25 && ratio <= 2.1) {
        return { image, sourcePath };
      }
    } catch {
      // The publication illustration is used when an archived image is unreadable.
    }
  }
  return null;
}

function frontMatter({ title, dek, author, location, published, type, tags, hero, body }) {
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    `dek: ${JSON.stringify(dek)}`,
    `author: ${JSON.stringify(author)}`,
    `location: ${JSON.stringify(location)}`,
    `published: ${JSON.stringify(published)}`,
    "status: published",
    `type: ${type}`,
    "tags:",
    ...tags.map((tag) => `  - ${JSON.stringify(tag)}`),
    "hero:",
    `  file: ${JSON.stringify(hero.file)}`,
    `  alt: ${JSON.stringify(hero.alt)}`,
    `  caption: ${JSON.stringify(hero.caption)}`,
    `  credit: ${JSON.stringify(hero.credit)}`,
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

export async function prepareArticles(options) {
  const contentRoot = path.resolve(options.contentRoot || defaultContentRoot);
  const inputRoot = path.resolve(options.inputRoot || defaultInputRoot);
  const fallbackImage = path.resolve(options.fallbackImage || defaultFallbackImage);
  const allArticleFiles = await findNamedFiles(contentRoot, "article.md");
  const selected = options.all
    ? allArticleFiles.filter((file) => matter.read(file).data.status === "rewrite")
    : [...new Set(options.articlePaths.map((file) => path.resolve(file)))];
  if (!selected.length) return { prepared: 0, articles: [] };
  for (const articlePath of selected) {
    if (!isWithin(contentRoot, articlePath) || path.basename(articlePath) !== "article.md") {
      throw new Error(`Article path must be an article.md inside ${contentRoot}: ${articlePath}`);
    }
    if (!await pathExists(articlePath)) throw new Error(`Article does not exist: ${articlePath}`);
  }
  if (!await pathExists(fallbackImage)) throw new Error(`Fallback illustration is missing: ${fallbackImage}`);

  const selectedParsed = await Promise.all(selected.map(async (file) => ({ file, parsed: matter(await readFile(file, "utf8")) })));
  selectedParsed.forEach(({ file, parsed }) => {
    if (parsed.data.status !== "rewrite") throw new Error(`Article is not in rewrite staging: ${file}`);
  });

  if (!options.preview) {
    const seen = new Map();
    for (const { file, parsed } of selectedParsed) {
      const key = normalizedTitle(parsed.data.title);
      if (seen.has(key)) throw new Error(`Duplicate staged headline selected: ${parsed.data.title}`);
      seen.set(key, file);
    }
    for (const file of allArticleFiles.filter((candidate) => !selected.includes(candidate))) {
      const parsed = matter(await readFile(file, "utf8"));
      if (parsed.data.status !== "published") continue;
      const duplicate = seen.get(normalizedTitle(parsed.data.title));
      if (duplicate) throw new Error(`A published article already uses this headline: ${parsed.data.title}`);
    }
  }

  const bundles = await bundleMap(inputRoot);
  const articles = [];
  for (const { file, parsed } of selectedParsed) {
    const articleDirectory = path.dirname(file);
    const slug = path.basename(articleDirectory);
    const suffix = slug.match(/-([0-9a-f]{8})$/)?.[1];
    const bundle = suffix ? bundles.get(suffix) : null;
    const relativeParts = path.relative(contentRoot, file).split(path.sep);
    const section = relativeParts[0];
    const body = parsed.content.trim();
    const words = bodyWords(body);
    if (!options.preview && words < 120) {
      throw new Error(`${parsed.data.title} has ${words} words; production briefs require at least 120.`);
    }
    const location = inferLocation(parsed.data.title, body);
    const tags = inferTags(section, location, parsed.data.title, body);
    const type = inferType(section, parsed.data.title, body, words);
    const sourceImage = options.imageMode !== "illustration" ? await selectSourceImage(bundle) : null;
    let hero;
    if (sourceImage) {
      const extension = path.extname(sourceImage.sourcePath).toLowerCase();
      const filename = `hero${extension}`;
      const fallbackDescription = `Archived source image accompanying ${parsed.data.title}`;
      const altCandidate = plain(sourceImage.image.alt).length >= 12
        ? sourceImage.image.alt
        : plain(sourceImage.image.caption).length >= 12 ? sourceImage.image.caption : fallbackDescription;
      const captionCandidate = plain(sourceImage.image.caption).length >= 20
        ? sourceImage.image.caption
        : fallbackDescription;
      hero = {
        file: filename,
        alt: clipped(altCandidate, 180),
        caption: clipped(captionCandidate, 220),
        credit: sourceCredit(sourceImage.image, bundle.metadata.source_name),
        mode: "source",
      };
      if (!options.dryRun) await copyFile(sourceImage.sourcePath, path.join(articleDirectory, filename));
    } else {
      hero = {
        file: "hero.webp",
        alt: "Editorial illustration of Northern Virginia community life with transit, schools and local businesses",
        caption: "A Tysons Times illustration represents community life across Tysons and Northern Virginia.",
        credit: "Tysons Times / AI illustration",
        mode: "illustration",
      };
      if (!options.dryRun) await copyFile(fallbackImage, path.join(articleDirectory, hero.file));
    }
    const result = {
      id: slug,
      title: parsed.data.title,
      section,
      published: asDate(parsed.data.published),
      words,
      imageMode: hero.mode,
      articlePath: file,
      localUrl: `http://127.0.0.1:5173/#/article/${slug}`,
      productionUrl: `https://tysonstimes.org/#/article/${slug}`,
    };
    if (!options.dryRun) {
      await mkdir(articleDirectory, { recursive: true });
      await writeFile(file, frontMatter({
        title: parsed.data.title,
        dek: dekFromBody(body),
        author: options.author || "Tysons Times Staff",
        location,
        published: result.published,
        type,
        tags,
        hero,
        body,
      }), "utf8");
    }
    articles.push(result);
  }
  return { prepared: articles.length, articles };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await prepareArticles(options);
  if (options.json) console.log(JSON.stringify(result));
  else {
    console.log(`${options.dryRun ? "Checked" : "Prepared"} ${result.prepared} article${result.prepared === 1 ? "" : "s"}.`);
    result.articles.forEach((article) => console.log(`- ${article.title} (${article.imageMode})`));
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Publication preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
