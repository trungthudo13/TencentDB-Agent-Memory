#!/usr/bin/env bash
# Build the combined Panel + Knowledge image.
#
# Usage (run from deploy/panel-knowledge-combined/):
# ./build.sh                              # Default paths and tag.
# TMC_DIR=/path/to/MemoryPanel ./build.sh  # Override the Panel source directory.
#   KNOWLEDGE_DIR=/path/to/MemoryKnowledge ./build.sh
# IMAGE_TAG=my-tag ./build.sh             # Override the image tag.
# CTX_DIR=/tmp/my-ctx ./build.sh          # Override the temporary build context.
# KEEP_CTX=1 ./build.sh                   # Keep the context for debugging.
# PREPARE_ONLY=1 ./build.sh               # Prepare the rsync context without building (used by publish.sh).
#
# Default source layout under the repository root:
#   memory-tencentdb/
# ├── MemoryPanel/                         # Panel backend + web frontend.
#   ├── MemoryKnowledge/                     # knowledge service
# └── deploy/panel-knowledge-combined/     # This build recipe.
#
# Output image: team-memory-panel-knowledge:${TAG} (default tag: amd64).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"          # memory-tencentdb repository root
WORKSPACE_ROOT="$(dirname "$REPO_ROOT")"               # Parent directory, the default location for CTX_DIR.

TMC_DIR="${TMC_DIR:-$REPO_ROOT/MemoryPanel}"
KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-$REPO_ROOT/MemoryKnowledge}"
IMAGE_NAME="${IMAGE_NAME:-team-memory-panel-knowledge}"
IMAGE_TAG="${IMAGE_TAG:-amd64}"
CTX_DIR="${CTX_DIR:-$WORKSPACE_ROOT/panel-knowledge-builder}"
KEEP_CTX="${KEEP_CTX:-0}"
PREPARE_ONLY="${PREPARE_ONLY:-0}"
PLATFORM="${PLATFORM:-linux/amd64}"

err() { echo "[build-combined] error: $*" >&2; exit 1; }

[[ -d "$TMC_DIR/package.json" || -f "$TMC_DIR/package.json" ]] \
  || err "MemoryPanel not found at $TMC_DIR (override with TMC_DIR=<path>)."
[[ -f "$KNOWLEDGE_DIR/package.json" ]] \
  || err "MemoryKnowledge not found at $KNOWLEDGE_DIR (override with KNOWLEDGE_DIR=<path>)."
[[ -f "$SCRIPT_DIR/Dockerfile" ]] || err "Dockerfile not found in $SCRIPT_DIR"
[[ -f "$SCRIPT_DIR/start-combined.sh" ]] || err "start-combined.sh not found in $SCRIPT_DIR"

echo "[build-combined] panel  (MemoryPanel): $TMC_DIR"
echo "[build-combined] knowledge:            $KNOWLEDGE_DIR"
echo "[build-combined] context dir:                 $CTX_DIR"
echo "[build-combined] image:                       $IMAGE_NAME:$IMAGE_TAG"
echo ""

# Remove the previous context unless KEEP_CTX=1.
if [[ "$KEEP_CTX" == "1" ]]; then
  echo "[build-combined] KEEP_CTX=1 → Keeping the previous context"
else
  rm -rf "$CTX_DIR"
fi
mkdir -p "$CTX_DIR"

# Copy Panel with rsync; the builder needs src/, web/, package*.json, and tsconfig.json.
# Exclude sensitive config/*.json, docs, tests, .claude, Docker configuration, and other unnecessary files.
echo "[build-combined] rsync panel → $CTX_DIR/panel/"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude web/node_modules \
  --exclude dist \
  --exclude build \
  --exclude coverage \
  --exclude data \
  --exclude .claude \
  --exclude .env \
  --exclude .env.* \
  --exclude config/metadata-instances.json \
  --exclude config/*.yaml \
  --exclude config/*.yml \
  --exclude docs/ \
  --exclude tests/ \
  --exclude scripts/ \
  --exclude docker/ \
  --exclude e2e-*.sh \
  --exclude *.md \
  --exclude pnpm-lock.yaml \
  --exclude pnpm-workspace.yaml \
  --exclude vitest.config.ts \
  "$TMC_DIR"/ "$CTX_DIR/panel"/

# Copy Knowledge with rsync; the builder needs src/, package*.json, tsconfig.json, and tsdown.config.ts.
# Runtime needs the root openapi.yaml for Swagger UI. Exclude docs, tests, .claude, and Docker configuration.
echo "[build-combined] rsync knowledge → $CTX_DIR/knowledge/"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  --exclude coverage \
  --exclude data \
  --exclude .claude \
  --exclude .env \
  --exclude .env.* \
  --exclude bin/ \
  --exclude docs/ \
  --exclude __tests__/ \
  --exclude docker/ \
  --exclude docker-compose*.yml \
  --exclude Dockerfile \
  --exclude .dockerignore \
  --exclude *.md \
  --exclude pnpm-lock.yaml \
  --exclude vitest.config.ts \
  --exclude start.sh \
  "$KNOWLEDGE_DIR"/ "$CTX_DIR/knowledge"/

# Copy Dockerfile, start-combined.sh, .dockerignore, and README; .dockerignore adds protection after rsync filtering.
cp "$SCRIPT_DIR/Dockerfile" "$CTX_DIR"/
cp "$SCRIPT_DIR/start-combined.sh" "$CTX_DIR"/
cp "$SCRIPT_DIR/README.md" "$CTX_DIR"/
if [[ -f "$SCRIPT_DIR/.dockerignore" ]]; then
  cp "$SCRIPT_DIR/.dockerignore" "$CTX_DIR"/
fi

if [[ "$PREPARE_ONLY" == "1" ]]; then
  echo ""
  echo "[build-combined] PREPARE_ONLY=1 → Context ready: $CTX_DIR"
  exit 0
fi

# build
echo "[build-combined] docker build --platform $PLATFORM -t $IMAGE_NAME:$IMAGE_TAG $CTX_DIR"
docker build --platform "$PLATFORM" -t "$IMAGE_NAME:$IMAGE_TAG" "$CTX_DIR"

echo ""
echo "[build-combined] ✅ done: $IMAGE_NAME:$IMAGE_TAG"
echo "[build-combined] Context retained at $CTX_DIR (the next run removes it when KEEP_CTX=0)."
