import sharp from "sharp";

function skipped(buffer, mediaType, reason) {
  return {
    buffer,
    mediaType,
    attempted: false,
    optimized: false,
    method: null,
    bytesBefore: buffer.length,
    bytesAfter: buffer.length,
    bytesSaved: 0,
    reason,
  };
}

async function sameDecodedPixels(before, after) {
  const original = await sharp(before).raw().toBuffer({ resolveWithObject: true });
  const optimized = await sharp(after).raw().toBuffer({ resolveWithObject: true });
  return (
    original.info.width === optimized.info.width &&
    original.info.height === optimized.info.height &&
    original.info.channels === optimized.info.channels &&
    original.data.equals(optimized.data)
  );
}

export async function losslesslyCompressImage(buffer, contentType) {
  const mediaType = String(contentType || "").split(";")[0].toLowerCase();
  if (mediaType !== "image/png" && mediaType !== "image/webp") {
    return skipped(buffer, mediaType, "No safe in-process lossless optimizer for this format.");
  }

  try {
    const metadata = await sharp(buffer).metadata();
    if ((metadata.pages || 1) > 1) {
      return skipped(buffer, mediaType, "Animated images are preserved byte-for-byte.");
    }

    let pipeline = sharp(buffer).keepMetadata();
    let method;
    if (mediaType === "image/png") {
      method = "sharp-png-compression-level-9";
      pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false });
    } else {
      method = "sharp-webp-lossless-effort-6";
      pipeline = pipeline.webp({ lossless: true, effort: 6 });
    }

    const candidate = await pipeline.toBuffer();
    if (candidate.length >= buffer.length) {
      return {
        ...skipped(buffer, mediaType, "Optimized representation was not smaller."),
        attempted: true,
        method,
      };
    }
    if (!(await sameDecodedPixels(buffer, candidate))) {
      return {
        ...skipped(buffer, mediaType, "Decoded pixels changed, so the original was retained."),
        attempted: true,
        method,
      };
    }

    return {
      buffer: candidate,
      mediaType,
      attempted: true,
      optimized: true,
      method,
      bytesBefore: buffer.length,
      bytesAfter: candidate.length,
      bytesSaved: buffer.length - candidate.length,
      reason: null,
    };
  } catch (error) {
    return {
      ...skipped(buffer, mediaType, "Lossless optimization failed; original retained: " + String(error.message || error)),
      attempted: true,
    };
  }
}
