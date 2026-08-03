import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";

function mib(bytes) {
  return Number((Number(bytes || 0) / 1024 / 1024).toFixed(3));
}

export function createRunLogEntry(summary, outputRoot, rootDir) {
  const perSource = summary.results.map((result) => {
    const dataBytes = result.saved.reduce((total, record) => total + Number(record.data_bytes || 0), 0);
    const imageBytes = result.saved.reduce((total, record) => total + Number(record.image_bytes || 0), 0);
    const bytesSaved = result.saved.reduce(
      (total, record) => total + Number(record.lossless_compression?.bytes_saved || 0),
      0,
    );
    return {
      source_id: result.source_id,
      source_name: result.name,
      status: result.status,
      discovered: result.discovered,
      articles_saved: result.saved.length,
      extraction_failures: result.failures.length,
      data_bytes: dataBytes,
      data_mib: mib(dataBytes),
      image_bytes: imageBytes,
      lossless_bytes_saved: bytesSaved,
    };
  });

  return {
    schema_version: 1,
    run_id: summary.collected_at,
    run_type: "article-collection",
    started_at: summary.started_at,
    completed_at: summary.collected_at,
    duration_ms: summary.elapsed_ms,
    date_range: {
      start_inclusive: summary.range.start,
      end_exclusive: summary.range.endExclusive,
    },
    limit_per_source: summary.limit_per_source,
    output_root: path.relative(rootDir, outputRoot) || ".",
    selected_sources: summary.selected_sources,
    per_source: perSource,
    totals: {
      sources_requested: perSource.length,
      sources_with_articles: summary.sources_with_articles,
      failed_sources: summary.failed_sources.length,
      extraction_failures: perSource.reduce((total, source) => total + source.extraction_failures, 0),
      articles_saved: summary.total_saved,
      data_bytes: summary.data_bytes,
      data_mib: mib(summary.data_bytes),
      image_bytes: summary.image_bytes,
      image_mib: mib(summary.image_bytes),
      lossless_compression: summary.lossless_compression,
    },
  };
}

export async function appendRunLog(file, entry) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

