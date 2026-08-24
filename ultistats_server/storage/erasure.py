"""
True erasure of players and teams.

Everything else in this package *unlinks* — ``delete_player`` removes one JSON
file and leaves the person's name in every game that ever referenced them.
This module removes the person.

THE TRAP THIS MODULE EXISTS FOR
-------------------------------
Breakside entity IDs embed the person's name: ``generate_entity_id`` builds
``{sanitized-name}-{4-char-hash}``, so ``Alice-7f3a`` *is* the name. Scrubbing
``name`` fields while leaving IDs in place erases nothing. Every reference —
ID and display name alike — has to be rewritten.

So each erasure mints an opaque **tombstone**: a fresh ID (``Removed-3f9a1c02``)
plus the display name ``Removed Player``. Game history keeps its shape — the
point still had seven players on the field, the assist still has a thrower —
but the row is no longer a person. The tombstone is **per erasure**, not one
global sentinel, so two erased players never merge into one row in historical
stats. It is *random*, deliberately not derived from the original ID: a
deterministic hash of a low-entropy ID like ``Alice-7f3a`` would let anyone
confirm a guessed name by hashing it, which is the leak we are closing.

``Unknown Player`` is NOT reused as the display name: that string already means
"nobody was credited with this throw" (narration/narrationEngine.js,
playByPlay/fullPbp.js). Erased and unattributed must stay distinguishable.

WHY THE VERSION BACKUPS DOMINATE THE DESIGN
-------------------------------------------
Every sync writes a full copy of the game document to ``games/<id>/versions/``.
Production holds thousands of them. Each one contains the roster snapshot and
the whole event log, so skipping them leaves the name in thousands of files and
the "erasure" is theatre. They are scrubbed with the same traversal as
``current.json``.

Finding which files are affected means looking inside every one of them, and
there is no cheaper oracle than the bytes. So the scan reads each file's raw
bytes and tests for the ID/name as a substring — a hit is the only thing that
pays for a ``json.loads``. It never misses: any file whose text contains the
needle is parsed and offered to the structural scrub, which then decides on
*fields*, not on substrings.

Measured on a corpus matching production shape (34 games, 6,800 version files,
370MB): a scan finding nothing takes ~1.5s against ~2.0s to parse everything,
so the parse saving is real but modest — the substantial win is that a
non-matching file is never re-serialized or rewritten, and that memory stays
flat because exactly one document is held at a time. Erasing a player who
appears in every file took ~14s end to end; the endpoints therefore run this
off the event loop (the server is single-worker).

Note ``atomic_write_json`` uses ``json.dump`` defaults, i.e.
``ensure_ascii=True``, so a name like ``José`` is stored as ``Jos\\u00e9``.
The prefilter therefore searches for both the raw UTF-8 form and the
JSON-escaped form (see ``_needles``); searching only the raw form would sail
straight past every non-ASCII name.

ORDER OF OPERATIONS (partial-failure behaviour is deliberate)
-------------------------------------------------------------
Game data is scrubbed FIRST and the player's own record is deleted LAST. If a
write fails partway through — the known way this happens here is a root-owned
directory, the 2026-07-03 incident — the player record still exists, so the
operation is *resumable*: re-running recovers the display name from that record
and finishes the job. Deleting the record first would strand any name-only
legacy reference with no way left to find it.

Before touching anything, the scan checks that every file it intends to rewrite
lives in a writable directory (atomic writes need write+exec on the *directory*,
not the file). If any doesn't, the whole erasure is refused with
``ErasureBlocked`` and nothing is mutated — same fail-fast posture as
``assert_data_dir_writable``.

IDEMPOTENCE
-----------
Re-running is a no-op returning zero counts, never an error. Nothing gates on
the player still existing; the operation is driven by the ID, and after a
successful run that ID appears nowhere.

OUT OF REACH
------------
Spreadsheet and JSON exports that have already been downloaded still contain
the original name. Breakside cannot reach them, and the privacy policy has to
say so.
"""
import json
import logging
import os
import re
import secrets
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import (
    event_storage, game_storage, index_storage, invite_storage,
    membership_storage, player_storage, share_storage, team_storage,
    tombstones,
)
from .file_utils import atomic_write_json

logger = logging.getLogger(__name__)

# Display name written over every erased player reference.
TOMBSTONE_NAME = "Removed Player"

# Tombstone IDs look like an entity ID (so anything validating IDs against
# ``^[A-Za-z0-9_-]+$`` keeps working) but carry no name.
TOMBSTONE_PREFIX = "Removed-"

# 8 hex chars, not the 4 the rest of the ID format uses. Ordinary IDs get 4
# because they are disambiguated by the name in front of them; a tombstone has
# no name, so 4 hex is the entire ID space. At 4 hex, ~100 erasures already
# carry a ~7% chance that two erased people collide onto one ID and merge into
# a single row in historical stats — the exact outcome the per-erasure
# tombstone exists to prevent. 8 hex makes that negligible and costs nothing.
_TOMBSTONE_HEX = 8

# Shape a caller-supplied tombstone must match. ``erase_player`` accepts one
# so a retry can finish under the tombstone the first attempt already wrote;
# validating it keeps that parameter from becoming a way to inject an
# arbitrary string into thousands of stored documents.
TOMBSTONE_RE = re.compile(r"^Removed-[0-9a-f]{4,16}$")

# --------------------------------------------------------------------------
# Player-reference field maps, verified against stored production documents
# and against the client serializer (store/storage.js: serializeEvent /
# serializeGame).
# --------------------------------------------------------------------------

# Play-by-play event fields: {field holding a player ID: field holding that
# same player's display NAME}. ``assist`` is in this list and is absent from
# the original spec table — it is a real Player reference on scoring throws
# (store/storage.js serializeEvent), so leaving it out would strand the name
# on every goal the player assisted.
_EVENT_ID_TO_NAME = {
    "throwerId": "thrower",
    "receiverId": "receiver",
    "defenderId": "defender",
    "pullerId": "puller",
    "assistId": "assist",
}

# Per-point lists of player references. Stored data uses IDs; the model
# comments and older data use display names, so both are matched.
# ``substitutedInPlayers`` is likewise absent from the spec table but is
# written by the same serializer as ``substitutedOutPlayers``.
_POINT_REF_LISTS = ("players", "substitutedOutPlayers", "substitutedInPlayers")

# pendingNextLine holds the *plan* for upcoming points, not history.
_PENDING_LINE_KEYS = ("oLine", "dLine", "odLine", "odOnDeckLine")

# Per-person attributes on a roster-snapshot entry, nulled on erasure. A
# tombstone keeps its ID and "Removed Player" and nothing else.
#
# The jersey number is the one that matters most and is the least obvious:
# "Removed Player, #7" re-identifies the person to anyone who knows the team,
# which is everyone the share link reached. Gender is a per-person attribute by
# the same argument, and there is no reason an erased entry keeps a position or
# a default-line preference. This costs real historical fidelity — after an
# erasure nobody can tell who wore #7 in that game — and that is the intended
# trade: the record must stop pointing at a person.
#
# ``None`` specifically, not ``""``. utils/helpers.js formatPlayerName tests
# ``number !== null && number !== undefined``, so a null number renders as just
# the name while an empty string would render "Removed Player ()". Every other
# consumer (viewer.js ``|| '-'``, the ``=== 'FMP'`` gender comparisons,
# formatPlayerNameWithRole's ``|| null``) already degrades correctly on null.
_ROSTER_PERSON_ATTRS = ("nickname", "number", "gender", "position", "defaultLine")

# A Pull event records the puller's gender inline, so nulling the roster
# entry's gender is not enough on its own — an erased player's pulls would
# still publish it. ``Gender.UNKNOWN`` is the model's own "we don't know"
# sentinel (store/models.js), and playByPlay/pullDialog.js already skips
# events carrying it when tracking alternating-gender pulls, so this degrades
# along a path the client already handles. (The public share projection
# strips pullerGender entirely — see routers/shares.py — so this closes the
# authenticated surfaces.)
_UNKNOWN_GENDER = "Unknown"


class ErasureBlocked(Exception):
    """Raised before any mutation when some target file cannot be rewritten.

    Carries the offending paths so the caller can report them. Refusing up
    front is the point: a half-scrubbed game history is worse than a refused
    erasure, because the caller believes the name is gone.
    """

    def __init__(self, paths: List[str]):
        self.paths = paths
        super().__init__(
            f"{len(paths)} file(s) are in unwritable directories; erasure refused "
            f"before making any change: {', '.join(paths[:5])}"
            + (" ..." if len(paths) > 5 else "")
        )


def mint_tombstone_id() -> str:
    """A fresh, name-free player ID that collides with nothing on disk."""
    for _ in range(20):
        candidate = f"{TOMBSTONE_PREFIX}{secrets.token_hex(_TOMBSTONE_HEX // 2)}"
        if not player_storage.player_exists(candidate):
            return candidate
    # 2^32 space; reaching here means something is very wrong. Widen rather
    # than return a known-colliding ID.
    return f"{TOMBSTONE_PREFIX}{secrets.token_hex(8)}"


def _needles(value: str) -> List[bytes]:
    """Byte forms ``value`` can take inside a stored JSON document.

    Both the raw UTF-8 bytes and the ``\\uXXXX``-escaped form that
    ``json.dump``'s default ``ensure_ascii=True`` produces. Only searching the
    raw form would miss every non-ASCII name.
    """
    raw = value.encode("utf-8")
    forms = [raw]
    escaped = json.dumps(value)[1:-1].encode("utf-8")
    if escaped != raw:
        forms.append(escaped)
    return forms


# ==========================================================================
# The scrub itself — pure functions over a parsed document.
# ==========================================================================

class PlayerScrubber:
    """Rewrites every reference to one player inside a game/team/event document.

    Pure: takes a parsed dict, mutates it, reports whether anything changed.
    Preview and execution run the *same* traversal — preview simply throws the
    mutated object away instead of writing it (see ``_scrub_file``), so a
    preview can never disagree with the erasure that follows it.

    Name matching is deliberately conservative. When a reference carries an ID
    field, the ID decides and the paired name is rewritten only if that ID
    matches; a teammate who happens to share a display name is untouched. Only
    when there is NO ID (legacy name-only data, which predates ID references)
    does the name alone decide. Those matches are counted in
    ``name_only_matches`` and surfaced as a warning, because that is precisely
    the case where two people called "Alex" are indistinguishable and privacy
    has to win over the small risk of over-scrubbing.
    """

    def __init__(self, player_id: str, player_name: Optional[str],
                 tombstone_id: str, tombstone_name: str = TOMBSTONE_NAME):
        self.player_id = player_id
        # Empty/None disables name matching entirely — matching "" would hit
        # every blank field in the corpus.
        self.player_name = player_name or None
        self.tombstone_id = tombstone_id
        self.tombstone_name = tombstone_name
        self.name_only_matches = 0

    # -- predicates --------------------------------------------------------

    def _is_id(self, value: Any) -> bool:
        return isinstance(value, str) and value == self.player_id

    def _is_name(self, value: Any) -> bool:
        return (
            self.player_name is not None
            and isinstance(value, str)
            and value == self.player_name
        )

    def needles(self) -> List[bytes]:
        """Byte needles for the cheap pre-parse file filter."""
        forms = _needles(self.player_id)
        if self.player_name:
            forms.extend(_needles(self.player_name))
        return forms

    # -- reference lists ---------------------------------------------------

    def _scrub_ref_list(self, container: dict, key: str, remove: bool = False) -> bool:
        """Rewrite a list of player references held at ``container[key]``.

        ``remove=True`` drops the entry instead of substituting the tombstone.
        Used for ``pendingNextLine``, which is a plan for an upcoming point
        rather than history: a tombstone there would leave the line-selection
        UI holding a reference it cannot resolve, whereas a shorter line is
        exactly what "this player is gone" means. Point history keeps the
        tombstone so the point still shows the right number of players.
        """
        values = container.get(key)
        if not isinstance(values, list):
            return False

        changed = False
        out: List[Any] = []
        for value in values:
            if self._is_id(value):
                changed = True
                if not remove:
                    out.append(self.tombstone_id)
                continue
            if self._is_name(value):
                changed = True
                self.name_only_matches += 1
                if not remove:
                    out.append(self.tombstone_name)
                continue
            out.append(value)

        if changed:
            container[key] = out
        return changed

    def _drop_from_id_list(self, container: dict, key: str) -> bool:
        """Remove the player from a roster ID list (team/event rosters).

        Rosters are membership, not history: an erased player is not on the
        roster at all, so no tombstone is left behind.
        """
        values = container.get(key)
        if not isinstance(values, list):
            return False
        kept = [v for v in values if not (self._is_id(v) or self._is_name(v))]
        if len(kept) == len(values):
            return False
        self.name_only_matches += sum(
            1 for v in values if self._is_name(v) and not self._is_id(v)
        )
        container[key] = kept
        return True

    # -- game documents ----------------------------------------------------

    def scrub_event(self, event: dict) -> bool:
        changed = False
        for id_field, name_field in _EVENT_ID_TO_NAME.items():
            stored_id = event.get(id_field)
            if stored_id:
                if stored_id == self.player_id:
                    event[id_field] = self.tombstone_id
                    if name_field in event:
                        event[name_field] = self.tombstone_name
                    self._scrub_event_attrs(event, name_field)
                    changed = True
                # A present, non-matching ID settles it: the name belongs to
                # somebody else, even if the string is identical.
                continue
            if self._is_name(event.get(name_field)):
                event[name_field] = self.tombstone_name
                self._scrub_event_attrs(event, name_field)
                self.name_only_matches += 1
                changed = True
        return changed

    @staticmethod
    def _scrub_event_attrs(event: dict, name_field: str) -> None:
        """Clear per-person attributes an event records inline about the player.

        Only ``pullerGender`` today. Nulling the roster snapshot's gender is
        not enough on its own: a Pull event carries the puller's gender in the
        event itself, so an erased player's pulls would still publish it.
        """
        if name_field == "puller" and "pullerGender" in event:
            event["pullerGender"] = _UNKNOWN_GENDER

    def scrub_point(self, point: dict) -> bool:
        changed = False
        for key in _POINT_REF_LISTS:
            changed |= self._scrub_ref_list(point, key)
        for possession in point.get("possessions") or []:
            if not isinstance(possession, dict):
                continue
            for event in possession.get("events") or []:
                if isinstance(event, dict):
                    changed |= self.scrub_event(event)
        return changed

    def scrub_roster_snapshot(self, snapshot: dict) -> bool:
        changed = False
        for player in snapshot.get("players") or []:
            if not isinstance(player, dict):
                continue
            matched_by_id = self._is_id(player.get("id"))
            matched_by_name = (
                not player.get("id") and self._is_name(player.get("name"))
            )
            if not (matched_by_id or matched_by_name):
                continue
            if matched_by_name:
                self.name_only_matches += 1
            if "id" in player:
                player["id"] = self.tombstone_id
            player["name"] = self.tombstone_name
            for attribute in _ROSTER_PERSON_ATTRS:
                if attribute in player:
                    player[attribute] = None
            changed = True
        return changed

    def scrub_game(self, game: dict) -> bool:
        """Rewrite every player reference in one game document."""
        if not isinstance(game, dict):
            return False

        changed = False

        snapshot = game.get("rosterSnapshot")
        if isinstance(snapshot, dict):
            changed |= self.scrub_roster_snapshot(snapshot)

        for point in game.get("points") or []:
            if isinstance(point, dict):
                changed |= self.scrub_point(point)

        pending = game.get("pendingNextLine")
        if isinstance(pending, dict):
            for key in _PENDING_LINE_KEYS:
                changed |= self._scrub_ref_list(pending, key, remove=True)

        return changed

    # -- team documents ----------------------------------------------------

    def scrub_team(self, team: dict) -> bool:
        """Drop the player from a team's roster, its lines, and legacy blobs."""
        if not isinstance(team, dict):
            return False

        changed = self._drop_from_id_list(team, "playerIds")

        for line in team.get("lines") or []:
            if isinstance(line, dict):
                changed |= self._drop_from_id_list(line, "players")

        # Legacy embedded shapes. The server stores whatever the client posts
        # and ``serializeTeam`` still emits ``teamRoster`` (full player objects)
        # and ``games`` (full game documents). Current production team files
        # carry neither, but a stale client could put a name here, and a name
        # that survives in one file is a failed erasure.
        roster = team.get("teamRoster")
        if isinstance(roster, list):
            kept = [
                p for p in roster
                if not (isinstance(p, dict)
                        and (self._is_id(p.get("id")) or self._is_name(p.get("name"))))
            ]
            if len(kept) != len(roster):
                team["teamRoster"] = kept
                changed = True

        for game in team.get("games") or []:
            changed |= self.scrub_game(game)

        return changed

    # -- tournament events -------------------------------------------------

    def scrub_tournament_event(self, event: dict) -> bool:
        """Drop the player from a tournament event's roster."""
        if not isinstance(event, dict):
            return False

        roster = event.get("roster")
        if not isinstance(roster, dict):
            return False

        changed = self._drop_from_id_list(roster, "playerIds")

        # Pickup players are inline records (id/name/gender/number) that never
        # reach players/, but their IDs embed a name just the same.
        pickups = roster.get("pickupPlayers")
        if isinstance(pickups, list):
            kept = [
                p for p in pickups
                if not (isinstance(p, dict)
                        and (self._is_id(p.get("id")) or self._is_name(p.get("name"))))
            ]
            if len(kept) != len(pickups):
                roster["pickupPlayers"] = kept
                changed = True

        return changed


# ==========================================================================
# File-level plumbing
# ==========================================================================

def _writable_dir(path: Path) -> bool:
    """Can ``atomic_write_json`` replace this file?

    Atomic writes create a temp file next to the target and ``os.replace`` it,
    so what matters is write+exec on the containing directory, not permission
    on the file itself.
    """
    return os.access(str(path.parent), os.W_OK | os.X_OK)


def _scrub_file(path: Path, scrubber: PlayerScrubber, kind: str,
                dry_run: bool) -> bool:
    """Load, scrub, and (unless dry_run) rewrite one JSON document.

    Returns True if the document contained a reference to the player. The
    traversal is identical in both modes; ``dry_run`` only skips the write.
    """
    try:
        with open(path, "r") as handle:
            document = json.load(handle)
    except (json.JSONDecodeError, OSError):
        # A corrupt or unreadable file cannot be scrubbed, but it also cannot
        # be read by anything else, so it is not a live disclosure. Log and
        # move on rather than aborting a privacy operation over one bad file.
        logger.warning("ERASURE: could not parse %s; skipped", path)
        return False

    if kind == "game":
        changed = scrubber.scrub_game(document)
    elif kind == "team":
        changed = scrubber.scrub_team(document)
    elif kind == "event":
        changed = scrubber.scrub_tournament_event(document)
    else:  # pragma: no cover - programming error
        raise ValueError(f"unknown document kind: {kind}")

    if changed and not dry_run:
        atomic_write_json(path, document)
    return changed


def _iter_candidate_files(needles: List[bytes]) -> Iterable[Tuple[Path, str]]:
    """Yield (path, kind) for every stored document that mentions the player.

    Raw-bytes containment, not parsing: reading is unavoidable (nothing else
    knows what is inside a version backup) but parsing thousands of full game
    documents is not. A false positive here costs one wasted parse and zero
    mutations, because the structural scrub decides on fields.

    Directories are read from the storage modules at call time, never captured
    at import, so the per-module ``*_DIR`` patching the test suite relies on
    keeps working.
    """
    def mentions(path: Path) -> bool:
        try:
            blob = path.read_bytes()
        except OSError:
            return False
        return any(needle in blob for needle in needles)

    games_dir = Path(game_storage.GAMES_DIR)
    if games_dir.exists():
        for game_dir in sorted(games_dir.iterdir()):
            if not game_dir.is_dir():
                continue
            current = game_dir / "current.json"
            if current.exists() and mentions(current):
                yield current, "game"
            versions = game_dir / "versions"
            if versions.is_dir():
                for version_file in sorted(versions.glob("*.json")):
                    if mentions(version_file):
                        yield version_file, "game"

    teams_dir = Path(team_storage.TEAMS_DIR)
    if teams_dir.exists():
        for team_file in sorted(teams_dir.glob("*.json")):
            if not team_file.name.startswith("_") and mentions(team_file):
                yield team_file, "team"

    events_dir = Path(event_storage.EVENTS_DIR)
    if events_dir.exists():
        for event_file in sorted(events_dir.glob("*.json")):
            if not event_file.name.startswith("_") and mentions(event_file):
                yield event_file, "event"


# ==========================================================================
# Write-path guards — what stops a stale client from undoing an erasure.
#
# Breakside's sync queue re-POSTs whole entities, so a device that has not
# synced since an erasure will happily push back the player record, the roster
# that lists them, and a game whose event log names them. These run on the
# INBOUND body, before it is stored. See storage/tombstones.py.
# ==========================================================================

def _collect_player_refs(game: dict) -> Tuple[set, set]:
    """Every string in a game document that could name a player: (ids, names).

    Deliberately over-collects. A value is only a candidate for a deny-list
    lookup; it is the structural scrub that decides what actually gets
    rewritten, so a wrong guess here costs one hash and nothing else.
    """
    ids, names = set(), set()
    if not isinstance(game, dict):
        return ids, names

    snapshot = game.get("rosterSnapshot")
    if isinstance(snapshot, dict):
        for player in snapshot.get("players") or []:
            if isinstance(player, dict):
                if isinstance(player.get("id"), str):
                    ids.add(player["id"])
                if isinstance(player.get("name"), str):
                    names.add(player["name"])

    for point in game.get("points") or []:
        if not isinstance(point, dict):
            continue
        for key in _POINT_REF_LISTS:
            for value in point.get(key) or []:
                if isinstance(value, str):
                    # These lists hold IDs in current data and display names in
                    # older data, so every entry is both candidates.
                    ids.add(value)
                    names.add(value)
        for possession in point.get("possessions") or []:
            if not isinstance(possession, dict):
                continue
            for event in possession.get("events") or []:
                if not isinstance(event, dict):
                    continue
                for id_field, name_field in _EVENT_ID_TO_NAME.items():
                    if isinstance(event.get(id_field), str):
                        ids.add(event[id_field])
                    if isinstance(event.get(name_field), str):
                        names.add(event[name_field])

    pending = game.get("pendingNextLine")
    if isinstance(pending, dict):
        for key in _PENDING_LINE_KEYS:
            for value in pending.get(key) or []:
                if isinstance(value, str):
                    ids.add(value)
                    names.add(value)

    return ids, names


def _scrubbers_for(hits: Dict[str, str]) -> List[PlayerScrubber]:
    """One scrubber per erased reference found in an inbound body.

    Each hit string is passed as BOTH the ID and the name: the same value can
    appear as an ID in ``throwerId`` and as a display name in ``thrower``, and
    the scrubber's own field rules decide which role applies where. An ID can
    never be mistaken for a name in practice — IDs always carry a ``-hash``
    suffix.
    """
    return [
        PlayerScrubber(value, value, tombstone)
        for value, tombstone in hits.items()
        if tombstone
    ]


def scrub_erased_from_game(game_data: dict) -> int:
    """Rewrite references to already-erased players in an INBOUND game sync.

    Mutates ``game_data`` in place and returns how many erased people were
    found. Returns 0 immediately when nothing has ever been erased, so the
    normal sync path pays one small file read.

    Without this, ``POST /api/games/{id}/sync`` from a phone holding a cached
    copy of the game silently reinstates the name in the event log and the
    roster snapshot — and, because every sync writes a version backup, in a
    fresh permanent file too.
    """
    if not isinstance(game_data, dict) or not tombstones.any_erased_players():
        return 0

    ids, names = _collect_player_refs(game_data)
    hits = tombstones.lookup(ids, names)
    if not hits:
        return 0

    for scrubber in _scrubbers_for(hits):
        scrubber.scrub_game(game_data)

    logger.warning(
        "ERASURE GUARD: an inbound game sync carried %d erased player "
        "reference(s); they were scrubbed before storage. A client still "
        "holds pre-erasure data.", len(hits),
    )
    return len(hits)


def strip_erased_from_team(team_data: dict) -> int:
    """Remove already-erased players from an INBOUND team document.

    Mutates ``team_data`` in place and returns how many were removed. The rest
    of the update is legitimate — a coach editing a roster on a stale device is
    doing normal work — so the team write proceeds; only the erased entries are
    dropped from ``playerIds`` and ``lines[].players``.
    """
    if not isinstance(team_data, dict) or not tombstones.any_erased_players():
        return 0

    candidates = set()
    for value in team_data.get("playerIds") or []:
        if isinstance(value, str):
            candidates.add(value)
    for line in team_data.get("lines") or []:
        if isinstance(line, dict):
            for value in line.get("players") or []:
                if isinstance(value, str):
                    candidates.add(value)
    for player in team_data.get("teamRoster") or []:
        if isinstance(player, dict):
            for key in ("id", "name"):
                if isinstance(player.get(key), str):
                    candidates.add(player[key])

    hits = tombstones.lookup(candidates, candidates)
    if not hits:
        return 0

    for scrubber in _scrubbers_for(hits):
        scrubber.scrub_team(team_data)

    logger.warning(
        "ERASURE GUARD: an inbound team write carried %d erased player "
        "reference(s); they were stripped before storage.", len(hits),
    )
    return len(hits)


def _empty_counts() -> Dict[str, int]:
    return {
        "players": 0,
        "teams": 0,
        "rosters": 0,
        "games": 0,
        "versions": 0,
        "events": 0,
        "memberships": 0,
        "shares": 0,
        "invites": 0,
    }


# ==========================================================================
# Player erasure
# ==========================================================================

def erase_player(player_id: str, *, dry_run: bool = False,
                 tombstone_id: Optional[str] = None) -> Dict[str, Any]:
    """Erase one player everywhere, or report what erasing them would touch.

    Deletes the player record and rewrites every reference to them — in team
    rosters and lines, in tournament-event rosters, in each game's
    ``current.json`` and in **every file under its ``versions/``** — to an
    opaque tombstone.

    Args:
        player_id: The player to erase.
        dry_run: Run the identical traversal and return counts without writing
            anything. This is what the preview endpoint calls.
        tombstone_id: Reuse a specific tombstone instead of minting one. Not
            exposed over HTTP; it exists so a retry after a partial failure can
            finish the job under the tombstone the first attempt already wrote.

    Returns:
        ``{"playerId", "tombstoneId", "dryRun", "counts", "warnings"}``.
        ``counts`` uses the shared preview shape; for a player erasure
        ``games`` counts games *scrubbed* (not deleted), ``rosters`` counts
        team documents edited, and teams/memberships/shares/invites are always
        zero.

    Raises:
        ErasureBlocked: Some target file sits in an unwritable directory.
            Raised before any mutation; nothing has been changed.
    """
    # The name comes from the player record. On a retry after a partial
    # failure the record is still there (it is deleted last, deliberately), so
    # name-only legacy references remain reachable. Once the record is gone the
    # erasure is ID-driven, which is exactly right: after a clean run the ID
    # appears nowhere and the re-run finds nothing.
    if tombstone_id is not None and not TOMBSTONE_RE.match(tombstone_id):
        raise ValueError(f"Invalid tombstone id: {tombstone_id!r}")

    stored = None
    if player_storage.player_exists(player_id):
        try:
            stored = player_storage.get_player(player_id)
        except (FileNotFoundError, ValueError):
            stored = None

    player_name = (stored or {}).get("name")
    # A retry reuses the tombstone the first attempt already wrote into the
    # documents it reached, so a partially-failed erasure doesn't split one
    # person across two tombstone rows in historical stats. The deny-list is
    # where that mapping lives (keyed by a hash of the ID, never the ID).
    tombstone = (
        tombstone_id
        or tombstones.player_tombstone(player_id)
        or mint_tombstone_id()
    )
    scrubber = PlayerScrubber(player_id, player_name, tombstone)

    counts = _empty_counts()
    warnings: List[str] = []

    targets = list(_iter_candidate_files(scrubber.needles()))

    # Fail before destroying anything: a refused erasure is recoverable, a
    # half-scrubbed history that the caller believes is clean is not.
    if not dry_run:
        blocked = [str(p) for p, _ in targets if not _writable_dir(p)]
        if stored is not None:
            player_file = Path(player_storage.PLAYERS_DIR) / f"{player_id}.json"
            if player_file.exists() and not _writable_dir(player_file):
                blocked.append(str(player_file))
        if blocked:
            raise ErasureBlocked(blocked)

    for path, kind in targets:
        if not _scrub_file(path, scrubber, kind, dry_run):
            continue
        if kind == "game":
            if path.name == "current.json":
                counts["games"] += 1
            else:
                counts["versions"] += 1
        elif kind == "team":
            counts["rosters"] += 1
        elif kind == "event":
            counts["events"] += 1

    # Record the erasure BEFORE deleting the record. An offline client that
    # reconnects mid-operation would otherwise be able to re-POST the player
    # and undo everything above (see storage/tombstones.py).
    if not dry_run:
        tombstones.record_player_erasure(player_id, tombstone, player_name)

    # Index buckets. Done after the documents so that a rebuild would produce
    # exactly this state: the tombstone now appears in the scrubbed games, so
    # it takes the player's place in gameRoster/playerGames, while playerTeams
    # simply loses the entry (the tombstone is on no roster).
    if not dry_run:
        index_storage.replace_player_in_index(player_id, tombstone)

    # The record itself, last.
    if stored is not None:
        counts["players"] = 1
        if not dry_run:
            player_storage.delete_player(player_id)

    if scrubber.name_only_matches:
        warnings.append(
            f"{scrubber.name_only_matches} legacy reference(s) carry a name but no "
            f"player ID and were matched by name alone; a teammate with the same "
            f"display name would also be affected."
        )
    if counts["versions"]:
        warnings.append(
            f"{counts['versions']} version backup(s) will be rewritten in place; "
            f"the pre-erasure snapshots are not recoverable."
        )
    warnings.append(
        "Erasure is irreversible. Spreadsheet and JSON exports already downloaded "
        "still contain the original name and cannot be reached."
    )

    return {
        "playerId": player_id,
        "tombstoneId": tombstone,
        "dryRun": dry_run,
        "counts": counts,
        "warnings": warnings,
    }


# ==========================================================================
# Team erasure
# ==========================================================================

def _team_game_ids(team_id: str) -> List[str]:
    """Game IDs belonging to ``team_id``, read from disk rather than the index.

    ``teamGames`` is a cache and this codebase has already been burned by
    trusting it (see ``get_player_teams_verified``): an index that had not been
    rebuilt in eight months was found in production. A missed game here would
    survive the erasure of its team with its full roster snapshot intact.
    """
    found = []
    for game in game_storage.list_all_games():
        if game.get("teamId") == team_id:
            found.append(game["game_id"])
    return sorted(found)


def _count_versions(game_id: str) -> int:
    versions = Path(game_storage.GAMES_DIR) / game_id / "versions"
    if not versions.is_dir():
        return 0
    return sum(1 for _ in versions.glob("*.json"))


def erase_team(team_id: str, *, dry_run: bool = False,
               erase_orphaned_players: bool = False) -> Dict[str, Any]:
    """Erase a team and everything that only existed because of it.

    Cascade: every game whose ``teamId`` is this team (whole directory,
    ``versions/`` included), the shares pointing at those games, the team's
    invites, its tournament events, its memberships, and finally the team
    record and its index entries.

    Players are NOT erased by default. A player on this team *and* another team
    must survive, and a player on only this team is a person, not a side
    effect — the count is reported so the caller can decide.

    Args:
        team_id: The team to erase.
        dry_run: Identical traversal, no writes. What the preview calls.
        erase_orphaned_players: Also erase players left on no other team. The
            caller has to ask for this explicitly.

    Returns:
        ``{"teamId", "dryRun", "counts", "orphanedPlayerIds", "warnings"}``.
        Here ``games`` counts games *deleted* and ``versions`` the backups
        destroyed with them.
    """
    counts = _empty_counts()
    warnings: List[str] = []

    exists = team_storage.team_exists(team_id)
    team = team_storage.get_team(team_id) if exists else {}

    game_ids = _team_game_ids(team_id)
    counts["games"] = len(game_ids)
    counts["versions"] = sum(_count_versions(gid) for gid in game_ids)

    # Shares are found two ways: by game (the index) and by the denormalized
    # teamId on the share itself, which catches shares whose game has already
    # gone missing.
    share_ids = set()
    listed_public = 0
    for game_id in game_ids:
        for share in share_storage.list_game_shares(game_id):
            share_ids.add(share["id"])
            if share.get("listed"):
                listed_public += 1
    for share in share_storage.list_all_shares():
        if share.get("teamId") == team_id:
            share_ids.add(share["id"])
    counts["shares"] = len(share_ids)

    invites = invite_storage.list_team_invites(team_id)
    counts["invites"] = len(invites)

    memberships = membership_storage.get_team_memberships(team_id)
    counts["memberships"] = len(memberships)

    # Tournament events belong to exactly one team. The spec's cascade omits
    # them, but leaving them behind orphans a document whose ``teamId`` points
    # at nothing and whose roster is a list of this team's player IDs — i.e.
    # names, in a file nothing can now reach through the UI.
    events = event_storage.list_team_events(team_id)
    counts["events"] = len(events)

    counts["teams"] = 1 if exists else 0

    # Orphans: on this roster and no other.
    orphans: List[str] = []
    for player_id in team.get("playerIds") or []:
        others = [
            t for t in index_storage.get_player_teams_verified(player_id)
            if t != team_id
        ]
        if not others:
            orphans.append(player_id)

    if listed_public:
        warnings.append(f"{listed_public} game(s) are shared publicly")
    if orphans and not erase_orphaned_players:
        warnings.append(
            f"orphans {len(orphans)} player(s) — they are on no other team and "
            f"their records will remain until erased individually"
        )
    warnings.append(
        "Erasure is irreversible. Spreadsheet and JSON exports already downloaded "
        "are not affected and cannot be reached."
    )

    if dry_run:
        # Count the orphans only when the caller says they intend to erase
        # them, so the preview describes the operation that is actually about
        # to run rather than a different one.
        if erase_orphaned_players:
            counts["players"] = len(orphans)
        return {
            "teamId": team_id,
            "dryRun": True,
            "counts": counts,
            "orphanedPlayerIds": orphans,
            "warnings": warnings,
        }

    # --- destructive from here -------------------------------------------
    for game_id in game_ids:
        game_storage.delete_game(game_id)
    for share_id in share_ids:
        share_storage.delete_share(share_id)
    for invite in invites:
        invite_storage.delete_invite(invite["id"])
    for event in events:
        event_storage.delete_event(event["id"])

    # Orphaned players before the memberships go, so erase_player's scan runs
    # while the data dir is otherwise settled. Their games are already gone, so
    # this reduces to deleting each record and its index rows.
    if erase_orphaned_players:
        for player_id in orphans:
            erase_player(player_id)
        counts["players"] = len(orphans)

    for membership in memberships:
        membership_storage.delete_membership(membership["id"])

    # Before the record goes, so a client reconnecting mid-cascade cannot
    # re-POST the team and undo it.
    tombstones.record_team_erasure(team_id)

    if exists:
        team_storage.delete_team(team_id)

    index_storage.remove_team_from_index(team_id, game_ids)

    return {
        "teamId": team_id,
        "dryRun": False,
        "counts": counts,
        "orphanedPlayerIds": [] if erase_orphaned_players else orphans,
        "warnings": warnings,
    }
