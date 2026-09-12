"""
Outbound transports: SES in production, a file outbox for development and
tests, and a null sender that only logs.

Recipients are always **envelope** recipients. The visible To: header is the
list address; the individual members never see each other's addresses, and
nothing in the message tells a recipient who else got it.
"""
import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from ._shared import config

logger = logging.getLogger(__name__)

# SESv2 SendEmail accepts at most 50 destinations per call.
SES_BATCH = 50


class TransportError(RuntimeError):
    """The provider refused or failed the send. The caller logs and, for the
    SQS path, leaves the message in the queue to retry."""


class NullTransport:
    name = "none"

    def send(self, *, from_addr: str, recipients: Sequence[str], raw: bytes) -> str:
        logger.info("mail transport=none: would send %d bytes from %s to %d recipient(s)",
                    len(raw), from_addr, len(recipients))
        return "none"


class FileTransport:
    """Write each send as ``{timestamp}-{n}.eml`` plus a ``.json`` envelope
    into an outbox directory. The directory is the assertion surface for the
    relay tests and the quickest way to eyeball a rewritten message locally."""
    name = "file"

    def __init__(self, outbox_dir: Path):
        self.outbox_dir = Path(outbox_dir)
        self._seq = 0
        self._lock = threading.Lock()

    def send(self, *, from_addr: str, recipients: Sequence[str], raw: bytes) -> str:
        self.outbox_dir.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._seq += 1
            seq = self._seq
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
        base = self.outbox_dir / f"{stamp}-{seq:04d}"
        with open(base.with_suffix(".eml"), "wb") as f:
            f.write(raw)
        with open(base.with_suffix(".json"), "w") as f:
            json.dump({"from": from_addr, "recipients": list(recipients), "bytes": len(raw)}, f, indent=2)
        return base.name

    def sent(self) -> List[Dict[str, Any]]:
        """Every envelope in the outbox, oldest first (test helper)."""
        out = []
        for path in sorted(self.outbox_dir.glob("*.json")):
            with open(path, "r") as f:
                envelope = json.load(f)
            envelope["raw"] = path.with_suffix(".eml").read_bytes()
            envelope["name"] = path.stem
            out.append(envelope)
        return out


class SesTransport:
    name = "ses"

    def __init__(self, region: str, configuration_set: str = "", client=None):
        self.region = region
        self.configuration_set = configuration_set
        self._client = client

    @property
    def client(self):
        if self._client is None:
            import boto3  # imported lazily: tests and dev backends never need it
            self._client = boto3.client("sesv2", region_name=self.region)
        return self._client

    def send(self, *, from_addr: str, recipients: Sequence[str], raw: bytes) -> str:
        first_id: Optional[str] = None
        recipients = list(recipients)
        for start in range(0, len(recipients), SES_BATCH):
            batch = recipients[start:start + SES_BATCH]
            kwargs: Dict[str, Any] = {
                "FromEmailAddress": from_addr,
                "Destination": {"ToAddresses": batch},
                "Content": {"Raw": {"Data": raw}},
            }
            if self.configuration_set:
                kwargs["ConfigurationSetName"] = self.configuration_set
            try:
                response = self.client.send_email(**kwargs)
            except Exception as exc:  # noqa: BLE001 — botocore raises many types
                raise TransportError(f"SES send failed: {exc}") from exc
            first_id = first_id or response.get("MessageId")
        return first_id or "ses"


_transport = None
_transport_lock = threading.Lock()


def get_transport():
    """The process-wide transport, built from config on first use."""
    global _transport
    with _transport_lock:
        if _transport is None:
            _transport = build_transport()
        return _transport


def set_transport(transport) -> None:
    """Override the process-wide transport (tests, dev endpoints)."""
    global _transport
    with _transport_lock:
        _transport = transport


def build_transport():
    mode = getattr(config, "MAIL_TRANSPORT", "none")
    if mode == "ses":
        return SesTransport(config.MAIL_REGION, getattr(config, "MAIL_CONFIGURATION_SET", ""))
    if mode == "file":
        return FileTransport(Path(config.MAIL_OUTBOX_DIR))
    return NullTransport()
