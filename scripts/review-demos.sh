#!/bin/bash
# Build review sheets for the recorded demo clips.
#
#   ./scripts/review-demos.sh            # all clips in docs/clips
#   ./scripts/review-demos.sh qs-04      # one clip, as a per-clip contact sheet
#
# Two questions get a clip rejected, and both are answered by looking rather
# than by the test passing (DEMO_VIDEOS.md lesson #5):
#   - does it OPEN on the starting screen, or mid-gesture?   → first-frames.png
#   - does it END on the payoff, or wherever the app         → last-frames.png
#     navigated afterwards?
#
# Output goes to a scratch dir, never into the repo.

[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIPS="$ROOT/docs/clips"
OUT="${DEMO_REVIEW_DIR:-/tmp/breakside-demo-review}"
ONE="${1:-}"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT/f" "$OUT/l"

if [[ -n "$ONE" ]]; then
  # Per-clip contact sheet: one frame every 2s, 5 across.
  for mp4 in "$CLIPS"/*"$ONE"*.mp4; do
    name=$(basename "$mp4" .mp4)
    ffmpeg -loglevel error -y -i "$mp4" -vf "fps=1/2,scale=200:-1,tile=5x3" \
           -frames:v 1 "$OUT/$name-sheet.png"
    echo "$OUT/$name-sheet.png"
  done
  exit 0
fi

n=0
for mp4 in "$CLIPS"/*.mp4; do
  [[ -e "$mp4" ]] || continue
  name=$(basename "$mp4" .mp4)
  idx=$(printf "%02d" "$n")
  # 0.4s in, not 0.0 — the very first frame can be mid-fade.
  ffmpeg -loglevel error -y -ss 0.4 -i "$mp4" -frames:v 1 -vf scale=160:-1 "$OUT/f/$idx-$name.png"
  ffmpeg -loglevel error -y -sseof -0.4 -i "$mp4" -frames:v 1 -vf scale=160:-1 "$OUT/l/$idx-$name.png"
  n=$((n + 1))
done

[[ $n -eq 0 ]] && { echo "no clips in $CLIPS"; exit 1; }

cols=6
ffmpeg -loglevel error -y -pattern_type glob -i "$OUT/f/*.png" \
       -vf "tile=${cols}x$(( (n + cols - 1) / cols )):padding=4:color=white" \
       -frames:v 1 "$OUT/first-frames.png"
ffmpeg -loglevel error -y -pattern_type glob -i "$OUT/l/*.png" \
       -vf "tile=${cols}x$(( (n + cols - 1) / cols )):padding=4:color=white" \
       -frames:v 1 "$OUT/last-frames.png"

echo "$n clips"
echo "$OUT/first-frames.png"
echo "$OUT/last-frames.png"
printf '%s\n' "$OUT"/f/*.png | sed 's#.*/##; s/\.png$//'
