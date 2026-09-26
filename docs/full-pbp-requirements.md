# Full Play-by-Play Mode — Requirements v1

Status: design / pre-implementation. Code plan deferred until the audio narration feature lands so we can align with its event-hook surface.

## Overview

A new **Full** play-by-play tab that lets a coach log every event of a point (every throw, every turnover, every D) with minimal taps. It lives alongside the existing key-play-only mode (renamed **Simple**). Both tabs produce the same `Throw` / `Turnover` / `Defense` events into the same `Possession` structure — Full is purely a faster UI for the same data model.

## Placement

- New "Full" tab alongside "Simple" (the current PBP UI, to be renamed).
- The "All" panel-view tab keeps Simple mode only for now.

## Layout (phone width, 3 columns)

- **Left — players.** Unknown Player + this point's roster, one row each. The current holder is highlighted.
- **Middle — per-player buttons.** Contextual to whether the row is the current holder.
  - Non-holder row: `drop` / `score` / `…`
  - Holder row: `throwaway` / `break` / `…`
- **Right — context panel.** Adaptive; see "Right panel" below.
- **Undo.** Big, always visible. Pops the last event and re-derives holder state from the event stream.

## O-mode interactions

| Tap | Event | Flip? |
|---|---|---|
| *Pull not yet received* — `Catches Pull` / `Picks Up` / player name (2026-09) | `Pickup{receiver=tapped, pullCatch if caught}` | no; tapped becomes holder; the point clock starts (first touch) |
| *Pull not yet received* — `Drops Pull` (2026-09) | `Turnover{drop, thrower=null, receiver=tapped}` — a dropped pull is a drop with no thrower | O→D, no holder; the point clock starts |
| Other player name | `Throw{thrower=holder, receiver=tapped, break if armed}` | no; tapped becomes new holder |
| `drop` on other row | `Turnover{drop, thrower=holder, receiver=tapped}` | O→D, no holder |
| `score` on other row | `Throw{score, thrower=holder, receiver=tapped}` | end point |
| `throwaway` on holder row | `Turnover{throwaway, thrower=holder}` | O→D, no holder |
| `break` on holder row | *Arms* break_flag for next throw; visually selected; tap again to un-arm | no |
| `…` → Stall | `Turnover{stall, thrower=holder}` | O→D, no holder |
| `…` → Good D | `Turnover{goodDefense, thrower=holder}` | O→D, no holder |

## D-mode interactions

| Tap | Event | Flip? |
|---|---|---|
| `block` on any row | `Defense{defender=tapped}` | D→O, no holder |
| `interception` on any row | `Defense{interception, defender=tapped}` | D→O, holder = tapped |
| `…` → Callahan | `Defense{Callahan, defender=tapped}` | end point, we score |
| `…` → Stall | `Defense{stall, defender=tapped}` | D→O, no holder |
| Right-panel **"They turnover"** | `Defense{unforcedError, defender=null}` | D→O, no holder |

## Right panel — adaptive

- After a `Throw`: "Last pass was a:" — checkboxes for `huck` / `break` / `hammer` / `sky` / `layout` / `dump`. Retroactively amends the most recent Throw's flags.
- After a `Defense`: "Last D was a:" — `sky` / `layout`. Retroactively amends the most recent Defense's flags.
- In D mode at all times (regardless of whether a D event has been logged yet): also shows the **"They turnover"** button.
- Modifiers auto-clear when the next event becomes the "last" event; the panel label/content swaps as the most-recent event type changes.

The retroactive-modifier UX is **tentative**. We may instead mock and try: pre-arm next throw, long-press on the throw, or dual prev/next sections. Pick what sticks in practice.

## Start state & transitions

- No holder at point start. On an **offensive** point every row shows `Drops Pull` / `Catches Pull` / `Picks Up` until the first touch is recorded, and a name tap is `Picks Up` (added 2026-09; see ARCHITECTURE.md § Point clock and the first touch). Start Point arms the point clock on this surface; that first touch starts it, so point time excludes the pull's flight.
- After a block / stall / opponent unforced error (no holder, mid-point) the first player-name tap records a `Pickup` in the new offensive possession (2026-09-26); after an interception the defender already holds.
- After any O↔D flip *except* an interception: no holder; the first tap records a `Pickup` (since 2026-09-26 — it used to establish the holder with no event).
- The existing pull dialog still gates point entry exactly as today.

## Cross-cutting behavior

- Full stays the active PBP tab across points unless the user switches.
- **New "Start Point (Offense/Defense)" button on the Call Next Line tab.** No such button exists today.
  - If Defense: flows into the existing pull dialog.
  - If Offense: skips the pull dialog.
  - When one coach holds both Line and Active Coach roles, pressing the button auto-navigates to whichever PBP tab (Full or Simple) they last used.
- Opponent Callahan is **not** modeled. Log as a throwaway followed by an opponent score. Proper opponent-Callahan tracking is on the future-enhancements list.
- Full PBP reuses existing `Throw` / `Turnover` / `Defense` models and `Possession` boundaries. The one addition since v1 is the `Pickup` event for pull reception (2026-09).
- The `…` menu opens as a popover anchored to its button (v1).

## Deferred / future enhancements

- Retroactive-modifier alternatives (pre-arm next throw; long-press throw; dual prev/next sections).
- Opponent Callahan tracking.
- Anything surfaced by the audio narration architecture once that feature lands.
