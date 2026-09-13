"""
Who receives a list message, who may post, and what must never be relayed.

Pure functions over plain dicts so the rules can be unit-tested with fixtures
and never touch disk. A "contact" is the record shape stored by
storage/mail_storage.py, or a derived coach record from mail/directory.py:

    {id, kind, name, email, playerIds, alias, status, optOut, bounce}

The rules, in the order relay.py applies them:

1. Loops. Anything carrying our own list header, a list/bulk precedence, or
   an auto-submitted marker is dropped — that is how two lists (or a
   vacation responder) would otherwise ping-pong forever.
2. Provider verdicts. SES already scanned the message: spam or virus FAIL is
   dropped; a DMARC FAIL (the sender's own domain says "reject this") is
   quarantined even when the address is known, because that is exactly what
   a spoof of a parent's address looks like.
3. Sender. Unknown address → quarantine. Known but the list's post policy
   excludes their kind → quarantine (different reason, so the coach can see
   "Alice's dad tried to post to the coaches list").
4. Recipients. Expanded from the directory, the author included, minus
   opt-outs, minus paused / alumni / hard-bounced contacts, deduplicated by
   address.
"""
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional

from .addresses import normalize_email

# Which contact kinds each list delivers to. The per-player alias list is
# computed separately (the player, their guardians, every coach).
DELIVERY_KINDS: Dict[str, frozenset] = {
    "all": frozenset({"coach", "manager", "guardian", "player", "other"}),
    "parents": frozenset({"coach", "manager", "guardian"}),
    "coaches": frozenset({"coach"}),
    "staff": frozenset({"coach", "manager"}),
    "players": frozenset({"coach", "player"}),
}

# A relay to more than this many addresses is almost certainly a directory
# mistake, not a youth team. SESv2 caps a single call at 50 anyway; the
# transport chunks, this just bounds the blast radius.
MAX_RECIPIENTS = 400

BLOCKING_BOUNCES = frozenset({"hard", "complaint"})


@dataclass
class Decision:
    action: str                      # "relay" | "quarantine" | "drop"
    reason: Optional[str] = None     # machine-readable, e.g. "unknown-sender"
    kind: Optional[str] = None       # list kind ("parents", "player", …)
    slug: Optional[str] = None
    alias: Optional[str] = None
    sender: Optional[Dict[str, Any]] = None       # first matching contact
    sender_kinds: List[str] = field(default_factory=list)
    recipients: List[Dict[str, Any]] = field(default_factory=list)
    list_settings: Dict[str, Any] = field(default_factory=dict)
    player: Optional[Dict[str, Any]] = None       # the alias's player contact


# ==========================================================================
# 1. Loops
# ==========================================================================

def loop_reason(headers: Mapping[str, str], own_domain: str) -> Optional[str]:
    """Return why this message must not be relayed, or None if it may be.

    ``headers`` is a case-insensitive-ish mapping (relay.py passes a dict of
    lowercased header names to their first value).
    """
    lower = {str(k).lower(): (v or "") for k, v in headers.items()}
    if lower.get("x-breakside-list"):
        return "loop-own-header"
    precedence = lower.get("precedence", "").strip().lower()
    if precedence in ("list", "bulk", "junk"):
        return "loop-precedence"
    auto = lower.get("auto-submitted", "").strip().lower()
    if auto and not auto.startswith("no"):
        return "loop-auto-submitted"
    if lower.get("x-auto-response-suppress") or lower.get("x-autoreply"):
        return "loop-auto-reply"
    sender_from = lower.get("from", "")
    if own_domain and f"@{own_domain.lower()}" in sender_from.lower():
        return "loop-own-address"
    return None


# ==========================================================================
# 2. Provider verdicts
# ==========================================================================

def verdict_reason(verdicts: Optional[Mapping[str, str]]) -> Optional[tuple]:
    """``(action, reason)`` when SES's scan says stop, else None.

    Keys are ``spam``, ``virus``, ``spf``, ``dkim``, ``dmarc``; values the
    SES status words (PASS / FAIL / GRAY / PROCESSING_FAILED). GRAY means
    "no policy published", which is most school districts, and is fine.
    """
    if not verdicts:
        return None
    upper = {k.lower(): str(v or "").upper() for k, v in verdicts.items()}
    if upper.get("virus") == "FAIL":
        return ("drop", "virus")
    if upper.get("spam") == "FAIL":
        return ("drop", "spam")
    if upper.get("dmarc") == "FAIL":
        return ("quarantine", "dmarc-fail")
    if upper.get("spf") == "FAIL" and upper.get("dkim") == "FAIL":
        return ("quarantine", "auth-fail")
    return None


# ==========================================================================
# 3. Senders and posting
# ==========================================================================

def contact_addresses(contact: Mapping[str, Any]) -> List[str]:
    """Every address on a contact, tolerating the pre-2026-09-12 single-``email`` shape."""
    emails = contact.get("emails")
    if isinstance(emails, list):
        return [normalize_email(e) for e in emails if e]
    single = normalize_email(contact.get("email") or "")
    return [single] if single else []


def find_contacts_by_email(contacts: Iterable[Dict[str, Any]], email: str) -> List[Dict[str, Any]]:
    """Every ACTIVE contact carrying this address (a parent-coach matches twice)."""
    email = normalize_email(email)
    if not email:
        return []
    return [
        c for c in contacts
        if email in contact_addresses(c) and c.get("status", "active") == "active"
    ]


def may_post(list_settings: Mapping[str, Any], sender_kinds: Iterable[str]) -> bool:
    policy = list(list_settings.get("postPolicy") or [])
    if "anyone" in policy:
        return True
    return any(kind in policy for kind in sender_kinds)


# ==========================================================================
# 4. Recipients
# ==========================================================================

def deliverable_addresses(contact: Mapping[str, Any]) -> List[str]:
    """The addresses on a contact that may be sent to right now: the contact
    is active, and the address has no hard bounce or complaint on record."""
    if contact.get("status", "active") != "active":
        return []
    bounces = contact.get("bounces") if isinstance(contact.get("bounces"), dict) else {}
    legacy = contact.get("bounce") or None
    first = normalize_email(contact.get("email") or "")
    out = []
    for address in contact_addresses(contact):
        record = bounces.get(address) or (legacy if legacy and address == first else None)
        if record and record.get("kind") in BLOCKING_BOUNCES:
            continue
        out.append(address)
    return out


def deliverable(contact: Mapping[str, Any]) -> bool:
    return bool(deliverable_addresses(contact))


def _expand(contacts: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One delivery entry per deliverable address: the contact's fields with
    ``email`` set to that one address, deduplicated across contacts."""
    seen = set()
    out = []
    for c in contacts:
        for address in deliverable_addresses(c):
            if address in seen:
                continue
            seen.add(address)
            out.append({**c, "email": address})
    return out


def find_player_contact(contacts: Iterable[Dict[str, Any]], alias: str) -> Optional[Dict[str, Any]]:
    for c in contacts:
        if c.get("kind") == "player" and c.get("alias") == alias:
            return c
    return None


def recipients_for(kind: str, contacts: Iterable[Dict[str, Any]], *,
                   alias: Optional[str] = None) -> Optional[List[Dict[str, Any]]]:
    """Expand a list into deliverable, deduplicated contacts.

    Returns None when a player alias does not exist (the caller quarantines
    or drops). Each entry is a contact with ``email`` set to ONE of its
    addresses (a contact with two addresses yields two entries). The same
    expansion serves the "who's on this list" view in the admin screen.
    """
    contacts = list(contacts)
    if kind == "player":
        player = find_player_contact(contacts, alias or "")
        if player is None:
            return None
        player_id = (player.get("playerIds") or [None])[0]
        chosen = [player]
        chosen += [c for c in contacts if c.get("kind") == "guardian" and player_id in (c.get("playerIds") or [])]
        chosen += [c for c in contacts if c.get("kind") == "coach"]
        opt_key = "player"
    else:
        kinds = DELIVERY_KINDS.get(kind)
        if kinds is None:
            return None
        chosen = [c for c in contacts if c.get("kind") in kinds]
        opt_key = kind
    chosen = [c for c in chosen if opt_key not in (c.get("optOut") or [])]
    return _expand(chosen)


# ==========================================================================
# The decision
# ==========================================================================

def decide(directory: Mapping[str, Any], kind: str, alias: Optional[str],
           sender_email: str, contacts: Iterable[Dict[str, Any]], *,
           force: bool = False) -> Decision:
    """Apply rules 3–4 for one list address. Rules 1–2 need the raw headers
    and verdicts, which relay.py checks before calling this.

    ``force`` is the quarantine-release path: the coach has looked at the
    message, so the sender allow-list and the post policy are skipped. List
    enablement and recipient expansion still apply.
    """
    contacts = list(contacts)
    lists = directory.get("lists") or {}
    settings = lists.get(kind) or {}
    decision = Decision(action="drop", kind=kind, slug=directory.get("slug"),
                        alias=alias, list_settings=settings)

    if not settings.get("enabled", kind != "players"):
        decision.action = "quarantine"
        decision.reason = "list-disabled"
        return decision

    matches = find_contacts_by_email(contacts, sender_email)
    decision.sender = matches[0] if matches else None
    decision.sender_kinds = sorted({m["kind"] for m in matches})

    if not force:
        if not matches:
            decision.action = "quarantine"
            decision.reason = "unknown-sender"
            return decision
        if not may_post(settings, decision.sender_kinds):
            decision.action = "quarantine"
            decision.reason = "not-allowed-to-post"
            return decision

    expanded = recipients_for(kind, contacts, alias=alias)
    if expanded is None:
        decision.action = "quarantine" if kind == "player" else "drop"
        decision.reason = "unknown-alias" if kind == "player" else "unknown-list"
        return decision
    if kind == "player":
        decision.player = find_player_contact(contacts, alias or "")

    # Everyone on the list gets the relay, the author included — the same as
    # any mailing list. The author's own copy is what confirms delivery and
    # keeps the thread whole for someone reading forwarded mail elsewhere;
    # Gmail folds it into the Sent copy by Message-ID, so Gmail users never
    # see it twice. (2.1.1 dropped the author's copy at every address they
    # held, which meant a parent who is also a coach never saw their own
    # posts at all.)
    recipients = list(expanded)
    if len(recipients) > MAX_RECIPIENTS:
        decision.action = "quarantine"
        decision.reason = "too-many-recipients"
        return decision

    decision.recipients = recipients
    decision.action = "relay" if recipients else "drop"
    decision.reason = None if recipients else "no-recipients"
    return decision
