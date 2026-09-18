#!/usr/bin/env bash
# Continuous traffic against the Swarm service, one line per request:
#   <ISO timestamp> <HTTP status> <replica hostname> <app version>
#
# Used for Task 37 (rolling update) and Task 40 (scale-down under traffic).
# Every request opens a new connection (Connection: close) so the routing mesh
# can hand it to a different replica instead of reusing one keep-alive socket.
# Exactly one request per loop, so the printed totals are the real counts.
#
#   ./swarm/traffic-loop.sh                        # runs until Ctrl-C
#   ./swarm/traffic-loop.sh 0.2 evidence/log.txt   # interval, tee to a file
#   DURATION=240 ./swarm/traffic-loop.sh 0.2 log   # stop after 240s on its own
set -uo pipefail

INTERVAL="${1:-0.2}"
LOGFILE="${2:-}"
URL="${URL:-http://localhost:3200/healthz}"
# 0 = run until interrupted.
DURATION="${DURATION:-0}"
DEADLINE=0
if [ "${DURATION}" != "0" ]; then
  DEADLINE=$(( $(date +%s) + DURATION ))
fi

HDRS="$(mktemp -t b4hdrs)"
total=0
fail=0

summary() {
  echo "---"
  echo "url: ${URL}"
  echo "requests: ${total}  failures: ${fail}"
  rm -f "${HDRS}"
  exit 0
}
trap summary INT TERM

while true; do
  if [ "${DEADLINE}" != "0" ] && [ "$(date +%s)" -ge "${DEADLINE}" ]; then
    summary
  fi

  # One request. --max-time bounds a hung request; a connection error or a
  # timeout leaves the status code as 000, which counts as a failure.
  code=$(curl -s -o /dev/null -D "${HDRS}" --max-time 5 \
         -H 'Connection: close' -w '%{http_code}' "${URL}" 2>/dev/null) || code="000"
  [ -z "${code}" ] && code="000"

  hdr=$(tr -d '\r' < "${HDRS}" | awk '
    tolower($1) == "x-served-by:"   { h = $2 }
    tolower($1) == "x-app-version:" { v = $2 }
    END { print (h == "" ? "-" : h), (v == "" ? "-" : v) }')

  total=$((total + 1))
  case "${code}" in
    2*) ;;
    *) fail=$((fail + 1)) ;;
  esac

  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) ${code} ${hdr}"
  if [ -n "${LOGFILE}" ]; then
    echo "${line}" | tee -a "${LOGFILE}"
  else
    echo "${line}"
  fi
  sleep "${INTERVAL}"
done
