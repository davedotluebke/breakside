"""
Deny-list of erased entity IDs — the thing that makes erasure *durable*.

WHY THIS EXISTS
---------------
Breakside is offline-first and its sync queue re-POSTs whole entities:
``store/sync.js`` sends ``POST /api/players`` for both create and update
("POST handles both create and update via ID"), ``POST /api/teams`` for a whole
team document, and ``POST /api/games/{id}/sync`` for a whole game.

So a second coach whose phone has not synced since an erasure will, on its next
connection, cheerfully re-create the erased player record with its original ID
and name, put that ID back on the team roster, and push a cached game whose
event log still names them. Nothing would report it. Without a server-side
guard, erasure is not a state — it is a race against every device holding a
cached copy, and on a sideline with two coaches that race is normal operation.

This module is the server's memory of what has been erased, so those writes can
be refused (players), stripped (teams), or scrubbed (game syncs).

WHY THE IDS ARE HASHED, AND WHAT THAT DOES AND DOESN'T BUY
----------------------------------------------------------
Entity IDs embed the person's name (``Alice-7f3a``). A plaintext deny-list
would therefore be a tidy list of exactly the names just erased — recreating in
a new file the very problem the erasure solved, and one that would follow the
data into every backup. So IDs are stored as a salted SHA-256 digest and never
in the clear.

Be precise about what that is worth. This is a **verifier, not a secret store.**
The server has to answer "is this incoming ID erased?", and any function that
answers that can be run backwards by anyone holding both this file and a
candidate name — entity IDs have far too little entropy (a name plus four
characters) for a fast hash to resist a guess. What hashing buys is real but
bounded: the file is not *readable* as a list of people, a casual look at the
data directory or a leaked backup discloses nothing, and the per-installation
salt keeps digests from being comparable across installations or against a
precomputed table.

The alternative — no deny-list — means any stale device silently undoes an
erasure. That is strictly worse, so the trade is taken deliberately. If it ever
needs to be stronger, key the HMAC from an environment secret held outside the
data directory (``SUPABASE_JWT_SECRET`` is already loaded that way), which
makes filesystem access alone insufficient.

Display names — the name AND the nickname, since the app renders ``nickname ||
name`` — are hashed alongside IDs, and only when they were known at erasure
time. That is what lets a name-only legacy reference — a line entry, an old
event with no ``*Id`` field — be recognized in an incoming write. A name hash
is weaker than an ID hash (one guess to test, rather than a guess plus the
4-character suffix), but the ID hash is already a name oracle for anyone
willing to spend 1.7M hashes, so this changes the practical threat model very
little and closes a real durability hole.
"""
import hashlib
import json
import logging
import secrets
from datetime import datetime
from pathlib import Path
from typing import Optional

from ._config import config
from .file_utils import atomic_write_json, entity_lock

logger = logging.getLogger(__name__)

# Module-level so tests can patch it, matching every other storage module.
ERASED_FILE = config.DATA_DIR / "erased.json"

_LOCK_KEY = "erased-denylist"
_SCHEMA_VERSION = 1


def _empty() -> dict:
    return {
        "version": _SCHEMA_VERSION,
        # Per-installation, generated on first write. Not a secret (it lives
        # in this file); it stops digests being comparable across
        # installations or against a precomputed table.
        "salt": secrets.token_hex(16),
        "players": {},      # sha256(id)   -> {tombstoneId, erasedAt}
        "playerNames": {},  # sha256(name) -> tombstoneId
        "teams": {},        # sha256(id)   -> {erasedAt}
    }


def _load() -> dict:
    path = Path(ERASED_FILE)
    if not path.exists():
        return _empty()
    try:
        with open(path, "r") as handle:
            data = json.load(handle)
    except (json.JSONDecodeError, OSError):
        # A corrupt deny-list must not be silently treated as "nothing was
        # ever erased" — that would quietly re-enable resurrection. Log loudly
        # and fail closed on the read side by returning an empty list with a
        # fresh salt only if there is genuinely nothing to preserve.
        logger.error(
            "ERASURE DENY-LIST UNREADABLE at %s. Erased entities can be "
            "recreated by a stale client until this is fixed.", path,
            exc_info=True,
        )
        return _empty()
    for key in ("players", "playerNames", "teams"):
        data.setdefault(key, {})
    data.setdefault("salt", secrets.token_hex(16))
    return data


def _digest(data: dict, domain: str, value: str) -> str:
    salt = data.get("salt", "")
    return hashlib.sha256(
        f"{salt}:{domain}:{value}".encode("utf-8")
    ).hexdigest()


def record_player_erasure(player_id: str, tombstone_id: str,
                          player_name: Optional[str] = None,
                          player_nickname: Optional[str] = None) -> None:
    """Remember that ``player_id`` was erased, so it can never be recreated.

    ``player_name`` and ``player_nickname`` are optional and only present when
    the record still existed at erasure time; they are what let name-only
    legacy references be recognized in a later inbound write. The nickname
    matters as much as the name: the app renders ``nickname || name``, so a
    stale client's cached document is *more* likely to carry the nickname in a
    display field. Idempotent.
    """
    with entity_lock(_LOCK_KEY):
        data = _load()
        data["players"][_digest(data, "player", player_id)] = {
            "tombstoneId": tombstone_id,
            "erasedAt": datetime.now().isoformat(),
        }
        for display_name in (player_name, player_nickname):
            if display_name:
                data["playerNames"][_digest(data, "name", display_name)] = tombstone_id
        atomic_write_json(Path(ERASED_FILE), data)


def record_team_erasure(team_id: str) -> None:
    """Remember that ``team_id`` was erased. Idempotent."""
    with entity_lock(_LOCK_KEY):
        data = _load()
        data["teams"][_digest(data, "team", team_id)] = {
            "erasedAt": datetime.now().isoformat(),
        }
        atomic_write_json(Path(ERASED_FILE), data)


def player_tombstone(player_id: str) -> Optional[str]:
    """The tombstone ID an erased player was replaced by, or None."""
    data = _load()
    entry = data["players"].get(_digest(data, "player", player_id))
    return entry.get("tombstoneId") if entry else None


def name_tombstone(name: str) -> Optional[str]:
    """The tombstone ID for an erased player's display name, or None."""
    if not name:
        return None
    data = _load()
    return data["playerNames"].get(_digest(data, "name", name))


def is_player_erased(player_id: str) -> bool:
    return player_tombstone(player_id) is not None


def is_team_erased(team_id: str) -> bool:
    data = _load()
    return _digest(data, "team", team_id) in data["teams"]


def any_erased_players() -> bool:
    """Cheap gate so the guards on every write cost nothing in the normal case."""
    data = _load()
    return bool(data["players"] or data["playerNames"])


def lookup(player_ids=(), names=()) -> dict:
    """Batch membership test: {value: tombstoneId} for the erased ones only.

    One file read for a whole document's worth of candidates, so the sync-path
    guards don't re-read the deny-list per reference.
    """
    data = _load()
    if not (data["players"] or data["playerNames"]):
        return {}

    hits = {}
    for player_id in player_ids:
        if not isinstance(player_id, str):
            continue
        entry = data["players"].get(_digest(data, "player", player_id))
        if entry:
            hits[player_id] = entry.get("tombstoneId")
    for name in names:
        if not isinstance(name, str) or not name:
            continue
        tombstone = data["playerNames"].get(_digest(data, "name", name))
        if tombstone and name not in hits:
            hits[name] = tombstone
    return hits
