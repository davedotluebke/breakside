"""
The team's mail directory as the relay and the admin screen see it.

Stored contacts (storage/mail_storage.py) cover guardians, players, managers
and "other". **Coaches are never stored**: they are derived here from the
team's memberships every time, so the coaches list follows invites and
removals with no admin step and can never be stale.
"""
from typing import Any, Dict, List, Optional

from ._shared import config, storage
from . import addresses

LIST_ORDER = ("all", "parents", "coaches", "staff", "players")


def derived_coach_contacts(team_id: str) -> List[Dict[str, Any]]:
    coaches = []
    for membership in storage.get_team_memberships(team_id):
        if membership.get("role") != "coach":
            continue
        user = storage.get_user(membership["userId"]) or {}
        email = (user.get("email") or "").strip().lower()
        if not email:
            continue
        coaches.append({
            "id": f"coach:{membership['userId']}",
            "kind": "coach",
            "name": user.get("displayName") or email.split("@", 1)[0],
            "email": email,
            "emails": [email],
            "playerIds": [],
            "alias": None,
            "status": "active",
            "optOut": [],
            "bounces": {},
            "derived": True,
            "userId": membership["userId"],
        })
    coaches.sort(key=lambda c: c["name"].lower())
    return coaches


def effective_contacts(team_id: str, directory: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    directory = directory or storage.get_mail_directory(team_id)
    stored = list((directory or {}).get("contacts") or [])
    return derived_coach_contacts(team_id) + stored


def roster_players(team_id: str) -> List[Dict[str, str]]:
    """``[{id, name}]`` for every player on the team's roster, by name."""
    try:
        players = storage.get_team_players(team_id)
    except FileNotFoundError:
        return []
    out = [{"id": p["id"], "name": p.get("name") or p["id"]} for p in players if p.get("id")]
    out.sort(key=lambda p: p["name"].lower())
    return out


def ensure_player_aliases(team_id: str) -> List[Dict[str, Any]]:
    """Give every roster player without a contact an alias address.

    Aliases come from first names and are disambiguated in roster order
    (``alice``, then ``alice-s``, then ``alice2``). Coaches can rename them
    afterwards. Returns the contacts added.
    """
    directory = storage.get_mail_directory(team_id)
    if directory is None:
        raise FileNotFoundError(team_id)
    taken = [c.get("alias") for c in directory["contacts"] if c.get("alias")]
    taken.append(directory["slug"])
    have = {c["playerIds"][0] for c in directory["contacts"]
            if c["kind"] == "player" and c.get("playerIds")}
    plan = []
    for player in roster_players(team_id):
        if player["id"] in have:
            continue
        alias = addresses.make_alias(player["name"], taken)
        taken.append(alias)
        plan.append((player["id"], player["name"], alias))
    if not plan:
        return []
    return storage.add_player_contacts(team_id, plan)


def team_addresses(directory: Dict[str, Any], domain: Optional[str] = None) -> Dict[str, str]:
    domain = domain or config.MAIL_DOMAIN
    slug = directory["slug"]
    out = {kind: addresses.address(kind, slug, domain) for kind in LIST_ORDER}
    out["playerPattern"] = f"<name>-{slug}@{domain}"
    return out


def list_members_view(kind: str, contacts: List[Dict[str, Any]], alias: Optional[str] = None) -> List[Dict[str, Any]]:
    """Who a list currently delivers to, for the admin screen."""
    from . import policy
    expanded = policy.recipients_for(kind, contacts, alias=alias) or []
    return [{"id": c["id"], "name": c["name"], "email": c["email"], "kind": c["kind"]} for c in expanded]


def directory_view(team_id: str) -> Dict[str, Any]:
    """Everything the admin screen renders, in one payload."""
    domain = config.MAIL_DOMAIN
    directory = storage.get_mail_directory(team_id)
    roster = roster_players(team_id)
    members = []
    for membership in storage.get_team_memberships(team_id):
        user = storage.get_user(membership["userId"]) or {}
        members.append({
            "userId": membership["userId"],
            "role": membership.get("role"),
            "displayName": user.get("displayName"),
            "email": (user.get("email") or "").strip().lower() or None,
        })
    members.sort(key=lambda m: ((m["displayName"] or m["email"] or "").lower()))

    if directory is None:
        return {
            "configured": False,
            "domain": domain,
            "transport": getattr(config, "MAIL_TRANSPORT", "none"),
            "inboundEnabled": config.mail_inbound_enabled(),
            "roster": roster,
            "members": members,
            "coaches": derived_coach_contacts(team_id),
        }

    contacts = effective_contacts(team_id, directory)
    directory_emails = {e for c in contacts for e in (c.get("emails") or [])}
    for member in members:
        member["inDirectory"] = bool(member["email"] and member["email"] in directory_emails)
    alias_by_player = {c["playerIds"][0]: c for c in directory["contacts"]
                       if c["kind"] == "player" and c.get("playerIds")}
    roster_out = []
    for player in roster:
        contact = alias_by_player.get(player["id"])
        roster_out.append({
            **player,
            "contactId": contact["id"] if contact else None,
            "alias": contact["alias"] if contact else None,
            "address": addresses.address("player", directory["slug"], domain, contact["alias"]) if contact else None,
        })

    lists = {}
    for kind in LIST_ORDER:
        settings = dict(directory["lists"].get(kind) or {})
        settings["address"] = addresses.address(kind, directory["slug"], domain)
        settings["recipients"] = list_members_view(kind, contacts)
        lists[kind] = settings
    player_settings = dict(directory["lists"].get("player") or {})
    player_settings["address"] = f"<name>-{directory['slug']}@{domain}"
    lists["player"] = player_settings

    return {
        "configured": True,
        "domain": domain,
        "transport": getattr(config, "MAIL_TRANSPORT", "none"),
        "inboundEnabled": config.mail_inbound_enabled(),
        "teamId": team_id,
        "slug": directory["slug"],
        "displayName": directory["displayName"],
        "addresses": team_addresses(directory, domain),
        "lists": lists,
        "contacts": contacts,
        "roster": roster_out,
        "members": members,
        "quarantineCount": len(storage.list_mail_quarantine(team_id)),
        "createdAt": directory.get("createdAt"),
        "updatedAt": directory.get("updatedAt"),
    }
