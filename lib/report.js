/**
 * Report generation: CSV with one row per run + summary row
 */

const fs = require("fs");
const { median, percentile, improvement, stdDev, formatMs, formatPercent } = require("./utils");

const CSV_HEADER = [
  "timestamp",
  "page_id",
  "variant",
  "run",
  "images_ms",
  "avg_img_ms",
  "ttfb_ms",
  "lcp_ms",
  "images_total",
  "images_failed",
  "errors",
  // Summary columns (filled only in TOTAL row)
  "origin_median",
  "origin_p90",
  "origin_avg_img",
  "cdn_median",
  "cdn_p90",
  "cdn_avg_img",
  "improvement_%",
  "improvement_p90_%",
].join(",");

function recordToCsvRow(record) {
  return [
    record.timestamp_iso,
    record.page_id,
    record.variant,
    record.run_index + 1,
    record.images_loaded_ms ?? "",
    record.avg_image_ms ?? "",
    record.ttfb_ms ?? "",
    record.lcp_ms ?? "",
    record.images_total ?? "",
    record.images_failed ?? "",
    record.errors_count ?? "",
    "", "", "", "", "", "", "", "",
  ].join(",");
}

function computeSummary(records) {
  const origin = records.filter((r) => r.variant === "origin");
  const cdn = records.filter((r) => r.variant === "cdn");

  const originValues = origin.map((r) => r.images_loaded_ms).filter((v) => v != null);
  const cdnValues = cdn.map((r) => r.images_loaded_ms).filter((v) => v != null);
  const originAvgImg = origin.map((r) => r.avg_image_ms).filter((v) => v != null);
  const cdnAvgImg = cdn.map((r) => r.avg_image_ms).filter((v) => v != null);

  const originMedian = originValues.length ? median(originValues) : null;
  const originP90 = originValues.length ? percentile(originValues, 0.9) : null;
  const originStddev = originValues.length > 1 ? stdDev(originValues) : null;
  const originAvgImgMedian = originAvgImg.length ? median(originAvgImg) : null;

  const cdnMedian = cdnValues.length ? median(cdnValues) : null;
  const cdnP90 = cdnValues.length ? percentile(cdnValues, 0.9) : null;
  const cdnStddev = cdnValues.length > 1 ? stdDev(cdnValues) : null;
  const cdnAvgImgMedian = cdnAvgImg.length ? median(cdnAvgImg) : null;

  const improvementMedian = improvement(originMedian, cdnMedian);
  const improvementP90 = improvement(originP90, cdnP90);

  return {
    originMedian: originMedian != null ? Math.round(originMedian) : null,
    originP90: originP90 != null ? Math.round(originP90) : null,
    originStddev: originStddev != null ? Math.round(originStddev) : null,
    originAvgImg: originAvgImgMedian != null ? Math.round(originAvgImgMedian) : null,
    cdnMedian: cdnMedian != null ? Math.round(cdnMedian) : null,
    cdnP90: cdnP90 != null ? Math.round(cdnP90) : null,
    cdnStddev: cdnStddev != null ? Math.round(cdnStddev) : null,
    cdnAvgImg: cdnAvgImgMedian != null ? Math.round(cdnAvgImgMedian) : null,
    improvementMedian,
    improvementP90,
    originErrors: origin.reduce((sum, r) => sum + (r.errors_count || 0), 0),
    cdnErrors: cdn.reduce((sum, r) => sum + (r.errors_count || 0), 0),
  };
}

function summaryToCsvRow(summary, timestamp) {
  return [
    timestamp,
    "TOTAL",
    "-",
    "-",
    "", "", "", "", "", "", "",
    summary.originMedian ?? "",
    summary.originP90 ?? "",
    summary.originAvgImg ?? "",
    summary.cdnMedian ?? "",
    summary.cdnP90 ?? "",
    summary.cdnAvgImg ?? "",
    summary.improvementMedian != null ? summary.improvementMedian.toFixed(1) : "",
    summary.improvementP90 != null ? summary.improvementP90.toFixed(1) : "",
  ].join(",");
}

function printSummary(summary) {
  console.log("");
  console.log("=== SUMMARY ===");
  console.log(
    `origin: median ${formatMs(summary.originMedian)}, p90 ${formatMs(summary.originP90)}, avg/img ${formatMs(summary.originAvgImg)}, errors ${summary.originErrors}`
  );
  console.log(
    `cdn:    median ${formatMs(summary.cdnMedian)}, p90 ${formatMs(summary.cdnP90)}, avg/img ${formatMs(summary.cdnAvgImg)}, errors ${summary.cdnErrors}`
  );
  console.log(
    `improvement: median ${formatPercent(summary.improvementMedian)}, p90 ${formatPercent(summary.improvementP90)}`
  );
}

async function saveReport({ outputPath, records }) {
  const lines = [CSV_HEADER];

  for (const record of records) {
    lines.push(recordToCsvRow(record));
  }

  const summary = computeSummary(records);
  lines.push(summaryToCsvRow(summary, new Date().toISOString()));

  await fs.promises.writeFile(outputPath, lines.join("\n"));
  printSummary(summary);

  return summary;
}

// Image benchmark report
function computeImageStats(records) {
  const totalValues = records.map((r) => r.total_ms).filter((v) => v != null);
  const ttfbValues = records.map((r) => r.ttfb_ms).filter((v) => v != null);

  return {
    total_mean_ms: totalValues.length ? Math.round(totalValues.reduce((a, b) => a + b, 0) / totalValues.length) : null,
    total_p50_ms: totalValues.length ? Math.round(percentile(totalValues, 0.5)) : null,
    total_p95_ms: totalValues.length ? Math.round(percentile(totalValues, 0.95)) : null,
    total_p99_ms: totalValues.length ? Math.round(percentile(totalValues, 0.99)) : null,
    total_stddev_ms: totalValues.length ? Math.round(stdDev(totalValues)) : null,
    ttfb_mean_ms: ttfbValues.length ? Math.round(ttfbValues.reduce((a, b) => a + b, 0) / ttfbValues.length) : null,
    ttfb_p50_ms: ttfbValues.length ? Math.round(percentile(ttfbValues, 0.5)) : null,
    ttfb_p95_ms: ttfbValues.length ? Math.round(percentile(ttfbValues, 0.95)) : null,
    ttfb_p99_ms: ttfbValues.length ? Math.round(percentile(ttfbValues, 0.99)) : null,
    errors: records.reduce((sum, r) => sum + r.errors_count, 0),
  };
}

module.exports = {
  saveReport,
  computeSummary,
  printSummary,
  computeImageStats,
};
