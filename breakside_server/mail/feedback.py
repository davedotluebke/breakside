"""
In-app feedback: a signed-in user's message, emailed to the support address.

The app menu's "Give Feedback" used to open a GitHub new-issue form, which
most coaches and parents have no account for. Now the app posts the message
to ``POST /api/feedback`` and the server mails it to whoever ``help@``
forwards to (``help=`` in ``BREAKSIDE_MAIL_FORWARDS``), through the same
outbound transport the team lists use. Nothing is stored: the email is the
only record, exactly as for a message sent to help@ by hand.

The message is shaped like a help@ forward (``relay._forward``) so it lands
and is answered the same way: From the support address under the user's
name (``"Alice via Breakside Feedback" <help@…>``), Reply-To the user, and
To the support address itself, because Gmail picks its "send as" identity
from To and a reply from the inbox then comes from help@. Our
``X-Breakside-List`` marker rides along so the relay's loop guard drops the
message should it ever come back in.

The app attaches diagnostics (version, device, current team and game, sync
state) so a report can be matched to server-side data without a round of
"which game was that?". They are free-form ``key: value`` pairs from the
client, trimmed and capped here; nothing in them is trusted or acted on.
"""
import logging
import re
import threading
import time
from collections import deque
from email import policy as email_policy
from email.headerregistry import Address
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from typing import Any, Deque, Dict, List, Optional, Tuple

from ._shared import config
from . import addresses
from .transport import get_transport

logger = logging.getLogger(__name__)

# The system forward the feedback goes to.
FORWARD_LOCAL = "help"

MAX_MESSAGE_CHARS = 5000
MAX_DIAGNOSTICS = 40
MAX_KEY_CHARS = 40
MAX_VALUE_CHARS = 300
SUBJECT_EXCERPT_CHARS = 60

# A signed-in account can send this many per hour, and the server this many
# in total. Accounts are free to make, so the global cap is what keeps a
# scripted run from becoming a flood in the support inbox. In memory, like
# the quarantine-notice limiter: the API is single-worker by construction.
PER_USER_PER_HOUR = 5
GLOBAL_PER_HOUR = 60
WINDOW_SECONDS = 3600

_user_sends: Dict[str, Deque[float]] = {}
_all_sends: Deque[float] = deque()
_rate_lock = threading.Lock()

_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# Plain addresses only: the account email goes into a Reply-To header, and a
# Supabase address with quotes or brackets in it is not worth parsing.
_EMAIL_RE = re.compile(r'^[^@\s"<>(),;:\\\[\]]+@[^@\s"<>(),;:\\\[\]]+\.[^@\s"<>(),;:\\\[\]]+$')
_LINE_BREAK_RE = re.compile(r"[\r\n\t]+")


class FeedbackError(Exception):
    """Base for the refusals the endpoint turns into an HTTP status."""


class InvalidFeedback(FeedbackError):
    """The request itself is unusable (400)."""


class NotConfigured(FeedbackError):
    """No ``help=`` forward is configured, so there is nowhere to send (503)."""


class RateLimited(FeedbackError):
    """Too many recently, from this account or from everyone (429)."""

    def __init__(self, message: str, retry_after: int):
        super().__init__(message)
        self.retry_after = retry_after


def recipient() -> Optional[str]:
    """Where feedback is delivered: the ``help`` system forward's target."""
    return config.mail_forwards().get(FORWARD_LOCAL)


def support_address() -> str:
    """The visible From/To address: help@ on the base domain when one is
    configured (where the relay answers it), else on the list domain, which
    is the identity a self-hoster without a base domain has verified."""
    domain = getattr(config, "MAIL_BASE_DOMAIN", "") or config.MAIL_DOMAIN
    return f"{FORWARD_LOCAL}@{domain}"


# =============================================================================
# Input cleaning
# =============================================================================

def _one_line(value: Any, limit: int) -> str:
    text = _LINE_BREAK_RE.sub(" ", str(value))
    text = _CONTROL_RE.sub("", text).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def clean_message(message: Any) -> str:
    """The user's text, with stray control characters removed and line
    endings normalized. Empty or over-long is refused rather than cut: the
    dialog enforces the same limit, so only a modified client gets here."""
    if not isinstance(message, str):
        raise InvalidFeedback("Please write a message.")
    text = _CONTROL_RE.sub("", message.replace("\r\n", "\n").replace("\r", "\n")).strip()
    if not text:
        raise InvalidFeedback("Please write a message.")
    if len(text) > MAX_MESSAGE_CHARS:
        raise InvalidFeedback(f"Please keep your message under {MAX_MESSAGE_CHARS} characters.")
    return text


def clean_diagnostics(diagnostics: Any) -> List[Tuple[str, str]]:
    """Ordered ``(key, value)`` pairs: scalars only, one line each, capped in
    count and length. Anything else is dropped without complaint; a report
    with half its diagnostics is still worth sending."""
    if not isinstance(diagnostics, dict):
        return []
    out: List[Tuple[str, str]] = []
    for key, value in diagnostics.items():
        if len(out) >= MAX_DIAGNOSTICS:
            break
        if value is None or isinstance(value, (dict, list, tuple, set)):
            continue
        k = _one_line(key, MAX_KEY_CHARS)
        v = _one_line(value, MAX_VALUE_CHARS)
        if k and v:
            out.append((k, v))
    return out


# =============================================================================
# Rate limit
# =============================================================================

def _prune(times: Deque[float], now: float) -> None:
    while times and now - times[0] >= WINDOW_SECONDS:
        times.popleft()


def _take_slot(user_id: str, now: float) -> None:
    with _rate_lock:
        mine = _user_sends.setdefault(user_id, deque())
        _prune(mine, now)
        _prune(_all_sends, now)
        if len(mine) >= PER_USER_PER_HOUR:
            raise RateLimited(
                "You've sent several messages in the last hour. Please try again later, "
                "or email us directly.", int(WINDOW_SECONDS - (now - mine[0])) + 1)
        if len(_all_sends) >= GLOBAL_PER_HOUR:
            raise RateLimited(
                "Feedback is busy right now. Please try again later, or email us directly.",
                int(WINDOW_SECONDS - (now - _all_sends[0])) + 1)
        mine.append(now)
        _all_sends.append(now)


def _release_slot(user_id: str, now: float) -> None:
    """Give back the slot of a send that failed, so a transport outage does
    not also lock the user out once it is over."""
    with _rate_lock:
        for times in (_user_sends.get(user_id), _all_sends):
            if times and now in times:
                times.remove(now)


def reset_rate_limits() -> None:
    """Forget every recorded send (tests)."""
    with _rate_lock:
        _user_sends.clear()
        _all_sends.clear()


# =============================================================================
# The message
# =============================================================================

def subject_for(message: str) -> str:
    first = next((line.strip() for line in message.splitlines() if line.strip()), "")
    return f"Feedback: {_one_line(first, SUBJECT_EXCERPT_CHARS)}"


def build_message(*, message: str, name: str, email: str, user_id: str,
                  diagnostics: List[Tuple[str, str]]) -> bytes:
    """The email: the user's words first, then who sent it, then the
    diagnostics as aligned ``key: value`` lines."""
    support = support_address()
    display = _one_line(name or email or "A Breakside user", 60)

    who = [("From", f"{display} <{email}>" if email else f"{display} (no email on the account)"),
           ("User ID", user_id)]
    width = max(len(k) for k, _ in who + diagnostics) + 1
    lines = [f"{(k + ':').ljust(width)} {v}" for k, v in who]
    if diagnostics:
        lines.append("")
        lines.extend(f"{(k + ':').ljust(width)} {v}" for k, v in diagnostics)
    body = f"{message}\n\n-- \n" + "\n".join(lines) + "\n"

    msg = EmailMessage(policy=email_policy.default)
    msg["From"] = Address(display_name=f"{display} via Breakside Feedback", addr_spec=support)
    msg["To"] = Address(display_name="Breakside Help", addr_spec=support)
    if email:
        msg["Reply-To"] = Address(display_name=display, addr_spec=email)
    msg["Subject"] = subject_for(message)
    msg["Date"] = formatdate(usegmt=True)
    msg["Message-ID"] = make_msgid(domain=support.partition("@")[2] or None)
    msg["X-Breakside-List"] = FORWARD_LOCAL
    msg.set_content(body)
    return msg.as_bytes()


def send_feedback(*, user: Dict[str, Any], profile: Optional[Dict[str, Any]],
                  message: Any, diagnostics: Any = None) -> str:
    """Validate, rate-limit and send one feedback message. Returns the
    provider id. Raises a ``FeedbackError`` for a refusal and lets the
    transport's ``TransportError`` through for a failed send."""
    text = clean_message(message)
    to = recipient()
    if not to:
        raise NotConfigured("Feedback by email is not set up on this server.")
    profile = profile or {}
    user_id = str(user.get("id") or "")
    email = (profile.get("email") or user.get("email") or "").strip().lower()
    if not _EMAIL_RE.match(email):
        email = ""
    name = (profile.get("displayName") or "").strip()

    raw = build_message(message=text, name=name, email=email, user_id=user_id,
                        diagnostics=clean_diagnostics(diagnostics))
    now = time.time()
    _take_slot(user_id, now)
    try:
        provider_id = get_transport().send(from_addr=support_address(), recipients=[to], raw=raw)
    except Exception:
        _release_slot(user_id, now)
        raise
    logger.info("feedback: sent from user %s (%s)", user_id,
                addresses.mask_address(email) if email else "no email")
    return provider_id
