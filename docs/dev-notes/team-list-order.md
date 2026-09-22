# Teams screen order and pins

Status: shipped (branch `team-pins`, built 2026-09-15). Code: `store/teamListPrefs.js` (the rules), `teams/teamList.js` (`renderCloudTeamsList`, `buildTeamSection`, `recordTeamViewed`, `toggleTeamPinned`), `css/teams.css` (`.team-pin-btn`, `.team-group-label`, `.team-header-actions`). Tests: `tests/unit/teamListPrefs.test.mjs`, `tests/scenarios/14-team-pins.spec.ts`.

## What it is

The teams screen lists teams most recently opened first, with a pinned group above. The pin toggle sits left of the team-settings gear in each card's header (for viewers too, where it is the only header button). Nothing was configurable before: the list was ordered by each team's most recent game, which nobody could work out from looking at it.

## Decisions

- **Per device, in localStorage, not per account on the server.** Key `breakside_team_list_prefs`, shape `{ pinned: [ids, top first], lastViewed: { id: epochMs } }`. A phone and a laptop can differ. Server-side preferences would need a new user-preferences slot in `breakside_server/storage/user_storage.py` and a backend deploy; not worth it until someone asks for pins that follow them.
- **Sign-out wipes it.** The key is in `LOCAL_DATA_KEYS` (`auth/auth.js`), so Sign Out and the Clear Cache button both remove it. Team ids embed team names, and the sign-out wipe promises the next coach on a shared tablet sees nothing of the previous one's. Signing back in means re-pinning; sign-out is rare enough that this beats keying the data per user.
- **What counts as opening a team.** Any navigation into the team: Roster, Team Settings, New Game, Join, Review, New Event Game, Event roster (all of which go through `selectCloudTeam`), plus creating or joining a team. Expanding a card, pinning, event settings and deleting do *not* count. The list redraws every few seconds on the auto-refresh, so a team that counted as "viewed" when its card was expanded would jump to the top while the coach was reading it.
- **Fallback for teams never opened on this device** is the old rule: most recent game first, then name, then id. So the day this ships the order is exactly what it was, and teams sort themselves as the coach uses them. A never-opened team never outranks an opened one, however recent its games; a team that matters is either opened or pinned.
- **Pin order is "last pinned on top", no drag handle.** To arrange the pinned group, unpin and pin in the wanted order. Accepted as good enough for now against adding a drag affordance; the reconsideration note is in TODO.md § UI/UX.
- **Pin toggles redraw from the last fetch.** `populateCloudTeamsAndGames` now fetches and stashes `_lastListData`, and `renderCloudTeamsList` draws; a pin tap writes the prefs and redraws synchronously. Nothing else changed in the refresh path: the periodic refresh still refetches, and scroll position is still preserved across the swap.
- **Returning to the screen redraws the kept list before the refetch.** Since the no-flicker change (2026-09-22) `showSelectTeamScreen` keeps the previous list on screen while the refetch is in flight. The order depends on this device's prefs, not on the server, so the kept list is redrawn from `_lastListData` first; otherwise the team the coach just opened sat in its old place for a beat and then hopped to the top. Corollary for tests: assert the order as an eventual state (`expect.poll`), because a one-shot read right after returning can see the list from before a team was created.
- **Stale ids are skipped, not scrubbed.** A pinned or viewed id for a team the coach erased or left is ignored by `arrangeTeams`. A team joined again comes back pinned. The key cannot grow past a few KB in a coach's lifetime.
- **Group labels only when something is pinned.** "Pinned" and "Other teams"; with everything pinned, only "Pinned". With nothing pinned the list looks as it always did.

## How to verify

Unit: `node --test 'tests/unit/*.test.mjs'`. E2E: scenario 14 (see [e2e-and-unit-tests.md](e2e-and-unit-tests.md) for the per-worktree ports).

By hand on a preview or staging: open two teams in turn and confirm the one opened last leads on return; pin one and confirm it moves under a "Pinned" label without a network round trip (works offline too); reload and confirm the pin held; pin a second and confirm it lands above the first; sign out and back in and confirm the pins are gone. In the console, `localStorage.getItem('breakside_team_list_prefs')` shows the stored shape.
