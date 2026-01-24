#!/usr/bin/env bash
set -euo pipefail

CDN_URL="$(cat ../urls.txt |grep media |shuf -n1)"
ORIGIN_URL="$(echo $CDN_URL |sed -e 's/media.mamba.ru/photo1.wambacdn.net/')"

N="50"

OUT_CDN="cdn.csv"
OUT_ORIGIN="origin.csv"

sep_for() { [[ "$1" == *\?* ]] && echo "&" || echo "?"; }
rand() { printf "%s%06d" "$(date +%s)" "$RANDOM"; }

curl_metrics() {
  curl -o /dev/null -sS --compressed --http2 \
    --connect-timeout 5 --max-time 30 \
    -w "%{http_code}|%{remote_ip}|%{local_ip}|%{http_version}|%{ssl_verify_result}|%{content_type}|%{size_download}|%{speed_download}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_pretransfer}|%{time_starttransfer}|%{time_total}" \
    "$1" || true
}

run_bench() {
  local label="$1" url="$2" n="$3" out="$4"
  local sep; sep="$(sep_for "$url")"

  echo "=== $label ==="
  echo "URL: $url"
  echo "Requests: $n"
  echo "CSV: $out"
  echo

  echo "i,code,remote_ip,local_ip,http_version,ssl_verify,content_type,size_download,speed_download,time_namelookup,time_connect,time_appconnect,time_pretransfer,time_starttransfer,time_total,err" > "$out"
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

    echo "$i,${code},${remote_ip},${local_ip},${http_version},${ssl_verify},\"${content_type}\",${size},${speed},${dns},${tcp},${tls},${pre},${ttfb},${total},\"${err}\"" >> "$out"

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
  local label="$1" csv="$2"
  awk -F',' '
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
NR==1{next}
{
  code=$2; total=$15+0; ttfb=$14+0; tcp=$11+0; tls=$12+0; dns=$10+0;
  speed=$9+0; size=$8+0
  cnt++; sum_total+=total; sum_ttfb+=ttfb; sum_tcp+=tcp; sum_tls+=tls; sum_dns+=dns;
  sum_speed+=speed; sizesum+=size
  if (code=="200") ok++; else bad++
  totals[cnt]=total; ttfbs[cnt]=ttfb
}
END{
  if (cnt==0) { print "No data"; exit 1 }
  qsort(totals,1,cnt); qsort(ttfbs,1,cnt)
  p50=int(0.50*cnt+0.5); if(p50<1)p50=1
  p95=int(0.95*cnt+0.5); if(p95<1)p95=1
  p99=int(0.99*cnt+0.5); if(p99<1)p99=1

  printf "%s\n", "'"$label"'"
  printf "  requests=%d ok=%d non200=%d\n", cnt, ok, bad
  printf "  total_mean=%.3f  total_p50=%.3f  total_p95=%.3f  total_p99=%.3f  total_max=%.3f\n", sum_total/cnt, totals[p50], totals[p95], totals[p99], totals[cnt]
  printf "  ttfb_mean=%.3f   ttfb_p50=%.3f   ttfb_p95=%.3f   ttfb_max=%.3f\n", sum_ttfb/cnt, ttfbs[p50], ttfbs[p95], ttfbs[cnt]
  printf "  dns_mean=%.3f tcp_mean=%.3f tls_mean=%.3f\n", sum_dns/cnt, sum_tcp/cnt, sum_tls/cnt
  printf "  speed_mean_MiBs=%.2f downloaded_MiB=%.2f\n", (sum_speed/cnt)/1024/1024, sizesum/1024/1024
}' "$csv"
}

diff_vals() {
  awk -F',' '
NR==1{next}
{cnt++; totals[cnt]=$15+0; ttfbs[cnt]=$14+0; sum_total+=$15+0; sum_ttfb+=$14+0}
END{
  for(i=1;i<=cnt;i++) for(j=i+1;j<=cnt;j++) if(totals[i]>totals[j]){t=totals[i];totals[i]=totals[j];totals[j]=t}
  for(i=1;i<=cnt;i++) for(j=i+1;j<=cnt;j++) if(ttfbs[i]>ttfbs[j]){t=ttfbs[i];ttfbs[i]=ttfbs[j];ttfbs[j]=t}
  p50=int(0.50*cnt+0.5); if(p50<1)p50=1
  p95=int(0.95*cnt+0.5); if(p95<1)p95=1
  printf "%.6f %.6f %.6f %.6f %.6f\n", sum_total/cnt, totals[p50], totals[p95], sum_ttfb/cnt, ttfbs[p50]
}' "$1"
}

# --- run ---
run_bench "CDN" "$CDN_URL" "$N" "$OUT_CDN"
run_bench "ORIGIN (MSK)" "$ORIGIN_URL" "$N" "$OUT_ORIGIN"

echo "=== SUMMARY ==="
summarize "CDN" "$OUT_CDN"
summarize "ORIGIN (MSK)" "$OUT_ORIGIN"

echo
echo "=== DIFF (CDN - ORIGIN) ==="
read -r at_mean at_p50 at_p95 at_ttfb_mean at_ttfb_p50 < <(diff_vals "$OUT_CDN")
read -r bt_mean bt_p50 bt_p95 bt_ttfb_mean bt_ttfb_p50 < <(diff_vals "$OUT_ORIGIN")

printf "total_mean: %+0.3fs\n"  "$(awk "BEGIN{print $at_mean-$bt_mean}")"
printf "total_p50 : %+0.3fs\n"  "$(awk "BEGIN{print $at_p50-$bt_p50}")"
printf "total_p95 : %+0.3fs\n"  "$(awk "BEGIN{print $at_p95-$bt_p95}")"
printf "ttfb_mean : %+0.3fs\n"  "$(awk "BEGIN{print $at_ttfb_mean-$bt_ttfb_mean}")"
printf "ttfb_p50  : %+0.3fs\n"  "$(awk "BEGIN{print $at_ttfb_p50-$bt_ttfb_p50}")"

echo
echo "CSV files: $OUT_CDN  $OUT_ORIGIN"

echo
echo "=== IMPROVEMENT (vs ORIGIN) ==="

speedup() { awk -v o="$1" -v c="$2" 'BEGIN{ if(c==0)print "inf"; else printf "%.2f", o/c }'; }
impr()    { awk -v o="$1" -v c="$2" 'BEGIN{ if(o==0)print "0"; else printf "%.1f", (o-c)/o*100 }'; }

echo "TOTAL mean: $(speedup "$bt_mean" "$at_mean")x  (+$(impr "$bt_mean" "$at_mean")%)"
echo "TOTAL p50 : $(speedup "$bt_p50"  "$at_p50")x  (+$(impr "$bt_p50"  "$at_p50")%)"
echo "TOTAL p95 : $(speedup "$bt_p95"  "$at_p95")x  (+$(impr "$bt_p95"  "$at_p95")%)"
echo "TTFB  mean: $(speedup "$bt_ttfb_mean" "$at_ttfb_mean")x  (+$(impr "$bt_ttfb_mean" "$at_ttfb_mean")%)"
echo "TTFB  p50 : $(speedup "$bt_ttfb_p50"  "$at_ttfb_p50")x  (+$(impr "$bt_ttfb_p50"  "$at_ttfb_p50")%)"
