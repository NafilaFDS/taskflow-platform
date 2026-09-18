#!/usr/bin/env bash
# Build one version of the notes API and push it to the local registry that the
# Swarm node pulls from.
#
#   ./swarm/build-push.sh v1        # normal build, APP_VERSION=v1
#   ./swarm/build-push.sh v2        # normal build, APP_VERSION=v2
#   ./swarm/build-push.sh v3 break  # deliberately broken: /healthz returns 500
#
# Run from scenario-b/.
set -euo pipefail

VERSION="${1:?usage: build-push.sh <version> [break]}"
BREAK="${2:-}"
REGISTRY="${REGISTRY:-localhost:5001}"
IMAGE="${REGISTRY}/notes-api:${VERSION}"

BREAK_HEALTHZ=0
if [ "${BREAK}" = "break" ]; then
  BREAK_HEALTHZ=1
fi

echo "Building ${IMAGE} (APP_VERSION=${VERSION}, BREAK_HEALTHZ=${BREAK_HEALTHZ})"
docker build \
  --build-arg "APP_VERSION=${VERSION}" \
  --build-arg "BREAK_HEALTHZ=${BREAK_HEALTHZ}" \
  -t "${IMAGE}" \
  ./app

docker push "${IMAGE}"
echo "Pushed ${IMAGE}"
