#!/bin/bash
# Record and post-produce the tutorial demo clips.
#
#   ./scripts/record-demos.sh                 # every clip
#   ./scripts/record-demos.sh quickstart      # one spec file (tests/demo/quickstart.spec.ts)
#   ./scripts/record-demos.sh quickstart qs-03-start-game   # one clip
#
# Runs the demo Playwright config (portrait 480×960, video on, no retries),
# reads the DEMO_TRIM_MS[<clip>]=<ms> line each spec prints at the end of its
# off-camera setup, and cuts + encodes each take into docs/clips/<clip>.mp4
# with a matching <clip>.jpg poster.
#
# See DEMO_VIDEOS.md for the style rules and the gotchas these encode.

[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TESTS="$ROOT/tests"
TAKES="$TESTS/demo-results"
OUT="$ROOT/docs/clips"
# NOT inside demo-results: Playwright wipes outputDir at the start of every run,
# which would delete the log we're writing the trim offsets into.
LOG="$TESTS/.demo-record.log"

SPEC="${1:-}"
GREP="${2:-}"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)"; exit 1; }
mkdir -p "$OUT"

ARGS=(test --config=playwright.demo.config.ts)
[[ -n "$SPEC" ]] && ARGS+=("demo/${SPEC}.spec.ts")
[[ -n "$GREP" ]] && ARGS+=(-g "$GREP")

echo "▶ recording: npx playwright ${ARGS[*]}"
mkdir -p "$TAKES"
# Keep going to the cutting stage even if a clip failed — the passing takes are
# still worth encoding, and the failure is reported at the end.
FAILED=0
(cd "$TESTS" && npx playwright "${ARGS[@]}" 2>&1) | tee "$LOG" || FAILED=1

echo
echo "▶ cutting"
CUT=0
SKIPPED=0
# Only takes that reached their own last line get cut. A test that failed
# halfway still leaves a video.webm and a DEMO_TRIM_MS line behind, and cutting
# that would ship truncated footage from a green-looking run.
OK_CLIPS=$(sed -nE 's/.*DEMO_OK\[([^]]+)\].*/\1/p' "$LOG" | sort -u)

# sed, not shell parameter expansion: `${line#DEMO_TRIM_MS[}` reads the bracket
# as a glob character class and silently eats the wrong prefix.
while IFS='|' read -r clip ms; do
  if ! grep -qx "$clip" <<<"$OK_CLIPS"; then
    echo "  ✗ $clip — take did not finish; keeping the previous clip"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  # ffmpeg wants seconds. The video starts recording slightly before the test
  # body, so trimming a touch early is the safe direction (DEMO_VIDEOS.md #6).
  secs=$(awk -v m="$ms" 'BEGIN{ printf "%.2f", m/1000 }')

  src=$(ls -d "$TAKES"/*-"$clip"-chromium/video.webm 2>/dev/null | head -1 || true)
  if [[ -z "$src" ]]; then
    echo "  ✗ $clip — no take found (did it fail?)"
    continue
  fi

  ffmpeg -loglevel error -y -ss "$secs" -i "$src" \
         -c:v libx264 -pix_fmt yuv420p -crf 20 -preset slow -movflags +faststart \
         "$OUT/$clip.mp4"
  # Poster = first frame, so the still matches where playback begins.
  ffmpeg -loglevel error -y -i "$OUT/$clip.mp4" -frames:v 1 -q:v 3 "$OUT/$clip.jpg"

  dur=$(ffprobe -loglevel error -show_entries format=duration -of csv=p=0 "$OUT/$clip.mp4")
  size=$(du -h "$OUT/$clip.mp4" | cut -f1)
  printf "  ✓ %-28s %5.1fs  %s\n" "$clip" "$dur" "$size"
  CUT=$((CUT + 1))
done < <(sed -nE 's/.*DEMO_TRIM_MS\[([^]]+)\]=([0-9]+).*/\1|\2/p' "$LOG" || true)

echo
if [[ $SKIPPED -gt 0 ]]; then
  echo "$CUT clip(s) written to docs/clips/, $SKIPPED skipped"
else
  echo "$CUT clip(s) written to docs/clips/"
fi
if [[ $FAILED -eq 1 ]]; then
  echo "⚠ some takes failed — see $LOG"
  exit 1
fi
exit 0
