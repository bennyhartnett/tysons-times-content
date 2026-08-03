import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { losslesslyCompressImage } from "./scrapers/media.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputRoot = path.join(rootDir, "input");
const target = process.argv[2] ? path.resolve(rootDir, process.argv[2]) : inputRoot;
const relativeTarget = path.relative(inputRoot, target);
if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
  throw new Error("The lossless optimizer only accepts paths inside input.");
}

async function findMetadata(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return findMetadata(file);
      return entry.isFile() && entry.name === "metadata.json" ? [file] : [];
    }),
  );
  return nested.flat();
}

function mediaTypeFor(image) {
  if (image.media_type) return image.media_type;
  const extension = path.extname(image.local_path || "").toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

const totals = {
  records: 0,
  images_examined: 0,
  eligible_images: 0,
  optimized_images: 0,
  bytes_before: 0,
  bytes_after: 0,
  bytes_saved: 0,
};

for (const metadataFile of await findMetadata(target)) {
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  let changed = false;
  totals.records += 1;
  for (const image of metadata.images || []) {
    if (!image.local_path) continue;
    const imagePath = path.join(path.dirname(metadataFile), image.local_path);
    const input = await readFile(imagePath);
    const optimized = await losslesslyCompressImage(input, mediaTypeFor(image));
    totals.images_examined += 1;
    totals.bytes_before += optimized.bytesBefore;
    totals.bytes_after += optimized.bytesAfter;
    if (optimized.attempted) totals.eligible_images += 1;
    if (!optimized.optimized) continue;

    await writeFile(imagePath, optimized.buffer);
    image.bytes = optimized.bytesAfter;
    const originalBytes = image.lossless_compression?.original_bytes || optimized.bytesBefore;
    image.lossless_compression = {
      method: optimized.method,
      original_bytes: originalBytes,
      bytes_saved: originalBytes - optimized.bytesAfter,
    };
    totals.optimized_images += 1;
    totals.bytes_saved += optimized.bytesSaved;
    changed = true;
  }
  if (changed) await writeFile(metadataFile, JSON.stringify(metadata, null, 2) + "\n", "utf8");
}

let storedBytes = 0;
for (const metadataFile of await findMetadata(target)) {
  const directory = path.dirname(metadataFile);
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  for (const relative of [
    "metadata.json",
    "article.html",
    "article.txt",
    metadata.document?.local_path,
    ...(metadata.images || []).map((image) => image.local_path),
  ].filter(Boolean)) {
    try {
      storedBytes += (await stat(path.join(directory, relative))).size;
    } catch {
      // The collection audit reports missing referenced files separately.
    }
  }
}

console.log(
  JSON.stringify(
    {
      ...totals,
      stored_data_bytes: storedBytes,
      stored_data_mib: Number((storedBytes / 1024 / 1024).toFixed(3)),
    },
    null,
    2,
  ),
);
