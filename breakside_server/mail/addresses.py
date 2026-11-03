"""
Address rules for team mailing lists. Pure functions, no I/O.

Every team address is ``<local>@<domain>`` where the local part is one of:

    <slug>                 everyone on the team            ("all")
    parents-<slug>         guardians + coaches (+managers) ("parents")
    coaches-<slug>         coaches                         ("coaches")
    staff-<slug>           coaches + managers              ("staff")
    players-<slug>         players + coaches               ("players")
    <alias>-<slug>         one player + their guardians + all coaches ("player")
    <slug>-<event>         an event list: coaches, managers, the players
                           going (with their guardians) and any pickup
                           players with theirs                  ("event")

``slug`` is chosen by a coach and is globally unique across Breakside;
``alias`` is a player's address name (``alice``, ``alice-b``), unique within
the team; ``event`` is an event list's name (``states``), unique within the
team. All are lowercase ASCII so an address survives being read aloud,
typed on a phone, and folded by every mail client on earth.

Event lists put the team's slug FIRST (``cudo-states``), player aliases put
it last (``alice-cudo``), so the two can only collide across teams (team
``cudo``'s event ``states`` against a player ``cudo`` on a team whose slug is
``states``). Storage refuses an event name whose address already resolves
to another team under the slug rules, and an alias or slug that would form
an existing event address, so every address resolves one way.
"""
import re
import unicodedata
from typing import Dict, Iterable, Mapping, Optional, Tuple

# Kinds of list a local part can resolve to, and the prefix each one uses.
LIST_PREFIXES: Dict[str, str] = {
    "parents": "parents",
    "coaches": "coaches",
    "staff": "staff",
    "players": "players",
}
LIST_KINDS = ("all", "parents", "coaches", "staff", "players", "player", "event")

# Local parts nobody may claim as a slug or an alias. RFC 2142 role addresses,
# the words we use for list prefixes, and things that would look official.
RESERVED = frozenset({
    "postmaster", "abuse", "hostmaster", "webmaster", "admin", "administrator",
    "root", "noreply", "no-reply", "help", "support", "info", "mail", "mailer",
    "mailer-daemon", "bounce", "bounces", "www", "team", "teams", "breakside",
    "all", "everyone", "list", "lists", "owner", "request", "security",
    "parent", "parents", "coach", "coaches", "staff", "player", "players",
    "guardian", "guardians", "manager", "managers", "captain", "captains",
})

SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SLUG_MIN, SLUG_MAX = 2, 24
ALIAS_MIN, ALIAS_MAX = 1, 24


class AddressError(ValueError):
    """A slug or alias that cannot be used. The message is user-facing."""


def _fold(text: str) -> str:
    """Lowercase ASCII with accents stripped: ``José`` → ``jose``."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


def normalize_email(address: str) -> str:
    """Canonical form for comparing addresses: trimmed and lowercased.

    The local part is case-sensitive by RFC and case-insensitive at every
    provider anyone on a youth team uses; lowercasing both halves is the
    behaviour people expect when they type their address into a form.
    """
    return (address or "").strip().lower()


def validate_slug(slug: str) -> str:
    """Return ``slug`` lowercased and stripped, or raise AddressError."""
    slug = _fold((slug or "").strip())
    if not slug:
        raise AddressError("Team address name is required.")
    if len(slug) < SLUG_MIN or len(slug) > SLUG_MAX:
        raise AddressError(
            f"Team address name must be {SLUG_MIN}–{SLUG_MAX} characters."
        )
    if not SLUG_RE.match(slug):
        raise AddressError(
            "Team address name may use only lowercase letters, digits and "
            "single hyphens (e.g. \"cudo\" or \"cudo-mixed\")."
        )
    if slug in RESERVED:
        raise AddressError(f"\"{slug}\" is reserved; pick another name.")
    head = slug.split("-", 1)[0]
    if head in LIST_PREFIXES:
        raise AddressError(
            f"Team address name may not start with \"{head}-\"; that prefix "
            "is used for the team's lists."
        )
    return slug


def validate_alias(alias: str) -> str:
    """Return ``alias`` folded, or raise AddressError."""
    alias = _fold((alias or "").strip())
    if not alias:
        raise AddressError("Address name is required.")
    if len(alias) < ALIAS_MIN or len(alias) > ALIAS_MAX:
        raise AddressError(f"Address name must be {ALIAS_MIN}–{ALIAS_MAX} characters.")
    if not SLUG_RE.match(alias):
        raise AddressError(
            "Address name may use only lowercase letters, digits and single hyphens."
        )
    if alias in RESERVED or alias in LIST_PREFIXES:
        raise AddressError(f"\"{alias}\" is reserved; pick another name.")
    return alias


def validate_event_slug(slug: str) -> str:
    """Return an event list's address name folded, or raise AddressError.

    Same shape as a player alias (``states``, ``spring-break-2026``). The
    reserved words are refused so ``cudo-parents@`` can never look like a
    list it is not.
    """
    slug = _fold((slug or "").strip())
    if not slug:
        raise AddressError("Event address name is required.")
    if len(slug) < ALIAS_MIN or len(slug) > ALIAS_MAX:
        raise AddressError(f"Event address name must be {ALIAS_MIN}–{ALIAS_MAX} characters.")
    if not SLUG_RE.match(slug):
        raise AddressError(
            "Event address name may use only lowercase letters, digits and single hyphens "
            "(e.g. \"states\" or \"spring-break\")."
        )
    if slug in RESERVED or slug in LIST_PREFIXES:
        raise AddressError(f"\"{slug}\" is reserved; pick another name.")
    return slug


def _name_tokens(name: str) -> Tuple[str, str]:
    """(first, last-initial) from a display name, folded to ``[a-z0-9]``."""
    folded = _fold(name)
    parts = [re.sub(r"[^a-z0-9]", "", p) for p in folded.split()]
    parts = [p for p in parts if p]
    if not parts:
        return "", ""
    first = parts[0]
    last_initial = parts[-1][0] if len(parts) > 1 else ""
    return first, last_initial


def make_alias(name: str, taken: Iterable[str]) -> str:
    """Pick a free alias for a player named ``name``.

    ``alice`` → ``alice-s`` (first + last initial) → ``alice2``, ``alice3``…
    ``taken`` is every alias already in use on the team. Reserved words are
    never produced: a player called "Coach" gets ``coach2``.
    """
    taken_set = {a for a in taken if a}
    first, last_initial = _name_tokens(name)
    if not first:
        first = "teammate"

    def free(candidate: str) -> bool:
        return (
            candidate not in taken_set
            and candidate not in RESERVED
            and candidate not in LIST_PREFIXES
        )

    if free(first):
        return first
    if last_initial and free(f"{first}-{last_initial}"):
        return f"{first}-{last_initial}"
    n = 2
    while not free(f"{first}{n}"):
        n += 1
    return f"{first}{n}"


def local_part(kind: str, slug: str, alias: Optional[str] = None) -> str:
    """The local part of the address for a list kind on a team."""
    if kind == "all":
        return slug
    if kind == "player":
        if not alias:
            raise ValueError("player lists need an alias")
        return f"{alias}-{slug}"
    if kind == "event":
        if not alias:
            raise ValueError("event lists need an event name")
        return f"{slug}-{alias}"
    if kind in LIST_PREFIXES:
        return f"{LIST_PREFIXES[kind]}-{slug}"
    raise ValueError(f"unknown list kind: {kind}")


def address(kind: str, slug: str, domain: str, alias: Optional[str] = None) -> str:
    return f"{local_part(kind, slug, alias)}@{domain}"


def parse_local_part(local: str, slugs: Iterable[str],
                     event_locals: Optional[Mapping[str, Tuple[str, str]]] = None,
                     ) -> Optional[Tuple[str, str, Optional[str]]]:
    """Resolve a local part to ``(kind, slug, alias)`` or None.

    ``event_locals`` maps every registered event address local part to its
    ``(team slug, event name)``; an exact match wins, as ``("event", slug,
    event)``, and the storage layer guarantees such a local never resolves
    to another team under the rules below.

    Otherwise, matches the longest known slug that the local part ends with,
    so with slugs ``mixed`` and ``cudo-mixed`` both registered,
    ``parents-cudo-mixed`` resolves to the parents list of ``cudo-mixed``,
    not to a player called ``parents-cudo`` on ``mixed``. Anything left over
    in front of the slug is either a list prefix or a player alias; whether
    that alias exists is the caller's business (policy.py).
    """
    local = _fold(local.strip())
    if event_locals and local in event_locals:
        slug, event = event_locals[local]
        return ("event", slug, event)
    candidates = sorted((s for s in slugs if s), key=len, reverse=True)
    for slug in candidates:
        if local == slug:
            return ("all", slug, None)
        suffix = f"-{slug}"
        if local.endswith(suffix):
            prefix = local[: -len(suffix)]
            if not prefix:
                continue
            for kind, word in LIST_PREFIXES.items():
                if prefix == word:
                    return (kind, slug, None)
            if SLUG_RE.match(prefix):
                return ("player", slug, prefix)
    return None


def mask_address(addr: Optional[str]) -> str:
    """``dave@example.org`` → ``da…@example.org``, for log lines.

    The system journal is root-readable and retained for weeks; it needs to
    say which list a message went to and roughly who wrote it, not carry
    every parent's full address. The coach-visible activity log (storage)
    keeps the real one.
    """
    if not addr:
        return "(none)"
    addr = normalize_email(addr)
    if "@" not in addr:
        return addr[:2] + "…" if len(addr) > 2 else addr
    local, domain = addr.rsplit("@", 1)
    head = local[:2] if len(local) > 2 else local[:1]
    return f"{head}…@{domain}"


def split_address(addr: str) -> Tuple[str, str]:
    """``local@domain`` → (local, domain), both folded. Missing domain → ''."""
    addr = normalize_email(addr)
    if "@" not in addr:
        return addr, ""
    local, domain = addr.rsplit("@", 1)
    return local, domain
