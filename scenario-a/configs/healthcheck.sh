#!/bin/bash

CONFIG="${1:-./checks.conf}"
LOG="/var/log/healthcheck.log"
LOCK="/tmp/healthcheck.lock"

GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
RESET='\033[0m'

if [[ ! -r "$CONFIG" ]]; then
    echo "ERROR: Config file missing or unreadable: $CONFIG"
    exit 2
fi

exec 9>"$LOCK"
if ! flock -n 9; then
    exit 0
fi

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

failed=0

echo "===== Health Check ====="

while IFS='|' read -r name url expected; do
    [[ -z "$name" ]] && continue
    [[ "$name" == \#* ]] && continue

    http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url")
    curl_status=$?

    if [[ $curl_status -eq 0 && "$http_code" == "$expected" ]]; then
        printf "${GREEN}%-10s OK${RESET} HTTP %s\n" "$name" "$http_code"
        log "$name OK HTTP $http_code"
    else
        printf "${RED}%-10s FAIL${RESET} expected HTTP %s, got %s\n" "$name" "$expected" "$http_code"
        log "$name FAIL expected HTTP $expected, got $http_code (curl exit $curl_status)"
        failed=1
    fi
done < "$CONFIG"

disk_usage=$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')

if [[ "$disk_usage" -gt 80 ]]; then
    printf "${YELLOW}%-10s WARNING${RESET} disk usage is %s%%\n" "Disk" "$disk_usage"
    log "Disk WARNING usage ${disk_usage}%"
else
    printf "${GREEN}%-10s OK${RESET} disk usage is %s%%\n" "Disk" "$disk_usage"
    log "Disk OK usage ${disk_usage}%"
fi

if [[ $failed -eq 0 ]]; then
    echo "========================"
    echo "Overall: ${GREEN}OK${RESET}"
    log "Overall OK"
    exit 0
else
    echo "========================"
    echo "Overall: ${RED}FAIL${RESET}"
    log "Overall FAIL"
    exit 1
fi
