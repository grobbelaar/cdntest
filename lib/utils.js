/**
 * Utility functions: stats, formatting, helpers
 */

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return null;
  const avg = mean(values);
  const squareDiffs = values.map((v) => Math.pow(v - avg, 2));
  return Math.sqrt(squareDiffs.reduce((sum, v) => sum + v, 0) / (values.length - 1));
}

function improvement(originMs, cdnMs) {
  if (originMs == null || cdnMs == null || originMs === 0) return null;
  return ((originMs - cdnMs) / originMs) * 100;
}

function formatMs(value) {
  if (value == null || Number.isNaN(value)) return "n/a";
  return `${Math.round(value)}ms`;
}

function formatPercent(value) {
  if (value == null || Number.isNaN(value)) return "n/a";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(fn, attempts, backoffMs, onRetry) {
  let lastError = null;
  const total = Math.max(1, attempts);
  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      return await fn(attempt, total);
    } catch (error) {
      lastError = error;
      if (attempt >= total) break;
      const delay = backoffMs * Math.pow(2, attempt - 1);
      if (onRetry) onRetry(attempt, total, error, delay);
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastError;
}

function makeRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date}-${time}`;
}

function parseBool(value) {
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

function toNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

function normalizeUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function cacheBustToken() {
  return `${Date.now()}${Math.floor(Math.random() * 1000000)}`;
}

function appendCacheBust(url, token) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}nocache=${token}`;
}

function parseHostPatterns(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  return raw.split(",").map((e) => e.trim()).filter(Boolean);
}

function hasCliArg(flag) {
  return process.argv.some(
    (arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`)
  );
}

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

module.exports = {
  median,
  percentile,
  mean,
  stdDev,
  improvement,
  formatMs,
  formatPercent,
  sleep,
  withRetries,
  makeRunId,
  parseBool,
  toNonEmptyString,
  normalizeBaseUrl,
  normalizeUrl,
  cacheBustToken,
  appendCacheBust,
  parseHostPatterns,
  hasCliArg,
  shuffle,
};
