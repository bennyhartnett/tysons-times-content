import crypto from "node:crypto";
import path from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { fetchBuffer, slugify, writeJson } from "./core.mjs";
import { losslesslyCompressImage } from "./media.mjs";

const mediaTypeExtensions = new Map([
  ["image/avif", ".avif"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/svg+xml", ".svg"],
  ["image/webp", ".webp"],
]);

function stableArticleSlug(record) {
  const fromPath = (() => {
    try {
      const parts = new URL(record.canonical_url || record.source_url).pathname.split("/").filter(Boolean);
      return parts.at(-1)?.replace(/\.[a-z0-9]+$/i, "");
    } catch {
      return null;
    }
  })();
  const stem = slugify(fromPath || record.title);
  const identity = record.canonical_url || record.source_url || record.title;
  const suffix = crypto.createHash("sha1").update(identity).digest("hex").slice(0, 8);
  return stem + "-" + suffix;
}

function extensionFor(url, contentType) {
  const mediaType = String(contentType || "").split(";")[0].toLowerCase();
  if (mediaTypeExtensions.has(mediaType)) return mediaTypeExtensions.get(mediaType);
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.(avif|gif|jpe?g|png|svg|webp)$/.test(extension)) {
      return extension === ".jpeg" ? ".jpg" : extension;
    }
  } catch {
    // Fall through to the safe default.
  }
  return ".jpg";
}

function imageDownloadUrls(url) {
  const candidates = [url];
  try {
    const parsed = new URL(url);
    if (parsed.pathname.includes("/wp-content/uploads/") && !/^i\d\.wp\.com$/i.test(parsed.hostname)) {
      const proxy = new URL("https://i0.wp.com/");
      proxy.pathname = "/" + parsed.hostname + parsed.pathname;
      proxy.search = parsed.search;
      candidates.push(proxy.href);
    }
  } catch {
    // The original URL will report the useful validation error.
  }
  return candidates;
}

async function downloadImages(source, articleDir, images, maximum) {
  const stored = [];
  const compression = {
    images_examined: 0,
    eligible_images: 0,
    optimized_images: 0,
    bytes_before: 0,
    bytes_after: 0,
    bytes_saved: 0,
  };
  const imageDir = path.join(articleDir, "images");
  for (const [index, image] of images.slice(0, maximum).entries()) {
    try {
      let download;
      let lastError;
      for (const url of imageDownloadUrls(image.url)) {
        try {
          const candidate = await fetchBuffer(url, {
            delayMs: source.delayMs,
            timeoutMs: 30_000,
            headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5" },
          });
          const contentType = candidate.response.headers.get("content-type") || "";
          if (!contentType.toLowerCase().startsWith("image/")) {
            throw new Error("Expected an image but received " + contentType);
          }
          download = { ...candidate, contentType };
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!download) throw lastError;

      const { buffer, response, contentType } = download;
      if (buffer.length > 15 * 1024 * 1024) throw new Error("Image exceeds the 15 MB limit.");
      const optimized = await losslesslyCompressImage(buffer, contentType);
      compression.images_examined += 1;
      if (optimized.attempted) compression.eligible_images += 1;
      if (optimized.optimized) compression.optimized_images += 1;
      compression.bytes_before += optimized.bytesBefore;
      compression.bytes_after += optimized.bytesAfter;
      compression.bytes_saved += optimized.bytesSaved;
      const extension = extensionFor(response.url, contentType);
      const filename = String(index + 1).padStart(3, "0") + extension;
      await mkdir(imageDir, { recursive: true });
      await writeFile(path.join(imageDir, filename), optimized.buffer);
      const storedImage = {
        ...image,
        fetched_url: response.url,
        local_path: "images/" + filename,
        media_type: contentType.split(";")[0],
        bytes: optimized.buffer.length,
      };
      if (optimized.optimized) {
        storedImage.lossless_compression = {
          method: optimized.method,
          original_bytes: optimized.bytesBefore,
          bytes_saved: optimized.bytesSaved,
        };
      }
      stored.push(storedImage);
    } catch (error) {
      stored.push({ ...image, download_error: String(error.message || error) });
    }
  }
  return { images: stored, compression };
}

async function storedDataStats(articleDir, metadata, compression) {
  const files = ["metadata.json"];
  if (metadata.quality?.characters) files.push("article.html", "article.txt");
  if (metadata.document?.local_path) files.push(metadata.document.local_path);
  for (const image of metadata.images || []) {
    if (image.local_path) files.push(image.local_path);
  }

  let totalBytes = 0;
  let imageBytes = 0;
  for (const relative of new Set(files)) {
    try {
      const bytes = (await stat(path.join(articleDir, relative))).size;
      totalBytes += bytes;
      if (relative.startsWith("images/")) imageBytes += bytes;
    } catch {
      // Missing optional files are already represented in record metadata.
    }
  }
  return {
    total_bytes: totalBytes,
    image_bytes: imageBytes,
    lossless_compression: compression,
  };
}

export async function storeRecord(source, record, options) {
  const publishedDay = record.publication_day || record.published_at?.slice(0, 10) || "undated";
  const articleDir = path.join(
    options.outputRoot,
    source.id,
    "unprocessed-articles",
    publishedDay,
    stableArticleSlug(record),
  );
  await mkdir(articleDir, { recursive: true });

  if (record.body_html) await writeFile(path.join(articleDir, "article.html"), record.body_html + "\n", "utf8");
  if (record.body_text) await writeFile(path.join(articleDir, "article.txt"), record.body_text + "\n", "utf8");
  if (record._documentBuffer) await writeFile(path.join(articleDir, "article.pdf"), record._documentBuffer);

  const metadata = { ...record };
  delete metadata.body_html;
  delete metadata.body_text;
  delete metadata._documentBuffer;
  let compression = {
    images_examined: 0,
    eligible_images: 0,
    optimized_images: 0,
    bytes_before: 0,
    bytes_after: 0,
    bytes_saved: 0,
  };
  if (options.downloadImages) {
    const downloaded = await downloadImages(source, articleDir, metadata.images || [], options.maxImages);
    metadata.images = downloaded.images;
    compression = downloaded.compression;
  } else {
    metadata.images = (metadata.images || []).slice(0, options.maxImages);
  }
  if (metadata.document && record._documentBuffer) {
    metadata.document = {
      ...metadata.document,
      local_path: "article.pdf",
      bytes: record._documentBuffer.length,
    };
  }
  await writeJson(path.join(articleDir, "metadata.json"), metadata);
  const stats = await storedDataStats(articleDir, metadata, compression);
  return { articleDir, metadata, stats };
}
