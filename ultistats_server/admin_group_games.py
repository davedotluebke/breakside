#!/usr/bin/env python3
"""
admin_group_games.py — group existing games into a TournamentEvent.

Admin / ops tool for retroactively bundling games that were entered as
standalone games into a single "event" (a.k.a. tournament / league session),
so the app can show combined cross-game stats (W/L record, and especially
total playing time per player) on the event-roster screen.

It writes directly to the file-based JSON store, using the same storage
modules the API uses, so the index stays consistent and no app redeploy is
needed. The app discovers the event on its next sync via
GET /api/teams/{team_id}/events and aggregates stats from event.gameIds.

DATA LOCATION
    Operates on whatever ULTISTATS_DATA_DIR points to (see config.py).
    On the EC2 host that is the production data:
        ULTISTATS_DATA_DIR=/var/lib/breakside/data
    Locally it defaults to <repo>/data.

SAFETY
    - Read-only subcommands (teams / games / events) never write.
    - `group` and `unlink` print a plan and require --yes to actually write
      (otherwise they run as a dry run).
    - `group` refuses to move a game that is already in a *different* event
      unless you pass --force.

USAGE
    # always run from inside the ultistats_server/ directory, or anywhere with
    # this file's directory importable — the script puts itself on sys.path.
    export ULTISTATS_DATA_DIR=/var/lib/breakside/data   # on the server

    python3 admin_group_games.py teams [--filter Flick]
    python3 admin_group_games.py games  --team "Flickers"
    python3 admin_group_games.py events --team "Flickers"

    # dry run (no --yes): shows exactly what would change
    python3 admin_group_games.py group --team "Flickers" \
        --event "Summer League - June 19" \
        --games <gameId1> <gameId2>

    # do it for real:
    python3 admin_group_games.py group --team "Flickers" \
        --event "Summer League - June 19" \
        --games <gameId1> <gameId2> --yes

    # undo (useful when testing on the throwaway "Offline Test" team):
    python3 admin_group_games.py unlink --event <eventId> --all --delete-event --yes
"""
import argparse
import os
import sys

# Make the storage package importable regardless of the current directory.
_SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
if _SERVER_DIR not in sys.path:
    sys.path.insert(0, _SERVER_DIR)

import config  # noqa: E402  (import after sys.path tweak)
from storage import team_storage, game_storage, event_storage  # noqa: E402


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _die(msg: str, code: int = 1):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def resolve_team(name_or_id: str) -> dict:
    """Resolve a team by exact id, then exact name, then unique substring.

    Exits with a helpful message on no-match or ambiguous-match.
    """
    if team_storage.team_exists(name_or_id):
        return team_storage.get_team(name_or_id)

    teams = team_storage.list_teams()
    lowered = name_or_id.strip().lower()

    exact = [t for t in teams if t.get("name", "").strip().lower() == lowered]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        _ambiguous(name_or_id, exact)

    partial = [t for t in teams if lowered in t.get("name", "").strip().lower()]
    if len(partial) == 1:
        return partial[0]
    if len(partial) > 1:
        _ambiguous(name_or_id, partial)

    _die(f"no team matches '{name_or_id}'. Try: admin_group_games.py teams")


def _ambiguous(query: str, matches: list):
    print(f"ERROR: '{query}' is ambiguous — {len(matches)} teams match:",
          file=sys.stderr)
    for t in matches:
        print(f"    {t.get('id'):<28} {t.get('name')}", file=sys.stderr)
    print("Re-run with the exact team id.", file=sys.stderr)
    sys.exit(1)


def team_game_metas(team_id: str) -> list:
    """All games whose teamId == team_id, sorted by start time.

    Scans the games on disk (authoritative) rather than trusting the index,
    so a stale index can never hide or invent a game.
    """
    metas = [g for g in game_storage.list_all_games()
             if g.get("teamId") == team_id]
    metas.sort(key=lambda g: g.get("game_start_timestamp") or "")
    return metas


def _fmt_meta(m: dict) -> str:
    start = (m.get("game_start_timestamp") or "")[:16].replace("T", " ")
    scores = m.get("scores") or {}
    score = f"{scores.get('team', '?')}-{scores.get('opponent', '?')}"
    ev = m.get("eventId")
    ev_str = f"  event={ev}" if ev else ""
    return (f"  {m['game_id']}\n"
            f"      {start or '(no date)':<16}  vs {m.get('opponent', '?'):<20}"
            f"  {score:>7}{ev_str}")


# ---------------------------------------------------------------------------
# read-only subcommands
# ---------------------------------------------------------------------------

def cmd_teams(args):
    teams = team_storage.list_teams()
    if args.filter:
        f = args.filter.lower()
        teams = [t for t in teams if f in t.get("name", "").lower()]
    if not teams:
        print("(no teams)")
        return
    print(f"{len(teams)} team(s):")
    for t in teams:
        n_games = len(team_game_metas(t["id"]))
        print(f"  {t.get('id'):<28} {t.get('name'):<28} ({n_games} games)")


def cmd_games(args):
    team = resolve_team(args.team)
    metas = team_game_metas(team["id"])
    print(f"Team: {team.get('name')}  ({team['id']})")
    if not metas:
        print("  (no games)")
        return
    print(f"  {len(metas)} game(s):")
    for m in metas:
        print(_fmt_meta(m))


def cmd_events(args):
    team = resolve_team(args.team)
    events = event_storage.list_team_events(team["id"])
    print(f"Team: {team.get('name')}  ({team['id']})")
    if not events:
        print("  (no events)")
        return
    for e in events:
        gids = e.get("gameIds", [])
        print(f"  {e.get('id'):<28} {e.get('name'):<30} "
              f"[{e.get('status', '?')}]  {len(gids)} game(s)")
        for gid in gids:
            print(f"      {gid}")


# ---------------------------------------------------------------------------
# group
# ---------------------------------------------------------------------------

def _default_roster_ids(team: dict, game_ids: list) -> list:
    """Player ids to seed a new event's roster.

    The app's in-game player picker (getActiveRoster) returns *empty* when an
    event's roster.playerIds is empty — which blanks the Lines table for any
    game in the event. The event-roster screen, by contrast, defaults an empty
    roster to "all team players". We mirror that default here so a tool-created
    event behaves like one created in the app.

    Prefer the team's playerIds; if the team has none (legacy team carrying
    only an embedded roster), fall back to everyone who appears in the linked
    games' roster snapshots.
    """
    ids = list(team.get("playerIds") or [])
    if ids:
        return ids
    seen, order = set(), []
    for gid in game_ids:
        try:
            cur = game_storage.get_game_current(gid)
        except FileNotFoundError:
            continue
        for p in (cur.get("rosterSnapshot") or {}).get("players", []):
            pid = p.get("id")
            if pid and pid not in seen:
                seen.add(pid)
                order.append(pid)
    return order


def _resolve_target_event(team_id: str, event_name: str, event_id: str):
    """Return (event_dict_or_None, will_create_bool).

    - If --event-id given: must exist and belong to this team.
    - Else match an existing event of this team by name (case-insensitive).
    - Else None + will_create.
    """
    if event_id:
        if not event_storage.event_exists(event_id):
            _die(f"event id '{event_id}' not found")
        ev = event_storage.get_event(event_id)
        if ev.get("teamId") != team_id:
            _die(f"event '{event_id}' belongs to team {ev.get('teamId')}, "
                 f"not {team_id}")
        return ev, False

    matches = [e for e in event_storage.list_team_events(team_id)
               if e.get("name", "").strip().lower() == event_name.strip().lower()]
    if len(matches) == 1:
        return matches[0], False
    if len(matches) > 1:
        print(f"ERROR: {len(matches)} existing events named '{event_name}' "
              f"for this team. Re-run with --event-id:", file=sys.stderr)
        for e in matches:
            print(f"    {e.get('id')}", file=sys.stderr)
        sys.exit(1)
    return None, True


def cmd_group(args):
    team = resolve_team(args.team)
    team_id = team["id"]
    event, will_create = _resolve_target_event(team_id, args.event, args.event_id)
    target_event_id = None if will_create else event["id"]

    # Validate games and detect conflicts.
    known = {m["game_id"]: m for m in team_game_metas(team_id)}
    problems = []
    conflicts = []
    for gid in args.games:
        if not game_storage.game_exists(gid):
            problems.append(f"game not found: {gid}")
            continue
        cur = game_storage.get_game_current(gid)
        if cur.get("teamId") != team_id:
            problems.append(
                f"game {gid} belongs to team {cur.get('teamId')}, not "
                f"{team_id} ({team.get('name')})")
            continue
        existing_ev = cur.get("eventId")
        if existing_ev and existing_ev != target_event_id:
            conflicts.append((gid, existing_ev))

    if problems:
        for p in problems:
            print(f"ERROR: {p}", file=sys.stderr)
        sys.exit(1)
    if conflicts and not args.force:
        print("ERROR: these games are already in a different event "
              "(use --force to move them):", file=sys.stderr)
        for gid, ev in conflicts:
            print(f"    {gid}  ->  {ev}", file=sys.stderr)
        sys.exit(1)

    # Print the plan.
    print(f"Team:  {team.get('name')}  ({team_id})")
    roster_ids = _default_roster_ids(team, args.games) if will_create else None
    if will_create:
        print(f"Event: '{args.event}'  (WILL BE CREATED, "
              f"roster seeded with {len(roster_ids)} player(s))")
    else:
        print(f"Event: '{event.get('name')}'  ({event['id']})  (existing)")
    if args.phase:
        print(f"Phase: {args.phase}")
    print(f"Games to add ({len(args.games)}):")
    for gid in args.games:
        note = ""
        for c_gid, c_ev in conflicts:
            if c_gid == gid:
                note = f"   (moving from {c_ev})"
        print(f"    {gid}{note}")

    if not args.yes:
        print("\nDry run — no changes written. Re-run with --yes to apply.")
        return

    # Apply.
    if will_create:
        new_event = {
            "name": args.event,
            "teamId": team_id,
            "status": "open",
            "phases": [args.phase] if args.phase else [],
            # Seed the roster so the in-game Lines table isn't blanked for
            # games in this event (see _default_roster_ids).
            "roster": {"playerIds": roster_ids, "pickupPlayers": []},
        }
        target_event_id = event_storage.save_event(new_event)
        print(f"\nCreated event: {target_event_id}")
    else:
        target_event_id = event["id"]
        if args.phase and args.phase not in event.get("phases", []):
            event.setdefault("phases", []).append(args.phase)
            event_storage.save_event(event, target_event_id)

    for gid in args.games:
        updates = {"eventId": target_event_id}
        if args.phase:
            updates["phase"] = args.phase
        game_storage.update_game_metadata(gid, updates)
        event_storage.add_game_to_event(target_event_id, gid)
        print(f"  linked {gid}")

    # Verify.
    final = event_storage.get_event(target_event_id)
    print(f"\nDone. Event '{final.get('name')}' ({target_event_id}) now has "
          f"{len(final.get('gameIds', []))} game(s):")
    for gid in final.get("gameIds", []):
        cur = game_storage.get_game_current(gid)
        print(f"    {gid}  eventId={cur.get('eventId')}  phase={cur.get('phase')}")


# ---------------------------------------------------------------------------
# unlink
# ---------------------------------------------------------------------------

def cmd_unlink(args):
    if not event_storage.event_exists(args.event):
        _die(f"event '{args.event}' not found")
    event = event_storage.get_event(args.event)
    current_ids = list(event.get("gameIds", []))

    if args.all:
        targets = current_ids
    elif args.games:
        targets = args.games
    else:
        _die("specify --games <id...> or --all")

    print(f"Event: '{event.get('name')}'  ({args.event})")
    print(f"Will unlink {len(targets)} game(s):")
    for gid in targets:
        print(f"    {gid}")
    if args.delete_event:
        print("Then DELETE the event.")

    if not args.yes:
        print("\nDry run — no changes written. Re-run with --yes to apply.")
        return

    for gid in targets:
        if game_storage.game_exists(gid):
            cur = game_storage.get_game_current(gid)
            if cur.get("eventId") == args.event:
                game_storage.update_game_metadata(gid, {"eventId": None, "phase": None})
        if gid in event.get("gameIds", []):
            event["gameIds"].remove(gid)
        print(f"  unlinked {gid}")

    if args.delete_event:
        event_storage.delete_event(args.event)
        print(f"\nDeleted event {args.event}.")
    else:
        event_storage.save_event(event, args.event)
        print(f"\nEvent now has {len(event.get('gameIds', []))} game(s).")


# ---------------------------------------------------------------------------
# cli
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Group existing games into a TournamentEvent.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"Data dir (ULTISTATS_DATA_DIR): {config.DATA_DIR}")
    sub = p.add_subparsers(dest="cmd", required=True)

    pt = sub.add_parser("teams", help="list teams")
    pt.add_argument("--filter", help="case-insensitive name substring")
    pt.set_defaults(func=cmd_teams)

    pg = sub.add_parser("games", help="list a team's games")
    pg.add_argument("--team", required=True, help="team name or id")
    pg.set_defaults(func=cmd_games)

    pe = sub.add_parser("events", help="list a team's events")
    pe.add_argument("--team", required=True, help="team name or id")
    pe.set_defaults(func=cmd_events)

    pgr = sub.add_parser("group", help="create/reuse an event and link games")
    pgr.add_argument("--team", required=True, help="team name or id")
    pgr.add_argument("--event", required=True, help="event name")
    pgr.add_argument("--event-id", help="reuse this exact event id")
    pgr.add_argument("--games", nargs="+", required=True, help="game ids to add")
    pgr.add_argument("--phase", help="optional phase label for these games")
    pgr.add_argument("--force", action="store_true",
                     help="move games already in a different event")
    pgr.add_argument("--yes", action="store_true", help="apply (not a dry run)")
    pgr.set_defaults(func=cmd_group)

    pu = sub.add_parser("unlink", help="remove games from an event / delete it")
    pu.add_argument("--event", required=True, help="event id")
    pu.add_argument("--games", nargs="+", help="game ids to unlink")
    pu.add_argument("--all", action="store_true", help="unlink all games")
    pu.add_argument("--delete-event", action="store_true",
                    help="delete the event after unlinking")
    pu.add_argument("--yes", action="store_true", help="apply (not a dry run)")
    pu.set_defaults(func=cmd_unlink)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
