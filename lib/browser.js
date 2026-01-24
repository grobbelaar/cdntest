/**
 * Playwright browser automation: page loading, image timing measurement
 */

const { sleep } = require("./utils");

const IGNORED_IMAGE_HOSTS = ["ad.adriver.ru", "ev.adriver.ru"];

async function disableCacheIfPossible(context, page, browserName) {
  if (browserName !== "chromium") return;
  const session = await context.newCDPSession(page);
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
}

async function autoScroll(page, delayMs) {
  if (delayMs == null || delayMs < 0) return;
  await page.evaluate(async (delay) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const viewport = window.innerHeight || document.documentElement.clientHeight;
    const step = Math.max(1, Math.floor(viewport * 0.85));
    const maxScroll = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    let current = 0;
    while (current < maxScroll) {
      window.scrollTo(0, current);
      await sleep(delay);
      current += step;
    }
    window.scrollTo(0, 0);
  }, delayMs);
}

/**
 * Collect image timing using Resource Timing API (more accurate than polling img.complete)
 */
async function collectImageTimings(page, ignoreHosts, allowHosts) {
  return await page.evaluate(({ ignoreHosts, allowHosts }) => {
    const matchHost = (host, pattern) => {
      if (!pattern || !host) return false;
      if (!pattern.includes("*")) return host === pattern;
      const parts = pattern.split("*").filter(Boolean);
      if (parts.length === 0) return true;
      if (!pattern.startsWith("*") && !host.startsWith(parts[0])) return false;
      if (!pattern.endsWith("*") && !host.endsWith(parts[parts.length - 1])) return false;
      let index = 0;
      for (const part of parts) {
        const found = host.indexOf(part, index);
        if (found === -1) return false;
        index = found + part.length;
      }
      return true;
    };

    const allowedHost = (host) =>
      allowHosts.length === 0 || allowHosts.some((p) => matchHost(host, p));

    // Get all image elements
    const imgElements = Array.from(document.images);
    const imgData = imgElements
      .map((img) => {
        const src = img.currentSrc || img.src;
        if (!src) return null;
        try {
          const url = new URL(src, document.baseURI);
          return { img, src, hostname: url.hostname };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((e) => !ignoreHosts.includes(e.hostname))
      .filter((e) => allowedHost(e.hostname));

    const hosts = [...new Set(imgData.map((e) => e.hostname))];
    const urls = imgData.map((e) => e.src);

    // Get Resource Timing entries for images
    const resourceEntries = performance.getEntriesByType("resource");
    const imageTimings = [];
    const failedUrls = [];

    for (const entry of imgData) {
      const img = entry.img;
      const src = entry.src;

      // Find matching resource timing entry
      const timing = resourceEntries.find((r) => r.name === src || r.name === img.currentSrc);

      if (timing) {
        // responseEnd is when the last byte was received
        imageTimings.push({
          url: src,
          responseEnd: timing.responseEnd,
          ttfb: timing.responseStart - timing.startTime,
          duration: timing.duration,
          transferSize: timing.transferSize,
        });
      } else if (img.complete && img.naturalWidth > 0) {
        // Fallback: image loaded but no timing (cross-origin without CORS headers)
        imageTimings.push({
          url: src,
          responseEnd: null,
          ttfb: null,
          duration: null,
          transferSize: null,
          noTiming: true,
        });
      } else if (img.complete && img.naturalWidth === 0) {
        failedUrls.push(src);
      }
    }

    // Calculate image timing metrics
    const timingsWithData = imageTimings.filter((t) => t.responseEnd != null && t.duration != null);

    let maxResponseEnd = null;
    let imagesOnlyMs = null;
    let avgImageMs = null;
    let sumImageMs = null;

    if (timingsWithData.length > 0) {
      const starts = timingsWithData.map((t) => t.responseEnd - t.duration);
      const ends = timingsWithData.map((t) => t.responseEnd);
      const firstStart = Math.min(...starts);
      const lastEnd = Math.max(...ends);

      maxResponseEnd = lastEnd;
      imagesOnlyMs = lastEnd - firstStart; // чистое время от первой до последней картинки
      avgImageMs = timingsWithData.reduce((sum, t) => sum + t.duration, 0) / timingsWithData.length;
      sumImageMs = timingsWithData.reduce((sum, t) => sum + t.duration, 0); // суммарное время
    }

    // Check for pending images
    const pending = imgData.filter((e) => !e.img.complete).map((e) => e.src);

    return {
      total: imgData.length,
      loaded: imageTimings.length,
      failed: failedUrls.length,
      pending: pending.length,
      failedUrls,
      pendingUrls: pending,
      urls,
      hosts,
      maxResponseEnd,
      imagesOnlyMs,  // чистое время: lastEnd - firstStart
      avgImageMs,    // среднее время на картинку
      sumImageMs,    // сумма всех duration
      imageTimings,
    };
  }, { ignoreHosts, allowHosts });
}

/**
 * Wait for all target images to load using Resource Timing API
 * Returns timing info when all images are loaded or timeout
 */
async function waitForImages(page, ignoreHosts, allowHosts, verbose, logPrefix, maxWaitMs = 60000) {
  const prefix = logPrefix ? `${logPrefix} ` : "";
  const startTime = Date.now();
  const pollMs = 200;
  const logEveryMs = 5000;
  let lastLogAt = 0;

  while (Date.now() - startTime < maxWaitMs) {
    const stats = await collectImageTimings(page, ignoreHosts, allowHosts);

    if (!stats) {
      return { timeout: true, timeoutReason: "stats_error" };
    }

    // No target images on page
    if (stats.total === 0 || stats.total === stats.failed) {
      return {
        timeout: false,
        timeoutReason: "no_images",
        ...stats,
      };
    }

    // All images loaded (none pending)
    if (stats.pending === 0) {
      return {
        timeout: false,
        timeoutReason: stats.failed > 0 ? "images_failed" : null,
        ...stats,
      };
    }

    // Log progress
    const now = Date.now();
    if (verbose && now - lastLogAt >= logEveryMs) {
      lastLogAt = now;
      console.log(
        `${prefix}waiting: total ${stats.total} loaded ${stats.loaded} failed ${stats.failed} pending ${stats.pending}`
      );
      if (stats.pendingUrls.length > 0) {
        console.log(`${prefix}pending: ${stats.pendingUrls.slice(0, 3).join(" ")}`);
      }
    }

    await sleep(pollMs);
  }

  // Timeout - get final stats
  const finalStats = await collectImageTimings(page, ignoreHosts, allowHosts);
  return {
    timeout: true,
    timeoutReason: "timeout",
    ...finalStats,
  };
}

/**
 * Run single page benchmark
 */
async function runSingle({
  browser,
  browserName,
  url,
  scrollDelayMs,
  allowedImageHosts,
  timeoutMs = 60000,
  verbose = false,
  logPrefix = "",
}) {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Setup LCP observer
  await page.addInitScript(() => {
    window.__bench = { lcp: null };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__bench.lcp = entry.startTime;
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
  });

  await disableCacheIfPossible(context, page, browserName);
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(0);

  const prefix = logPrefix ? `${logPrefix} ` : "";
  let navStatus = null;
  let navError = null;
  let navUrl = null;
  let userAgent = null;
  let viewport = null;
  let ttfbMs = null;
  let lcpMs = null;

  const startMs = Date.now();
  let imageStats = null;
  let imagesLoadedMs = null;

  try {
    // Navigate to page
    const navResponse = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    if (navResponse) {
      navStatus = navResponse.status();
      navUrl = navResponse.url();
      if (verbose) {
        console.log(`${prefix}nav ${navStatus} ${navUrl}`);
      }
    }

    // Scroll to trigger lazy-load images
    await autoScroll(page, scrollDelayMs);

    // Wait for images using Resource Timing API
    imageStats = await waitForImages(
      page,
      IGNORED_IMAGE_HOSTS,
      allowedImageHosts,
      verbose,
      logPrefix,
      timeoutMs
    );

    // Calculate images loaded time - use imagesOnlyMs (pure image loading time)
    if (imageStats.imagesOnlyMs != null) {
      imagesLoadedMs = imageStats.imagesOnlyMs;
    } else if (!imageStats.timeout && imageStats.pending === 0) {
      // Fallback: use wall-clock time if no Resource Timing available
      imagesLoadedMs = Date.now() - startMs;
    }

  } catch (error) {
    imageStats = {
      timeout: true,
      timeoutReason: error?.name === "TimeoutError" ? "navigation_timeout" : "navigation_error",
      total: 0,
      loaded: 0,
      failed: 0,
      pending: 0,
      failedUrls: [],
      pendingUrls: [],
      urls: [],
      hosts: [],
    };
    navError = error?.message || "navigation_error";
  }

  // Collect page metrics
  try {
    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const ttfb = nav ? nav.responseStart - nav.startTime : null;
      const lcp = window.__bench?.lcp ?? null;
      return {
        ttfb,
        lcp,
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    });
    ttfbMs = metrics.ttfb != null ? Math.round(metrics.ttfb) : null;
    lcpMs = metrics.lcp != null ? Math.round(metrics.lcp) : null;
    userAgent = metrics.userAgent;
    viewport = metrics.viewport;
  } catch {
    // Ignore metrics failures
  }

  await context.close();

  return {
    imagesLoadedMs: imagesLoadedMs != null ? Math.round(imagesLoadedMs) : null,
    avgImageMs: imageStats.avgImageMs != null ? Math.round(imageStats.avgImageMs) : null,
    sumImageMs: imageStats.sumImageMs != null ? Math.round(imageStats.sumImageMs) : null,
    timeout: imageStats.timeout,
    timeoutReason: imageStats.timeoutReason,
    imagesTotal: imageStats.total - (imageStats.failed || 0),
    imagesLoaded: imageStats.loaded,
    imagesFailed: imageStats.failed,
    imagesPending: imageStats.pending,
    navStatus,
    navError,
    navUrl,
    errorsCount: imageStats.failed || 0,
    userAgent,
    viewport,
    ttfbMs,
    lcpMs,
    imageUrls: imageStats.urls || [],
    imageFailedUrls: imageStats.failedUrls || [],
    imageHosts: imageStats.hosts || [],
  };
}

/**
 * Run single image URL benchmark (direct navigation to image)
 */
async function runImageSingle({
  browser,
  browserName,
  url,
  timeoutMs,
  verbose = false,
  logPrefix = "",
}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await disableCacheIfPossible(context, page, browserName);

  const prefix = logPrefix ? `${logPrefix} ` : "";
  let navStatus = null;
  let navError = null;
  let navUrl = null;
  let timeout = false;
  let timeoutReason = null;
  let ttfbMs = null;
  let totalMs = null;

  try {
    const navResponse = await page.goto(url, {
      waitUntil: "load",
      timeout: timeoutMs,
    });
    if (navResponse) {
      navStatus = navResponse.status();
      navUrl = navResponse.url();
    }
  } catch (error) {
    timeout = true;
    navError = error?.message || "navigation_error";
    timeoutReason = error?.name === "TimeoutError" ? "navigation_timeout" : "navigation_error";
  }

  try {
    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      if (!nav) return { ttfb: null, total: null };
      return {
        ttfb: nav.responseStart - nav.startTime,
        total: nav.responseEnd - nav.startTime,
      };
    });
    ttfbMs = metrics.ttfb != null ? Math.round(metrics.ttfb) : null;
    totalMs = metrics.total != null ? Math.round(metrics.total) : null;
  } catch {
    // Ignore
  }

  await context.close();

  return {
    timeout,
    timeoutReason,
    navStatus,
    navError,
    navUrl,
    errorsCount: timeout || (navStatus != null && navStatus >= 400) ? 1 : 0,
    ttfbMs,
    totalMs,
  };
}

/**
 * Warmup: load each page variant to prime DNS/connections/CDN edge
 */
async function runWarmup({ browser, browserName, urls, warmupRuns = 2, timeoutMs = 15000 }) {
  for (let run = 0; run < warmupRuns; run++) {
    for (const url of urls) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await disableCacheIfPossible(context, page, browserName);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      } catch {
        // Warmup errors are non-fatal
      } finally {
        await context.close();
      }
    }
  }
}

module.exports = {
  runSingle,
  runImageSingle,
  runWarmup,
  IGNORED_IMAGE_HOSTS,
};
