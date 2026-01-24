/**
 * Geo detection via public IP lookup
 */

const { requestJson } = require("./http");
const { toNonEmptyString } = require("./utils");

const PROVIDERS = [
  {
    name: "ipinfo.io",
    url: "https://ipinfo.io/json",
    pickCity: (data) => data.city,
    pickIp: (data) => data.ip,
  },
  {
    name: "ipapi.co",
    url: "https://ipapi.co/json/",
    pickCity: (data) => data.city,
    pickIp: (data) => data.ip,
  },
];

async function detectCity(timeoutMs = 3000) {
  for (const provider of PROVIDERS) {
    try {
      const data = await requestJson(provider.url, timeoutMs);
      const city = toNonEmptyString(provider.pickCity(data));
      const ip = toNonEmptyString(provider.pickIp(data));
      if (city || ip) {
        return { city, source: provider.name, ip };
      }
    } catch {
      // Try next provider
    }
  }
  return { city: null, source: null, ip: null };
}

module.exports = { detectCity };
