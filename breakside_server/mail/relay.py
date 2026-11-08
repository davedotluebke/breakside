"""
The relay: raw MIME in, decisions + sends + log lines out.

Used by the SQS poller (mail/inbound.py), the quarantine release endpoint,
and the dev-only inbound endpoint. Everything that decides is in policy.py
and rewrite.py; this module wires them to storage and the transport.
"""
import logging
import re
import textwrap
import threading
import time
from collections import defaultdict, deque
from dataclasses import asdict, dataclass
from email.utils import getaddresses
from urllib.parse import quote
from typing import Any, Deque, Dict, List, Optional, Sequence, Tuple

from ._shared import config, storage
from . import addresses, directory as directory_mod, policy, rewrite
from .transport import TransportError, get_transport

logger = logging.getLogger(__name__)

# Coaches get at most this many "a message was held" notices per team per
# hour. A spam wave against a published address must not become a spam wave
# against the coaches; the held messages are all still in the queue.
NOTIFY_MAX_PER_HOUR = 5
_notify_times: Dict[str, Deque[float]] = defaultdict(deque)
_notify_lock = threading.Lock()


@dataclass
class RelayResult:
    address: str
    team_id: Optional[str]
    action: str                       # relay | quarantine | drop
    reason: Optional[str] = None
    recipients: int = 0
    message_id: Optional[str] = None
    quarantine_id: Optional[str] = None
    log_id: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _base_domain() -> str:
    return getattr(config, "MAIL_BASE_DOMAIN", "") or ""


def _resolve(local: str, domain: str, slugs, event_locals) -> Optional[addresses.Target]:
    return addresses.resolve(local, domain, list_domain=config.MAIL_DOMAIN, base_domain=_base_domain(),
                             slugs=slugs, event_locals=event_locals, forwards=config.mail_forwards())


def _is_list_address(slugs, event_locals):
    """For the loop guard: does this From address name one of our lists, in
    any spelling? A system forward (``help@``) is deliberately not one."""
    def check(addr: str) -> bool:
        local, dom = addresses.split_address(addr)
        target = _resolve(local, dom, slugs, event_locals) if dom else None
        return target is not None and target.kind != "forward"
    return check


def target_addresses(msg, envelope_recipients: Optional[Sequence[str]]) -> List[Tuple[str, str]]:
    """``(local, domain)`` pairs at our domains this message was addressed
    to: the list domain, the base domain and its subdomains.

    SES hands us the envelope recipients, which is authoritative (a Bcc to a
    list shows up there and nowhere in the headers). The header scan is the
    fallback for the dev endpoint and for releases from quarantine.
    """
    found: List[Tuple[str, str]] = []

    def add(addr: str) -> None:
        local, dom = addresses.split_address(addr)
        dom = dom.rstrip(".")
        if local and addresses.is_our_domain(dom, list_domain=config.MAIL_DOMAIN, base_domain=_base_domain()) \
                and (local, dom) not in found:
            found.append((local, dom))

    for addr in envelope_recipients or []:
        add(addr)
    if not found:
        values = []
        for header in ("To", "Cc", "Delivered-To", "X-Original-To"):
            values.extend(str(v) for v in msg.get_all(header, []) if v is not None)
        for _name, addr in getaddresses(values):
            add(addr)
    return found


def _log(team_id: str, entry: Dict[str, Any]) -> str:
    return storage.append_mail_log(team_id, entry)["id"]


def process_inbound(raw: bytes, *, envelope_recipients: Optional[Sequence[str]] = None,
                    envelope_from: Optional[str] = None,
                    verdicts: Optional[Dict[str, str]] = None,
                    source: str = "sqs", force: bool = False) -> List[RelayResult]:
    """Relay one received message to every list address it was sent to.

    Every spelling of an address (``parents-cudo@team.…``, ``parents@cudo.…``,
    ``cudo@<base>``) resolves to the same list; from here on ``local`` is the
    canonical list-spelling local part, which is what every log row,
    quarantine record and ``X-Breakside-List`` carries, and ``address`` the
    spelling the deployment prefers, which is what goes out as From.

    ``force`` is the quarantine-release path (sender allow-list and post
    policy skipped; loop and enablement checks still apply).
    """
    domain = config.MAIL_DOMAIN
    msg = rewrite.parse_message(raw)
    author_name, author_email = rewrite.sender_of(msg)
    headers = rewrite.header_map(msg)
    subject = str(msg.get("Subject", "") or "")[:200]
    message_id = str(msg.get("Message-ID", "") or "")[:200]
    slugs = storage.list_mail_slugs()
    event_locals = storage.list_mail_event_locals()
    is_own = _is_list_address(slugs.keys(), event_locals)

    results: List[Optional[RelayResult]] = []
    # Player aliases of one team addressed by the same message are relayed
    # together (see _relay_player_group), so a coach behind every alias gets
    # one copy, not one per player. Their slots in ``results`` are filled in
    # afterwards so the order still follows the envelope.
    pending: Dict[str, List[_PlayerTarget]] = {}
    seen_locals: set = set()
    for local_in, dom in target_addresses(msg, envelope_recipients):
        target = _resolve(local_in, dom, slugs.keys(), event_locals)
        if target is None:
            address = f"{local_in}@{dom}"
            logger.info("mail: dropped message to unknown address %s from %s", address, addresses.mask_address(author_email))
            results.append(RelayResult(address, None, "drop", "unknown-address"))
            continue
        if target.kind == "forward":
            results.append(_forward(raw, target, headers, envelope_from, verdicts, author_name, author_email, is_own))
            continue
        kind, slug, alias = target.kind, target.slug, target.alias
        local = target.local
        if local in seen_locals:
            # The same list under two spellings on one envelope is one list.
            continue
        seen_locals.add(local)
        address = directory_mod.preferred_address(kind, slug, alias)
        team_id = slugs[slug]
        directory = storage.get_mail_directory(team_id)
        if directory is None:
            results.append(RelayResult(address, team_id, "drop", "no-directory"))
            continue

        base_entry = {
            "list": local, "kind": kind, "alias": alias,
            "from": author_email or envelope_from, "fromName": author_name,
            "subject": subject, "messageId": message_id, "source": source,
            "verdicts": verdicts or None,
        }

        loop = policy.loop_reason(headers, domain, envelope_from=envelope_from, is_own=is_own)
        if loop:
            log_id = _log(team_id, {**base_entry, "action": "dropped", "recipients": 0, "reason": loop})
            results.append(RelayResult(address, team_id, "drop", loop, log_id=log_id))
            continue

        verdict = policy.verdict_reason(verdicts) if not force else None
        if verdict and verdict[0] == "drop":
            log_id = _log(team_id, {**base_entry, "action": "dropped", "recipients": 0, "reason": verdict[1]})
            results.append(RelayResult(address, team_id, "drop", verdict[1], log_id=log_id))
            continue

        contacts = directory_mod.effective_contacts(team_id, directory)
        decision = policy.decide(directory, kind, alias, author_email, contacts, force=force)
        if verdict and decision.action == "relay":
            decision.action, decision.reason = "quarantine", verdict[1]

        if decision.action == "relay" and kind == "player":
            pending.setdefault(team_id, []).append(
                _PlayerTarget(len(results), local, directory, decision, base_entry))
            results.append(None)
        elif decision.action == "relay":
            results.append(_relay(raw, team_id, directory, decision, local, domain,
                                  author_name, author_email, base_entry))
        elif decision.action == "quarantine":
            results.append(_quarantine(raw, team_id, directory, decision, local, domain,
                                       contacts, base_entry))
        else:
            log_id = _log(team_id, {**base_entry, "action": "dropped", "recipients": 0,
                                    "reason": decision.reason})
            results.append(RelayResult(address, team_id, "drop", decision.reason, log_id=log_id))
    for team_id, targets in pending.items():
        grouped = _relay_player_group(raw, team_id, targets, domain, author_name, author_email)
        for target, result in zip(targets, grouped):
            results[target.index] = result
    return [r for r in results if r is not None]


def _forward(raw, target: addresses.Target, headers, envelope_from, verdicts,
             author_name, author_email, is_own) -> RelayResult:
    """Relay a system forward (``help@<base>``) to its one configured recipient.

    Open to any sender — nobody reviews a quarantine for the support address,
    so what SES's scan says to hold (a DMARC failure) is dropped instead —
    with the From rewritten like any list, Reply-To the author and the To
    header untouched, so the recipient's mail client picks its "send as"
    identity from it and a reply comes from the support address as before.
    No List-* headers (``rewrite_message(list_headers=False)``); our own
    ``X-Breakside-List`` marker still catches the mail coming back. There is
    no team, so the only record is the journal line; a bounce of the
    recipient is likewise journal-only (``inbound.py`` finds no contact to
    stamp) and never suppresses the next forward.
    """
    address = f"{target.local}@{_base_domain()}"
    masked = addresses.mask_address(author_email)
    loop = policy.loop_reason(headers, _base_domain(), envelope_from=envelope_from, is_own=is_own, forward=True)
    if loop:
        logger.info("mail: dropped forward to %s from %s (%s)", address, masked, loop)
        return RelayResult(address, None, "drop", loop)
    verdict = policy.verdict_reason(verdicts)
    if verdict:
        logger.info("mail: dropped forward to %s from %s (%s)", address, masked, verdict[1])
        return RelayResult(address, None, "drop", verdict[1])
    out = rewrite.rewrite_message(
        raw,
        list_address=address,
        list_display=f"Breakside {target.local.capitalize()}",
        subject_tag="",
        reply_to_mode="author",
        author=(author_name, author_email),
        list_key=target.local,
        list_headers=False,
    )
    try:
        provider_id = get_transport().send(from_addr=address, recipients=[target.forward_to], raw=out)
    except TransportError as exc:
        logger.error("mail: forward %s failed: %s", address, exc)
        raise
    logger.info("mail: forwarded %s from %s", address, masked)
    return RelayResult(address, None, "relay", None, 1, provider_id)


def _team_display(directory: Dict[str, Any]) -> str:
    return directory.get("displayName") or directory["slug"]


def _list_display(directory: Dict[str, Any], decision: policy.Decision) -> str:
    """The list's human name, role first: "Coaches CUDO F26", "Cyrus Luebke (CUDO F26)".

    Gmail's threaded view abbreviates a sender to the first word of the
    display name, so the word that carries the information has to come
    first: "Coaches", "Parents", or the player's name — not the team.
    """
    name = _team_display(directory)
    kind = decision.kind
    if kind == "player" and decision.player:
        return f"{decision.player['name']} ({name})"
    if kind == "event" and decision.event:
        return f"{decision.event['name']} ({name})"
    prefix = {"parents": "Parents", "coaches": "Coaches", "staff": "Staff", "players": "Players"}.get(kind)
    return f"{prefix} {name}" if prefix else name


def _also_reply_to(author_name: str, author_email: str, recipients) -> Optional[tuple]:
    """The author as an extra Reply-To when they are not among ``recipients``.

    An author who is not on the list (a parent writing to the coaches, a
    coach writing to another player's alias) would otherwise never see a
    reply: Reply-To is the list, and they are not on it.
    """
    if not author_email:
        return None
    reachable = {addresses.normalize_email(c.get("email") or "") for c in recipients}
    if addresses.normalize_email(author_email) in reachable:
        return None
    return (author_name, author_email)


def _log_action(base_entry: Dict[str, Any]) -> str:
    # A quarantine release is logged as "released" rather than "relayed" so
    # the coach's activity view shows one row per message, not two.
    return "released" if base_entry.get("source") == "release" else "relayed"


def _relay(raw, team_id, directory, decision, local, domain, author_name, author_email, base_entry) -> RelayResult:
    """One send to everyone on a group list (parents, coaches, staff, all).

    ``local`` is the canonical list key; the From address is the preferred
    spelling, while List-Id keeps the key at the list domain so parents'
    filters survive a change of spelling."""
    address = directory_mod.preferred_address(decision.kind, directory["slug"], decision.alias)
    settings = decision.list_settings
    total = len(decision.recipients)
    out = rewrite.rewrite_message(
        raw,
        list_address=address,
        list_display=_list_display(directory, decision),
        subject_tag=settings.get("subjectTag", ""),
        reply_to_mode=settings.get("replyTo", "list"),
        coaches_address=directory_mod.preferred_address("coaches", directory["slug"]),
        coaches_display=f"Coaches {_team_display(directory)}",
        author=(author_name, author_email),
        also_reply_to=_also_reply_to(author_name, author_email, decision.recipients),
        list_key=local,
        list_id_domain=domain,
    )
    emails = [c["email"] for c in decision.recipients]
    try:
        provider_id = get_transport().send(from_addr=address, recipients=emails, raw=out)
    except TransportError as exc:
        logger.error("mail: relay to %s failed: %s", address, exc)
        _log(team_id, {**base_entry, "action": "failed", "recipients": total, "reason": str(exc)[:200]})
        raise
    # providerIds: every SES message id this relay produced, so a bounce
    # notification (which names the id of the send that bounced) can be tied
    # back to this row; providerId stays the first for older readers.
    log_id = _log(team_id, {**base_entry, "action": _log_action(base_entry), "recipients": total,
                            "reason": None, "providerId": provider_id, "providerIds": [provider_id],
                            "senderKinds": decision.sender_kinds, "copies": None})
    logger.info("mail: relayed %s from %s to %d recipient(s)", address, addresses.mask_address(author_email), total)
    return RelayResult(address, team_id, "relay", None, total, provider_id, log_id=log_id)


@dataclass
class _PlayerTarget:
    """One player alias of a message, awaiting the team's grouped relay."""
    index: int                      # its slot in process_inbound's results
    local: str
    directory: Dict[str, Any]
    decision: policy.Decision
    base_entry: Dict[str, Any]


# Subject markers per recipient role on a player-alias copy. The player's own
# copy is unmarked; anything else (an unexpected kind) goes unmarked too.
COPY_MARKERS = {"guardian": rewrite.PARENT_COPY_MARKER, "coach": rewrite.COACH_COPY_MARKER}
# When one address is behind several aliases in different roles (a coach who
# is also a parent of one of the players), the copy reads as the closer role.
_ROLE_RANK = {"player": 0, "guardian": 1}


def _player_display(player: Optional[Dict[str, Any]], team_name: str) -> str:
    return f"{player['name']} ({team_name})" if player else team_name


def _players_display(players: List[Dict[str, Any]], team_name: str) -> str:
    """"Alice Smith, Bob Jones (CUDO)" for a copy that covers several
    aliases; past three players, "4 players (CUDO)"."""
    names = [p["name"] for p in players if p]
    if not names:
        return team_name
    if len(names) > 3:
        return f"{len(names)} players ({team_name})"
    return f"{', '.join(names)} ({team_name})"


def _relay_player_group(raw, team_id, targets: List[_PlayerTarget], domain,
                        author_name, author_email) -> List[RelayResult]:
    """Relay one message to every player alias of one team it was sent to.

    Mail to a player's alias goes out as separate copies by role, each
    reading as what it is: the player's own, the guardians' (subject marked
    ``[Parent copy]``) and the coaches' (``[Coach copy]``). Across the
    aliases the message was sent to, every address receives ONE copy: a
    coach (behind every alias) or a parent of two of the players gets a
    single mail whose From names all the players it covers and whose
    Reply-To lists all their aliases, so a reply still reaches every family
    and comes back through this same path, where it is grouped again.

    Returns one result per target, in order; one activity-log row per alias.
    """
    directory = targets[0].directory
    settings = targets[0].decision.list_settings
    team_name = _team_display(directory)
    coaches_address = directory_mod.preferred_address("coaches", directory["slug"])
    by_local = {t.local: t for t in targets}
    slug = directory["slug"]

    def alias_address(target: _PlayerTarget) -> str:
        return directory_mod.preferred_address("player", slug, target.decision.alias)

    # address → its role and the aliases it is behind, in envelope order
    reach: Dict[str, Dict[str, Any]] = {}
    for target in targets:
        for contact in target.decision.recipients:
            kind = contact.get("kind", "coach")
            entry = reach.setdefault(contact["email"], {"kind": kind, "locals": []})
            if _ROLE_RANK.get(kind, 9) < _ROLE_RANK.get(entry["kind"], 9):
                entry["kind"] = kind
            if target.local not in entry["locals"]:
                entry["locals"].append(target.local)
    # one send per (role, set of aliases)
    sends: Dict[tuple, List[str]] = {}
    for email, entry in reach.items():
        sends.setdefault((entry["kind"], tuple(entry["locals"])), []).append(email)

    copies: Dict[str, Dict[str, int]] = {t.local: {} for t in targets}
    provider_ids: List[str] = []
    for (kind, locals_), emails in sends.items():
        covered = [by_local[local] for local in locals_]
        address = alias_address(covered[0])
        players = [t.decision.player for t in covered]
        out = rewrite.rewrite_message(
            raw,
            list_address=address,
            list_display=_players_display(players, team_name),
            subject_tag=settings.get("subjectTag", ""),
            reply_to_mode=settings.get("replyTo", "list"),
            coaches_address=coaches_address,
            coaches_display=f"Coaches {team_name}",
            author=(author_name, author_email),
            subject_marker=COPY_MARKERS.get(kind, ""),
            also_reply_to=_also_reply_to(author_name, author_email,
                                         [c for t in covered for c in t.decision.recipients]),
            reply_to_lists=[(_player_display(p, team_name), alias_address(t))
                            for t, p in zip(covered, players)],
            list_key=locals_[0],
            list_id_domain=domain,
        )
        try:
            sent_id = get_transport().send(from_addr=address, recipients=emails, raw=out)
        except TransportError as exc:
            logger.error("mail: relay to %s (%s copy) failed: %s", address, kind, exc)
            for target in targets:
                _log(team_id, {**target.base_entry, "action": "failed",
                               "recipients": len(target.decision.recipients),
                               "reason": str(exc)[:200], "copies": copies[target.local]})
            raise
        if sent_id:
            provider_ids.append(sent_id)
        for local in locals_:
            copies[local][kind] = copies[local].get(kind, 0) + len(emails)

    provider_id = provider_ids[0] if provider_ids else None
    results = []
    for target in targets:
        total = len(target.decision.recipients)
        address = alias_address(target)
        others = [t.local for t in targets if t is not target]
        # Every send's id goes on every alias's row: a coach copy covering two
        # aliases can bounce, and either row should show it.
        log_id = _log(team_id, {**target.base_entry, "action": _log_action(target.base_entry),
                                "recipients": total, "reason": None, "providerId": provider_id,
                                "providerIds": provider_ids,
                                "senderKinds": target.decision.sender_kinds,
                                "copies": copies[target.local],
                                "sharedWith": others or None})
        logger.info("mail: relayed %s from %s to %d recipient(s)%s", address,
                    addresses.mask_address(author_email), total,
                    f" (one copy each with {', '.join(others)})" if others else "")
        results.append(RelayResult(address, team_id, "relay", None, total, provider_id, log_id=log_id))
    return results


def _quarantine(raw, team_id, directory, decision, local, domain, contacts, base_entry) -> RelayResult:
    address = directory_mod.preferred_address(decision.kind, directory["slug"], decision.alias)
    item = storage.add_mail_quarantine(team_id, {
        "list": local, "kind": decision.kind, "alias": decision.alias,
        "from": base_entry["from"], "fromName": base_entry["fromName"],
        "subject": base_entry["subject"], "messageId": base_entry["messageId"],
        "reason": decision.reason, "verdicts": base_entry["verdicts"],
        "source": base_entry["source"],
    }, raw)
    log_id = _log(team_id, {**base_entry, "action": "quarantined", "recipients": 0,
                            "reason": decision.reason, "quarantineId": item["id"]})
    logger.info("mail: held message to %s from %s (%s)", address, addresses.mask_address(base_entry["from"]), decision.reason)
    _notify_quarantine(team_id, directory, contacts, item, domain, excerpt=rewrite.excerpt(raw), address=address)
    return RelayResult(address, team_id, "quarantine", decision.reason, quarantine_id=item["id"], log_id=log_id)


REASON_TEXT = {
    "unknown-sender": "the sender's address is not in the team directory",
    "not-allowed-to-post": "the sender is in the directory but may not post to this list",
    "not-on-event": "the sender is in the directory but not on this event's list",
    "dmarc-fail": "the sender's mail provider says the message did not come from them (possible spoof)",
    "auth-fail": "the message failed both sender checks (possible spoof)",
    "list-disabled": "this list is turned off",
    "unknown-alias": "no player has this address",
    "too-many-recipients": "the recipient list is implausibly large",
}


def review_url(team_id: str) -> str:
    """Where a held-mail notice sends the coach: the app, opening the team's
    Email Lists screen (utils/deepLink.js reads ``open`` and ``team``)."""
    base = config.MAIL_APP_URL
    return f"{base}{'&' if '?' in base else '?'}open=mail&team={quote(team_id, safe='')}"


def _notify_quarantine(team_id: str, directory: Dict[str, Any], contacts, item: Dict[str, Any], domain: str,
                       *, excerpt: str = "", address: Optional[str] = None) -> None:
    coach_addresses = [a for c in contacts if c.get("kind") == "coach" for a in policy.deliverable_addresses(c)]
    if not coach_addresses:
        return
    now = time.time()
    with _notify_lock:
        times = _notify_times[team_id]
        while times and now - times[0] > 3600:
            times.popleft()
        if len(times) >= NOTIFY_MAX_PER_HOUR:
            logger.info("mail: quarantine notice for %s suppressed (rate limit)", team_id)
            return
        times.append(now)

    coaches_address = directory_mod.preferred_address("coaches", directory["slug"])
    held_address = address or f"{item['list']}@{domain}"
    why = REASON_TEXT.get(item.get("reason") or "", item.get("reason") or "held for review")
    # The opening of the message, so the coaches can tell whose question it
    # is (and whether it is for them at all) from the notice alone.
    begins = (f"It begins:\n\n{textwrap.fill(excerpt, 72, initial_indent='    ', subsequent_indent='    ')}\n\n"
              if excerpt else "It has no readable text (an attachment or image only, perhaps).\n\n")
    body = (
        f"A message to {held_address} was held and not delivered.\n\n"
        f"From:    {item.get('fromName') or ''} <{item.get('from') or 'unknown'}>\n"
        f"Subject: {item.get('subject') or '(no subject)'}\n"
        f"Reason:  {why}\n\n"
        f"{begins}"
        f"Review it in Breakside (this link opens the team's Email Lists):\n{review_url(team_id)}\n\n"
        f"Held messages are discarded automatically after {storage.mail_storage.QUARANTINE_TTL_DAYS} days.\n"
    )
    raw = rewrite.build_notice(
        from_address=coaches_address,
        from_display=f"Breakside ({_team_display(directory)})",
        to_address=coaches_address,
        subject=f"[Held] {item.get('subject') or '(no subject)'}",
        body=body,
        list_local=f"coaches-{directory['slug']}",
    )
    try:
        get_transport().send(from_addr=coaches_address, recipients=coach_addresses, raw=raw)
    except TransportError as exc:
        logger.error("mail: quarantine notice for %s failed: %s", team_id, exc)


def release_quarantine(team_id: str, item_id: str, *, add_sender: Optional[Dict[str, Any]] = None) -> List[RelayResult]:
    """Relay a held message after a coach's review, then discard the hold.

    ``add_sender`` optionally adds the sender to the directory first (kind,
    name, playerIds) so their next message goes straight through.
    """
    found = storage.get_mail_quarantine(team_id, item_id)
    if found is None:
        raise KeyError(item_id)
    item, raw = found
    if add_sender and item.get("from"):
        storage.add_mail_contact(team_id, {**add_sender, "email": item["from"]})
    address = f"{item['list']}@{config.MAIL_DOMAIN}"
    results = process_inbound(raw, envelope_recipients=[address], source="release", force=True)
    storage.remove_mail_quarantine(team_id, item_id)
    return results


def send_test_message(team_id: str, to_email: str, requester: str) -> str:
    """Send the requesting coach a message from the team address, proving
    the outbound path works. Returns the provider id."""
    directory = storage.get_mail_directory(team_id)
    if directory is None:
        raise FileNotFoundError(team_id)
    from_address = directory_mod.preferred_address("all", directory["slug"])
    coaches_address = directory_mod.preferred_address("coaches", directory["slug"])
    body = (
        f"This is a test message from your team's mailing lists.\n\n"
        f"Requested by {requester}. If you can read this, outbound mail from "
        f"{from_address} works. Reply to this message to test the inbound path: "
        f"your reply goes to the coaches list.\n"
    )
    raw = rewrite.build_notice(
        from_address=from_address,
        from_display=f"Breakside ({_team_display(directory)})",
        to_address=to_email,
        subject=f"{directory['lists'].get('all', {}).get('subjectTag', '')} Test message".strip(),
        body=body,
        list_local=directory["slug"],
    )
    # A test must be answerable: strip the auto-generated marker so a reply
    # to it is a normal human message, and point the reply at the coaches.
    raw = re.sub(rb"(?im)^Auto-Submitted:.*\r?\n", b"", raw, count=1)
    raw = raw.replace(b"\r\n\r\n", f"\r\nReply-To: {coaches_address}\r\n\r\n".encode(), 1) \
        if b"\r\n\r\n" in raw else raw.replace(b"\n\n", f"\nReply-To: {coaches_address}\n\n".encode(), 1)
    provider_id = get_transport().send(from_addr=from_address, recipients=[to_email], raw=raw)
    storage.append_mail_log(team_id, {
        "action": "test", "list": directory["slug"], "from": from_address, "fromName": requester,
        "subject": "Test message", "recipients": 1, "reason": None, "providerId": provider_id,
        "source": "api",
    })
    return provider_id
