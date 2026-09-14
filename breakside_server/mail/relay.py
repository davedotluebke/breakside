"""
The relay: raw MIME in, decisions + sends + log lines out.

Used by the SQS poller (mail/inbound.py), the quarantine release endpoint,
and the dev-only inbound endpoint. Everything that decides is in policy.py
and rewrite.py; this module wires them to storage and the transport.
"""
import logging
import re
import threading
import time
from collections import defaultdict, deque
from dataclasses import asdict, dataclass
from email.utils import getaddresses
from typing import Any, Deque, Dict, List, Optional, Sequence

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


def target_locals(msg, envelope_recipients: Optional[Sequence[str]], domain: str) -> List[str]:
    """Local parts at our domain this message was addressed to.

    SES hands us the envelope recipients, which is authoritative (a Bcc to a
    list shows up there and nowhere in the headers). The header scan is the
    fallback for the dev endpoint and for releases from quarantine.
    """
    domain = domain.lower()
    found: List[str] = []

    def add(addr: str) -> None:
        local, dom = addresses.split_address(addr)
        if dom == domain and local and local not in found:
            found.append(local)

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

    results: List[RelayResult] = []
    for local in target_locals(msg, envelope_recipients, domain):
        address = f"{local}@{domain}"
        parsed = addresses.parse_local_part(local, slugs.keys())
        if parsed is None:
            logger.info("mail: dropped message to unknown address %s from %s", address, author_email)
            results.append(RelayResult(address, None, "drop", "unknown-address"))
            continue
        kind, slug, alias = parsed
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

        loop = policy.loop_reason(headers, domain)
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

        if decision.action == "relay":
            results.append(_relay(raw, team_id, directory, decision, local, domain,
                                  author_name, author_email, base_entry))
        elif decision.action == "quarantine":
            results.append(_quarantine(raw, team_id, directory, decision, local, domain,
                                       contacts, base_entry))
        else:
            log_id = _log(team_id, {**base_entry, "action": "dropped", "recipients": 0,
                                    "reason": decision.reason})
            results.append(RelayResult(address, team_id, "drop", decision.reason, log_id=log_id))
    return results


def _list_display(directory: Dict[str, Any], decision: policy.Decision) -> str:
    name = directory.get("displayName") or directory["slug"]
    kind = decision.kind
    if kind == "player" and decision.player:
        return f"{name} ({decision.player['name']})"
    suffix = {"parents": "Parents", "coaches": "Coaches", "staff": "Staff", "players": "Players"}.get(kind)
    return f"{name} {suffix}" if suffix else name


def _recipient_groups(decision: policy.Decision) -> List[tuple]:
    """``[(group, contacts, subject_marker), …]`` — one send per group.

    Mail to a player's alias goes out as separate copies: the player's own,
    the guardians' (subject marked ``[Parent copy]``) and the coaches'
    (``[Coach copy]``), so each reads as what it is. Every other list is a
    single unmarked send.
    """
    if decision.kind != "player":
        return [("all", list(decision.recipients), "")]
    by_kind: Dict[str, list] = {"player": [], "guardian": [], "coach": []}
    for contact in decision.recipients:
        by_kind.setdefault(contact.get("kind", "coach"), []).append(contact)
    return [
        ("player", by_kind.pop("player"), ""),
        ("guardian", by_kind.pop("guardian"), rewrite.PARENT_COPY_MARKER),
        ("coach", by_kind.pop("coach"), rewrite.COACH_COPY_MARKER),
    ] + [(kind, contacts, "") for kind, contacts in by_kind.items()]


def _relay(raw, team_id, directory, decision, local, domain, author_name, author_email, base_entry) -> RelayResult:
    address = f"{local}@{domain}"
    settings = decision.list_settings
    coaches_address = addresses.address("coaches", directory["slug"], domain)
    total = len(decision.recipients)
    copies: Dict[str, int] = {}
    provider_id: Optional[str] = None
    # An author who is not on the list (a parent writing to the coaches, a
    # coach writing to another player's alias) would otherwise never see a
    # reply: Reply-To is the list, and they are not on it. Add them.
    recipient_addresses = {addresses.normalize_email(c.get("email") or "") for c in decision.recipients}
    also_reply_to = None
    if author_email and addresses.normalize_email(author_email) not in recipient_addresses:
        also_reply_to = (author_name, author_email)
    for group, contacts, marker in _recipient_groups(decision):
        if not contacts:
            continue
        out = rewrite.rewrite_message(
            raw,
            list_address=address,
            list_display=_list_display(directory, decision),
            subject_tag=settings.get("subjectTag", ""),
            reply_to_mode=settings.get("replyTo", "list"),
            coaches_address=coaches_address,
            author=(author_name, author_email),
            subject_marker=marker,
            also_reply_to=also_reply_to,
        )
        emails = [c["email"] for c in contacts]
        try:
            sent_id = get_transport().send(from_addr=address, recipients=emails, raw=out)
        except TransportError as exc:
            logger.error("mail: relay to %s (%s copy) failed: %s", address, group, exc)
            _log(team_id, {**base_entry, "action": "failed", "recipients": total,
                           "reason": str(exc)[:200], "copies": copies})
            raise
        provider_id = provider_id or sent_id
        copies[group] = len(emails)
    # A quarantine release is logged as "released" rather than "relayed" so
    # the coach's activity view shows one row per message, not two.
    action = "released" if base_entry.get("source") == "release" else "relayed"
    log_id = _log(team_id, {**base_entry, "action": action, "recipients": total,
                            "reason": None, "providerId": provider_id,
                            "senderKinds": decision.sender_kinds,
                            "copies": copies if decision.kind == "player" else None})
    logger.info("mail: relayed %s from %s to %d recipient(s)", address, author_email, total)
    return RelayResult(address, team_id, "relay", None, total, provider_id, log_id=log_id)


def _quarantine(raw, team_id, directory, decision, local, domain, contacts, base_entry) -> RelayResult:
    address = f"{local}@{domain}"
    item = storage.add_mail_quarantine(team_id, {
        "list": local, "kind": decision.kind, "alias": decision.alias,
        "from": base_entry["from"], "fromName": base_entry["fromName"],
        "subject": base_entry["subject"], "messageId": base_entry["messageId"],
        "reason": decision.reason, "verdicts": base_entry["verdicts"],
        "source": base_entry["source"],
    }, raw)
    log_id = _log(team_id, {**base_entry, "action": "quarantined", "recipients": 0,
                            "reason": decision.reason, "quarantineId": item["id"]})
    logger.info("mail: held message to %s from %s (%s)", address, base_entry["from"], decision.reason)
    _notify_quarantine(team_id, directory, contacts, item, domain)
    return RelayResult(address, team_id, "quarantine", decision.reason, quarantine_id=item["id"], log_id=log_id)


REASON_TEXT = {
    "unknown-sender": "the sender's address is not in the team directory",
    "not-allowed-to-post": "the sender is in the directory but may not post to this list",
    "dmarc-fail": "the sender's mail provider says the message did not come from them (possible spoof)",
    "auth-fail": "the message failed both sender checks (possible spoof)",
    "list-disabled": "this list is turned off",
    "unknown-alias": "no player has this address",
    "too-many-recipients": "the recipient list is implausibly large",
}


def _notify_quarantine(team_id: str, directory: Dict[str, Any], contacts, item: Dict[str, Any], domain: str) -> None:
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

    coaches_address = addresses.address("coaches", directory["slug"], domain)
    why = REASON_TEXT.get(item.get("reason") or "", item.get("reason") or "held for review")
    body = (
        f"A message to {item['list']}@{domain} was held and not delivered.\n\n"
        f"From:    {item.get('fromName') or ''} <{item.get('from') or 'unknown'}>\n"
        f"Subject: {item.get('subject') or '(no subject)'}\n"
        f"Reason:  {why}\n\n"
        f"Review it under Team Settings → Email Lists in Breakside:\n{config.MAIL_APP_URL}\n\n"
        f"Held messages are discarded automatically after {storage.mail_storage.QUARANTINE_TTL_DAYS} days.\n"
    )
    raw = rewrite.build_notice(
        from_address=coaches_address,
        from_display=f"{directory.get('displayName') or directory['slug']} team mail",
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
    domain = config.MAIL_DOMAIN
    from_address = addresses.address("all", directory["slug"], domain)
    body = (
        f"This is a test message from your team's mailing lists.\n\n"
        f"Requested by {requester}. If you can read this, outbound mail from "
        f"{from_address} works. Reply to this message to test the inbound path: "
        f"your reply goes to the coaches list.\n"
    )
    raw = rewrite.build_notice(
        from_address=from_address,
        from_display=f"{directory.get('displayName') or directory['slug']} team mail",
        to_address=to_email,
        subject=f"{directory['lists'].get('all', {}).get('subjectTag', '')} Test message".strip(),
        body=body,
        list_local=directory["slug"],
    )
    # A test must be answerable: strip the auto-generated marker so a reply
    # to it is a normal human message, and point the reply at the coaches.
    raw = re.sub(rb"(?im)^Auto-Submitted:.*\r?\n", b"", raw, count=1)
    raw = raw.replace(b"\r\n\r\n", f"\r\nReply-To: {addresses.address('coaches', directory['slug'], domain)}\r\n\r\n".encode(), 1) \
        if b"\r\n\r\n" in raw else raw.replace(b"\n\n", f"\nReply-To: {addresses.address('coaches', directory['slug'], domain)}\n\n".encode(), 1)
    provider_id = get_transport().send(from_addr=from_address, recipients=[to_email], raw=raw)
    storage.append_mail_log(team_id, {
        "action": "test", "list": directory["slug"], "from": from_address, "fromName": requester,
        "subject": "Test message", "recipients": 1, "reason": None, "providerId": provider_id,
        "source": "api",
    })
    return provider_id
