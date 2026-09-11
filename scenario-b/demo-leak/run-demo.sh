#!/usr/bin/env bash
# Builds the insecure image from Task 25 and recovers the "deleted" .env
# straight out of the image layers.
#
# The .env is generated here with obvious canary values, so no real secret and
# no file named .env is ever committed to the repository.

set -euo pipefail
cd "$(dirname "$0")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK" .env' EXIT

cat > .env <<'ENVEOF'
DB_PASSWORD=leak-canary-do-not-use-7f3a91
API_KEY=leak-canary-apikey-c0ffee
ENVEOF

echo "=== The secret that is about to be 'deleted' ==="
cat .env
echo

docker build -q -t myapp:leaky -f Dockerfile.leaky . > /dev/null
echo "=== 1. Inside a running container, /app looks clean ==="
docker run --rm myapp:leaky ls -la /app
echo

echo "=== 2. Now read the image layers instead ==="
docker save myapp:leaky -o "$WORK/leaky.tar"
mkdir -p "$WORK/x"
tar -xf "$WORK/leaky.tar" -C "$WORK/x"

for blob in "$WORK"/x/blobs/sha256/*; do
  tar -tf "$blob" >/dev/null 2>&1 || continue
  if tar -tf "$blob" 2>/dev/null | grep -q '^app/\.env$'; then
    echo "layer $(basename "$blob" | cut -c1-16) still contains app/.env:"
    tar -xOf "$blob" app/.env | sed 's/^/    /'
  fi
  if tar -tf "$blob" 2>/dev/null | grep -q '\.wh\.'; then
    echo "layer $(basename "$blob" | cut -c1-16) only adds a whiteout marker:"
    tar -tf "$blob" | grep '\.wh\.' | sed 's/^/    /'
  fi
done

echo
echo "The RUN rm layer records a whiteout that hides the file at runtime."
echo "The bytes are still in the earlier COPY layer and anyone with the image can read them."
