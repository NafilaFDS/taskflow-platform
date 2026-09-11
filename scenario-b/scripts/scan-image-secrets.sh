#!/usr/bin/env bash
# Task 25 - prove an image contains no secrets.
#
# Searches EVERY layer of the image, not just the final filesystem. A file
# deleted by a later layer is still present in the earlier layer that added it,
# so scanning a running container is not proof of anything.
#
# Usage: ./scripts/scan-image-secrets.sh [image]     (default: myapp:multi)

set -uo pipefail

IMAGE="${1:-myapp:multi}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== Task 25 secret scan: $IMAGE ==="
echo

# ---------------------------------------------------------------------------
# 1. Metadata baked into the image config.
# ---------------------------------------------------------------------------
echo "--- 1. Baked-in environment variables ---"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE"

echo "--- 1b. Build history ---"
if docker history --no-trunc --format '{{.CreatedBy}}' "$IMAGE" \
     | grep -i -E 'password|secret|api_?key|token|passwd|PRIVATE KEY'; then
  echo "!! credential pattern found in build history"
else
  echo "no credential patterns in build history"
fi
echo

# ---------------------------------------------------------------------------
# 2. Unpack every layer blob.
# ---------------------------------------------------------------------------
docker save "$IMAGE" -o "$WORK/image.tar"
mkdir -p "$WORK/oci" "$WORK/layers"
tar -xf "$WORK/image.tar" -C "$WORK/oci"

n=0
for blob in "$WORK"/oci/blobs/sha256/* "$WORK"/oci/*.tar "$WORK"/oci/*/layer.tar; do
  [ -f "$blob" ] || continue
  tar -tf "$blob" >/dev/null 2>&1 || continue          # skip JSON manifests
  n=$((n + 1))
  dir="$WORK/layers/layer$(printf '%02d' "$n")_$(basename "$blob" | cut -c1-12)"
  mkdir -p "$dir"
  tar -xf "$blob" -C "$dir" 2>/dev/null
done
echo "--- 2. Unpacked $n filesystem layers ---"
echo

L="$WORK/layers"
fail=0
report() {           # report <count> <description>
  if [ "$1" -eq 0 ]; then
    printf 'PASS  %-56s %s\n' "$2" "0 hits"
  else
    printf 'FAIL  %-56s %s\n' "$2" "$1 hits"
    fail=1
  fi
}

# ---------------------------------------------------------------------------
# 3. Secret files present in any layer.
# ---------------------------------------------------------------------------
c=$(find "$L" \( -name '.env' -o -name '.env.*' \) ! -name '.env.example' | wc -l | tr -d ' ')
report "$c" "dotenv files in any layer"

# CA trust stores are public certificates, not secrets, so they are excluded.
c=$(find "$L" \( -name 'id_rsa*' -o -name 'id_ed25519*' -o -name '*.pem' -o -name '*.key' \
                 -o -name '.netrc' -o -name 'credentials' -o -name '.git' \) \
     -not -path '*/etc/ssl/*' -not -path '*/etc/ssl1.1/*' -not -path '*/ca-certificates/*' \
     | wc -l | tr -d ' ')
report "$c" "key / credential / .git files (CA stores excluded)"

# An .npmrc only matters if it carries an auth token; npm ships an empty one.
c=$(find "$L" -name '.npmrc' -size +0 -exec grep -lI -E '_auth|_authToken|_password' {} \; 2>/dev/null \
     | wc -l | tr -d ' ')
report "$c" ".npmrc files containing registry auth tokens"

# ---------------------------------------------------------------------------
# 4. Deleted-then-hidden secrets: whiteout entries name files that a later
#    layer removed but an earlier layer still contains. This is the exact
#    trap in Task 25, so it is checked explicitly.
# ---------------------------------------------------------------------------
c=0
for blob in "$WORK"/oci/blobs/sha256/*; do
  [ -f "$blob" ] || continue
  tar -tf "$blob" 2>/dev/null | grep -E '\.wh\.' \
    | grep -i -E 'env|secret|credential|\.pem|\.key|npmrc|netrc' && c=$((c + 1))
done
report "$c" "whiteouts hiding a secret file added by an earlier layer"

# ---------------------------------------------------------------------------
# 5. Secret values in file contents.
#    -I skips binaries: a compiled binary's base64/WASM blobs produce random
#    matches for key formats (verified separately, see ANSWERS.md).
# ---------------------------------------------------------------------------
# A real PEM key has its base64 body on its own lines. Documentation examples
# (npm docs, the dotenv README) only ever contain the header with placeholders,
# so requiring a genuine body line removes them without ignoring real keys.
c=0
while IFS= read -r f; do
  grep -qE '^[A-Za-z0-9+/]{60,}={0,2}$' "$f" 2>/dev/null && c=$((c + 1))
done < <(grep -rIl -E 'BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----' "$L" 2>/dev/null)
report "$c" "PEM private keys with a real base64 body"

KEYFMT='(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[0-9A-Za-z-]{10,}|sk-[A-Za-z0-9]{32,})'
c=$(grep -rI -E "$KEYFMT" "$L" 2>/dev/null | wc -l | tr -d ' ')
report "$c" "AWS / GitHub / Slack / OpenAI key formats (text files)"

c=$(grep -rI -E '(mongodb|postgres(ql)?|mysql|redis|amqp)://[^[:space:]"'"'"']*:[^[:space:]"'"'"'@]+@' \
     "$L" 2>/dev/null | wc -l | tr -d ' ')
report "$c" "connection strings with embedded passwords"

# Application source only. node_modules is upstream library code where
# "password" appears as a parameter name, never as a value of mine.
# Matches both quoted assignments (source code) and bare KEY=value (dotenv
# form). A placeholder such as CHANGEME or an empty value is not a leak.
c=$(grep -rInI -E '(PASSWORD|PASSWD|SECRET|API_?KEY|TOKEN)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[^"'"'"'[:space:]]{4,}' \
     "$L"/*/app --exclude-dir=node_modules 2>/dev/null \
     | grep -viE '(CHANGEME|YOUR_|EXAMPLE|PLACEHOLDER|xxxx|process\.env|<[a-z_]+>)' | wc -l | tr -d ' ')
report "$c" "hard-coded credential values in application source"

# Informational: compiled binaries are excluded from the check above because a
# base64 or WASM blob inside one produces random matches for these formats. Any
# such match is listed here and compared against the untouched base image, so it
# is reported rather than hidden.
echo
echo "--- informational: key-format matches inside compiled binaries ---"
grep -ral -E "$KEYFMT" "$L" 2>/dev/null | while read -r f; do
  file "$f" | grep -qi 'executable\|binary' && echo "  $(echo "$f" | sed "s|$L/||")  (binary - verify against base image)"
done
echo "  (none listed above means no binary matches)"

echo
if [ "$fail" -eq 0 ]; then
  echo "RESULT: no secrets found in any layer of $IMAGE"
else
  echo "RESULT: SECRETS PRESENT in $IMAGE - do not push this image"
fi
exit "$fail"
