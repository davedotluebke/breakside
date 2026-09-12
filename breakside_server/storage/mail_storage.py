"""
Persistence for team mailing lists (Comms Phase 0). See TODO.Comms.md.

Layout under ``data/mail/``:

    _slugs.json                     slug ↔ teamId (global; routes inbound mail)
    {teamId}/directory.json         slug, display name, per-list settings, contacts
    {teamId}/log/{YYYY-MM}.jsonl    one line per relayed / quarantined / bounced message
    {teamId}/quarantine/{id}.json   held message metadata …
    {teamId}/quarantine/{id}.eml    … and its raw MIME

Everything here is coach-only data (parent and player email addresses), which
is why it lives beside the other private entity stores rather than on the
public team document that every viewer syncs. Coaches themselves are never
stored as contacts: they are derived live from team memberships by
mail/directory.py, so the coaches list can never go stale.

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

MAIL_DIR = config.MAIL_DIR

CONTACT_KINDS = ("guardian", "player", "manager", "other")
CONTACT_STATUSES = ("active", "paused", "alumni")
LIST_KINDS = ("all", "parents", "coaches", "staff", "players", "player")
POSTER_KINDS = ("coach", "manager", "guardian", "player", "other")
REPLY_TO_MODES = ("author", "list", "coaches")

# Editable per-contact fields. ``bounce`` may only be cleared (set to None)
# through the API; the inbound path is what sets it.
CONTACT_FIELDS = ("kind", "name", "email", "playerIds", "alias", "status", "optOut", "notes")
LIST_FIELDS = ("enabled", "postPolicy", "subjectTag", "replyTo")

QUARANTINE_TTL_DAYS = 14

_slugs = JsonIndex(
    path_getter=lambda: Path(MAIL_DIR) / "_slugs.json",
    lock_key="mail-slugs",
    empty=lambda: {"bySlug": {}, "byTeam": {}},
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
    previous = index["byTeam"].get(team_id)
    if previous and previous != slug:
        index["bySlug"].pop(previous, None)
    index["bySlug"][slug] = team_id
    index["byTeam"][team_id] = slug


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


def get_mail_directory(team_id: str) -> Optional[Dict[str, Any]]:
    path = _directory_file(team_id)
    if not path.exists():
        return None
    with open(path, "r") as f:
        return json.load(f)


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
            with _slugs.update() as index:
                _claim_slug(index, slug, team_id)
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
                found.append(json.load(f))
        except (json.JSONDecodeError, IOError):
            continue
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


def _clean_email(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    email = str(value).strip().lower()
    if not _EMAIL_RE.match(email):
        raise ValueError(f"\"{value}\" is not a valid email address.")
    return email


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
    if "email" in updates:
        clean["email"] = _clean_email(updates["email"])
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
    if not contact.get("email") and kind != "player":
        raise ValueError("An email address is required.")
    for other in directory["contacts"]:
        if other["id"] == exclude_id:
            continue
        if alias and other.get("alias") == alias:
            raise ValueError(f"The address name \"{alias}\" is already used by {other['name']}.")
        if kind == "player" and other["kind"] == "player" and other.get("playerIds") == player_ids:
            raise ValueError(f"{other['name']} already has an address on this team.")
        if (contact.get("email") and other.get("email") == contact["email"]
                and other["kind"] == kind):
            raise ValueError(f"{contact['email']} is already in the directory as {other['name']}.")


def add_mail_contact(team_id: str, contact: Dict[str, Any]) -> Dict[str, Any]:
    """Add a contact. ``contact`` carries any of CONTACT_FIELDS; ``kind`` and
    ``name`` are required. Returns the stored record (with id/timestamps)."""
    clean = _clean_contact_updates(contact)
    if "kind" not in clean or "name" not in clean:
        raise ValueError("kind and name are required.")
    record = {
        "id": _new_id("mc"),
        "kind": clean["kind"],
        "name": clean["name"],
        "email": clean.get("email"),
        "playerIds": clean.get("playerIds", []),
        "alias": clean.get("alias"),
        "status": clean.get("status", "active"),
        "optOut": clean.get("optOut", []),
        "notes": clean.get("notes", ""),
        "bounce": None,
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
    """Edit a contact. ``{"bounce": None}`` clears a recorded bounce so the
    address is delivered to again; nothing else may write ``bounce``."""
    clean = _clean_contact_updates(updates)
    clear_bounce = "bounce" in updates and updates["bounce"] is None
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
                candidate["bounce"] = None
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
                "email": None,
                "playerIds": [player_id],
                "alias": alias,
                "status": "active",
                "optOut": [],
                "notes": "",
                "bounce": None,
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
# Bounces and complaints
# ==========================================================================

def record_mail_bounce(email: str, kind: str, detail: str = "") -> int:
    """Mark every contact with this address, in every team. Returns count.

    ``kind`` is ``hard`` (permanent bounce), ``soft`` (transient) or
    ``complaint``. Hard bounces and complaints stop delivery to the address
    until a coach clears them (policy.py); soft ones are informational.
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
            changed = False
            for contact in directory["contacts"]:
                if contact.get("email") == email:
                    contact["bounce"] = {"at": _now(), "kind": kind, "detail": detail[:200]}
                    contact["updatedAt"] = _now()
                    changed = True
                    touched += 1
            if changed:
                _save_directory(directory)
                append_mail_log(team_id, {
                    "action": "bounce" if kind != "complaint" else "complaint",
                    "list": None,
                    "from": email,
                    "fromName": None,
                    "subject": detail[:120],
                    "recipients": 0,
                    "reason": kind,
                })
    return touched


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
                    if contact.get("email"):
                        removed_emails.add(contact["email"])
                    continue
                remaining = [i for i in ids if i != player_id]
                if remaining or contact["kind"] != "guardian":
                    contact["playerIds"] = remaining
                    contact["updatedAt"] = _now()
                    kept.append(contact)
                else:
                    counts["contacts"] += 1
                    if contact.get("email"):
                        removed_emails.add(contact["email"])
            if not dry_run and len(kept) != len(directory["contacts"]):
                directory["contacts"] = kept
                _save_directory(directory)
            elif not dry_run and counts["contacts"] == 0:
                # playerIds may have changed on a guardian with other kids
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
    return counts
