import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import sharp from "sharp";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTarget = path.join(rootDir, "content", "articles");
const requestedTarget = process.argv[2] ? path.resolve(rootDir, process.argv[2]) : defaultTarget;

const targetRelativePath = path.relative(defaultTarget, requestedTarget);
if (targetRelativePath.startsWith("..") || path.isAbsolute(targetRelativePath)) {
  throw new Error("The optimizer only accepts paths inside content/articles.");
}

async function findArticles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return findArticles(target);
      return entry.isFile() && entry.name === "article.md" ? [target] : [];
    }),
  );
  return results.flat();
}

let converted = 0;
let bytesBefore = 0;
let bytesAfter = 0;
const articleFiles = await findArticles(requestedTarget);

for (const articleFile of articleFiles) {
  const raw = await readFile(articleFile, "utf8");
  const parsed = matter(raw);
  const imageConfigs = [parsed.data.hero, ...(parsed.data.images || [])].filter(Boolean);
  let updated = raw;

  for (const image of imageConfigs) {
    const extension = path.extname(image.file || "").toLowerCase();
    if (!extension || extension === ".webp") continue;

    const sourcePath = path.join(path.dirname(articleFile), image.file);
    const outputName = `${path.basename(image.file, extension)}.webp`;
    const outputPath = path.join(path.dirname(articleFile), outputName);
    const input = await readFile(sourcePath);
    bytesBefore += input.byteLength;

    await sharp(input)
      .rotate()
      .resize({ width: 2000, height: 1400, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 86, effort: 5 })
      .toFile(outputPath);

    const optimized = await readFile(outputPath);
    bytesAfter += optimized.byteLength;
    updated = updated.replaceAll(image.file, outputName);
    await unlink(sourcePath);
    converted += 1;
  }

  if (updated !== raw) await writeFile(articleFile, updated, "utf8");
}

const saved = bytesBefore - bytesAfter;
console.log(
  `Optimized ${converted} source image${converted === 1 ? "" : "s"}; saved ${(saved / 1024 / 1024).toFixed(1)} MB.`,
);
