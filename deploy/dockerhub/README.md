# Publishing Docker Hub images

Build and push the three service images to the Docker Hub
[`agentmemory`](https://hub.docker.com/u/agentmemory) namespace。

`publish.sh` is self-contained: it depends only on each component's Dockerfile,
`deploy/panel-knowledge-combined/build.sh`, and `MemoryPanel/scripts/secret-scan.sh`.

## Components and image names

| Component | Build context | Image |
|---|---|---|
| `memory-core` | `MemoryCore/` | `agentmemory/memory-core` |
| `memory-proxy` | `MemoryProxy/` (rsync to a temporary context) | `agentmemory/memory-proxy` |
| `memory-hub` | Combined `MemoryPanel/` + `MemoryKnowledge/` | `agentmemory/memory-hub` |

## Prerequisites

```bash
docker login docker.io          # The account needs push access to agentmemory.
docker buildx version           # Requires buildx; the script creates a builder automatically.
```

## Usage

```bash
cd deploy/dockerhub

# Publish all three images together.
VERSION=1.0.0 ./publish.sh all

# Publish individual components.
VERSION=1.0.0 ./publish.sh memory-core
VERSION=1.0.0 ./publish.sh memory-proxy
VERSION=1.0.0 ./publish.sh memory-hub

# Dry run: scan secrets and prepare contexts without building or pushing.
DRY_RUN=1 VERSION=1.0.0 ./publish.sh all

# Build a single platform locally and inspect image contents without pushing.
PUSH=0 VERSION=1.0.0 ./publish.sh memory-core

# Also update :latest.
ALSO_LATEST=1 VERSION=1.0.0 ./publish.sh all
```

`VERSION` is required and must not start with `dev-`, to avoid publishing development tags publicly.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VERSION` | None (required) | Image tag |
| `NAMESPACE` | `agentmemory` | Docker Hub namespace |
| `REGISTRY` | `docker.io` | Target registry |
| `PLATFORMS` | `linux/amd64,linux/arm64` | Multi-platform build targets |
| `ALSO_LATEST` | `0` | Also push `:latest` |
| `PUSH` | `1` | Set to `0` for a local single-platform `--load` without pushing |
| `DRY_RUN` | `0` | Set to `1` to scan and prepare contexts only |
| `LOAD_PLATFORM` | `linux/amd64` | Local build platform when `PUSH=0` |
| `KEEP_CTX` | `0` | Set to `1` to reuse the previous temporary context |
| `APT_MIRROR` | `deb.debian.org` | Build-time apt repository; override with an internal mirror for faster builds |

## Build-time apt mirrors

All four Dockerfiles accept the `APT_MIRROR` build argument and default to official Debian repositories,
so public-network builds work out of the box. To speed up internal builds, pass one shared variable; the resulting images are unaffected:

```bash
APT_MIRROR=<your-debian-mirror> VERSION=1.0.0 ./publish.sh all
```

## Optional private modules

- `MemoryProxy/packages/cost-guard` is an optional extension excluded from public images. `publish.sh` generates
  a stub package in the temporary context so the dependency graph resolves. If the dynamic import in
  `src/guard-adapter.ts` fails at runtime, the proxy falls back to passthrough forwarding.
- `MemoryCore/src/integrations` is similarly excluded by `MemoryCore/.dockerignore`
  and uses its runtime fallback.

## Verification

```bash
docker pull agentmemory/memory-core:1.0.0
docker buildx imagetools inspect agentmemory/memory-core:1.0.0
```
