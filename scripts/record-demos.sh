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

# The list reporter interleaves cursor-control escapes with the tests' own
# stdout, and they land mid-line — so a raw grep of the log yields clip names
# with an ESC sequence buried inside, which then fail to match anything.
CLEAN="$TESTS/.demo-record.clean.log"
perl -pe 's/\e\[[0-9;?]*[a-zA-Z]//g' "$LOG" > "$CLEAN"

# Only takes that reached their own last line get cut. A test that failed
# halfway still leaves a video.webm and a DEMO_TRIM_MS line behind, and cutting
# that would ship truncated footage from a green-looking run.
OK_CLIPS=$(sed -nE 's/.*DEMO_OK\[([^]]+)\].*/\1/p' "$CLEAN" | sort -u)

# Collect the whole work list BEFORE the loop, and iterate the array rather
# than a pipe. ffmpeg reads stdin, so a `while read … done < <(sed …)` loop with
# ffmpeg in its body has the encoder eat the loop's own input: later clip names
# come back missing their first character(s) and "have no take". `-nostdin`
# below is the belt to this braces.
#
# sed, not shell parameter expansion: `${line#DEMO_TRIM_MS[}` reads the bracket
# as a glob character class and silently eats the wrong prefix.
PAIRS=()
while IFS= read -r pair; do
  [[ -n "$pair" ]] && PAIRS+=("$pair")
done < <(sed -nE 's/.*DEMO_TRIM_MS\[([^]]+)\]=([0-9]+).*/\1|\2/p' "$CLEAN" || true)

for pair in ${PAIRS+"${PAIRS[@]}"}; do
  clip="${pair%%|*}"
  ms="${pair##*|}"
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

  # -ss AFTER -i (output-side, frame-accurate). Input-side seeking on these
  # webms silently truncates the tail — Playwright's VP8 output has no duration
  # header and sparse keyframes, so ffmpeg stops early and you get a clip that
  # ends several seconds before the payoff. Decoding from the start costs
  # nothing at this length.
  ffmpeg -nostdin -loglevel error -y -i "$src" -ss "$secs" \
         -c:v libx264 -pix_fmt yuv420p -crf 20 -preset slow -movflags +faststart \
         "$OUT/$clip.mp4"
  # Poster = first frame, so the still matches where playback begins.
  ffmpeg -nostdin -loglevel error -y -i "$OUT/$clip.mp4" -frames:v 1 -q:v 3 "$OUT/$clip.jpg"

  dur=$(ffprobe -loglevel error -show_entries format=duration -of csv=p=0 "$OUT/$clip.mp4")
  size=$(du -h "$OUT/$clip.mp4" | cut -f1)
  printf "  ✓ %-28s %5.1fs  %s\n" "$clip" "$dur" "$size"

  # Playwright's video is a screencast encoded at a fixed 25fps, so its length
  # is a frame count, not wall-clock: under load the capture drops frames and
  # the take can come out seconds shorter than the test ran — losing the end of
  # the choreography, not just speeding it up. The clip still looks fine on its
  # own, so say so out loud and re-record that one.
  srcdur=$(ffprobe -loglevel error -show_entries format=duration -of csv=p=0 "$src" 2>/dev/null || echo 0)
  awk -v d="$dur" -v s="$srcdur" -v t="$secs" -v c="$clip" \
      'BEGIN { if (s > 0 && (s - t) - d > 2.0)
                 printf "     ⚠ %s is %.1fs shorter than its take — frames were dropped; re-record it\n", c, (s-t)-d }'
  CUT=$((CUT + 1))
done

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
