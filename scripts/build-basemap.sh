#!/usr/bin/env bash
#
# Regenerate the self-hosted Denver basemap archive (public/denver.pmtiles).
#
# We vendor a clipped PMTiles extract instead of hitting a tile API at runtime:
# zero third-party requests, no API key, and it fits under Cloudflare Pages'
# 25 MiB per-file limit. The archive IS committed to git and is the source of
# truth; this script only exists to refresh it periodically, because the
# upstream Protomaps daily builds rotate out after roughly three months.
#
# Usage:
#   scripts/build-basemap.sh [YYYYMMDD]
#
# With no argument it probes the last two weeks of Protomaps builds and uses
# the newest one that exists. Pass an explicit date to pin a specific build.
set -euo pipefail

PMTILES_VERSION="1.30.3"
# Map maxBounds (see src/map.ts): west,south,east,north.
BBOX="-105.35,39.45,-104.35,40.05"
MAXZOOM="15"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLING="$ROOT/.tooling"
OUT="$ROOT/basemap/denver.pmtiles"
CLI="$TOOLING/pmtiles"

os="$(uname -s)"            # Darwin | Linux
arch="$(uname -m)"          # arm64 | x86_64 | aarch64
case "$arch" in
  aarch64) arch="arm64" ;;
esac

# --- Ensure the pmtiles CLI is present (downloaded into gitignored .tooling) ---
if [ ! -x "$CLI" ]; then
  echo "Downloading pmtiles CLI v$PMTILES_VERSION ..."
  mkdir -p "$TOOLING"
  asset="go-pmtiles_${PMTILES_VERSION}_${os}_${arch}.tar.gz"
  url="https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${asset}"
  curl -fsSL "$url" | tar -xz -C "$TOOLING" pmtiles
  chmod +x "$CLI"
fi

# --- Resolve a build date that still exists upstream ---
date_arg="${1:-}"
build_date=""
if [ -n "$date_arg" ]; then
  build_date="$date_arg"
else
  echo "Probing recent Protomaps builds ..."
  for i in $(seq 0 14); do
    if [ "$os" = "Darwin" ]; then
      d="$(date -v-"${i}"d +%Y%m%d)"
    else
      d="$(date -d "-${i} days" +%Y%m%d)"
    fi
    if curl -fsSL -I "https://build.protomaps.com/${d}.pmtiles" >/dev/null 2>&1; then
      build_date="$d"
      break
    fi
  done
fi

if [ -z "$build_date" ]; then
  echo "Could not find a recent Protomaps build. Pass an explicit date: scripts/build-basemap.sh YYYYMMDD" >&2
  exit 1
fi

SRC="https://build.protomaps.com/${build_date}.pmtiles"
echo "Extracting Denver from $SRC (bbox=$BBOX maxzoom=$MAXZOOM) ..."

# extract reads only the needed byte ranges over HTTP; it does not download
# the whole planet archive.
"$CLI" extract "$SRC" "$OUT" --bbox="$BBOX" --maxzoom="$MAXZOOM"

echo "Wrote $OUT"
ls -lh "$OUT"
echo
echo "Commit the archive, then publish it to R2 (the app loads it from there):"
echo "  CLOUDFLARE_ACCOUNT_ID=032e52cb6909be01a6bce1a4f573e2d8 \\"
echo "  npx wrangler r2 object put denver-scooter-fyi-basemap/denver.pmtiles \\"
echo "    --file=$OUT --content-type=application/octet-stream --remote"
