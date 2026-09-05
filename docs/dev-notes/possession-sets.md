# Possession sets (zone tracking)

Status: shipped (merged to main 2026-08-09, frontend only). Data model and stats in ARCHITECTURE.md § Possession Sets. Invisible until a team opts in via Team Settings → Set Tracking.

## The design call that blocked the last stage

Sets live on *possessions*; breaks and holds are classified per *point*. The choice was between a `{set}` filter option composed with the phase filter, and a breakdown block showing every set at once. The breakdown block won: `Zone (D): 8/12 stops, 4 breaks` / `Ho-stack (O): 5/8 scored`, rendered under breaks/holds on both stats screens and as xlsx footer rows. No filter, no composition.

## Known limitation

`Possession.set` is a single label, so a mid-possession "Fire!" call overwrites rather than records the transition. The backlog item "Record a transition between sets" in TODO.md sketches it; the gating question is stats attribution (which segment owns the stop, which owns the break), not the UI.

## Three bug patterns worth remembering

1. **Unscoped auth CSS leaks.** Team Settings fields rendered white-on-white because `auth/auth.css` styles `.form-group` unscoped for the dark auth screen. Now in ARCHITECTURE.md § CSS Styling Gotchas. The file is `auth/auth.css`, not `css/auth.css`.
2. **Inline delimiters carry the next possession's tag.** A Turnover emits an inline "on defense" delimiter in the game log and suppresses the next possession's own, so a defensive set tagged mid-point was silently dropped until the inline delimiter learned to carry it.
3. **Controls keyed off the last possession are wrong right after a turnover.** The mode flips before the new possession exists (possessions are created on the first recorded event). Primary controls key off the live mode (`setLabelsForSide`) and materialise the possession on write via `ensurePossessionExists`.

## How to apply

- Anything that hand-merges team stats numerically silently drops the `sets` field. Use the shared `getGamesTeamStats`.
- Tagging UI: a `Set:` control on the Full tab's top line and the Field tab's action row (live mode), plus a mirror beside "Last turnover was a:" / "Last D was a:" bound to that possession. Tap cycles; long-press opens an anchored popover (`ui/setPicker.js`). The pull-dialog picker was removed.
- Verifying in-game needs a recorded game; see [preview-testing.md](preview-testing.md).
