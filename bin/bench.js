#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { chromium, firefox, webkit } = require("playwright");

const {
  sleep,
  makeRunId,
  parseBool,
  toNonEmptyString,
  normalizeBaseUrl,
  normalizeUrl,
  cacheBustToken,
  appendCacheBust,
  parseHostPatterns,
  formatMs,
  mean,
  percentile,
  stdDev,
} = require("../lib/utils");

const { requestText, fetchUrlMetrics, uploadFileS3, defaultS3Region } = require("../lib/http");
const { withRetries, hasCliArg } = require("../lib/utils");
const { detectCity } = require("../lib/geo");
const { runSingle, runImageSingle, runWarmup } = require("../lib/browser");
const { saveReport, computeImageStats } = require("../lib/report");

// Constants
const PAGES = ["page1", "page2", "page3"];
const VARIANTS = ["origin", "cdn"];

function buildPath(variant, pageId) {
  return `/cdntest/${pageId}/${variant}/index.html`;
}

async function loadConfig(configPath) {
  if (!configPath) return {};
  try {
    const data = await fs.promises.readFile(configPath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

function parseUrlList(data) {
  const urls = [];
  for (const line of data.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new Error(`Invalid URL: ${trimmed}`);
    }
    urls.push(trimmed);
  }
  if (urls.length === 0) throw new Error("No URLs found in list");
  return urls;
}

async function loadUrlListFromUrl(listUrl, timeoutMs) {
  if (!/^https?:\/\//i.test(listUrl)) {
    throw new Error("--urls must be http(s) URL");
  }
  const data = await requestText(listUrl, timeoutMs);
  return parseUrlList(data);
}

function getBrowserType(browserName) {
  switch (browserName) {
    case "firefox": return firefox;
    case "webkit": return webkit;
    default: return chromium;
  }
}

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ============ RUN COMMAND ============
async function cmdRun(args) {
  const config = await loadConfig(args.config);
  const baseUrl = normalizeBaseUrl(args["base-url"]);
  const repeats = Number(args.repeats);
  const browserName = args.browser;
  const headless = parseBool(args.headless);
  const timeoutMs = Number(args["timeout-ms"]) || 60000;
  const outputDir = args["output-dir"];
  const delayMs = Number(args["delay-ms"]) || 1000;
  const scrollDelayMs = Number(args["scroll-delay-ms"]) || 0;
  const verbose = parseBool(args.verbose);
  const allowedImageHosts = parseHostPatterns(args["image-hosts"]);

  // S3 config
  const s3Bucket = hasCliArg("s3-bucket") ? toNonEmptyString(args["s3-bucket"]) : toNonEmptyString(config.s3_bucket);
  const s3Prefix = hasCliArg("s3-prefix") ? toNonEmptyString(args["s3-prefix"]) : toNonEmptyString(config.s3_prefix);
  const s3Endpoint = hasCliArg("s3-endpoint") ? toNonEmptyString(args["s3-endpoint"]) : toNonEmptyString(config.s3_endpoint);
  const s3Region = hasCliArg("s3-region") ? toNonEmptyString(args["s3-region"]) : toNonEmptyString(config.s3_region) || defaultS3Region(s3Endpoint);
  const s3AccessKeyId = hasCliArg("s3-access-key-id") ? toNonEmptyString(args["s3-access-key-id"]) : toNonEmptyString(config.s3_access_key_id);
  const s3SecretAccessKey = hasCliArg("s3-secret-access-key") ? toNonEmptyString(args["s3-secret-access-key"]) : toNonEmptyString(config.s3_secret_access_key);

  // Geo detection
  const autoCity = parseBool(args["auto-city"]);
  const configCity = toNonEmptyString(config.city);
  const cliCity = toNonEmptyString(args.city);
  const declaredCity = cliCity || configCity || null;

  let cityGeo = null;
  let publicIp = null;

  if (autoCity) {
    const detected = await detectCity(3000);
    cityGeo = detected.city;
    publicIp = detected.ip;
    if (verbose) {
      const geo = cityGeo ? `${cityGeo} (${detected.source})` : "n/a";
      console.log(`Auto geo: ${geo}${publicIp ? ` ip ${publicIp}` : ""}`);
    }
  }

  // Setup output
  const runId = makeRunId();
  await ensureDir(outputDir);
  const csvPath = path.join(outputDir, `${runId}.csv`);

  const rawRecords = [];
  const meta = {
    city: declaredCity,
    city_geo: cityGeo,
  };

  // Launch browser
  const browserType = getBrowserType(browserName);
  const browser = await browserType.launch({ headless });

  try {
    // Build all URLs for warmup
    const allUrls = [];
    for (const pageId of PAGES) {
      for (const variant of VARIANTS) {
        allUrls.push(baseUrl + buildPath(variant, pageId));
      }
    }

    if (verbose) console.log("Warmup: start");
    await runWarmup({ browser, browserName, urls: allUrls, warmupRuns: 2, timeoutMs: 15000 });
    if (verbose) console.log("Warmup: done\n");

    // Main benchmark loop
    for (const pageId of PAGES) {
      for (let i = 0; i < repeats; i++) {
        const variantsOrder = shuffle(VARIANTS);

        for (const variant of variantsOrder) {
          const url = baseUrl + buildPath(variant, pageId);
          const logPrefix = `[${pageId}] ${variant} #${i + 1}`;

          const runData = await runSingle({
            browser,
            browserName,
            url,
            scrollDelayMs,
            allowedImageHosts,
            timeoutMs,
            verbose: false,
            logPrefix,
          });

          const record = {
            timestamp_iso: new Date().toISOString(),
            page_id: pageId,
            variant,
            run_index: i,
            images_loaded_ms: runData.imagesLoadedMs,
            avg_image_ms: runData.avgImageMs,
            images_total: runData.imagesTotal,
            images_failed: runData.imagesFailed,
            lcp_ms: runData.lcpMs,
            ttfb_ms: runData.ttfbMs,
            timeout: runData.timeout,
            errors_count: runData.errorsCount,
            city: declaredCity,
            city_geo: cityGeo,
          };
          rawRecords.push(record);

          if (verbose) {
            const images = runData.imagesLoadedMs != null ? `${runData.imagesLoadedMs}ms` : "n/a";
            const avgImg = runData.avgImageMs != null ? `${runData.avgImageMs}ms` : "n/a";
            const status = runData.timeout ? "TIMEOUT" : "ok";
            console.log(`${logPrefix} ${status} images=${images} avg/img=${avgImg} errors=${runData.errorsCount}`);
          }

          // Delay between runs (except last)
          const isLast = pageId === PAGES[PAGES.length - 1] && i === repeats - 1 && variant === variantsOrder[variantsOrder.length - 1];
          if (!isLast && delayMs > 0) {
            await sleep(delayMs);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  // Save CSV report
  await saveReport({ outputPath: csvPath, records: rawRecords, meta });
  console.log(`\nSaved: ${csvPath}`);

  // Upload to S3
  if (s3Bucket && s3AccessKeyId && s3SecretAccessKey) {
    const s3Key = s3Prefix ? `${s3Prefix}/${runId}.csv` : `${runId}.csv`;
    try {
      await withRetries(
        () => uploadFileS3({
          bucket: s3Bucket,
          key: s3Key,
          region: s3Region,
          endpoint: s3Endpoint,
          credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
          filePath: csvPath,
          contentType: "text/csv",
          timeoutMs: 30000,
        }),
        3,
        2000,
        (attempt, total, err) => console.log(`S3 retry ${attempt}/${total}: ${err.message}`)
      );
      console.log(`Uploaded: s3://${s3Bucket}/${s3Key}`);
    } catch (err) {
      console.error(`S3 upload failed: ${err.message}`);
    }
  }
}

// ============ IMAGE COMMAND ============
async function cmdImage(args) {
  const config = await loadConfig(args.config);
  const imageUrl = normalizeUrl(args.url);
  if (!imageUrl) throw new Error("Image URL is required");

  const repeats = Number(args.repeats) || 20;
  const browserName = args.browser;
  const headless = parseBool(args.headless);
  const timeoutMs = Number(args["timeout-ms"]) || 30000;
  const outputDir = args["output-dir"];
  const delayMs = Number(args["delay-ms"]) || 0;
  const cacheBust = parseBool(args["cache-bust"]);
  const verbose = parseBool(args.verbose);

  const configCity = toNonEmptyString(config.city);
  const cliCity = toNonEmptyString(args.city);
  const declaredCity = cliCity || configCity || null;

  const autoCity = parseBool(args["auto-city"]);
  let cityGeo = null;
  let publicIp = null;

  if (autoCity) {
    const detected = await detectCity(3000);
    cityGeo = detected.city;
    publicIp = detected.ip;
    if (verbose) {
      console.log(`Auto geo: ${cityGeo || "n/a"}${publicIp ? ` ip ${publicIp}` : ""}`);
    }
  }

  const runId = makeRunId();
  await ensureDir(outputDir);
  const csvPath = path.join(outputDir, `${runId}.csv`);

  const rawRecords = [];
  const browserType = getBrowserType(browserName);
  const browser = await browserType.launch({ headless });

  try {
    for (let i = 0; i < repeats; i++) {
      const requestUrl = cacheBust ? appendCacheBust(imageUrl, cacheBustToken()) : imageUrl;
      const runData = await runImageSingle({
        browser,
        browserName,
        url: requestUrl,
        timeoutMs,
        verbose: false,
      });

      rawRecords.push({
        timestamp_iso: new Date().toISOString(),
        run_index: i,
        total_ms: runData.totalMs,
        ttfb_ms: runData.ttfbMs,
        timeout: runData.timeout,
        errors_count: runData.errorsCount,
      });

      if (verbose) {
        const total = runData.totalMs != null ? `${runData.totalMs}ms` : "n/a";
        const ttfb = runData.ttfbMs != null ? `${runData.ttfbMs}ms` : "n/a";
        console.log(`#${i + 1} total=${total} ttfb=${ttfb}`);
      }

      if (i < repeats - 1 && delayMs > 0) await sleep(delayMs);
    }
  } finally {
    await browser.close();
  }

  const stats = computeImageStats(rawRecords);
  const cityNote = `city ${declaredCity || "n/a"} geo ${cityGeo || "n/a"}`;
  console.log(
    `\nimage total: mean ${formatMs(stats.total_mean_ms)} p50 ${formatMs(stats.total_p50_ms)} p95 ${formatMs(stats.total_p95_ms)} stddev ${formatMs(stats.total_stddev_ms)} (${cityNote})`
  );
  console.log(
    `image ttfb:  mean ${formatMs(stats.ttfb_mean_ms)} p50 ${formatMs(stats.ttfb_p50_ms)} p95 ${formatMs(stats.ttfb_p95_ms)} (${cityNote})`
  );

  // Save simple CSV
  const header = "run,total_ms,ttfb_ms,errors,city,city_geo";
  const lines = rawRecords.map(
    (r, i) =>
      `${i + 1},${r.total_ms ?? ""},${r.ttfb_ms ?? ""},${r.errors_count},${declaredCity ?? ""},${cityGeo ?? ""}`
  );
  const summary = `TOTAL,${stats.total_p50_ms ?? ""},${stats.ttfb_p50_ms ?? ""},${stats.errors},${declaredCity ?? ""},${cityGeo ?? ""}`;
  await fs.promises.writeFile(csvPath, [header, ...lines, summary].join("\n"));
  console.log(`Saved: ${csvPath}`);
}

// ============ URLS COMMAND ============
async function cmdUrls(args) {
  const config = await loadConfig(args.config);
  const urlsUrl = args.urls;
  const repeats = Number(args.repeats) || 20;
  const timeoutMs = Number(args["timeout-ms"]) || 30000;
  const urls = await loadUrlListFromUrl(urlsUrl, timeoutMs);
  const outputDir = args["output-dir"];
  const delayMs = Number(args["delay-ms"]) || 0;
  const cacheBust = parseBool(args["cache-bust"]);
  const verbose = parseBool(args.verbose);

  const configCity = toNonEmptyString(config.city);
  const cliCity = toNonEmptyString(args.city);
  const declaredCity = cliCity || configCity || null;

  const autoCity = parseBool(args["auto-city"]);
  let cityGeo = null;
  if (autoCity) {
    const detected = await detectCity(3000);
    cityGeo = detected.city;
    if (verbose) {
      console.log(`Auto geo: ${detected.city || "n/a"}${detected.ip ? ` ip ${detected.ip}` : ""}`);
    }
  }

  const runId = makeRunId();
  await ensureDir(outputDir);
  const csvPath = path.join(outputDir, `${runId}.csv`);

  const rawRecords = [];

  for (const url of urls) {
    for (let i = 0; i < repeats; i++) {
      const requestUrl = cacheBust ? appendCacheBust(url, cacheBustToken()) : url;
      const result = await fetchUrlMetrics(requestUrl, timeoutMs);

      rawRecords.push({
        timestamp_iso: new Date().toISOString(),
        url,
        run_index: i,
        total_ms: result.totalMs,
        ttfb_ms: result.ttfbMs,
        status_code: result.statusCode,
        error: result.error,
      });

      if (verbose) {
        const total = result.totalMs != null ? `${result.totalMs}ms` : "n/a";
        const status = result.error ? "ERR" : result.statusCode;
        console.log(`${url} #${i + 1} ${status} total=${total}`);
      }

      if (i < repeats - 1 && delayMs > 0) await sleep(delayMs);
    }
  }

  // Per-URL stats
  const header = "url,total_mean,total_p50,total_p95,ttfb_mean,ok,errors,city,city_geo";
  const lines = urls.map((url) => {
    const entries = rawRecords.filter((r) => r.url === url);
    const totalValues = entries.map((r) => r.total_ms).filter((v) => v != null);
    const ttfbValues = entries.map((r) => r.ttfb_ms).filter((v) => v != null);
    const ok = entries.filter((r) => r.status_code === 200).length;
    const errors = entries.filter((r) => r.error || (r.status_code && r.status_code >= 400)).length;

    return [
      `"${url}"`,
      totalValues.length ? Math.round(mean(totalValues)) : "",
      totalValues.length ? Math.round(percentile(totalValues, 0.5)) : "",
      totalValues.length ? Math.round(percentile(totalValues, 0.95)) : "",
      ttfbValues.length ? Math.round(mean(ttfbValues)) : "",
      ok,
      errors,
      declaredCity ?? "",
      cityGeo ?? "",
    ].join(",");
  });

  await fs.promises.writeFile(csvPath, [header, ...lines].join("\n"));
  console.log(`\nSaved: ${csvPath}`);
}

// ============ CLI DEFINITION ============
const commonOptions = {
  config: { type: "string", default: "./bench.config.json", describe: "Path to JSON config" },
  "output-dir": { type: "string", default: "./results", describe: "Output directory" },
  verbose: { type: "boolean", default: true, describe: "Verbose logs" },
  "auto-city": { type: "boolean", default: true, describe: "Auto-detect city via IP" },
  city: { type: "string", describe: "Meta: city" },
};

yargs(hideBin(process.argv))
  .command(
    "run [city]",
    "Run CDN benchmark",
    (y) => y
      .option("base-url", { type: "string", default: "https://cdntest.wamba.com", describe: "Base URL" })
      .option("repeats", { type: "number", default: 3, describe: "Repeats per variant" })
      .option("browser", { type: "string", default: "chromium", choices: ["chromium", "firefox", "webkit"] })
      .option("headless", { type: "string", default: "true", describe: "Headless mode" })
      .option("timeout-ms", { type: "number", default: 60000, describe: "Timeout per run" })
      .option("delay-ms", { type: "number", default: 1000, describe: "Delay between runs" })
      .option("scroll-delay-ms", { type: "number", default: 0, describe: "Scroll step delay" })
      .option("image-hosts", { type: "string", describe: "Image host allowlist (comma-separated)" })
      .option("s3-bucket", { type: "string", describe: "S3 bucket for upload" })
      .option("s3-prefix", { type: "string", describe: "S3 key prefix" })
      .option("s3-region", { type: "string", describe: "S3 region" })
      .option("s3-endpoint", { type: "string", describe: "S3 endpoint" })
      .option("s3-access-key-id", { type: "string", describe: "S3 access key" })
      .option("s3-secret-access-key", { type: "string", describe: "S3 secret key" })
      .options(commonOptions)
      .positional("city", { type: "string", describe: "Meta: city (positional)" }),
    cmdRun
  )
  .command(
    "image <url> [city]",
    "Benchmark single image URL",
    (y) => y
      .positional("url", { type: "string", describe: "Image URL" })
      .option("repeats", { type: "number", default: 20 })
      .option("browser", { type: "string", default: "chromium", choices: ["chromium", "firefox", "webkit"] })
      .option("headless", { type: "string", default: "true" })
      .option("timeout-ms", { type: "number", default: 30000 })
      .option("delay-ms", { type: "number", default: 0 })
      .option("cache-bust", { type: "boolean", default: false, describe: "Append nocache param (disables CDN cache)" })
      .options(commonOptions)
      .positional("city", { type: "string", describe: "Meta: city (positional)" }),
    cmdImage
  )
  .command(
    "urls [city]",
    "Benchmark list of URLs",
    (y) => y
      .option("urls", { type: "string", demandOption: true, describe: "HTTP URL to text file with URLs" })
      .option("repeats", { type: "number", default: 20 })
      .option("timeout-ms", { type: "number", default: 30000 })
      .option("delay-ms", { type: "number", default: 0 })
      .option("cache-bust", { type: "boolean", default: false, describe: "Append nocache param (disables CDN cache)" })
      .options(commonOptions)
      .positional("city", { type: "string", describe: "Meta: city (positional)" }),
    cmdUrls
  )
  .demandCommand(1)
  .strict()
  .help()
  .parse();
