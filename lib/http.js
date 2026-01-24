/**
 * HTTP utilities: requests, S3 upload
 */

const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");

const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  null;

const PROXY_AGENT = (() => {
  if (!PROXY_URL) return null;
  try {
    return new HttpsProxyAgent(PROXY_URL);
  } catch {
    return null;
  }
})();

function getClient(url) {
  return url.protocol === "https:" ? https : http;
}

function getAgent(url) {
  return url.protocol === "https:" ? PROXY_AGENT : undefined;
}

async function requestJson(url, timeoutMs) {
  const target = new URL(url);
  const client = getClient(target);
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "cdntest-bench" },
        agent: getAgent(target),
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk.toString("utf8")));
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function requestText(url, timeoutMs) {
  const target = new URL(url);
  const client = getClient(target);
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: "GET",
        headers: { accept: "text/plain", "user-agent": "cdntest-bench" },
        agent: getAgent(target),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          resolve(body);
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function fetchUrlMetrics(url, timeoutMs) {
  const target = new URL(url);
  const client = getClient(target);
  return new Promise((resolve) => {
    const startMs = Date.now();
    let done = false;
    let statusCode = null;
    let remoteIp = null;
    let httpVersion = null;
    let responseAt = null;
    let firstByteAt = null;
    let sizeBytes = 0;
    let timeout = false;
    let error = null;

    const finish = (payload) => {
      if (done) return;
      done = true;
      resolve(payload);
    };

    const req = client.request(
      target,
      {
        method: "GET",
        headers: { "user-agent": "cdntest-bench" },
        agent: getAgent(target),
      },
      (res) => {
        statusCode = res.statusCode || null;
        httpVersion = res.httpVersion;
        remoteIp = res.socket?.remoteAddress || null;
        responseAt = Date.now();
        res.on("data", (chunk) => {
          if (firstByteAt == null) firstByteAt = Date.now();
          sizeBytes += chunk.length;
        });
        res.on("end", () => {
          const endMs = Date.now();
          const ttfbMs = firstByteAt != null
            ? firstByteAt - startMs
            : responseAt != null
              ? responseAt - startMs
              : null;
          finish({ statusCode, remoteIp, httpVersion, sizeBytes, ttfbMs, totalMs: endMs - startMs, timeout, error });
        });
        res.on("error", (err) => {
          error = err.message;
          finish({ statusCode, remoteIp, httpVersion, sizeBytes, ttfbMs: responseAt ? responseAt - startMs : null, totalMs: null, timeout, error });
        });
      }
    );
    req.on("error", (err) => {
      error = err.message;
      finish({ statusCode, remoteIp, httpVersion, sizeBytes, ttfbMs: null, totalMs: null, timeout, error });
    });
    req.setTimeout(timeoutMs, () => {
      timeout = true;
      error = "timeout";
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

async function uploadFilePresigned(uploadUrl, filePath, timeoutMs) {
  const target = new URL(uploadUrl);
  const client = getClient(target);
  const stat = await fs.promises.stat(filePath);
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: "PUT",
        headers: { "content-length": stat.size, "content-type": "application/zip" },
        agent: getAgent(target),
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) {
          res.resume();
          resolve(status);
          return;
        }
        let body = "";
        res.on("data", (chunk) => (body += chunk.toString("utf8")));
        res.on("end", () => reject(new Error(`Upload failed: ${status} ${body}`.trim())));
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Upload timeout")));
    fs.createReadStream(filePath).pipe(req);
  });
}

// S3 helpers
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, data, output = "buffer") {
  const hmac = crypto.createHmac("sha256", key).update(data);
  return output === "hex" ? hmac.digest("hex") : hmac.digest();
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function normalizeEndpoint(endpoint) {
  if (!endpoint) return null;
  return /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
}

function endpointHost(endpoint) {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint.replace(/^https?:\/\//i, "");
  }
}

function encodeS3Key(key) {
  return String(key || "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function buildS3Key(prefix, runId, explicitKey) {
  if (explicitKey) return explicitKey.replace(/^\/+/, "");
  const cleanPrefix = (prefix || "").replace(/^\/+|\/+$/g, "");
  return cleanPrefix ? `${cleanPrefix}/${runId}.zip` : `${runId}.zip`;
}

function defaultS3Region(endpoint) {
  if (!endpoint) return null;
  const ep = endpoint.toLowerCase();
  if (ep.includes("yandexcloud.net")) return "ru-central1";
  return "us-east-1";
}

async function uploadFileS3({ bucket, key, region, endpoint, credentials, filePath, contentType, timeoutMs }) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new Error("S3 credentials incomplete");
  }
  const normalizedEndpoint = normalizeEndpoint(endpoint) || "https://storage.yandexcloud.net";
  const host = endpointHost(normalizedEndpoint);
  const stat = await fs.promises.stat(filePath);
  const payloadHash = await sha256File(filePath);

  const now = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  const amzDate = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = `/${bucket}/${encodeS3Key(key)}`;

  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((n) => `${n}:${headers[n]}\n`).join("");
  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmacSha256(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign, "hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const requestHeaders = {
    ...headers,
    Authorization: authorization,
    "content-length": stat.size,
    "content-type": contentType || "application/zip",
  };

  const url = new URL(normalizedEndpoint);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "PUT",
        hostname: url.hostname,
        port: url.port || 443,
        path: canonicalUri,
        headers: requestHeaders,
        agent: PROXY_AGENT || undefined,
      },
      (res) => {
        const status = res.statusCode || 0;
        let body = "";
        res.on("data", (chunk) => (body += chunk.toString("utf8")));
        res.on("end", () => {
          if (status >= 200 && status < 300) {
            const etag = res.headers.etag ? String(res.headers.etag).replace(/"/g, "") : null;
            resolve({ status, etag });
            return;
          }
          reject(new Error(`S3 upload failed: ${status} ${body}`.trim()));
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs || 60000, () => req.destroy(new Error("S3 upload timeout")));
    fs.createReadStream(filePath).pipe(req);
  });
}

module.exports = {
  requestJson,
  requestText,
  fetchUrlMetrics,
  uploadFilePresigned,
  uploadFileS3,
  buildS3Key,
  defaultS3Region,
};
