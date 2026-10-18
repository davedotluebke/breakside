"""
Inbound intake: SES receiving → S3 (raw MIME) → SNS → SQS → this poller.

Why a queue and not a webhook: no inbound HTTP surface to authenticate, no
port 25 on the box, and if the API is down the mail waits in the queue (up
to the queue's retention, days) instead of being retried a handful of times
by SNS and dropped. A dead-letter queue catches anything that fails
repeatedly so one poison message cannot block the rest.

The same queue also receives bounce and complaint events from the SES
configuration set, so the poller records those against contacts.

One message, several notifications: a sender's mail server may deliver a
message addressed to two of our addresses as two SMTP transactions (Gmail
does), and SES then stores two copies and sends two notifications, each
naming one recipient. The poller therefore holds Received notifications for
a few seconds, keyed by the original Message-ID and envelope sender, and
relays the siblings that arrive in that window as ONE message with every
recipient, which is what lets relay.py give a coach behind two player
aliases a single copy. Every inbound mail pays that latency; a sibling that
arrives after the window is relayed on its own, as before.
"""
import asyncio
import json
import logging
import math
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi.concurrency import run_in_threadpool

from ._shared import config, storage
from . import addresses, relay

logger = logging.getLogger(__name__)

RECEIVE_WAIT_SECONDS = 20
RECEIVE_MAX = 10
HOLD_SECONDS = 5          # how long a Received notification waits for siblings


@dataclass
class _Held:
    deadline: float
    items: List[Tuple[Dict[str, Any], Dict[str, Any]]] = field(default_factory=list)   # (sqs message, notification)


def parse_notification(body: str) -> Dict[str, Any]:
    """Unwrap an SQS body into the SES notification it carries.

    With raw message delivery on the SNS subscription the body IS the SES
    JSON; without it, the body is the SNS envelope whose ``Message`` field
    is the SES JSON as a string. Handle both, so a subscription created by
    hand still works.
    """
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        # SES publishes a plain-text "Successfully validated SNS topic for
        # Amazon SES event publishing" when a destination is wired up. Not
        # actionable, not an error: report it so the poller deletes it.
        return {"Type": "Text", "text": body[:200]}
    if isinstance(data, dict) and data.get("Type") == "Notification" and "Message" in data:
        inner = data["Message"]
        if isinstance(inner, str):
            try:
                return json.loads(inner)
            except json.JSONDecodeError:
                return {"Type": "Text", "text": inner[:200]}
        return inner
    return data


def verdicts_from_receipt(receipt: Dict[str, Any]) -> Dict[str, str]:
    out = {}
    for key in ("spam", "virus", "spf", "dkim", "dmarc"):
        verdict = receipt.get(f"{key}Verdict") or {}
        out[key] = str(verdict.get("status", "")).upper()
    return out


class InboundPoller:
    def __init__(self, queue_url: str, *, region: str, bucket: str = "",
                 sqs_client=None, s3_client=None,
                 processor: Callable[..., List[relay.RelayResult]] = relay.process_inbound,
                 hold_seconds: float = HOLD_SECONDS):
        self.queue_url = queue_url
        self.region = region
        self.bucket = bucket
        self._sqs = sqs_client
        self._s3 = s3_client
        self.processor = processor
        self.hold_seconds = hold_seconds
        self.processed = 0
        self._held: Dict[Tuple[str, str], _Held] = {}
        self._clock = time.monotonic

    @property
    def sqs(self):
        if self._sqs is None:
            import boto3
            self._sqs = boto3.client("sqs", region_name=self.region)
        return self._sqs

    @property
    def s3(self):
        if self._s3 is None:
            import boto3
            self._s3 = boto3.client("s3", region_name=self.region)
        return self._s3

    # ---------------------------------------------------------------- one message

    @staticmethod
    def _kind(note: Dict[str, Any]) -> Optional[str]:
        return note.get("notificationType") or note.get("eventType") or note.get("Type")

    def handle_body(self, body: str) -> Optional[List[relay.RelayResult]]:
        """Process one queue message at once (no sibling hold)."""
        note = parse_notification(body)
        if not isinstance(note, dict):
            logger.warning("mail: ignoring non-object notification")
            return None
        if self._kind(note) == "Received":
            return self._handle_received([note])
        return self._handle_other(note)

    def _handle_other(self, note: Dict[str, Any]) -> None:
        kind = self._kind(note)
        if kind in ("Bounce", "Complaint"):
            self._handle_bounce(kind, note)
            return None
        if kind == "Text":
            logger.info("mail: ignoring non-JSON queue message: %s", note.get("text"))
            return None
        if kind == "SubscriptionConfirmation":
            logger.warning("mail: SNS subscription is unconfirmed (SubscribeURL in message); "
                           "confirm it with the setup script")
            return None
        # Delivery / Send / Open / Click / Reject etc. — nothing to record.
        logger.debug("mail: ignoring notification type %s", kind)
        return None

    @staticmethod
    def _recipients_of(note: Dict[str, Any]) -> List[str]:
        receipt = note.get("receipt") or {}
        mail = note.get("mail") or {}
        return list(receipt.get("recipients") or mail.get("destination") or [])

    def _handle_received(self, notes: List[Dict[str, Any]]) -> List[relay.RelayResult]:
        """Relay one received message. ``notes`` are the notifications for
        its copies (one per delivery); the first copy's body stands for all,
        and the envelope recipients are the union, in order of arrival."""
        first = notes[0]
        receipt = first.get("receipt") or {}
        mail = first.get("mail") or {}
        action = receipt.get("action") or {}
        bucket = action.get("bucketName") or self.bucket
        key = action.get("objectKey")
        if not bucket or not key:
            raise ValueError("Received notification without an S3 object location")
        raw = self.s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        recipients: List[str] = []
        for note in notes:
            for address in self._recipients_of(note):
                if address not in recipients:
                    recipients.append(address)
        if len(notes) > 1:
            logger.info("mail: relaying %d deliveries of one message as one (%d recipient address(es))",
                        len(notes), len(recipients))
        results = self.processor(
            raw,
            envelope_recipients=recipients,
            envelope_from=mail.get("source"),
            verdicts=verdicts_from_receipt(receipt),
            source="sqs",
        )
        self.processed += 1
        return results

    # ---------------------------------------------------------------- the hold

    @staticmethod
    def _group_key(message: Dict[str, Any], note: Dict[str, Any]) -> Tuple[str, str]:
        """Copies of one message share its Message-ID header (SES reports it
        as ``mail.commonHeaders.messageId``) and envelope sender. Without a
        header the SES message id, then the queue message id, keeps the
        notification in a group of its own."""
        mail = note.get("mail") or {}
        common = mail.get("commonHeaders") or {}
        message_id = common.get("messageId") or mail.get("messageId") or message.get("MessageId") or ""
        return (str(message_id), str(mail.get("source") or "").lower())

    def _hold(self, message: Dict[str, Any], note: Dict[str, Any]) -> None:
        key = self._group_key(message, note)
        held = self._held.get(key)
        if held is None:
            held = self._held[key] = _Held(deadline=self._clock() + self.hold_seconds)
        held.items.append((message, note))

    def _next_wait(self) -> int:
        """Long-poll wait: the full wait, or until the earliest hold expires."""
        if not self._held:
            return RECEIVE_WAIT_SECONDS
        soonest = min(h.deadline for h in self._held.values())
        return max(0, min(RECEIVE_WAIT_SECONDS, math.ceil(soonest - self._clock())))

    def _flush(self) -> int:
        """Relay every held group whose window has closed; returns the number
        of queue messages that were processed and deleted."""
        now = self._clock()
        handled = 0
        for key in [k for k, h in self._held.items() if h.deadline <= now]:
            held = self._held.pop(key)
            try:
                self._handle_received([note for _message, note in held.items])
            except Exception:  # noqa: BLE001 — leave them in the queue; the DLQ policy bounds retries
                logger.exception("mail: failed to process queue message(s) %s",
                                 [m.get("MessageId") for m, _note in held.items])
                continue
            for message, _note in held.items:
                self.sqs.delete_message(QueueUrl=self.queue_url, ReceiptHandle=message["ReceiptHandle"])
                handled += 1
        return handled

    def _handle_bounce(self, kind: str, note: Dict[str, Any]) -> None:
        if kind == "Bounce":
            bounce = note.get("bounce") or {}
            bounce_kind = "hard" if bounce.get("bounceType") == "Permanent" else "soft"
            detail = bounce.get("bounceSubType") or ""
            recipients = bounce.get("bouncedRecipients") or []
            for r in recipients:
                diag = r.get("diagnosticCode") or detail
                n = storage.record_mail_bounce(r.get("emailAddress", ""), bounce_kind, diag)
                logger.info("mail: %s bounce for %s recorded on %d contact(s)", bounce_kind, addresses.mask_address(r.get("emailAddress")), n)
        else:
            complaint = note.get("complaint") or {}
            detail = complaint.get("complaintFeedbackType") or "complaint"
            for r in complaint.get("complainedRecipients") or []:
                n = storage.record_mail_bounce(r.get("emailAddress", ""), "complaint", detail)
                logger.warning("mail: complaint from %s recorded on %d contact(s)", addresses.mask_address(r.get("emailAddress")), n)

    # ---------------------------------------------------------------- the loop

    def poll_once(self) -> int:
        """One receive: events are handled at once, Received notifications are
        held for siblings (see the module docstring), and every hold whose
        window has closed is relayed. Returns the number of queue messages
        processed and deleted."""
        response = self.sqs.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=RECEIVE_MAX,
            WaitTimeSeconds=self._next_wait(),
        )
        messages = response.get("Messages") or []
        handled = 0
        for message in messages:
            try:
                note = parse_notification(message.get("Body", ""))
                if isinstance(note, dict) and self._kind(note) == "Received":
                    self._hold(message, note)
                    continue
                if isinstance(note, dict):
                    self._handle_other(note)
                else:
                    logger.warning("mail: ignoring non-object notification")
            except Exception:  # noqa: BLE001 — leave it in the queue; the DLQ policy bounds retries
                logger.exception("mail: failed to process queue message %s", message.get("MessageId"))
                continue
            self.sqs.delete_message(QueueUrl=self.queue_url, ReceiptHandle=message["ReceiptHandle"])
            handled += 1
        return handled + self._flush()

    async def run(self, stop: asyncio.Event) -> None:
        logger.info("mail: inbound poller started on %s", self.queue_url)
        backoff = 1
        while not stop.is_set():
            try:
                await run_in_threadpool(self.poll_once)
                backoff = 1
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("mail: queue poll failed; retrying in %ss", backoff)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 60)
        logger.info("mail: inbound poller stopped")


def build_poller() -> Optional[InboundPoller]:
    """The poller for this process, or None when inbound mail is off.

    Reads the environment at call time (like ``config.mail_inbound_enabled``)
    so a test or a dev backend can turn it on without re-importing config.
    """
    if not config.mail_inbound_enabled():
        return None
    return InboundPoller(
        os.getenv("BREAKSIDE_MAIL_QUEUE_URL") or config.MAIL_QUEUE_URL,
        region=os.getenv("BREAKSIDE_MAIL_REGION") or config.MAIL_REGION,
        bucket=os.getenv("BREAKSIDE_MAIL_INBOUND_BUCKET") or config.MAIL_INBOUND_BUCKET,
    )
