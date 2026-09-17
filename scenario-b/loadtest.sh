#!/usr/bin/env bash
# B3 Task 31 - load generator for the multi-tenant Notes API.
#
# Usage (from scenario-b/):
#   ./loadtest.sh                          # 5 minutes against http://localhost:3100
#   DURATION=420 ./loadtest.sh             # longer run
#   BASE_URL=http://localhost:3000 ./loadtest.sh
#
# Traffic, all running at the same time:
#   normal  every TICK seconds, 4 requests for a random tenant (all 5 tenants):
#           /api/notes?limit=20, /api/search?q=abc, /api/stats, /api/notes/1
#   heavy   from HEAVY_DELAY seconds on, HEAVY_WORKERS back-to-back requests
#           from HEAVY_TENANT for /api/notes?limit=5000, so one tenant is
#           clearly worse. The first minute is a clean baseline to compare with.
#   burst   for BURST_SECONDS in the middle of the run, BURST_TICKERS extra
#           normal-traffic loops at BURST_TICK seconds, then they stop
#
# Stop at any time with Ctrl-C: every worker and in-flight curl is stopped and
# a summary of the traffic sent so far is still printed. Needs only bash + curl.

set -u

BASE_URL="${BASE_URL:-http://localhost:3100}"
DURATION="${DURATION:-300}"
# Sized for this stack: with the deliberate problems in place one
# /api/notes?limit=20 costs about 1 CPU-second of MongoDB time. A round every 2s
# leaves headroom even on a throttled laptop (a round every second already
# saturated MongoDB in Low Power Mode), and the burst (4x the rate) pushes it
# into saturation. One heavy worker holds about one MongoDB core; two slowed
# every tenant, hiding which one was the cause.
TICK="${TICK:-2}"
HEAVY_TENANT="${HEAVY_TENANT:-acme}"
HEAVY_LIMIT="${HEAVY_LIMIT:-5000}"
HEAVY_WORKERS="${HEAVY_WORKERS:-1}"
HEAVY_DELAY="${HEAVY_DELAY:-60}"
BURST_SECONDS="${BURST_SECONDS:-30}"
BURST_TICKERS="${BURST_TICKERS:-1}"
BURST_TICK="${BURST_TICK:-0.5}"
MAX_TIME="${MAX_TIME:-30}"
TENANTS=(acme globex initech umbrella hooli)

if (( DURATION < 300 )) && [[ "${ALLOW_SHORT:-}" != 1 ]]; then
  echo "DURATION must be at least 300 seconds (set ALLOW_SHORT=1 for a quick test)" >&2
  exit 1
fi

if ! curl -s -o /dev/null --max-time 5 "$BASE_URL/healthz"; then
  echo "App not reachable at $BASE_URL - is the stack up? (docker compose up -d)" >&2
  exit 1
fi

RESULTS="$(mktemp "${TMPDIR:-/tmp}/loadtest.XXXXXX")"
START=$(date +%s)
END=$(( START + DURATION ))
BURST_START=$(( START + (DURATION - BURST_SECONDS) / 2 ))
BURST_END=$(( BURST_START + BURST_SECONDS ))
PIDS=()

clock() {
  date -d "@$1" '+%H:%M:%S' 2>/dev/null || date -r "$1" '+%H:%M:%S'
}

log() {
  echo "[$(date '+%H:%M:%S') t+$(( $(date +%s) - START ))s] $*"
}

# One request. Appends "<phase> <endpoint> <tenant> <status> <seconds>" to the
# results file; the response body is discarded so the terminal stays quiet.
hit() {
  local phase=$1 tenant=$2 path=$3
  curl -s -o /dev/null --max-time "$MAX_TIME" -H "X-Tenant: $tenant" \
    -w "$phase $path $tenant %{http_code} %{time_total}\n" \
    "$BASE_URL$path" >> "$RESULTS"
}

# Open loop: a new round starts every tick whether or not the previous one has
# finished, like independent users. When the app slows down, requests pile up
# instead of the load quietly backing off.
ticker() {
  local phase=$1 tick=$2 until=$3 tenant
  while (( $(date +%s) < until )); do
    tenant=${TENANTS[RANDOM % ${#TENANTS[@]}]}
    hit "$phase" "$tenant" "/api/notes?limit=20" &
    hit "$phase" "$tenant" "/api/search?q=abc" &
    hit "$phase" "$tenant" "/api/stats" &
    hit "$phase" "$tenant" "/api/notes/1" &
    sleep "$tick"
  done
  wait
}

# Closed loop: one heavy request at a time per worker.
heavy_worker() {
  while (( $(date +%s) < END )); do
    hit heavy "$HEAVY_TENANT" "/api/notes?limit=$HEAVY_LIMIT"
  done
}

kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null
}

summary() {
  local total
  total=$(wc -l < "$RESULTS" | tr -d ' ')
  echo
  echo "================ load test summary ================"
  echo "base url     $BASE_URL"
  echo "ran for      $(( $(date +%s) - START ))s (planned ${DURATION}s)"
  echo "started      $(clock "$START")"
  echo "heavy from   $(clock $(( START + HEAVY_DELAY )))"
  (( BURST_TICKERS > 0 )) && echo "burst        $(clock "$BURST_START") - $(clock "$BURST_END")"
  echo "requests     $total"
  echo "raw results  $RESULTS"
  (( total == 0 )) && return

  echo
  echo "-- by endpoint --"
  awk '{ print $2, $5, $4 }' "$RESULTS" | report
  echo
  echo "-- by tenant --"
  awk '{ print $3, $5, $4 }' "$RESULTS" | report
  echo
  echo "-- by phase --"
  awk '{ print $1, $5, $4 }' "$RESULTS" | report
  echo
  echo "status 000 = curl gave up after ${MAX_TIME}s, 504 = app request budget exceeded"
}

# stdin: "<key> <seconds> <status>" -> one row per key with count, avg, p95,
# max and status code counts.
report() {
  printf '%-24s %8s %8s %8s %8s  %s\n' key requests avg_s p95_s max_s statuses
  sort -k1,1 -k2,2g | awk '
    function flush() {
      if (n == 0) return
      idx = int(n * 0.95); if (idx < n * 0.95) idx++; if (idx < 1) idx = 1
      codes = ""
      for (c in st) codes = codes c "x" st[c] " "
      printf "%-24s %8d %8.3f %8.3f %8.3f  %s\n", key, n, sum / n, t[idx], t[n], codes
      n = 0; sum = 0; delete t; delete st
    }
    $1 != key { flush(); key = $1 }
    { n++; t[n] = $2; sum += $2; st[$3]++ }
    END { flush() }'
}

stop() {
  trap - INT TERM
  echo
  log "stopping workers"
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill_tree "$pid"; done
  wait 2>/dev/null
  summary
  exit 0
}
trap stop INT TERM

log "load test against $BASE_URL for ${DURATION}s"
log "normal: 4 requests every ${TICK}s across tenants: ${TENANTS[*]}"
log "heavy:  $HEAVY_WORKERS workers from t+${HEAVY_DELAY}s, tenant=$HEAVY_TENANT, /api/notes?limit=$HEAVY_LIMIT"
(( BURST_TICKERS > 0 )) && log "burst:  $BURST_TICKERS extra loops every ${BURST_TICK}s from t+$(( BURST_START - START ))s to t+$(( BURST_END - START ))s"

ticker normal "$TICK" "$END" &
PIDS+=($!)

while (( $(date +%s) < START + HEAVY_DELAY )); do sleep 1; done
(( HEAVY_WORKERS > 0 )) && log "heavy tenant started"
for (( i = 0; i < HEAVY_WORKERS; i++ )); do
  heavy_worker &
  PIDS+=($!)
  sleep 2
done

while (( $(date +%s) < BURST_START )); do sleep 1; done
(( BURST_TICKERS > 0 )) && log "burst started"
for (( i = 0; i < BURST_TICKERS; i++ )); do
  ticker burst "$BURST_TICK" "$BURST_END" &
  PIDS+=($!)
done

while (( $(date +%s) < BURST_END )); do sleep 1; done
(( BURST_TICKERS > 0 )) && log "burst finished"

while (( $(date +%s) < END )); do sleep 1; done
log "duration reached, waiting for in-flight requests"
wait
summary
