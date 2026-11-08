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

**The subdomain spelling** (Comms Phase 0.5). When a base domain is
configured, every list is also reachable with the team named by the domain
and nothing but the list in the local part::

    team@cudo.<base>         everyone        (also cudo@<base>, and cudo@cudo.<base>)
    parents@cudo.<base>      guardians + coaches (+managers)
    coaches@cudo.<base>      coaches
    alice@cudo.<base>        the player alias
    states@cudo.<base>       the event list

The slug is in the domain, so there is no longest-suffix guessing and no
cross-team ambiguity; the one rule it adds is that within a team an alias,
an event name and the word ``team`` share a single namespace (storage
refuses an alias that equals an event name and the reverse; where old data
already has both, the event wins). ``resolve`` reads every spelling back to
the same ``(kind, slug, alias)``; ``local_part`` of that is the canonical
key every log and quarantine record keeps, whatever spelling arrived.
The base domain also carries *system forwards* (``help@<base>``): open
addresses relayed to one configured recipient, see ``resolve``.
"""
import re
import unicodedata
from dataclasses import dataclass
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
    # Hostnames that exist in the zone. A wildcard MX never covers a name that
    # already has records, so a slug equal to one would be a dead address at
    # <slug>.<base>; add any new hostname here in the change that creates it.
    "api", "staging", "app",
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


# The local part of every list in the subdomain spelling, where the team is
# named by the domain. "all" is the word ``team`` (reserved, so no alias can
# claim it); ``resolve`` also reads the slug itself there, since people
# guess ``cudo@cudo.<base>``.
ALL_SUBDOMAIN_LOCAL = "team"


def subdomain_local(kind: str, slug: str, alias: Optional[str] = None) -> str:
    """The local part at ``<slug>.<base>``: ``team``, ``parents``, ``alice``, ``states``."""
    if kind == "all":
        return ALL_SUBDOMAIN_LOCAL
    if kind in ("player", "event"):
        if not alias:
            raise ValueError(f"{kind} lists need an alias")
        return alias
    if kind in LIST_PREFIXES:
        return LIST_PREFIXES[kind]
    raise ValueError(f"unknown list kind: {kind}")


def apex_address(slug: str, base_domain: str) -> str:
    """``cudo@<base>``: the short spelling of a team's "everyone" list."""
    return f"{slug}@{base_domain}"


def address(kind: str, slug: str, domain: str, alias: Optional[str] = None, *,
            base_domain: Optional[str] = None, style: str = "list") -> str:
    """The address of a list in the spelling the deployment prefers.

    ``style`` ``list`` (the default) is ``parents-cudo@<domain>``;
    ``subdomain`` is ``parents@cudo.<base_domain>`` and falls back to the
    list spelling when no base domain is configured. Inbound, both are
    always accepted (``resolve``); this only decides what the app shows
    and the relay sends From.
    """
    if style == "subdomain" and base_domain:
        return f"{subdomain_local(kind, slug, alias)}@{slug}.{base_domain}"
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


def parse_subdomain_local(local: str, slug: str,
                          event_names: Iterable[str] = ()) -> Optional[Tuple[str, str, Optional[str]]]:
    """Resolve the local part of ``<local>@<slug>.<base>`` to ``(kind, slug, alias)``.

    ``team`` and the slug itself are "everyone"; a list prefix word is that
    list; a registered event name of this team is its event list; anything
    else shaped like an alias is a player alias (whether it exists is
    policy.py's business, as with the list spelling). Event names are
    checked before aliases so a directory that predates the shared
    namespace still resolves one way.
    """
    local = _fold(local.strip())
    if local in (ALL_SUBDOMAIN_LOCAL, slug):
        return ("all", slug, None)
    for kind, word in LIST_PREFIXES.items():
        if local == word:
            return (kind, slug, None)
    if local in set(event_names):
        return ("event", slug, local)
    if SLUG_RE.match(local) and local not in RESERVED:
        return ("player", slug, local)
    return None


@dataclass(frozen=True)
class Target:
    """What one recipient address means to us.

    ``kind`` is a list kind (``all``, ``parents``, …, ``player``, ``event``)
    with ``slug`` and ``alias`` as ``parse_local_part`` returns them, or
    ``forward`` for a system forward at the base domain, where ``alias`` is
    the local part (``help``) and ``forward_to`` the configured recipient.
    """
    kind: str
    slug: Optional[str] = None
    alias: Optional[str] = None
    forward_to: Optional[str] = None

    @property
    def local(self) -> str:
        """The canonical local part: the list spelling's, which every log and
        quarantine record keys on; for a forward, its own local part."""
        if self.kind == "forward":
            return self.alias or ""
        return local_part(self.kind, self.slug or "", self.alias)


def is_our_domain(domain: str, *, list_domain: str, base_domain: Optional[str] = None) -> bool:
    """Whether mail to ``domain`` is ours to relay: the list domain, the base
    domain, or any subdomain of the base (a wildcard MX brings them all)."""
    domain = (domain or "").strip().lower().rstrip(".")
    if not domain:
        return False
    if list_domain and domain == list_domain.lower():
        return True
    base = (base_domain or "").lower()
    return bool(base) and (domain == base or domain.endswith(f".{base}"))


def resolve(local: str, domain: str, *, list_domain: str, base_domain: Optional[str],
            slugs: Iterable[str],
            event_locals: Optional[Mapping[str, Tuple[str, str]]] = None,
            forwards: Optional[Mapping[str, str]] = None) -> Optional[Target]:
    """Read any spelling of one of our addresses back to a ``Target``.

    - ``<local>@<list_domain>``: the list spelling (``parse_local_part``).
    - ``<local>@<base>``: a system forward if ``local`` is in ``forwards``,
      else a slug (``cudo@`` is everyone), else the list spelling again, so
      ``parents-cudo@<base>`` works too.
    - ``<local>@<slug>.<base>`` for a registered slug: the subdomain
      spelling (``parse_subdomain_local``). An unregistered subdomain is
      nobody's: the wildcard MX accepts it, this returns None, the relay
      drops it as ``unknown-address``.

    ``slugs`` is every registered slug, ``event_locals`` the registered
    event addresses as ``list_mail_event_locals()`` gives them.
    """
    local = _fold((local or "").strip())
    domain = (domain or "").strip().lower().rstrip(".")
    if not local or not domain:
        return None
    slug_set = {s for s in slugs if s}

    def listed(parsed):
        return Target(*parsed) if parsed else None

    if list_domain and domain == list_domain.lower():
        return listed(parse_local_part(local, slug_set, event_locals))
    base = (base_domain or "").lower()
    if not base:
        return None
    if domain == base:
        if forwards and local in forwards:
            return Target("forward", alias=local, forward_to=forwards[local])
        return listed(parse_local_part(local, slug_set, event_locals))
    if domain.endswith(f".{base}"):
        slug = domain[: -len(base) - 1]
        if slug in slug_set:
            event_names = [ev for (s, ev) in (event_locals or {}).values() if s == slug]
            return listed(parse_subdomain_local(local, slug, event_names))
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
