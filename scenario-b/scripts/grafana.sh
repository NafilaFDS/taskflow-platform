#!/usr/bin/env bash
# Grafana helper for B3 (run from anywhere; talks to http://localhost:3001).
#
#   ./scripts/grafana.sh dashboard         create/update the dashboard from
#                                          grafana/dashboard.json, titled
#                                          exam-$EXAM_TOKEN
#   ./scripts/grafana.sh export            save the live dashboard JSON model
#                                          back to grafana/dashboard.json
#   ./scripts/grafana.sh annotate "text"   add an annotation at the current time
#                                          (e.g. marking a deployment)
#
# The admin password is read from .env (GRAFANA_ADMIN_PASSWORD) and handed to
# curl through a config file descriptor, so it never appears in argv.

set -euo pipefail
cd "$(dirname "$0")/.."

GRAFANA_URL="${GRAFANA_URL:-http://localhost:3001}"
DASHBOARD_UID="taskflow-b3"
DASHBOARD_FILE="grafana/dashboard.json"

if [[ -z "${GRAFANA_ADMIN_PASSWORD:-}" ]]; then
  GRAFANA_ADMIN_PASSWORD="$(grep -E '^GRAFANA_ADMIN_PASSWORD=' .env | cut -d= -f2-)"
fi

gcurl() {
  curl -sS --fail-with-body \
    --config <(printf 'user = "admin:%s"\n' "$GRAFANA_ADMIN_PASSWORD") \
    -H 'Content-Type: application/json' "$@"
}

case "${1:-}" in
  dashboard)
    : "${EXAM_TOKEN:?EXAM_TOKEN is not set in this shell}"
    jq --arg title "exam-$EXAM_TOKEN" \
      '{dashboard: (. + {title: $title, id: null}), overwrite: true, message: "B3 dashboard"}' \
      "$DASHBOARD_FILE" \
      | gcurl -X POST "$GRAFANA_URL/api/dashboards/db" --data-binary @- \
      | jq -r '"dashboard " + .status + ": '"$GRAFANA_URL"'" + .url'
    ;;
  export)
    gcurl "$GRAFANA_URL/api/dashboards/uid/$DASHBOARD_UID" | jq '.dashboard' > "$DASHBOARD_FILE"
    echo "exported to $DASHBOARD_FILE"
    ;;
  annotate)
    text="${2:?usage: grafana.sh annotate \"text\"}"
    jq -n --arg uid "$DASHBOARD_UID" --arg text "$text" --argjson time "$(( $(date +%s) * 1000 ))" \
      '{dashboardUID: $uid, time: $time, tags: ["deploy", "task34"], text: $text}' \
      | gcurl -X POST "$GRAFANA_URL/api/annotations" --data-binary @- \
      | jq -r '"annotation " + (.id|tostring) + ": " + .message'
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 1
    ;;
esac
