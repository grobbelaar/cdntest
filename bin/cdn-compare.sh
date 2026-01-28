#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${CDNTEST_ENV_FILE:-${ROOT_DIR}/.env}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

URLS_FILE="${ROOT_DIR}/urls.txt"
if [[ ! -f "${URLS_FILE}" ]]; then
  echo "urls.txt not found: ${URLS_FILE}"
  exit 1
fi

CDN_URL="$(grep media "${URLS_FILE}" | shuf -n1)"
if [[ -z "${CDN_URL}" ]]; then
  echo "No media.mamba.ru URLs in ${URLS_FILE}"
  exit 1
fi
ORIGIN_URL="$(echo "${CDN_URL}" | sed -e 's/media.mamba.ru/photo1.wambacdn.net/')"

N="20"

RUN_ID="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="${ROOT_DIR}/cmp-${RUN_ID}.csv"
TMP_CDN_TOTAL="$(mktemp)"
TMP_CDN_TTFB="$(mktemp)"
TMP_ORIGIN_TOTAL="$(mktemp)"
TMP_ORIGIN_TTFB="$(mktemp)"
trap 'rm -f "$TMP_CDN_TOTAL" "$TMP_CDN_TTFB" "$TMP_ORIGIN_TOTAL" "$TMP_ORIGIN_TTFB"' EXIT

CITY="${1:-${CDNTEST_CITY:-}}"
CITY_GEO="${CDNTEST_CITY_GEO:-}"
if [[ -z "${CITY}" ]]; then
  echo "CITY is required. Usage: $0 <city> (or set CDNTEST_CITY)"
  exit 1
fi

sep_for() { [[ "$1" == *\?* ]] && echo "&" || echo "?"; }
rand() { printf "%s%06d" "$(date +%s)" "$RANDOM"; }
iso_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

curl_metrics() {
  sleep 2
  curl -o /dev/null -sS --compressed --http2 \
    --connect-timeout 5 --max-time 30 \
    -w "%{http_code}|%{remote_ip}|%{local_ip}|%{http_version}|%{ssl_verify_result}|%{content_type}|%{size_download}|%{speed_download}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_pretransfer}|%{time_starttransfer}|%{time_total}|%{errormsg}" \
    "$1" || true
}

write_header() {
  echo "timestamp,page_id,variant,run,images_ms,avg_img_ms,ttfb_ms,lcp_ms,images_total,images_failed,errors,city,city_geo,origin_median,origin_p90,origin_avg_img,cdn_median,cdn_p90,cdn_avg_img,improvement_%,improvement_p90_%" > "$OUT_FILE"
}

run_bench() {
  local label="$1" variant="$2" url="$3" n="$4" tmp_total="$5" tmp_ttfb="$6"
  local sep; sep="$(sep_for "$url")"

  echo "=== $label ==="
  echo "URL: $url"
  echo "Requests: $n"
  echo "CSV: $OUT_FILE"
  echo "City: $CITY"
  echo
  printf "%3s  %4s  %15s  %7s  %7s  %7s  %7s  %7s  %s\n" \
    "i" "code" "remote_ip" "dns" "tcp" "tls" "ttfb" "total" "note"

  for i in $(seq 1 "$n"); do
    local u="${url}${sep}"
    local line
    line="$(curl_metrics "$u")"
    if [[ -z "${line// }" ]]; then
      line="000||||||0|0|0|0|0|0|0|0|curl_failed"
    fi

    local code remote_ip local_ip http_version ssl_verify content_type
    local size speed dns tcp tls pre ttfb total err
    IFS='|' read -r code remote_ip local_ip http_version ssl_verify \
      content_type size speed dns tcp tls pre ttfb total err <<< "$line"

    local errors=0
    if [[ "$code" != "200" || -n "${err}" && "${err}" != "-" ]]; then
      errors=1
    fi
    local total_ms=""
    local ttfb_ms=""
    if [[ "$errors" -eq 0 ]]; then
      total_ms="$(awk "BEGIN{printf \"%d\", (${total}+0)*1000}")"
      ttfb_ms="$(awk "BEGIN{printf \"%d\", (${ttfb}+0)*1000}")"
      echo "$total_ms" >> "$tmp_total"
      echo "$ttfb_ms" >> "$tmp_ttfb"
    fi

    local images_total=1
    local images_failed=$errors
    local timestamp
    timestamp="$(iso_now)"

    echo "${timestamp},cmp,${variant},${i},${total_ms},${total_ms},${ttfb_ms},,${images_total},${images_failed},${errors},\"${CITY}\",\"${CITY_GEO}\",,,,,,,," >> "$OUT_FILE"

    local note=""
    [[ "$code" != "200" ]] && note="HTTP_${code}"
    [[ -n "${err}" && "${err}" != "-" ]] && note="${note}${note:+,}${err}"

    printf "%3d  %4s  %15s  %7.3f  %7.3f  %7.3f  %7.3f  %7.3f  %s\n" \
      "$i" "${code}" "${remote_ip:--}" \
      "${dns:-0}" "${tcp:-0}" "${tls:-0}" "${ttfb:-0}" "${total:-0}" \
      "$note"
  done
  echo
}

summarize() {
  local label="$1" list="$2"
  awk '
function qsort(A, left, right,   i, j, pivot, tmp) {
  i = left; j = right; pivot = A[int((left+right)/2)]
  while (i <= j) {
    while (A[i] < pivot) i++
    while (A[j] > pivot) j--
    if (i <= j) { tmp = A[i]; A[i] = A[j]; A[j] = tmp; i++; j--; }
  }
  if (left < j) qsort(A, left, j)
  if (i < right) qsort(A, i, right)
}
{
  total=$1+0;
  cnt++; sum_total+=total;
  totals[cnt]=total;
}
END{
  if (cnt==0) { print "No data"; exit 1 }
  qsort(totals,1,cnt);
  p50=int(0.50*cnt+0.5); if(p50<1)p50=1
  p95=int(0.95*cnt+0.5); if(p95<1)p95=1
  p99=int(0.99*cnt+0.5); if(p99<1)p99=1

  printf "%s\n", "'"$label"'"
  printf "  requests=%d\n", cnt
  printf "  total_mean=%.3f  total_p50=%.3f  total_p95=%.3f  total_p99=%.3f  total_max=%.3f\n", sum_total/cnt, totals[p50], totals[p95], totals[p99], totals[cnt]
}' "$list"
}

diff_vals() {
  awk '
{cnt++; totals[cnt]=$1+0; sum_total+=$1+0}
END{
  if (cnt==0) { print "0 0 0"; exit }
  for(i=1;i<=cnt;i++) for(j=i+1;j<=cnt;j++) if(totals[i]>totals[j]){t=totals[i];totals[i]=totals[j];totals[j]=t}
  p50=int(0.50*cnt+0.5); if(p50<1)p50=1
  p95=int(0.95*cnt+0.5); if(p95<1)p95=1
  printf "%.6f %.6f %.6f\n", sum_total/cnt, totals[p50], totals[p95]
}' "$1"
}

stats_from_list() {
  awk '
  {
    vals[++n]=$1+0;
    sum+=$1;
  }
  END {
    if (n==0) { print "0 0 0 0"; exit }
    # sort
    for (i=1;i<=n;i++) for (j=i+1;j<=n;j++) if (vals[i]>vals[j]) { t=vals[i]; vals[i]=vals[j]; vals[j]=t }
    p50=int(0.50*n+0.5); if(p50<1)p50=1
    p90=int(0.90*n+0.5); if(p90<1)p90=1
    mean=sum/n
    printf "%.0f %.0f %.0f %.0f\n", mean, vals[p50], vals[p90], vals[p50]
  }' "$1"
}

impr_percent() {
  awk -v o="$1" -v c="$2" 'BEGIN{ if(o==0)print ""; else printf "%.1f", (o-c)/o*100 }'
}

# --- run ---
write_header
run_bench "CDN" "cdn" "$CDN_URL" "$N" "$TMP_CDN_TOTAL" "$TMP_CDN_TTFB"
run_bench "ORIGIN (MSK)" "origin" "$ORIGIN_URL" "$N" "$TMP_ORIGIN_TOTAL" "$TMP_ORIGIN_TTFB"

echo "=== SUMMARY ==="
summarize "CDN" "$TMP_CDN_TOTAL"
summarize "ORIGIN (MSK)" "$TMP_ORIGIN_TOTAL"

echo
echo "=== DIFF (CDN - ORIGIN) ==="
read -r at_mean at_p50 at_p95 < <(diff_vals "$TMP_CDN_TOTAL")
read -r bt_mean bt_p50 bt_p95 < <(diff_vals "$TMP_ORIGIN_TOTAL")
read -r at_ttfb_mean at_ttfb_p50 at_ttfb_p95 < <(diff_vals "$TMP_CDN_TTFB")
read -r bt_ttfb_mean bt_ttfb_p50 bt_ttfb_p95 < <(diff_vals "$TMP_ORIGIN_TTFB")

printf "total_mean: %+0.0fms\n"  "$(awk "BEGIN{print $at_mean-$bt_mean}")"
printf "total_p50 : %+0.0fms\n"  "$(awk "BEGIN{print $at_p50-$bt_p50}")"
printf "total_p95 : %+0.0fms\n"  "$(awk "BEGIN{print $at_p95-$bt_p95}")"
printf "ttfb_mean : %+0.0fms\n"  "$(awk "BEGIN{print $at_ttfb_mean-$bt_ttfb_mean}")"
printf "ttfb_p50  : %+0.0fms\n"  "$(awk "BEGIN{print $at_ttfb_p50-$bt_ttfb_p50}")"

echo
echo "CSV file: $OUT_FILE"

echo
echo "=== IMPROVEMENT (vs ORIGIN) ==="

speedup() { awk -v o="$1" -v c="$2" 'BEGIN{ if(c==0)print "inf"; else printf "%.2f", o/c }'; }
impr()    { awk -v o="$1" -v c="$2" 'BEGIN{ if(o==0)print "0"; else printf "%.1f", (o-c)/o*100 }'; }

echo "TOTAL mean: $(speedup "$bt_mean" "$at_mean")x  (+$(impr "$bt_mean" "$at_mean")%)"
echo "TOTAL p50 : $(speedup "$bt_p50"  "$at_p50")x  (+$(impr "$bt_p50"  "$at_p50")%)"
echo "TOTAL p95 : $(speedup "$bt_p95"  "$at_p95")x  (+$(impr "$bt_p95"  "$at_p95")%)"
echo "TTFB  mean: $(speedup "$bt_ttfb_mean" "$at_ttfb_mean")x  (+$(impr "$bt_ttfb_mean" "$at_ttfb_mean")%)"
echo "TTFB  p50 : $(speedup "$bt_ttfb_p50"  "$at_ttfb_p50")x  (+$(impr "$bt_ttfb_p50"  "$at_ttfb_p50")%)"

read -r origin_mean origin_p50 origin_p90 origin_avg < <(stats_from_list "$TMP_ORIGIN_TOTAL")
read -r cdn_mean cdn_p50 cdn_p90 cdn_avg < <(stats_from_list "$TMP_CDN_TOTAL")

timestamp="$(iso_now)"
impr_median="$(impr_percent "$origin_p50" "$cdn_p50")"
impr_p90="$(impr_percent "$origin_p90" "$cdn_p90")"

echo "${timestamp},TOTAL,-,-,,,,,,,\"${CITY}\",\"${CITY_GEO}\",${origin_p50},${origin_p90},${origin_avg},${cdn_p50},${cdn_p90},${cdn_avg},${impr_median},${impr_p90}" >> "$OUT_FILE"

upload_s3() {
  if [[ -z "${CDNTEST_S3_BUCKET:-}" || -z "${CDNTEST_S3_ACCESS_KEY_ID:-}" || -z "${CDNTEST_S3_SECRET_ACCESS_KEY:-}" ]]; then
    echo "S3 upload skipped: CDNTEST_S3_* missing"
    return 0
  fi
  echo
  echo "Uploading CSVs to S3..."
  (
    cd "${ROOT_DIR}"
    CDNTEST_RUN_ID="${RUN_ID}" \
    CDNTEST_UPLOAD_FILES="${OUT_FILE}" \
    node <<'NODE'
const path = require("path");
const { uploadFileS3, defaultS3Region } = require("./lib/http");
const { withRetries } = require("./lib/utils");

const bucket = process.env.CDNTEST_S3_BUCKET;
const prefix = process.env.CDNTEST_S3_PREFIX || "";
const endpoint = process.env.CDNTEST_S3_ENDPOINT || "";
const region = process.env.CDNTEST_S3_REGION || defaultS3Region(endpoint);
const accessKeyId = process.env.CDNTEST_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.CDNTEST_S3_SECRET_ACCESS_KEY;
const runId = process.env.CDNTEST_RUN_ID || "run";
const files = (process.env.CDNTEST_UPLOAD_FILES || "").split(",").filter(Boolean);

if (!bucket || !accessKeyId || !secretAccessKey) {
  console.log("S3 upload skipped: CDNTEST_S3_* missing");
  process.exit(0);
}

const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
const keyFor = (file) => {
  const name = path.basename(file);
  return cleanPrefix ? `${cleanPrefix}/${runId}/${name}` : `${runId}/${name}`;
};

(async () => {
  for (const file of files) {
    const key = keyFor(file);
    await withRetries(
      () =>
        uploadFileS3({
          bucket,
          key,
          region,
          endpoint: endpoint || undefined,
          credentials: { accessKeyId, secretAccessKey },
          filePath: file,
          contentType: "text/csv",
          timeoutMs: 60000,
        }),
      3,
      2000
    );
    console.log(`Uploaded: s3://${bucket}/${key}`);
  }
})().catch((err) => {
  console.error(`S3 upload failed: ${err.message}`);
  process.exit(1);
});
NODE
  )
}

upload_s3
