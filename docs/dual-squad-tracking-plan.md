# Dual-squad tracking — plan

**Status:** design agreed 2026-10-27, nothing built. Builds on the scrimmage variations branch (`scrimmage-variations`, ARCHITECTURE.md § Scrimmage variations). Mockup of the header in `mockups/dual-squad-tracking.html` (the header is the new part; the body and toast there are placeholders, not a redesign of Full mode or of the toast style).

One coach, one phone, both squads of a scrimmage: lines and play-by-play for both, recorded from whichever squad has the disc. The same mechanism later tracks two real teams the coach belongs to.

## Decisions (2026-10-27)

- **Architecture: twin ledgers, mirrored.** The two squad-games stay exactly what they are (one roster, one side each). A recorder on the phone writes every coach action into both, each from its own side. Nothing downstream changes: stats, sync, share links, replay, export, controller roles all keep working per game.
- **Record from the offense side.** The active squad follows the disc; D-side facts arrive as mirrors of O-side events. After a turnover a toast asks **Plain turnover** / **D — enter details** with a five-second burndown (the role-request toast's pattern); "enter details" opens the defending squad's Defense entry (defender, block / interception / layout / sky / stall).
- **Active squad = the squad with the disc**, until the coach taps the other squad; a manual pick holds until the next change of possession.
- **Squad colors**: a small jersey palette, chosen per squad in the New Scrimmage dialog, defaulted from the names. Header tint, switcher, player buttons and log lines carry it.
- **Lines**: one squad's line may be left unset at Start Point; that squad's playing time is simply not counted for that point. A Line Coach on another phone for the other squad works through today's pending-line sync.
- **One Undo**, reversing the last coach action in whichever ledgers it touched.
- **Log tab**: one merged, color-coded log of both squads.
- **Another coach holds a role on one half**: that half's tabs stay visible, greyed out; a tap toasts who holds the role with a button to request it (the existing handoff request).
- **Two real teams**: a coach who belongs to both teams; no guest roster. A "guest coach" membership (short-term, stats entry only, no mail or settings) is a separate, later item.
- **Field tab**: phase 2. **Voice narration**: only lineup narration, and only through the separate scrimmage-roster narration work; event narration stays single-squad.

## Model

```javascript
// Game — both halves carry the pairing; null on an unpaired game
{ pairedGameId: "2026-10-27_Light_vs_Dark_…",   // the other ledger
  pairedTeamId: "Velvet-Practice-99y5",          // its team (the same team for a scrimmage)
  squadColor: "navy" }                            // this side's jersey color (palette key)
```

A scrimmage already links its halves by `scrimmageId`; `pairedGameId` is the generalisation two real teams need and is what dual mode reads. `createSquadGames` fills it on both halves. On the server the field rides along in the game document (documents are stored whole) and is added to `list_all_games` summaries so the team card can offer **Track both**.

Nothing new on Point or Event. The mirror is in how the recorder writes, not in what is stored.

### The mirror table

| Coach records on the squad with the disc (A) | Written to A | Written to the other squad (B) |
|---|---|---|
| Completed pass | Throw | nothing (opponent passes are not events today) |
| Throwaway / drop / stall | Turnover | Defense, `unforcedError` (or the named defender and modifiers once the toast says so) |
| Score | scoring Throw, point won | point lost (as They Score today); scrimmage-rule outcomes mirrored |
| Callahan by B (entered on B's side) | — | Defense `Callahan`, point won, and a Turnover on A |
| Pull by A | Pull | Pickup / pull catch by whoever the coach taps next on B |
| Timeout | timeout "us" | timeout "them" |
| Injury sub, lineup correction | A only | — |
| Halftime, switch sides, end game | both | both |
| Field coordinates | as tapped | flipped: stored coords are relative to the attacking direction, so `(1 − x, 1 − y)` |

Scrimmage variations: the rules engine (`recordScore`, `settlePointAfterTurnover`, `bankPendingPoints`) runs once, for A, and the recorder applies the mirrored outcome to B (A `pendingConversion: 'team'` ⇔ B `'opponent'`, same `pendingValue`; the Bank chooser opens once).

## Mechanism

- **Active game resolution.** `currentGame()` (`utils/helpers.js`) is the one seam every surface reads (one other tail read, in `getActiveRoster`). It gains an override: `setActiveGame(game, team)` in `store/storage.js`; `currentGame()` returns the override when set, the tail of `currentTeam.games` otherwise. For a scrimmage both halves are on `currentTeam`; for two real teams the override also carries the team, so `getActiveRoster` and the header read the right roster and name. Leaving the game screen clears it.
- **The recorder** (`game/dualRecorder.js`, Features layer). Wraps the possession core's `createThrow / createTurnover / createDefense / createPull / createPickup`, the score paths, timeouts and period breaks: each coach action becomes one journal entry `{ action, a: [events written to A], b: [events written to B], scoreBefore, pendingBefore }`. Only active when `currentGame().pairedGameId` names a game this phone also holds live. Single-squad tracking is untouched: the wrapper is a no-op without a twin.
- **Journal undo.** In dual mode the Undo button pops the journal and reverses the entry in both ledgers (pop the events it wrote, restore the score and pending state it changed) instead of running `applyUndoToGame` on one game. The journal is device-local and rebuilt on reload from the two event streams' timestamps (events written by one action share a stamp), so a reload mid-game keeps Undo honest.
- **Following the disc.** After each recorded action the recorder asks the possession core which side has the disc (`reconstructState` on the active game) and switches the override when it changed, unless the coach pinned a squad since the last change of possession. A switch redraws the header, the tabs and the Line tab for the new squad; the tab stays where it was.
- **Points start and end together.** Start Point (either Line tab or the panel button) starts both games' points with each squad's selected line (an unset line starts an empty point on that side, with a toast). The point clocks arm per side as today: the puller's on the pull, the receiver's on the first touch. Scores end both points through the rules engine. Clock stoppages mirror.
- **Sync and roles.** `saveAllTeamsData` syncs the current game; the recorder also syncs the twin after each action (the same `syncGameToCloud(other)` the scrimmage creation uses). Dual mode requires Active Coach on both games; `startControllerPolling` runs for both ids. A role held elsewhere greys that half (visible, disabled) and taps offer the handoff request. When the other coach releases, the half rejoins.
- **Header.** Score line with both squad names in their colors; a segmented switcher with each squad's O/D pill; the header tinted by the active squad; the "auto / pinned" state as a small line under it (see the mockup). The existing O/D pill and the between-points chip stay.
- **They Score / They turnover.** In dual mode the D-side shortcuts switch to the other squad and open its own dialog (score attribution from its roster; the defense entry), so nothing is ever unattributed by accident. The Simple panel's We Score / They Score become "<Dark> scores / <Light> scores".
- **Log tab.** Entries from both games merged by timestamp, each line tinted with its squad; the per-game logs (Review, share links, export) are unchanged.

## Phases

### Phase 1 — scrimmage, Simple and Full
1. `pairedGameId` / `pairedTeamId` / `squadColor` on Game, serialised, set by `createSquadGames`; the palette in the New Scrimmage dialog; summaries carry the pairing (backend: `list_all_games`, one field).
2. `setActiveGame` override in storage + `currentGame()`; the header switcher, tint and follow-the-disc; **Track both** on the scrimmage card (both halves loaded live, both roles claimed).
3. The recorder with the mirror table for Simple and Full (throws, turnovers, scores, pulls, pickups, timeouts, halftime, end game), scrimmage-rule outcomes mirrored.
4. Journal undo, with the reload rebuild.
5. The post-turnover toast (plain / D — enter details, five-second burndown) and the D-side entry it opens.
6. Dual sync and dual role polling; the greyed-out half and the request-role toast.
7. Merged Log tab.
8. Unit tests for the mirror table and the journal (pure functions); an e2e scenario that tracks one point from both sides and checks both documents; staging field test.

### Phase 2 — Field tab and polish
- Field tab in dual mode: coordinate flip per squad, the pull's landing spot becoming the other squad's pickup, the direction indicator per squad.
- Line tab: a quick toggle to the other squad's line between points without leaving the tab; On Deck for both.
- Review / Scrimmage Stats: a consistency check between the halves (A's turnovers = B's defense events) surfaced as a note, since the ledgers are now meant to agree.

### Phase 3 — two real teams
- New Game → **vs one of my teams**: pick the opponent team; both games created on their own teams with `pairedGameId`, each in its own team's event if one is active; the same recorder.
- Membership: the coach must be a coach on both teams (server-side check on the paired sync).
- Later, separately: a **guest coach** membership role (time-limited, stats entry only).

## Open points to settle while building
- What the twin looks like when the other half is *not* loaded live (the other coach tracks it): dual mode is off, as today; the card says who is tracking.
- Whether a mirrored Defense with no defender should show in B's Log as "Dark turnover" rather than "Unforced error", to read naturally from B's side.
- The journal rebuild on reload needs each action's events to share a timestamp; `stampEvent` gives every event its own `at`, so the recorder stamps all of an action's events with one value.
