# Field Mode — Implementation Handoff

Spatial play-by-play entry: a new **Field** tab (alternative to **Full**) where the
coach taps a drawn field to record *where* each throw / catch / turnover / block /
pull happened, attributing players. This doc bridges the finished interactive
**mockup** to the real codebase. The mockup is the source of truth for
interactions; this doc maps those to code.

## The mockup (canonical interaction spec)

`mockups/field-position/index.html` — a single self-contained file, fully
interactive, with an on-page notes panel documenting every behavior and the
remaining open questions. Run it:

```bash
cd mockups/field-position && python3 -m http.server 4174
# open http://localhost:4174/index.html
```

Toolbar toggles Orientation (Portrait in-tab / Landscape full-screen),
Mode (Offense / Defense), a "Start D-point (pull)" trigger, and Reset.
It is **not** wired to real data — it's a state-machine + SVG/CSS prototype.

## Coordinate system

- **Canonical field coords**, orientation-independent — store events in these:
  - `l` 0–120 along length: 0 = own back line, 120 = attacking back line.
  - `w` 0–40 across width.
  - Endzones `l` 0–25 and 95–120 (depth 25). Playing field 25–95.
  - Red-zone lines at `l` = 45 and 75 (20 yd off each goal line). Brick marks at
    the same depths, centered (`w` = 20).
- **Two display flips** applied only at render time:
  - `flipAD` — attacking direction / which endzone we attack.
  - `flipHA` — which sideline is Home.
  - Defaults: portrait → Home **left**, attack **up**; landscape → Home
    **bottom**, attack **right**. (Portrait mirrors the width axis vs landscape;
    see `pct()`/`toField()` in the mockup.)
- Flips are user/game settings, changeable two ways: **long-press** any of the
  Home / Away / Attack / Defend field labels, or the **hamburger menu**
  (UI → *Swap Home and Away*, Gameplay → *Swap Attack/Defend Endzones*).
- **Real impl:** Attack/Defend should also auto-flip each point as teams score.
  Physical device rotation should force landscape (`orientationchange`).

## Event model (extend `store/models.js`)

Read the existing `Throw` / `Turnover` / `Point` / `Event` shapes first and
**extend, don't replace**. Each spatial event needs a location + attribution:

| Event | Fields (beyond existing) | Possession effect |
|---|---|---|
| Completion | `from{l,w}`, `to{l,w}`, `thrower`, `receiver`, `mods[]` | stays O |
| Score | as completion + `assist` (default = thrower, editable) | point ends |
| Throwaway | `from`, `to`, `thrower`, `mods[]` (no receiver) | O→D |
| Drop | `from`, `to`, `thrower`, `receiver`, `mods[]` | O→D |
| Block | `to`, `by` (defender), `mods[]` | D→O |
| Interception | `to`, `by`, `mods[]` | D→O (that player holds) |
| Stall | `to`, `by` (marker), `mods[]` | D→O |
| Callahan | `to`, `by`, `mods[]` | defensive **score**, point ends |
| Pull | `from` (defending goal line), `to` (landing), `by` (puller), `hang` (ms), `brick` (bool), `mods[]` | starts D possession |
| They score / They turnover | — | point ends / D→O |

- **Auto-score:** a completion whose `to` is in the attacking endzone is a score.
- **Modifiers:** throws = `Break, Reset, Huck, Hammer, Layout, Sky`; D =
  `Layout, Sky`; pull = `Rolled out, Roller, OI, IO`. Note **"reset" is a throw
  type**, not a clear. `Stall` and `Callahan` are their own D *actions* (not mods).
- Decide a location field name/shape consistent with the codebase (`{x,y}` vs
  `{l,w}`); the backlog "field position" item suggests `{x,y}` on Throw/Turnover.

## Possession state machine

- **Offense:** holder has the disc. Record a completion by choosing a receiver
  (tap chip / tap field→popover / drag chip) **and** a location. Throwaway/Drop
  flip to Defense. A score opens the **score-attribution dialog**.
- **Defense:** the player slot shows four D actions — **Block · Interception ·
  Stall · Callahan**. Tap one → player row appears → place the spot + pick the
  defender. Block/Int/Stall flip to Offense; Callahan is a defensive goal.
  Bottom bar: *They turnover* (→O), *They score* (point ends), *⋯ more*.
- **Pull (D-point start):** pick puller → hangtime stopwatch (tap on release / tap
  on landing, **or** tap the field directly to stop+place in one gesture) →
  landing spot or **Brick** → drops into Defense with the opponent receiving.
- **One modifier column** tags the **last recorded event**; the header adapts:
  *"Last throw was a:"* vs *"Last D was a:"*. Because a D flips to offense, the
  *Last D was a:* menu **persists on the O screen until the first completed pass**,
  and it also appears **while placing a D** (pre-labels Layout/Sky before
  player/location are set).

## UI structure (→ `playByPlay/fullPbp.js` or a new `playByPlay/field*` module)

- **Portrait** = embedded in the app (real header + tabbar with a new **Field**
  tab + action row with mode pill / Undo / ⛶ expand). Left rail = players +
  modifier strip; field on the right; status + events below; mic FAB bottom-right.
- **Landscape** = full-screen takeover (minimal header). Players across top, field
  left, modifier column right ("Last … was a:"), events bottom, mic FAB.
- **Placement gestures (all three live at once):** tap player→tap field; tap empty
  field→popover picker; drag player (pegman)→field. Drag any of the last ~4 catch
  markers to fine-tune (re-anchors the adjacent throw); older plays fade.
- **Players:** max 7 on field + an **Unknown** ("?") option (Full-PBP `is-unknown`
  styling); landscape never scrolls — shrink, drop jersey numbers first, then
  collapse Unknown to "?".
- **Score dialog:** goal (receiver) + assist (thrower) pre-filled & editable.
  Confirm = goal; **✕ "wasn't a score"** downgrades to a plain completion (throw
  preserved) so the coach can Undo or drag the catch out of the endzone.

## Real-impl TODOs / decisions not modeled in the mock

- **Block ≠ holder:** interception → that defender holds; a **block** leaves *no*
  holder (disc on the ground) — prompt who picks up / where, defaulting to
  "thrower picks up at the block spot" if they just start throwing.
- **Pickup, not Alice:** O-possession start (and post-block) shouldn't assume a
  holder — first action is who catches/picks up the pull.
- **Callahan → score dialog** (goal = defender) and advance to the next pull.
- **Auto-flip Attack/Defend each point.**
- **Hockey assist** (backlog) interplay with the new explicit `assist` field.

## Touch points

- `store/models.js` — event classes: location, `mods[]`, `assist`, `hang`, D types.
- `store/storage.js` — serialize/deserialize new fields; add round-trip tests in
  the server suite.
- `playByPlay/fullPbp.js` (+ likely a new field module) — the screen itself.
- `playByPlay/pullDialog.js`, `keyPlayDialog.js`, `scoreAttribution.js` — reuse /
  align the pull + score-attribution flows.
- `game/pointManagement.js` — point start (pull trigger, line→start) + possession
  flips; auto-flip attacking direction.
- `screens/navigation.js` / `ui/` — register the **Field** tab; event-log display
  of the new event types.
- `narration/narrationEngine.js` + `ultistats_server/narration.py` — if narrated
  events should carry location / pull / D-types (note: `record_pull` is already a
  flagged schema gap in the backlog).

## Open questions still worth a decision

- Drop entry: "tap Drop → tap spot → pick who" vs a cheaper swipe-down on the catch.
- Label/flip discoverability — a future "tips & hints" surface.
- Final location field naming (`{x,y}` vs `{l,w}`) to match existing conventions.

## How to continue

Work on branch **`field-position`** (worktree `.worktrees/field-position`) or
branch a new worktree from it. Start by reading `store/models.js` and the current
`playByPlay/fullPbp.js`, then stand the Field tab up against the mockup screen by
screen (pull → defense → offense → score), wiring each event type into the model
as you go.
