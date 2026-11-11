"""
Persistence for team mailing lists (Comms Phase 0). See TODO.Comms.md.

Layout under ``data/mail/``:

    _slugs.json                     slug ↔ teamId, plus every event address (global; routes inbound mail)
    {teamId}/directory.json         slug, display name, per-list settings, contacts, event lists
    {teamId}/log/{YYYY-MM}.jsonl    one line per relayed / quarantined / bounced message
    {teamId}/delivery/{YYYY-MM}.jsonl  per-recipient delivery facts for each send (kept ~3 months)
    {teamId}/quarantine/{id}.json   held message metadata …
    {teamId}/quarantine/{id}.eml    … and its raw MIME

Everything here is coach-only data (parent and player email addresses), which
is why it lives beside the other private entity stores rather than on the
public team document that every viewer syncs. Coaches themselves are never
stored as contacts: they are derived live from team memberships by
mail/directory.py, so the coaches list can never go stale.

**Event lists** (``<slug>-<event>@``) live on the directory as ``events``:
each carries its own settings, the roster players going (``playerIds``) and
its own ``contacts`` — pickup players and their guardians, who exist only
for that event and never receive the team's other mail. Their address
local parts are registered in the slug index so inbound routing can match
them exactly without opening every directory.

Address rules (what a slug or alias may look like) live in mail/addresses.py;
this module only enforces uniqueness and shape.
"""
import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ._config import config
from .file_utils import atomic_write_json, entity_lock
from .json_index import JsonIndex

try:
    from mail import addresses as _addresses
except ImportError:  # package mode
    from breakside_server.mail import addresses as _addresses

MAIL_DIR = config.MAIL_DIR

CONTACT_KINDS = ("guardian", "player", "manager", "other")
CONTACT_STATUSES = ("active", "paused", "alumni")
LIST_KINDS = ("all", "parents", "coaches", "staff", "players", "player")
POSTER_KINDS = ("coach", "manager", "guardian", "player", "other")
REPLY_TO_MODES = ("author", "list", "coaches")

# Editable per-contact fields. ``emails`` accepts a list or a string of
# comma/semicolon/space-separated addresses; ``email`` (single) is accepted
# as an alias for it and is always stored as the first address, so anything
# reading the old shape keeps working. ``bounces`` (per address) may only be
# cleared (set to None) through the API; the inbound path is what sets it.
CONTACT_FIELDS = ("kind", "name", "email", "emails", "playerIds", "alias", "status", "optOut", "notes")
LIST_FIELDS = ("enabled", "postPolicy", "subjectTag", "replyTo")
EVENT_FIELDS = ("slug", "name", "eventId", "playerIds") + LIST_FIELDS
EVENT_CONTACT_KINDS = ("player", "guardian")

QUARANTINE_TTL_DAYS = 14

_slugs = JsonIndex(
    path_getter=lambda: Path(MAIL_DIR) / "_slugs.json",
    lock_key="mail-slugs",
    empty=lambda: {"bySlug": {}, "byTeam": {}, "events": {}},
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _team_dir(team_id: str) -> Path:
    return Path(MAIL_DIR) / team_id


def _directory_file(team_id: str) -> Path:
    return _team_dir(team_id) / "directory.json"


def _log_dir(team_id: str) -> Path:
    return _team_dir(team_id) / "log"


def _quarantine_dir(team_id: str) -> Path:
    return _team_dir(team_id) / "quarantine"


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


# ==========================================================================
# Slug index
# ==========================================================================

def list_mail_slugs() -> Dict[str, str]:
    """``{slug: teamId}`` for every team with mail configured."""
    return dict(_slugs.load().get("bySlug", {}))


def resolve_mail_slug(slug: str) -> Optional[str]:
    return _slugs.load().get("bySlug", {}).get(slug)


def get_mail_slug_for_team(team_id: str) -> Optional[str]:
    return _slugs.load().get("byTeam", {}).get(team_id)


def _claim_slug(index: Dict[str, Any], slug: str, team_id: str) -> None:
    """Point ``slug`` at ``team_id`` inside an open index update, releasing
    whatever slug the team held before. Raises ValueError if taken."""
    owner = index["bySlug"].get(slug)
    if owner and owner != team_id:
        raise ValueError(f"The address name \"{slug}\" is already in use by another team.")
    event_owner = (index.get("events") or {}).get(slug)
    if event_owner and event_owner.get("team") != team_id:
        raise ValueError(f"The address name \"{slug}\" is already in use by another team's event list.")
    previous = index["byTeam"].get(team_id)
    if previous and previous != slug:
        index["bySlug"].pop(previous, None)
    index["bySlug"][slug] = team_id
    index["byTeam"][team_id] = slug


def list_mail_event_locals() -> Dict[str, Tuple[str, str]]:
    """``{local: (team slug, event name)}`` for every event list, every team.

    What ``mail.addresses.parse_local_part`` matches first; the team is
    ``list_mail_slugs()[slug]``.
    """
    index = _slugs.load()
    return {local: (entry["slug"], entry["event"])
            for local, entry in (index.get("events") or {}).items()
            if entry.get("slug") and entry.get("event")}


def _sync_event_locals(index: Dict[str, Any], team_id: str, slug: str,
                       event_slugs: Iterable[str]) -> None:
    """Make the index's event entries for ``team_id`` exactly ``event_slugs``
    under ``slug``, inside an open index update. Raises ValueError when a
    new local would shadow another team's address."""
    events = index.setdefault("events", {})
    # A local already registered to this team keeps its place: an event
    # address matches before the slug rules, so a team that later claimed a
    # slug the address could also be read under does not unseat it.
    held = {l for l, e in events.items() if e.get("team") == team_id}
    for local in held:
        del events[local]
    for event in event_slugs:
        local = f"{slug}-{event}"
        if local not in held:
            _check_event_local(index, local, team_id)
        events[local] = {"team": team_id, "slug": slug, "event": event}


def _check_event_local(index: Dict[str, Any], local: str, team_id: str) -> None:
    """Refuse an event address that already means something to another team:
    its whole slug, one of its lists, or a player alias of its (see
    mail/addresses.py on why the two address shapes can meet)."""
    other = (index.get("events") or {}).get(local)
    if other and other.get("team") != team_id:
        raise ValueError(f"The address \"{local}\" is already used by another team's event list.")
    parsed = _addresses.parse_local_part(local, index.get("bySlug", {}).keys())
    if parsed and index["bySlug"].get(parsed[1]) != team_id:
        raise ValueError(f"The address \"{local}\" would clash with another team's addresses; pick another name.")


# ==========================================================================
# Directory
# ==========================================================================

def default_lists(display_name: str) -> Dict[str, Dict[str, Any]]:
    """Per-list defaults for a new directory. See TODO.Comms.md § Phase 0.

    ``postPolicy`` is a list of contact kinds allowed to post, or ``["anyone"]``
    for everyone in the directory. ``replyTo`` is where a plain Reply goes:
    the original author, the list itself, or the coaches list. The team-wide
    list replies to the coaches on purpose — reply-all storms are the top
    complaint about team lists, and a parent's reply to an announcement is
    almost always a question for the coaches.
    """
    tag = display_name.strip() or "Team"
    return {
        "all":     {"enabled": True,  "postPolicy": ["coach", "manager", "guardian"], "subjectTag": f"[{tag}]",         "replyTo": "coaches"},
        "parents": {"enabled": True,  "postPolicy": ["coach", "manager", "guardian"], "subjectTag": f"[{tag} Parents]", "replyTo": "list"},
        "coaches": {"enabled": True,  "postPolicy": ["anyone"],                       "subjectTag": f"[{tag} Coaches]", "replyTo": "list"},
        "staff":   {"enabled": True,  "postPolicy": ["anyone"],                       "subjectTag": f"[{tag} Staff]",   "replyTo": "list"},
        "players": {"enabled": False, "postPolicy": ["coach", "player"],              "subjectTag": f"[{tag} Players]", "replyTo": "list"},
        "player":  {"enabled": True,  "postPolicy": ["anyone"],                       "subjectTag": f"[{tag}]",         "replyTo": "list"},
    }


def normalize_contact(contact: Dict[str, Any]) -> Dict[str, Any]:
    """Bring a stored contact up to the current shape, in place.

    Contacts written before 2026-09-12 carry a single ``email`` and a single
    ``bounce``; the current shape is ``emails`` (list) plus ``bounces`` (a map
    keyed by address). Normalizing on read means a directory never needs a
    migration: old records read correctly and are rewritten in the new shape
    the next time anything saves the directory. ``email`` is kept as the
    first address for the old readers (and the admin screen's sort/filter).
    """
    emails = contact.get("emails")
    if not isinstance(emails, list):
        single = contact.get("email")
        emails = [single] if single else []
    cleaned: List[str] = []
    for value in emails:
        if isinstance(value, str) and value.strip():
            address = value.strip().lower()
            if address not in cleaned:
                cleaned.append(address)
    contact["emails"] = cleaned
    contact["email"] = cleaned[0] if cleaned else None
    bounces = contact.get("bounces")
    if not isinstance(bounces, dict):
        legacy = contact.pop("bounce", None)
        bounces = {contact["email"]: legacy} if (legacy and contact["email"]) else {}
    else:
        contact.pop("bounce", None)
    contact["bounces"] = {k: v for k, v in bounces.items() if k in cleaned and v}
    return contact


def get_mail_directory(team_id: str) -> Optional[Dict[str, Any]]:
    path = _directory_file(team_id)
    if not path.exists():
        return None
    with open(path, "r") as f:
        directory = json.load(f)
    _normalize_directory(directory)
    return directory


def _normalize_directory(directory: Dict[str, Any]) -> None:
    for contact in directory.get("contacts") or []:
        normalize_contact(contact)
    directory.setdefault("events", [])
    for event in directory["events"]:
        event.setdefault("contacts", [])
        event.setdefault("playerIds", [])
        for contact in event["contacts"]:
            normalize_contact(contact)


def _save_directory(directory: Dict[str, Any]) -> None:
    directory["updatedAt"] = _now()
    atomic_write_json(_directory_file(directory["teamId"]), directory)


def create_mail_directory(team_id: str, slug: str, display_name: str) -> Dict[str, Any]:
    """Create the directory for a team and claim its slug.

    Raises:
        ValueError: slug already taken by another team, or directory exists.
    """
    with entity_lock(f"mail:{team_id}"):
        if _directory_file(team_id).exists():
            raise ValueError("Mail is already configured for this team.")
        with _slugs.update() as index:
            _claim_slug(index, slug, team_id)
        directory = {
            "teamId": team_id,
            "slug": slug,
            "displayName": display_name.strip() or slug,
            "createdAt": _now(),
            "updatedAt": _now(),
            "lists": default_lists(display_name),
            "contacts": [],
        }
        _save_directory(directory)
        return directory


def update_mail_settings(team_id: str, *, slug: Optional[str] = None,
                         display_name: Optional[str] = None) -> Dict[str, Any]:
    """Change the slug and/or display name. Slug changes re-point the index.

    Raises:
        FileNotFoundError: no directory for the team.
        ValueError: the new slug is taken.
    """
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            raise FileNotFoundError(team_id)
        if slug and slug != directory["slug"]:
            for contact in directory["contacts"]:
                if contact.get("alias") == slug:
                    raise ValueError(f"The address name \"{slug}\" is already {contact['name']}'s player address name.")
            for event in directory.get("events") or []:
                if event.get("slug") == slug:
                    raise ValueError(f"The address name \"{slug}\" is already the {event['name']} event list's address name.")
            with _slugs.update() as index:
                _claim_slug(index, slug, team_id)
                # Event addresses carry the slug: cudo-states → cudo-mixed-states.
                _sync_event_locals(index, team_id, slug, [e["slug"] for e in directory.get("events", [])])
            directory["slug"] = slug
        if display_name is not None:
            directory["displayName"] = display_name.strip() or directory["slug"]
        _save_directory(directory)
        return directory


def delete_mail_directory(team_id: str) -> bool:
    """Remove everything mail-related for a team (team erasure). Returns
    whether anything existed."""
    with entity_lock(f"mail:{team_id}"):
        existed = _team_dir(team_id).exists()
        with _slugs.update() as index:
            previous = index["byTeam"].pop(team_id, None)
            if previous:
                index["bySlug"].pop(previous, None)
            _sync_event_locals(index, team_id, previous or "", [])
        if existed:
            _rmtree(_team_dir(team_id))
        return existed


def _rmtree(path: Path) -> None:
    for child in sorted(path.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if child.is_dir():
            child.rmdir()
        else:
            child.unlink()
    path.rmdir()


def list_mail_directories() -> List[Dict[str, Any]]:
    """Every team directory on disk (bounce intake scans these)."""
    base = Path(MAIL_DIR)
    if not base.exists():
        return []
    found = []
    for path in sorted(base.glob("*/directory.json")):
        try:
            with open(path, "r") as f:
                directory = json.load(f)
        except (json.JSONDecodeError, IOError):
            continue
        _normalize_directory(directory)
        found.append(directory)
    return found


# ==========================================================================
# Lists
# ==========================================================================

def update_mail_list(team_id: str, kind: str, updates: Dict[str, Any]) -> Dict[str, Any]:
    """Change one list's settings. Unknown fields are ignored; bad values raise
    ValueError with a user-facing message."""
    if kind not in LIST_KINDS:
        raise ValueError(f"Unknown list: {kind}")
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            raise FileNotFoundError(team_id)
        current = directory["lists"].setdefault(kind, default_lists(directory["displayName"])[kind])
        for field in LIST_FIELDS:
            if field not in updates:
                continue
            value = updates[field]
            if field == "enabled":
                current["enabled"] = bool(value)
            elif field == "postPolicy":
                if not isinstance(value, list) or not value:
                    raise ValueError("postPolicy must be a non-empty list.")
                kinds = [str(v) for v in value]
                if "anyone" in kinds:
                    current["postPolicy"] = ["anyone"]
                else:
                    bad = [k for k in kinds if k not in POSTER_KINDS]
                    if bad:
                        raise ValueError(f"Unknown poster kind(s): {', '.join(bad)}")
                    current["postPolicy"] = kinds
            elif field == "subjectTag":
                tag = str(value or "").strip()
                if len(tag) > 40:
                    raise ValueError("Subject tag is too long (40 characters max).")
                current["subjectTag"] = tag
            elif field == "replyTo":
                if value not in REPLY_TO_MODES:
                    raise ValueError(f"replyTo must be one of {', '.join(REPLY_TO_MODES)}.")
                current["replyTo"] = value
        _save_directory(directory)
        return current


# ==========================================================================
# Contacts
# ==========================================================================

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _clean_emails(value: Any) -> List[str]:
    """Parse one address, a separated string, or a list into a clean list.

    Accepts ``"a@x.test"``, ``"a@x.test, b@y.test"`` (commas, semicolons or
    whitespace) or ``["a@x.test", "b@y.test"]``; lowercases, dedupes, keeps
    order, and rejects anything that is not shaped like an address.
    """
    if value is None:
        return []
    if isinstance(value, str):
        parts = re.split(r"[,;\s]+", value)
    elif isinstance(value, list):
        parts = [str(v) for v in value]
    else:
        raise ValueError("emails must be an address, a comma-separated string, or a list.")
    cleaned: List[str] = []
    for part in parts:
        address = part.strip().lower()
        if not address:
            continue
        if not _EMAIL_RE.match(address):
            raise ValueError(f"\"{part.strip()}\" is not a valid email address.")
        if address not in cleaned:
            cleaned.append(address)
    return cleaned


def _clean_contact_updates(updates: Dict[str, Any]) -> Dict[str, Any]:
    clean: Dict[str, Any] = {}
    if "kind" in updates:
        if updates["kind"] not in CONTACT_KINDS:
            raise ValueError(f"kind must be one of {', '.join(CONTACT_KINDS)}.")
        clean["kind"] = updates["kind"]
    if "name" in updates:
        name = str(updates["name"] or "").strip()
        if not name:
            raise ValueError("Name is required.")
        if len(name) > 80:
            raise ValueError("Name is too long (80 characters max).")
        clean["name"] = name
    if "emails" in updates or "email" in updates:
        raw = updates["emails"] if "emails" in updates else updates["email"]
        clean["emails"] = _clean_emails(raw)
        clean["email"] = clean["emails"][0] if clean["emails"] else None
    if "playerIds" in updates:
        ids = updates["playerIds"] or []
        if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
            raise ValueError("playerIds must be a list of player ids.")
        clean["playerIds"] = list(dict.fromkeys(ids))
    if "alias" in updates:
        alias = updates["alias"]
        clean["alias"] = str(alias).strip().lower() if alias else None
    if "status" in updates:
        if updates["status"] not in CONTACT_STATUSES:
            raise ValueError(f"status must be one of {', '.join(CONTACT_STATUSES)}.")
        clean["status"] = updates["status"]
    if "optOut" in updates:
        opt = updates["optOut"] or []
        if not isinstance(opt, list):
            raise ValueError("optOut must be a list of list kinds.")
        bad = [k for k in opt if k not in LIST_KINDS]
        if bad:
            raise ValueError(f"Unknown list kind(s) in optOut: {', '.join(bad)}")
        clean["optOut"] = list(dict.fromkeys(opt))
    if "notes" in updates:
        notes = str(updates["notes"] or "").strip()
        if len(notes) > 500:
            raise ValueError("Notes are too long (500 characters max).")
        clean["notes"] = notes
    return clean


def _validate_contact(directory: Dict[str, Any], contact: Dict[str, Any],
                      *, exclude_id: Optional[str] = None) -> None:
    """Cross-record rules: alias unique within the team; a player contact
    needs exactly one playerId and an alias; non-players carry no alias."""
    kind = contact["kind"]
    alias = contact.get("alias")
    player_ids = contact.get("playerIds") or []
    if kind == "player":
        if len(player_ids) != 1:
            raise ValueError("A player contact must be linked to exactly one player.")
        if not alias:
            raise ValueError("A player contact needs an address name.")
    else:
        if alias:
            raise ValueError("Only player contacts have an address name.")
        if kind == "guardian" and not player_ids:
            raise ValueError("A guardian must be linked to at least one player.")
    emails = contact.get("emails") or []
    if not emails and kind != "player":
        raise ValueError("An email address is required.")
    if alias:
        local = f"{alias}-{directory['slug']}"
        event_owner = (_slugs.load().get("events") or {}).get(local)
        if event_owner:
            raise ValueError(f"The address name \"{alias}\" would clash with an event list's address.")
        # In the subdomain spelling (alice@cudo.<base>) an alias shares its
        # namespace with the team's own name and its event names.
        if alias == directory["slug"]:
            raise ValueError(f"The address name \"{alias}\" is the team's own address name.")
        for event in directory.get("events") or []:
            if event.get("slug") == alias:
                raise ValueError(f"The address name \"{alias}\" is already the {event['name']} event list's address name.")
    for other in directory["contacts"]:
        if other["id"] == exclude_id:
            continue
        if alias and other.get("alias") == alias:
            raise ValueError(f"The address name \"{alias}\" is already used by {other['name']}.")
        if kind == "player" and other["kind"] == "player" and other.get("playerIds") == player_ids:
            raise ValueError(f"{other['name']} already has an address on this team.")
        if other["kind"] == kind:
            shared = [e for e in emails if e in (other.get("emails") or [])]
            if shared:
                raise ValueError(f"{shared[0]} is already in the directory as {other['name']}.")


def add_mail_contact(team_id: str, contact: Dict[str, Any]) -> Dict[str, Any]:
    """Add a contact. ``contact`` carries any of CONTACT_FIELDS; ``kind`` and
    ``name`` are required. Returns the stored record (with id/timestamps)."""
    clean = _clean_contact_updates(contact)
    if "kind" not in clean or "name" not in clean:
        raise ValueError("kind and name are required.")
    emails = clean.get("emails", [])
    record = {
        "id": _new_id("mc"),
        "kind": clean["kind"],
        "name": clean["name"],
        "emails": emails,
        "email": emails[0] if emails else None,
        "playerIds": clean.get("playerIds", []),
        "alias": clean.get("alias"),
        "status": clean.get("status", "active"),
        "optOut": clean.get("optOut", []),
        "notes": clean.get("notes", ""),
        "bounces": {},
        "createdAt": _now(),
        "updatedAt": _now(),
    }
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            raise FileNotFoundError(team_id)
        _validate_contact(directory, record)
        directory["contacts"].append(record)
        _save_directory(directory)
    return record


def get_mail_contact(team_id: str, contact_id: str) -> Optional[Dict[str, Any]]:
    directory = get_mail_directory(team_id)
    if directory is None:
        return None
    for contact in directory["contacts"]:
        if contact["id"] == contact_id:
            return contact
    return None


def update_mail_contact(team_id: str, contact_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Edit a contact. ``{"bounces": None}`` (or the old ``{"bounce": None}``)
    clears every recorded bounce so the addresses are delivered to again;
    nothing else may write bounce state."""
    clean = _clean_contact_updates(updates)
    clear_bounce = any(k in updates and updates[k] is None for k in ("bounce", "bounces"))
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            raise FileNotFoundError(team_id)
        for contact in directory["contacts"]:
            if contact["id"] != contact_id:
                continue
            candidate = dict(contact)
            candidate.update(clean)
            if clear_bounce:
                candidate["bounces"] = {}
            elif "emails" in clean:
                # An address that was removed takes its bounce record with it.
                candidate["bounces"] = {k: v for k, v in (candidate.get("bounces") or {}).items()
                                        if k in candidate["emails"]}
            _validate_contact(directory, candidate, exclude_id=contact_id)
            candidate["updatedAt"] = _now()
            contact.clear()
            contact.update(candidate)
            _save_directory(directory)
            return contact
    return None


def remove_mail_contact(team_id: str, contact_id: str) -> bool:
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            return False
        before = len(directory["contacts"])
        directory["contacts"] = [c for c in directory["contacts"] if c["id"] != contact_id]
        if len(directory["contacts"]) == before:
            return False
        _save_directory(directory)
        return True


def add_player_contacts(team_id: str, players: Iterable[Tuple[str, str, str]]) -> List[Dict[str, Any]]:
    """Bulk-add player contacts ``(playerId, name, alias)`` skipping players
    that already have one. Used by the alias sync; aliases are pre-computed
    by the caller (mail/directory.py) against the current directory."""
    added = []
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            raise FileNotFoundError(team_id)
        have = {c["playerIds"][0] for c in directory["contacts"]
                if c["kind"] == "player" and c.get("playerIds")}
        for player_id, name, alias in players:
            if player_id in have:
                continue
            record = {
                "id": _new_id("mc"),
                "kind": "player",
                "name": name,
                "emails": [],
                "email": None,
                "playerIds": [player_id],
                "alias": alias,
                "status": "active",
                "optOut": [],
                "notes": "",
                "bounces": {},
                "createdAt": _now(),
                "updatedAt": _now(),
            }
            _validate_contact(directory, record)
            directory["contacts"].append(record)
            have.add(player_id)
            added.append(record)
        if added:
            _save_directory(directory)
    return added


# ==========================================================================
# Event lists
# ==========================================================================

def default_event_settings(display_name: str, event_name: str) -> Dict[str, Any]:
    """Settings for a new event list: on, anyone on the list may post (the
    parents of the players going coordinate carpools and rooms among
    themselves), replies to the list, subject tagged with the team and the
    event ("[CUDO States]")."""
    tag = " ".join(p for p in ((display_name or "").strip(), (event_name or "").strip()) if p) or "Event"
    return {"enabled": True, "postPolicy": ["anyone"], "subjectTag": f"[{tag}]"[:40], "replyTo": "list"}


def _clean_event_updates(updates: Dict[str, Any]) -> Dict[str, Any]:
    clean: Dict[str, Any] = {}
    if "slug" in updates:
        clean["slug"] = _addresses.validate_event_slug(str(updates["slug"] or ""))
    if "name" in updates:
        name = str(updates["name"] or "").strip()
        if not name:
            raise ValueError("Event name is required.")
        if len(name) > 60:
            raise ValueError("Event name is too long (60 characters max).")
        clean["name"] = name
    if "eventId" in updates:
        value = updates["eventId"]
        if value is not None and (not isinstance(value, str) or not value.strip()):
            raise ValueError("eventId must be an event id or null.")
        clean["eventId"] = value.strip() if value else None
    if "playerIds" in updates:
        ids = updates["playerIds"] or []
        if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
            raise ValueError("playerIds must be a list of player ids.")
        clean["playerIds"] = list(dict.fromkeys(ids))
    for field in LIST_FIELDS:
        if field not in updates:
            continue
        value = updates[field]
        if field == "enabled":
            clean["enabled"] = bool(value)
        elif field == "postPolicy":
            if not isinstance(value, list) or not value:
                raise ValueError("postPolicy must be a non-empty list.")
            kinds = [str(v) for v in value]
            if "anyone" in kinds:
                clean["postPolicy"] = ["anyone"]
            else:
                bad = [k for k in kinds if k not in POSTER_KINDS]
                if bad:
                    raise ValueError(f"Unknown poster kind(s): {', '.join(bad)}")
                clean["postPolicy"] = kinds
        elif field == "subjectTag":
            tag = str(value or "").strip()
            if len(tag) > 40:
                raise ValueError("Subject tag is too long (40 characters max).")
            clean["subjectTag"] = tag
        elif field == "replyTo":
            if value not in REPLY_TO_MODES:
                raise ValueError(f"replyTo must be one of {', '.join(REPLY_TO_MODES)}.")
            clean["replyTo"] = value
    return clean


def _find_event(directory: Dict[str, Any], event_id: str) -> Optional[Dict[str, Any]]:
    for event in directory.get("events") or []:
        if event["id"] == event_id:
            return event
    return None


def find_mail_event_by_slug(directory: Dict[str, Any], slug: str) -> Optional[Dict[str, Any]]:
    for event in directory.get("events") or []:
        if event.get("slug") == slug:
            return event
    return None


def _validate_event(directory: Dict[str, Any], event: Dict[str, Any], *,
                    exclude_id: Optional[str] = None) -> None:
    for other in directory.get("events") or []:
        if other["id"] == exclude_id:
            continue
        if other.get("slug") == event["slug"]:
            raise ValueError(f"The event address name \"{event['slug']}\" is already used by {other['name']}.")
    if event["slug"] == directory["slug"]:
        raise ValueError(f"The event address name \"{event['slug']}\" is the team's own address name.")
    local = f"{directory['slug']}-{event['slug']}"
    # Within the team, the event address must not be a player's alias address
    # read the other way round (slug ``s``, event ``x-s``, alias ``s-x``), and
    # in the subdomain spelling (states@cudo.<base>) not an alias at all.
    parsed = _addresses.parse_local_part(local, [directory["slug"]])
    reversed_alias = parsed[2] if parsed and parsed[0] == "player" else None
    for contact in directory["contacts"]:
        if contact.get("alias") == event["slug"]:
            raise ValueError(f"The event address name \"{event['slug']}\" is already {contact['name']}'s player address name.")
        if reversed_alias and contact.get("alias") == reversed_alias:
            raise ValueError(f"The address \"{local}\" is already {contact['name']}'s player address.")


def add_mail_event(team_id: str, event: Dict[str, Any]) -> Dict[str, Any]:
    """Create an event list. ``event`` carries ``slug`` and ``name`` (required),
    optionally ``eventId`` (a tournament event to sync the roster from) and
    ``playerIds``. Raises ValueError on a bad or clashing name."""
    clean = _clean_event_updates(event)
    if "slug" not in clean or "name" not in clean:
        raise ValueError("slug and name are required.")
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            raise FileNotFoundError(team_id)
        record = {
            "id": _new_id("me"),
            "slug": clean["slug"],
            "name": clean["name"],
            "eventId": clean.get("eventId"),
            **default_event_settings(directory["displayName"], clean["name"]),
            "playerIds": clean.get("playerIds", []),
            "contacts": [],
            "createdAt": _now(),
            "updatedAt": _now(),
        }
        for field in LIST_FIELDS:
            if field in clean:
                record[field] = clean[field]
        _validate_event(directory, record)
        with _slugs.update() as index:
            _sync_event_locals(index, team_id, directory["slug"],
                               [e["slug"] for e in directory["events"]] + [record["slug"]])
        directory["events"].append(record)
        _save_directory(directory)
    return record


def get_mail_event(team_id: str, event_id: str) -> Optional[Dict[str, Any]]:
    directory = get_mail_directory(team_id)
    return _find_event(directory, event_id) if directory else None


def update_mail_event(team_id: str, event_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Edit an event list's name, address name, settings, linked tournament
    event or the roster players on it. None when the list does not exist."""
    clean = _clean_event_updates(updates)
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            raise FileNotFoundError(team_id)
        event = _find_event(directory, event_id)
        if event is None:
            return None
        candidate = {**event, **clean}
        _validate_event(directory, candidate, exclude_id=event_id)
        if candidate["slug"] != event["slug"]:
            with _slugs.update() as index:
                _sync_event_locals(index, team_id, directory["slug"],
                                   [candidate["slug"] if e["id"] == event_id else e["slug"]
                                    for e in directory["events"]])
        candidate["updatedAt"] = _now()
        event.clear()
        event.update(candidate)
        _save_directory(directory)
        return event


def remove_mail_event(team_id: str, event_id: str) -> bool:
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            return False
        before = len(directory["events"])
        directory["events"] = [e for e in directory["events"] if e["id"] != event_id]
        if len(directory["events"]) == before:
            return False
        with _slugs.update() as index:
            _sync_event_locals(index, team_id, directory["slug"], [e["slug"] for e in directory["events"]])
        _save_directory(directory)
        return True


def _validate_event_contact(event: Dict[str, Any], contact: Dict[str, Any], *,
                            exclude_id: Optional[str] = None) -> None:
    """Pickup players and their guardians: a player carries exactly one id
    (its own pickup id, which its guardians point at), a guardian at least
    one; nobody has an alias; an address appears once per kind."""
    kind = contact["kind"]
    if kind not in EVENT_CONTACT_KINDS:
        raise ValueError("An event list holds pickup players and their parents / guardians only.")
    if contact.get("alias"):
        raise ValueError("Pickup players do not get their own address.")
    player_ids = contact.get("playerIds") or []
    if kind == "player" and len(player_ids) != 1:
        raise ValueError("A pickup player carries exactly one id.")
    if kind == "guardian":
        pickups = {c["playerIds"][0] for c in event["contacts"] if c["kind"] == "player" and c.get("playerIds")}
        if not player_ids or not all(p in pickups for p in player_ids):
            raise ValueError("A guardian must be linked to a pickup player on this event.")
    emails = contact.get("emails") or []
    if not emails and kind != "player":
        raise ValueError("An email address is required.")
    for other in event["contacts"]:
        if other["id"] == exclude_id:
            continue
        if kind == "player" and other["kind"] == "player" and other.get("playerIds") == player_ids:
            raise ValueError(f"{other['name']} is already on this event list.")
        if other["kind"] == kind:
            shared = [e for e in emails if e in (other.get("emails") or [])]
            if shared:
                raise ValueError(f"{shared[0]} is already on this event list as {other['name']}.")


def add_mail_event_contact(team_id: str, event_id: str, contact: Dict[str, Any]) -> Dict[str, Any]:
    """Add a pickup player (``kind: player``; an id is generated unless
    ``playerIds`` names one, e.g. the tournament event's pickup id) or a
    guardian of one (``playerIds`` naming the pickup ids). Raises KeyError
    for an unknown event list, ValueError for a bad contact."""
    clean = _clean_contact_updates(contact)
    if "kind" not in clean or "name" not in clean:
        raise ValueError("kind and name are required.")
    emails = clean.get("emails", [])
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            raise FileNotFoundError(team_id)
        event = _find_event(directory, event_id)
        if event is None:
            raise KeyError(event_id)
        player_ids = clean.get("playerIds", [])
        if clean["kind"] == "player" and not player_ids:
            player_ids = [_new_id("pickup")]
        record = {
            "id": _new_id("mc"),
            "kind": clean["kind"],
            "name": clean["name"],
            "emails": emails,
            "email": emails[0] if emails else None,
            "playerIds": player_ids,
            "alias": None,
            "status": clean.get("status", "active"),
            "optOut": [],
            "notes": clean.get("notes", ""),
            "bounces": {},
            "createdAt": _now(),
            "updatedAt": _now(),
        }
        _validate_event_contact(event, record)
        event["contacts"].append(record)
        event["updatedAt"] = _now()
        _save_directory(directory)
    return record


def update_mail_event_contact(team_id: str, event_id: str, contact_id: str,
                              updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    clean = _clean_contact_updates(updates)
    clean.pop("kind", None)        # a pickup stays a pickup, a guardian a guardian
    clean.pop("alias", None)       # and nobody on an event list has an address of their own
    clear_bounce = any(k in updates and updates[k] is None for k in ("bounce", "bounces"))
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            raise FileNotFoundError(team_id)
        event = _find_event(directory, event_id)
        if event is None:
            raise KeyError(event_id)
        for contact in event["contacts"]:
            if contact["id"] != contact_id:
                continue
            candidate = dict(contact)
            candidate.update(clean)
            if clear_bounce:
                candidate["bounces"] = {}
            elif "emails" in clean:
                candidate["bounces"] = {k: v for k, v in (candidate.get("bounces") or {}).items()
                                        if k in candidate["emails"]}
            _validate_event_contact(event, candidate, exclude_id=contact_id)
            candidate["updatedAt"] = _now()
            contact.clear()
            contact.update(candidate)
            event["updatedAt"] = _now()
            _save_directory(directory)
            return contact
    return None


def remove_mail_event_contact(team_id: str, event_id: str, contact_id: str) -> bool:
    """Remove a pickup player (and the guardians linked only to them) or a
    guardian from an event list."""
    with entity_lock(f"mail:{team_id}"):
        directory = get_mail_directory(team_id)
        if directory is None:
            return False
        event = _find_event(directory, event_id)
        if event is None:
            return False
        target = next((c for c in event["contacts"] if c["id"] == contact_id), None)
        if target is None:
            return False
        kept = []
        gone = set(target.get("playerIds") or []) if target["kind"] == "player" else set()
        for contact in event["contacts"]:
            if contact["id"] == contact_id:
                continue
            if gone and contact["kind"] == "guardian":
                remaining = [p for p in (contact.get("playerIds") or []) if p not in gone]
                if not remaining:
                    continue
                contact["playerIds"] = remaining
            kept.append(contact)
        event["contacts"] = kept
        event["updatedAt"] = _now()
        _save_directory(directory)
        return True


# ==========================================================================
# Bounces and complaints
# ==========================================================================

def record_mail_bounce(email: str, kind: str, detail: str = "", provider_id: Optional[str] = None) -> int:
    """Mark every contact with this address, in every team. Returns count.

    ``kind`` is ``hard`` (permanent bounce), ``soft`` (transient) or
    ``complaint``. Hard bounces and complaints stop delivery to the address
    until a coach clears them (policy.py); soft ones are informational.

    ``provider_id`` is the SES message id of the send that bounced. When a
    relayed log row carries it, the bounce row is tied to that row
    (``relayedId``, and the row's list and subject), which is what lets the
    activity view show "8 recipients, 1 bounced" on the message itself.
    """
    email = (email or "").strip().lower()
    if not email:
        return 0
    touched = 0
    for directory in list_mail_directories():
        team_id = directory["teamId"]
        with entity_lock(f"mail:{team_id}"):
            directory = get_mail_directory(team_id)
            if directory is None:
                continue
            relayed = find_mail_log_by_provider(team_id, provider_id) if provider_id else None
            record = {"at": _now(), "kind": kind, "detail": detail[:200]}
            if relayed:
                record["subject"] = relayed.get("subject") or ""
                record["relayedId"] = relayed.get("id")
            changed = False
            everyone = list(directory["contacts"]) + [c for e in directory.get("events", []) for c in e["contacts"]]
            for contact in everyone:
                if email in (contact.get("emails") or []):
                    contact.setdefault("bounces", {})[email] = dict(record)
                    contact["updatedAt"] = _now()
                    changed = True
                    touched += 1
            if changed:
                _save_directory(directory)
                append_mail_log(team_id, {
                    "action": "bounce" if kind != "complaint" else "complaint",
                    "list": relayed.get("list") if relayed else None,
                    "from": email,
                    "fromName": None,
                    "subject": (relayed.get("subject") or "") if relayed else detail[:120],
                    "detail": detail[:200],
                    "recipients": 0,
                    "reason": kind,
                    "providerId": provider_id,
                    "relayedId": relayed.get("id") if relayed else None,
                })
    return touched


def find_mail_log_by_provider(team_id: str, provider_id: str, limit: int = 5000) -> Optional[Dict[str, Any]]:
    """The relayed (or released) row one of whose sends carried this SES
    message id, searching the newest ``limit`` rows; None when unknown.
    A bounce arrives minutes to days after the send, so recent is enough."""
    if not provider_id:
        return None
    for entry in read_mail_log(team_id, limit=limit):
        if entry.get("action") not in ("relayed", "released"):
            continue
        if entry.get("providerId") == provider_id or provider_id in (entry.get("providerIds") or []):
            return entry
    return None


def attach_bounces(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Give every relayed/released row in ``entries`` the bounce and
    complaint rows that point at it, as ``bounces``: ``[{at, email, kind,
    detail}, …]``. Joins within the given rows only: a bounce row is always
    newer than the row it points at, so a newest-first page that holds the
    relayed row holds its bounces too."""
    by_relayed: Dict[str, List[Dict[str, Any]]] = {}
    by_provider: Dict[str, List[Dict[str, Any]]] = {}
    for e in entries:
        if e.get("action") in ("bounce", "complaint") and (e.get("relayedId") or e.get("providerId")):
            item = {"id": e.get("id"), "at": e.get("at"), "email": e.get("from"), "kind": e.get("reason"),
                    "detail": e.get("detail") or e.get("subject") or ""}
            if e.get("relayedId"):
                by_relayed.setdefault(e["relayedId"], []).append(item)
            if e.get("providerId"):
                by_provider.setdefault(e["providerId"], []).append(item)
    for e in entries:
        if e.get("action") not in ("relayed", "released"):
            continue
        # By row id, and by send id too: a grouped relay logs one row per
        # player alias, all carrying the same send ids, and a bounce of the
        # shared coach copy belongs on every one of those rows.
        found: Dict[str, Dict[str, Any]] = {}
        for item in by_relayed.get(e.get("id") or "", []):
            found[item["id"]] = item
        for pid in e.get("providerIds") or ([e["providerId"]] if e.get("providerId") else []):
            for item in by_provider.get(pid, []):
                found[item["id"]] = item
        e["bounces"] = [{k: v for k, v in item.items() if k != "id"} for item in found.values()]
    return entries


# ==========================================================================
# Log
# ==========================================================================

def append_mail_log(team_id: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    """Append one line to this month's log. Adds ``id`` and ``at``."""
    record = {"id": _new_id("ml"), "at": _now()}
    record.update(entry)
    log_dir = _log_dir(team_id)
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / f"{record['at'][:7]}.jsonl"
    with entity_lock(f"mail-log:{team_id}"):
        with open(path, "a") as f:
            f.write(json.dumps(record) + "\n")
    return record


def read_mail_log(team_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    """Newest ``limit`` entries, newest first."""
    log_dir = _log_dir(team_id)
    if not log_dir.exists():
        return []
    entries: List[Dict[str, Any]] = []
    for path in sorted(log_dir.glob("*.jsonl"), reverse=True):
        with open(path, "r") as f:
            lines = f.readlines()
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
            if len(entries) >= limit:
                return entries
    return entries


def _rewrite_log(team_id: str, keep) -> int:
    """Drop log lines for which ``keep(entry)`` is false. Returns dropped count."""
    log_dir = _log_dir(team_id)
    if not log_dir.exists():
        return 0
    dropped = 0
    with entity_lock(f"mail-log:{team_id}"):
        for path in log_dir.glob("*.jsonl"):
            with open(path, "r") as f:
                lines = f.readlines()
            kept = []
            for line in lines:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    kept.append(line)
                    continue
                if keep(entry):
                    kept.append(line)
                else:
                    dropped += 1
            if dropped:
                tmp = path.with_suffix(".jsonl.tmp")
                with open(tmp, "w") as f:
                    f.writelines(kept)
                tmp.replace(path)
    return dropped


# ==========================================================================
# Delivery tracking
# ==========================================================================
#
# {teamId}/delivery/{YYYY-MM}.jsonl holds one line per fact about one
# outbound send: who it went to (``sent``), and what the provider reported
# for one recipient afterwards (``delivered``, ``delayed``, ``bounced``,
# ``complaint``, ``rejected``). It is kept apart from the activity log
# because it is per recipient (a list of 53 is 54 lines or more per message,
# and the log view reads the newest N lines) and because it is the one place
# that holds every recipient's address for every message: it has a shorter
# retention than the log and its own erasure pass.
#
# "Delivered" is the receiving mail server accepting the message. What that
# server does next (inbox, spam folder, a quarantine digest) is invisible
# from here.

DELIVERY_RETENTION_MONTHS = 3
DELIVERY_EVENTS = ("delivered", "delayed", "bounced", "complaint", "rejected")
# One recipient, several facts on record: the worst news wins, and
# "delivered" replaces an earlier "delayed".
_DELIVERY_RANK = {"complaint": 5, "bounced": 4, "rejected": 3, "delivered": 2, "delayed": 1}
# Ids that name no particular send (the null transport, an SES call that
# returned no id): nothing can ever be reported against them.
_UNTRACKED_IDS = frozenset({"", "none", "ses"})
_TRACKED_ACTIONS = ("relayed", "released", "test")
_send_teams: Dict[str, str] = {}      # provider id → team, for sends this process recorded


def _delivery_dir(team_id: str) -> Path:
    return _team_dir(team_id) / "delivery"


def _remember_send(provider_id: str, team_id: str) -> None:
    if len(_send_teams) > 5000:
        _send_teams.clear()
    _send_teams[provider_id] = team_id


def _append_delivery(team_id: str, record: Dict[str, Any]) -> Dict[str, Any]:
    record = {"at": _now(), **record}
    directory = _delivery_dir(team_id)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{record['at'][:7]}.jsonl"
    with entity_lock(f"mail-delivery:{team_id}"):
        with open(path, "a") as f:
            f.write(json.dumps(record) + "\n")
    return record


def _read_delivery(team_id: str) -> List[Dict[str, Any]]:
    """Every retained delivery record, oldest first."""
    directory = _delivery_dir(team_id)
    if not directory.exists():
        return []
    records: List[Dict[str, Any]] = []
    for path in sorted(directory.glob("*.jsonl")):
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return records


def record_mail_sends(team_id: str, batches: Iterable[Dict[str, Any]], *,
                      lists: Optional[Iterable[str]] = None) -> int:
    """Remember who each provider call went to, so delivery events (which
    name a call's message id) can be laid against the recipients expected.

    ``batches`` is what ``transport.send_batches`` returns. ``lists`` is the
    list keys the send belongs to: a grouped player-alias relay makes one
    send per audience, and each alias's log row shows only its own.
    Returns how many sends were recorded.
    """
    lists = list(lists or [])
    recorded = 0
    for batch in batches:
        provider_id = str(batch.get("id") or "")
        to = [_addresses.normalize_email(a) for a in (batch.get("recipients") or []) if a]
        if provider_id in _UNTRACKED_IDS or not to:
            continue
        _append_delivery(team_id, {"event": "sent", "providerId": provider_id, "to": to, "lists": lists})
        _remember_send(provider_id, team_id)
        recorded += 1
    if recorded:
        purge_mail_delivery(team_id)
    return recorded


def find_mail_send_team(provider_id: Optional[str]) -> Optional[str]:
    """The team whose relay made this send, or None when it is not one we
    recorded (a system forward, a coach notice, a send older than the
    retention). Sends made by this process are remembered; after a restart
    the delivery files are searched once per id."""
    provider_id = str(provider_id or "")
    if provider_id in _UNTRACKED_IDS:
        return None
    team_id = _send_teams.get(provider_id)
    if team_id:
        return team_id
    base = Path(MAIL_DIR)
    if not base.exists():
        return None
    for team_dir in sorted(p for p in base.iterdir() if p.is_dir()):
        for record in _read_delivery(team_dir.name):
            if record.get("event") == "sent" and record.get("providerId") == provider_id:
                _remember_send(provider_id, team_dir.name)
                return team_dir.name
    return None


def record_mail_delivery(provider_id: Optional[str], email: str, event: str, *,
                         when: Optional[str] = None, detail: str = "",
                         seconds: Optional[float] = None) -> Optional[str]:
    """Record what the provider reported for one recipient of one send.

    ``event`` is one of ``DELIVERY_EVENTS``; ``when`` is the provider's own
    timestamp, ``seconds`` how long the delivery took from the send. Returns
    the team it was recorded under, or None when the send is not a tracked
    one (nothing is written then).
    """
    if event not in DELIVERY_EVENTS:
        raise ValueError(f"Unknown delivery event: {event}")
    email = _addresses.normalize_email(email or "")
    team_id = find_mail_send_team(provider_id)
    if not team_id or not email:
        return None
    record: Dict[str, Any] = {"event": event, "providerId": str(provider_id), "email": email}
    if when:
        record["when"] = str(when)
    if detail:
        record["detail"] = str(detail)[:300]
    if seconds is not None:
        record["seconds"] = round(float(seconds), 1)
    _append_delivery(team_id, record)
    return team_id


def _delivery_index(records: Iterable[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Delivery records by the send they are about, each list oldest first."""
    index: Dict[str, List[Dict[str, Any]]] = {}
    for record in records:
        index.setdefault(record.get("providerId") or "", []).append(record)
    return index


def mail_delivery_status(team_id: str, entry: Dict[str, Any],
                         index: Optional[Dict[str, List[Dict[str, Any]]]] = None) -> Optional[Dict[str, Any]]:
    """Per-recipient delivery state for one activity-log row.

    None when the row is not a tracked send (it is not a relay, or it
    predates tracking or the retention). Otherwise::

        {"sentAt": iso, "recipients": [{"email", "status", "at", "seconds",
         "detail", "delay"}, …], "counts": {"sent": n, "delivered": n, …,
         "pending": n}, "slowestSeconds": n | None}

    ``status`` is ``pending`` until the provider reports something for that
    address. ``delay`` is the receiving server's last "try again later"
    answer, kept when the message was delivered afterwards so a slow
    delivery says why. ``index`` lets a caller that already read the
    delivery files pass them in (``_delivery_index``).
    """
    if entry.get("action") not in _TRACKED_ACTIONS:
        return None
    ids = {i for i in (entry.get("providerIds") or [entry.get("providerId")]) if i and i not in _UNTRACKED_IDS}
    if not ids:
        return None
    if index is None:
        index = _delivery_index(_read_delivery(team_id))
    # Only this row's sends are looked at, in the order the relay made them.
    ordered = [i for i in (entry.get("providerIds") or [entry.get("providerId")]) if i in ids]
    recipients: Dict[str, Dict[str, Any]] = {}
    mine: List[str] = []
    sent_at = None
    for provider_id in dict.fromkeys(ordered):
        for record in index.get(provider_id, []):
            if record.get("event") != "sent":
                continue
            lists = record.get("lists") or []
            if lists and entry.get("list") and entry["list"] not in lists:
                continue
            if provider_id not in mine:
                mine.append(provider_id)
            sent_at = sent_at or record.get("at")
            for address in record.get("to") or []:
                recipients.setdefault(address, {"email": address, "status": "pending", "at": None,
                                                "seconds": None, "detail": "", "delay": ""})
    if not recipients:
        return None
    for record in (r for provider_id in mine for r in index.get(provider_id, [])):
        event = record.get("event")
        if event not in _DELIVERY_RANK:
            continue
        row = recipients.get(record.get("email"))
        if row is None:
            continue
        if event == "delayed":
            row["delay"] = record.get("detail") or ""
        if _DELIVERY_RANK[event] >= _DELIVERY_RANK.get(row["status"], 0):
            row.update(status=event, at=record.get("when") or record.get("at"),
                       seconds=record.get("seconds"), detail=record.get("detail") or "")
    counts = {"sent": len(recipients), "pending": 0}
    counts.update({event: 0 for event in DELIVERY_EVENTS})
    for row in recipients.values():
        counts[row["status"]] += 1
    times = [row["seconds"] for row in recipients.values() if row["status"] == "delivered" and row["seconds"] is not None]
    return {"sentAt": sent_at, "recipients": list(recipients.values()), "counts": counts,
            "slowestSeconds": max(times) if times else None}


def attach_delivery(team_id: str, entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Give every tracked send in ``entries`` its delivery counts as
    ``delivery`` (``{"sent", "delivered", "delayed", "bounced", "complaint",
    "rejected", "pending", "slowestSeconds"}``); None on every other row.
    The per-recipient detail is ``mail_delivery_status``."""
    tracked = any(e.get("action") in _TRACKED_ACTIONS for e in entries)
    index = _delivery_index(_read_delivery(team_id)) if tracked else {}
    for entry in entries:
        status = mail_delivery_status(team_id, entry, index) if index else None
        entry["delivery"] = {**status["counts"], "slowestSeconds": status["slowestSeconds"]} if status else None
    return entries


def purge_mail_delivery(team_id: str, months: int = DELIVERY_RETENTION_MONTHS,
                        today: Optional[datetime] = None) -> int:
    """Delete delivery files older than ``months`` whole months before this
    one. Called on every recorded send, so the store bounds itself."""
    directory = _delivery_dir(team_id)
    if not directory.exists():
        return 0
    today = today or datetime.now(timezone.utc)
    index = today.year * 12 + (today.month - 1) - months
    cutoff = f"{index // 12:04d}-{index % 12 + 1:02d}"
    removed = 0
    with entity_lock(f"mail-delivery:{team_id}"):
        for path in directory.glob("*.jsonl"):
            if path.stem < cutoff:
                path.unlink()
                removed += 1
    return removed


def scrub_mail_delivery(team_id: str, emails: Iterable[str], *, dry_run: bool = False) -> int:
    """Erase addresses from the delivery records: their own event lines go,
    and they are taken out of every send's recipient list. Returns the
    number of lines removed or changed."""
    emails = {_addresses.normalize_email(e) for e in emails if e}
    directory = _delivery_dir(team_id)
    if not emails or not directory.exists():
        return 0
    touched = 0
    with entity_lock(f"mail-delivery:{team_id}"):
        for path in directory.glob("*.jsonl"):
            kept = []
            changed = 0
            with open(path, "r") as f:
                lines = f.readlines()
            for line in lines:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    kept.append(line)
                    continue
                if record.get("email") in emails:
                    changed += 1
                    continue
                to = record.get("to")
                if isinstance(to, list) and emails & set(to):
                    record["to"] = [a for a in to if a not in emails]
                    changed += 1
                    if record["to"]:
                        kept.append(json.dumps(record) + "\n")
                    continue
                kept.append(line)
            touched += changed
            if changed and not dry_run:
                tmp = path.with_suffix(".jsonl.tmp")
                with open(tmp, "w") as f:
                    f.writelines(kept)
                tmp.replace(path)
    return touched


# ==========================================================================
# Quarantine
# ==========================================================================

def add_mail_quarantine(team_id: str, item: Dict[str, Any], raw: bytes) -> Dict[str, Any]:
    """Hold a message. ``item`` is the metadata (list, from, subject, reason…);
    ``raw`` the full MIME. Returns the stored metadata with id/at."""
    qdir = _quarantine_dir(team_id)
    qdir.mkdir(parents=True, exist_ok=True)
    record = {"id": _new_id("mq"), "at": _now(), "size": len(raw)}
    record.update(item)
    with open(qdir / f"{record['id']}.eml", "wb") as f:
        f.write(raw)
    atomic_write_json(qdir / f"{record['id']}.json", record)
    return record


def list_mail_quarantine(team_id: str) -> List[Dict[str, Any]]:
    qdir = _quarantine_dir(team_id)
    if not qdir.exists():
        return []
    items = []
    for path in qdir.glob("mq_*.json"):
        try:
            with open(path, "r") as f:
                items.append(json.load(f))
        except (json.JSONDecodeError, IOError):
            continue
    items.sort(key=lambda i: i.get("at", ""), reverse=True)
    return items


def get_mail_quarantine(team_id: str, item_id: str) -> Optional[Tuple[Dict[str, Any], bytes]]:
    qdir = _quarantine_dir(team_id)
    meta = qdir / f"{item_id}.json"
    raw = qdir / f"{item_id}.eml"
    if not meta.exists() or not raw.exists():
        return None
    with open(meta, "r") as f:
        item = json.load(f)
    with open(raw, "rb") as f:
        return item, f.read()


def remove_mail_quarantine(team_id: str, item_id: str) -> bool:
    qdir = _quarantine_dir(team_id)
    removed = False
    for path in (qdir / f"{item_id}.json", qdir / f"{item_id}.eml"):
        if path.exists():
            path.unlink()
            removed = True
    return removed


def purge_expired_quarantine(team_id: str, days: int = QUARANTINE_TTL_DAYS) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    purged = 0
    for item in list_mail_quarantine(team_id):
        try:
            held_at = datetime.fromisoformat(item["at"])
        except (KeyError, ValueError):
            continue
        if held_at < cutoff and remove_mail_quarantine(team_id, item["id"]):
            purged += 1
    return purged


# ==========================================================================
# Erasure hooks (storage/erasure.py calls these)
# ==========================================================================

def scrub_player_from_mail(player_id: str, *, dry_run: bool = False) -> Dict[str, int]:
    """Remove a player from every team's mail directory.

    Drops the player's own contact (and with it their alias address), unlinks
    them from every guardian and removes guardians left with no player, drops
    quarantined mail addressed to the alias, and deletes log lines that name
    the alias or a removed contact's address. Returns
    ``{"contacts": n, "quarantine": n, "logLines": n}``.
    """
    counts = {"contacts": 0, "quarantine": 0, "logLines": 0}
    for directory in list_mail_directories():
        team_id = directory["teamId"]
        with entity_lock(f"mail:{team_id}"):
            directory = get_mail_directory(team_id)
            if directory is None:
                continue
            slug = directory["slug"]
            removed_emails = set()
            removed_aliases = set()
            kept = []
            for contact in directory["contacts"]:
                ids = contact.get("playerIds") or []
                if player_id not in ids:
                    kept.append(contact)
                    continue
                if contact["kind"] == "player":
                    counts["contacts"] += 1
                    if contact.get("alias"):
                        removed_aliases.add(contact["alias"])
                    removed_emails.update(contact.get("emails") or [])
                    continue
                remaining = [i for i in ids if i != player_id]
                if remaining or contact["kind"] != "guardian":
                    contact["playerIds"] = remaining
                    contact["updatedAt"] = _now()
                    kept.append(contact)
                else:
                    counts["contacts"] += 1
                    removed_emails.update(contact.get("emails") or [])
            # An event list the player was going to forgets them too.
            for event in directory.get("events", []):
                if player_id in (event.get("playerIds") or []):
                    if not dry_run:
                        event["playerIds"] = [p for p in event["playerIds"] if p != player_id]
                        event["updatedAt"] = _now()
            if not dry_run and len(kept) != len(directory["contacts"]):
                directory["contacts"] = kept
                _save_directory(directory)
            elif not dry_run:
                # playerIds may have changed on a guardian with other kids, or on an event
                _save_directory(directory)

            alias_locals = {f"{a}-{slug}" for a in removed_aliases}
            for item in list_mail_quarantine(team_id):
                if item.get("list") in alias_locals or item.get("from") in removed_emails:
                    counts["quarantine"] += 1
                    if not dry_run:
                        remove_mail_quarantine(team_id, item["id"])

            def keep(entry: Dict[str, Any]) -> bool:
                return not (
                    entry.get("list") in alias_locals
                    or (entry.get("from") and entry.get("from") in removed_emails)
                )
            if dry_run:
                for entry in read_mail_log(team_id, limit=1_000_000):
                    if not keep(entry):
                        counts["logLines"] += 1
            else:
                counts["logLines"] += _rewrite_log(team_id, keep)
            counts["logLines"] += scrub_mail_delivery(team_id, removed_emails, dry_run=dry_run)
    return counts
