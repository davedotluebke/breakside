"""
Inbound intake: SES receiving → S3 (raw MIME) → SNS → SQS → this poller.

Why a queue and not a webhook: no inbound HTTP surface to authenticate, no
port 25 on the box, and if the API is down the mail waits in the queue (up
to the queue's retention, days) instead of being retried a handful of times
by SNS and dropped. A dead-letter queue catches anything that fails
repeatedly so one poison message cannot block the rest.

The same queue also receives bounce and complaint events from the SES
configuration set, so the poller records those against contacts.
"""
import asyncio
import json
import logging
import os
from typing import Any, Callable, Dict, List, Optional

from fastapi.concurrency import run_in_threadpool

from ._shared import config, storage
from . import relay

logger = logging.getLogger(__name__)

RECEIVE_WAIT_SECONDS = 20
RECEIVE_MAX = 10


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
                 processor: Callable[..., List[relay.RelayResult]] = relay.process_inbound):
        self.queue_url = queue_url
        self.region = region
        self.bucket = bucket
        self._sqs = sqs_client
        self._s3 = s3_client
        self.processor = processor
        self.processed = 0

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

    def handle_body(self, body: str) -> Optional[List[relay.RelayResult]]:
        note = parse_notification(body)
        if not isinstance(note, dict):
            logger.warning("mail: ignoring non-object notification")
            return None
        kind = note.get("notificationType") or note.get("eventType") or note.get("Type")

        if kind == "Received":
            return self._handle_received(note)
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

    def _handle_received(self, note: Dict[str, Any]) -> List[relay.RelayResult]:
        receipt = note.get("receipt") or {}
        mail = note.get("mail") or {}
        action = receipt.get("action") or {}
        bucket = action.get("bucketName") or self.bucket
        key = action.get("objectKey")
        if not bucket or not key:
            raise ValueError("Received notification without an S3 object location")
        raw = self.s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        results = self.processor(
            raw,
            envelope_recipients=receipt.get("recipients") or mail.get("destination") or [],
            envelope_from=mail.get("source"),
            verdicts=verdicts_from_receipt(receipt),
            source="sqs",
        )
        self.processed += 1
        return results

    def _handle_bounce(self, kind: str, note: Dict[str, Any]) -> None:
        if kind == "Bounce":
            bounce = note.get("bounce") or {}
            bounce_kind = "hard" if bounce.get("bounceType") == "Permanent" else "soft"
            detail = bounce.get("bounceSubType") or ""
            recipients = bounce.get("bouncedRecipients") or []
            for r in recipients:
                diag = r.get("diagnosticCode") or detail
                n = storage.record_mail_bounce(r.get("emailAddress", ""), bounce_kind, diag)
                logger.info("mail: %s bounce for %s recorded on %d contact(s)", bounce_kind, r.get("emailAddress"), n)
        else:
            complaint = note.get("complaint") or {}
            detail = complaint.get("complaintFeedbackType") or "complaint"
            for r in complaint.get("complainedRecipients") or []:
                n = storage.record_mail_bounce(r.get("emailAddress", ""), "complaint", detail)
                logger.warning("mail: complaint from %s recorded on %d contact(s)", r.get("emailAddress"), n)

    # ---------------------------------------------------------------- the loop

    def poll_once(self) -> int:
        response = self.sqs.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=RECEIVE_MAX,
            WaitTimeSeconds=RECEIVE_WAIT_SECONDS,
        )
        messages = response.get("Messages") or []
        handled = 0
        for message in messages:
            try:
                self.handle_body(message.get("Body", ""))
            except Exception:  # noqa: BLE001 — leave it in the queue; the DLQ policy bounds retries
                logger.exception("mail: failed to process queue message %s", message.get("MessageId"))
                continue
            self.sqs.delete_message(QueueUrl=self.queue_url, ReceiptHandle=message["ReceiptHandle"])
            handled += 1
        return handled

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
