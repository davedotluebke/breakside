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
    out["eventPattern"] = f"{slug}-<event>@{domain}"
    return out


def list_members_view(kind: str, contacts: List[Dict[str, Any]], alias: Optional[str] = None,
                      event: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Who a list currently delivers to, for the admin screen."""
    from . import policy
    expanded = policy.recipients_for(kind, contacts, alias=alias, event=event) or []
    return [{"id": c["id"], "name": c["name"], "email": c["email"], "kind": c["kind"]} for c in expanded]


def tournament_events(team_id: str) -> List[Dict[str, Any]]:
    """The team's tournament events, newest first, as the event-list form
    offers them: id, name, status and how many players / pickups the event
    roster holds."""
    try:
        events = storage.list_team_events(team_id)
    except (FileNotFoundError, ValueError):
        return []
    out = []
    for e in events:
        roster = e.get("roster") or {}
        out.append({
            "id": e["id"], "name": e.get("name") or e["id"], "status": e.get("status") or "open",
            "playerCount": len(roster.get("playerIds") or []),
            "pickupCount": len(roster.get("pickupPlayers") or []),
        })
    return out


def event_view(directory: Dict[str, Any], event: Dict[str, Any], contacts: List[Dict[str, Any]],
               domain: Optional[str] = None) -> Dict[str, Any]:
    """One event list as the admin screen renders it: the record plus its
    address and who it reaches right now."""
    domain = domain or config.MAIL_DOMAIN
    return {
        **event,
        "address": addresses.address("event", directory["slug"], domain, event["slug"]),
        "recipients": list_members_view("event", contacts, event=event),
    }


def sync_event_roster(team_id: str, mail_event_id: str) -> Dict[str, Any]:
    """Copy the linked tournament event's roster onto the event list: the
    roster players going replace ``playerIds``; each pickup player on the
    tournament roster who is not yet on the list is added by name (no
    address yet — the coach fills those in). Returns ``{playerIds, added}``.

    Raises KeyError for an unknown list, ValueError when it has no linked
    tournament event or that event is gone.
    """
    mail_event = storage.get_mail_event(team_id, mail_event_id)
    if mail_event is None:
        raise KeyError(mail_event_id)
    if not mail_event.get("eventId"):
        raise ValueError("This list is not linked to a tournament event.")
    try:
        event = storage.get_event(mail_event["eventId"])
    except (FileNotFoundError, ValueError):
        raise ValueError("The linked tournament event no longer exists.")
    if event.get("teamId") != team_id:
        raise ValueError("The linked tournament event belongs to another team.")
    roster = event.get("roster") or {}
    on_team = {p["id"] for p in roster_players(team_id)}
    player_ids = [p for p in (roster.get("playerIds") or []) if p in on_team]
    updated = storage.update_mail_event(team_id, mail_event_id, {"playerIds": player_ids})
    have = {c["playerIds"][0] for c in updated["contacts"] if c["kind"] == "player" and c.get("playerIds")}
    added = []
    for pickup in roster.get("pickupPlayers") or []:
        pid = pickup.get("id")
        name = (pickup.get("name") or "").strip()
        if not pid or not name or pid in have:
            continue
        added.append(storage.add_mail_event_contact(team_id, mail_event_id, {
            "kind": "player", "name": name, "playerIds": [pid],
        }))
        have.add(pid)
    return {"playerIds": player_ids, "added": added}


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
    events = [event_view(directory, e, contacts, domain) for e in directory.get("events") or []]

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
        "events": events,
        "tournamentEvents": tournament_events(team_id),
        "quarantineCount": len(storage.list_mail_quarantine(team_id)),
        "createdAt": directory.get("createdAt"),
        "updatedAt": directory.get("updatedAt"),
    }


def lookup_address(team_id: str, email: str) -> Dict[str, Any]:
    """Why one address can (or cannot) post to and receive from each list.

    The answer the admin screen gives when a coach types an address into
    the directory search: which contacts carry it (and whether it is their
    first address or a later one, which is how a parent entered as a second
    address on their partner's card stays invisible in a long list), what
    the relay would do with mail from it, and which lists deliver to it.
    Computed with the relay's own rules (policy.find_contacts_by_email,
    may_post, recipients_for) so the screen can never disagree with what
    the relay actually does.
    """
    from . import policy
    email = addresses.normalize_email(email)
    directory = storage.get_mail_directory(team_id)
    if directory is None:
        return {"email": email, "configured": False}
    domain = config.MAIL_DOMAIN
    contacts = effective_contacts(team_id, directory)
    names = {p["id"]: p["name"] for p in roster_players(team_id)}

    carriers = [c for c in contacts if email in policy.contact_addresses(c)]
    active = policy.find_contacts_by_email(contacts, email)
    sender_kinds = sorted({c["kind"] for c in active})
    out_contacts = []
    for c in carriers:
        held = policy.contact_addresses(c)
        out_contacts.append({
            "id": c["id"],
            "name": c["name"],
            "kind": c["kind"],
            "status": c.get("status", "active"),
            "derived": bool(c.get("derived")),
            "addressIndex": held.index(email) + 1,
            "addressCount": len(held),
            "playerNames": [names.get(pid, pid) for pid in (c.get("playerIds") or [])],
            "alias": c.get("alias"),
            "deliverable": email in policy.deliverable_addresses(c),
        })

    lists = directory.get("lists") or {}
    may_post: List[str] = []
    receives: List[str] = []
    for kind in LIST_ORDER:
        settings = lists.get(kind) or {}
        if not settings.get("enabled", kind != "players"):
            continue
        if active and policy.may_post(settings, sender_kinds):
            may_post.append(kind)
        expanded = policy.recipients_for(kind, contacts) or []
        if any(e["email"] == email for e in expanded):
            receives.append(kind)

    player_settings = lists.get("player") or {}
    player_addresses = []
    if player_settings.get("enabled", True):
        for c in contacts:
            if c.get("kind") != "player" or not c.get("alias"):
                continue
            expanded = policy.recipients_for("player", contacts, alias=c["alias"]) or []
            if any(e["email"] == email for e in expanded):
                player_id = (c.get("playerIds") or [None])[0]
                player_addresses.append({
                    "alias": c["alias"],
                    "address": addresses.address("player", directory["slug"], domain, c["alias"]),
                    "playerName": names.get(player_id, player_id),
                })
    may_post_players = bool(active) and player_settings.get("enabled", True) \
        and policy.may_post(player_settings, sender_kinds)

    # Event lists. A pickup player or their parent exists only on an event
    # list, so without this the answer would be "not in the directory" for
    # an address the relay accepts (for that list). Same rules as decide():
    # known senders are the directory plus the event's own contacts, and a
    # poster must also be someone the list reaches.
    events_out = []
    for ev in directory.get("events") or []:
        ev_contacts = list(ev.get("contacts") or [])
        ev_names = dict(names)
        ev_names.update({c["playerIds"][0]: c["name"] for c in ev_contacts
                         if c.get("kind") == "player" and c.get("playerIds")})
        ev_carriers = [c for c in ev_contacts if email in policy.contact_addresses(c)]
        members = policy.event_members(ev, contacts)
        member_addresses = {a for c in members for a in policy.contact_addresses(c)}
        expanded = policy.recipients_for("event", contacts, event=ev) or []
        ev_receives = any(e["email"] == email for e in expanded)
        ev_active = policy.find_contacts_by_email(contacts + ev_contacts, email)
        ev_kinds = sorted({c["kind"] for c in ev_active})
        enabled = ev.get("enabled", True)
        ev_may_post = bool(enabled and ev_active and policy.may_post(ev, ev_kinds) and email in member_addresses)
        if not (ev_carriers or ev_receives or ev_may_post):
            continue
        events_out.append({
            "id": ev["id"],
            "name": ev.get("name") or ev.get("slug"),
            "slug": ev.get("slug"),
            "address": addresses.address("event", directory["slug"], domain, ev.get("slug")),
            "enabled": enabled,
            "mayPost": ev_may_post,
            "receives": ev_receives,
            "contacts": [{
                "id": c["id"],
                "name": c["name"],
                "kind": c["kind"],
                "status": c.get("status", "active"),
                "addressIndex": policy.contact_addresses(c).index(email) + 1,
                "addressCount": len(policy.contact_addresses(c)),
                "playerNames": [ev_names.get(pid, pid) for pid in (c.get("playerIds") or [])],
                "deliverable": email in policy.deliverable_addresses(c),
            } for c in ev_carriers],
        })

    member = None
    for membership in storage.get_team_memberships(team_id):
        user = storage.get_user(membership["userId"]) or {}
        if (user.get("email") or "").strip().lower() == email:
            member = {"userId": membership["userId"], "role": membership.get("role"),
                      "displayName": user.get("displayName")}
            break

    return {
        "email": email,
        "configured": True,
        "contacts": out_contacts,
        "senderKinds": sender_kinds,
        "mayPost": may_post,
        "mayPostToPlayerAddresses": may_post_players,
        "receives": receives,
        "playerAddresses": player_addresses,
        "events": events_out,
        "member": member,
    }
