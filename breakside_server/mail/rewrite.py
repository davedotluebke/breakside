"""
Turn a member's message into a list message.

The one non-obvious requirement: **From must be rewritten.** Yahoo, AOL and
Apple publish DMARC ``p=reject``; if we relay ``From: parent@yahoo.com``
unchanged from our servers, Gmail and everyone else will bounce it, because
Yahoo has said only Yahoo may send Yahoo mail. Google Groups rewrites to
"Name via Group <group@…>"; so do we. The author stays reachable through
Reply-To (or the list does, per list policy).

Everything else passes through: Message-ID / In-Reply-To / References keep
threads intact in every client, attachments and HTML parts are untouched, and
the original From is preserved in X-Original-From for the audit trail.
"""
import email
import re
from email import policy as email_policy
from email.headerregistry import Address
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import make_msgid, parseaddr
from typing import Dict, Optional, Tuple

# Headers that must not survive a relay. The original DKIM signature is broken
# by the From rewrite anyway (SES adds ours); Return-Path/Sender are the
# relay's to set; foreign List-* and Precedence would misdescribe the message;
# a Disposition-Notification-To would have every recipient's client offer to
# send the author a read receipt.
STRIP_HEADERS = (
    "DKIM-Signature", "Return-Path", "Sender", "Bcc", "Precedence",
    "List-Id", "List-Post", "List-Unsubscribe", "List-Unsubscribe-Post",
    "List-Help", "List-Archive", "List-Owner", "List-Subscribe",
    "Disposition-Notification-To", "Return-Receipt-To",
    "X-Breakside-List", "X-Original-From", "X-Original-Sender",
)

_REPLY_PREFIX_RE = re.compile(
    r"^((?:\s*(?:re|fwd?|aw|sv|tr|wg)\s*:\s*)+)(.*)$", re.IGNORECASE | re.DOTALL
)

# Subject markers the relay adds to one recipient group's copy of a message:
# mail to a player's alias reaches the guardians as "[Parent copy]" and the
# coaches as "[Coach copy]". Both are stripped from every inbound subject
# first, so a parent replying to "[Parent copy] Practice" does not send the
# player a message labelled as a parent copy.
PARENT_COPY_MARKER = "[Parent copy]"
COACH_COPY_MARKER = "[Coach copy]"
COPY_MARKERS = (PARENT_COPY_MARKER, COACH_COPY_MARKER)
_MARKER_RE = re.compile(
    "|".join(re.escape(m) for m in COPY_MARKERS), re.IGNORECASE
)


def parse_message(raw: bytes) -> EmailMessage:
    return BytesParser(policy=email_policy.default).parsebytes(raw)


def sender_of(msg: EmailMessage) -> Tuple[str, str]:
    """(display name, address) of the From header; tolerant of junk."""
    try:
        header = msg["From"]
        addresses = getattr(header, "addresses", ()) if header is not None else ()
        if addresses:
            first = addresses[0]
            spec = (first.addr_spec or "").lower()
            if "@" in spec:
                return (first.display_name or "", spec)
    except Exception:  # noqa: BLE001 — a malformed header must not stop the relay
        pass
    name, addr = parseaddr(str(msg.get("From", "")))
    addr = (addr or "").strip().lower()
    if "@" not in addr:
        addr = ""
    return (name or "", addr)


def header_map(msg: EmailMessage) -> Dict[str, str]:
    """Lowercased header name → first value, for policy.loop_reason."""
    out: Dict[str, str] = {}
    for key in msg.keys():
        lower = key.lower()
        if lower not in out:
            try:
                out[lower] = str(msg.get(key, "") or "")
            except Exception:  # noqa: BLE001
                out[lower] = ""
    return out


def tagged_subject(subject: str, tag: str) -> str:
    """Prepend ``[Tag]`` unless the subject already carries it, keeping any
    Re:/Fwd: prefixes in front so clients thread and sort as usual."""
    subject = (subject or "").strip()
    tag = (tag or "").strip()
    if not tag:
        return subject
    if tag.lower() in subject.lower():
        return subject
    match = _REPLY_PREFIX_RE.match(subject)
    if match:
        prefix, rest = match.group(1), match.group(2)
        return f"{prefix.strip()} {tag} {rest}".strip()
    return f"{tag} {subject}".strip()


def strip_markers(subject: str) -> str:
    """Remove any copy marker from a subject and tidy the spacing."""
    cleaned = _MARKER_RE.sub("", subject or "")
    return re.sub(r"[ \t]{2,}", " ", cleaned).strip()


def marked_subject(subject: str, tag: str, marker: str = "") -> str:
    """Tag the subject, then place ``marker`` right after the tag.

    ``[Offline] Practice`` → ``[Offline] [Parent copy] Practice``;
    ``Re: [Offline] Practice`` → ``Re: [Offline] [Parent copy] Practice``.
    With no tag the marker goes where the tag would have gone (after any
    Re:/Fwd: prefixes). Existing markers are always stripped first.
    """
    tagged = tagged_subject(strip_markers(subject), tag)
    marker = (marker or "").strip()
    if not marker:
        return tagged
    tag = (tag or "").strip()
    if tag:
        at = tagged.lower().find(tag.lower())
        if at >= 0:
            end = at + len(tag)
            return f"{tagged[:end]} {marker}{tagged[end:]}".strip()
    return tagged_subject(tagged, marker)


def rewrite_message(raw: bytes, *, list_address: str, list_display: str,
                    subject_tag: str, reply_to_mode: str,
                    coaches_address: Optional[str] = None,
                    author: Optional[Tuple[str, str]] = None,
                    subject_marker: str = "") -> bytes:
    """Return the relayed form of ``raw``.

    Args:
        list_address: ``parents-cudo@team.breakside.pro``.
        list_display: ``CUDO Parents`` — appears in "Name via CUDO Parents"
            and the List-Id display name.
        subject_tag: ``[CUDO Parents]`` or empty for none.
        reply_to_mode: ``author`` (the person who wrote it; honours their own
            Reply-To if they set one), ``list``, or ``coaches``.
        coaches_address: needed for ``coaches`` mode.
        author: (name, email) if the caller already parsed it.
        subject_marker: e.g. ``[Parent copy]`` for one recipient group's copy;
            placed after the tag (see ``marked_subject``).
    """
    msg = parse_message(raw)
    name, addr = author or sender_of(msg)
    display = name.strip() or (addr.split("@", 1)[0] if addr else "Someone")
    local, _, domain = list_address.partition("@")

    original_from = str(msg.get("From", "") or "")
    original_reply_to = str(msg.get("Reply-To", "") or "")

    for header in STRIP_HEADERS:
        del msg[header]
    del msg["Reply-To"]

    if original_from:
        msg["X-Original-From"] = original_from
    if addr:
        msg["X-Original-Sender"] = addr

    del msg["From"]
    msg["From"] = Address(display_name=f"{display} via {list_display}", addr_spec=list_address)
    msg["Sender"] = Address(addr_spec=list_address)

    if reply_to_mode == "coaches" and coaches_address:
        msg["Reply-To"] = Address(display_name=f"{list_display} coaches", addr_spec=coaches_address)
    elif reply_to_mode == "list":
        msg["Reply-To"] = Address(display_name=list_display, addr_spec=list_address)
    else:
        if original_reply_to:
            msg["Reply-To"] = original_reply_to
        elif addr:
            msg["Reply-To"] = Address(display_name=name.strip(), addr_spec=addr)

    subject = str(msg.get("Subject", "") or "")
    del msg["Subject"]
    msg["Subject"] = marked_subject(subject, subject_tag, subject_marker)

    if not msg.get("Message-ID"):
        msg["Message-ID"] = make_msgid(domain=domain or None)

    msg["List-Id"] = f"{_quote_display(list_display)} <{local}.{domain}>"
    msg["List-Post"] = f"<mailto:{list_address}>"
    msg["Precedence"] = "list"
    msg["X-Breakside-List"] = local

    return msg.as_bytes()


def _quote_display(text: str) -> str:
    cleaned = re.sub(r'[\r\n"]', "", text or "").strip()
    return f'"{cleaned}"' if cleaned else '""'


def build_notice(*, from_address: str, from_display: str, to_address: str,
                 subject: str, body: str, list_local: str) -> bytes:
    """A small system-generated message (quarantine digest, test message).

    Marked auto-generated and given our list header so a reply or a forward
    of it can never be relayed back through a list.
    """
    msg = EmailMessage(policy=email_policy.default)
    msg["From"] = Address(display_name=from_display, addr_spec=from_address)
    msg["To"] = Address(addr_spec=to_address)
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=from_address.partition("@")[2] or None)
    msg["Auto-Submitted"] = "auto-generated"
    msg["Precedence"] = "list"
    msg["X-Breakside-List"] = list_local
    msg.set_content(body)
    return msg.as_bytes()
