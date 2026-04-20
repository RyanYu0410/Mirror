#!/usr/bin/env bash
# Downloads all third-party runtime assets into ./vendor/ so the project can
# run without internet access. Safe to re-run — files are re-fetched on each
# invocation. This is important for a long-running installation that may
# outlive the CDN versions it originally shipped with, or be deployed on a
# network without outbound internet.
#
# Usage:  bash scripts/fetch-vendor.sh
#
# The versions below are pinned so that re-running this script produces
# byte-identical output. Bump manually when you want to upgrade.

set -euo pipefail

P5_VERSION="1.9.0"
MP_CAMERA_VERSION="0.3.1675466862"
MP_SELFIE_VERSION="0.1.1675465747"
MP_POSE_VERSION="0.5.1675469404"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Fetching into: $ROOT/vendor"
mkdir -p vendor/p5 \
         vendor/mediapipe/camera_utils \
         vendor/mediapipe/selfie_segmentation \
         vendor/mediapipe/pose

fetch() {
    local url="$1" dest="$2"
    echo "  $dest"
    curl -fsSL "$url" -o "$dest"
}

echo "[1/4] p5.js $P5_VERSION"
fetch "https://cdnjs.cloudflare.com/ajax/libs/p5.js/$P5_VERSION/p5.min.js" \
      "vendor/p5/p5.min.js"

# MediaPipe packages ship runtime WASM + tflite + data files next to their
# entry .js. The files a package actually requests are resolved via the
# `locateFile` callback at runtime, so we mirror every file the npm package
# publishes. That way any upgrade (or future MediaPipe internal refactor)
# still works offline without manually curating the file list.
mirror_mp_pkg() {
    local pkg="$1" version="$2" destdir="$3"
    local base="https://cdn.jsdelivr.net/npm/@mediapipe/$pkg@$version"
    local meta="https://data.jsdelivr.com/v1/package/npm/@mediapipe/$pkg@$version/flat"
    echo "[$pkg $version]"
    local files
    files=$(curl -fsSL "$meta" | python3 -c "
import sys, json
for f in json.load(sys.stdin)['files']:
    # Skip source maps / TypeScript decls that the runtime never asks for
    n = f['name']
    if n.endswith(('.map', '.d.ts', '.ts')):
        continue
    print(n)
")
    while IFS= read -r name; do
        [ -z "$name" ] && continue
        local url="$base$name"
        local out="$destdir${name}"
        mkdir -p "$(dirname "$out")"
        fetch "$url" "$out"
    done <<< "$files"
}

echo "[2/4] @mediapipe/camera_utils"
mirror_mp_pkg camera_utils "$MP_CAMERA_VERSION" "vendor/mediapipe/camera_utils"

echo "[3/4] @mediapipe/selfie_segmentation"
mirror_mp_pkg selfie_segmentation "$MP_SELFIE_VERSION" "vendor/mediapipe/selfie_segmentation"

echo "[4/4] @mediapipe/pose"
mirror_mp_pkg pose "$MP_POSE_VERSION" "vendor/mediapipe/pose"

# We pin `modelComplexity: 0` (lite) in js/segmentation.js, so the 6 MB `full`
# and 26 MB `heavy` pose tflite models are never requested at runtime. Strip
# them to keep the vendored bundle small (~34 MB instead of ~68 MB). If you
# ever raise modelComplexity, remove this block and re-run the script.
echo "[prune] removing unused pose landmark models (full, heavy)"
rm -f vendor/mediapipe/pose/pose_landmark_full.tflite \
      vendor/mediapipe/pose/pose_landmark_heavy.tflite

echo
echo "Done. Total size:"
du -sh vendor
