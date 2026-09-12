"""
Team mailing lists: the coach-only admin surface (Comms Phase 0).

Every endpoint under /api/teams/{team_id}/mail requires Coach access to the
team. Nothing here is ever returned to a viewer: the directory holds parent
and player email addresses. See TODO.Comms.md § Phase 0 and mail/.
"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool

from ._shared import (
    add_mail_contact,
    auth_required,
    config,
    create_mail_directory,
    get_mail_directory,
    get_mail_quarantine,
    get_user,
    list_mail_quarantine,
    purge_expired_quarantine,
    read_mail_log,
    remove_mail_contact,
    remove_mail_quarantine,
    require_team_coach,
    team_exists,
    get_team,
    update_mail_contact,
    update_mail_list,
    update_mail_settings,
    import_server_module,
)

addresses = import_server_module("mail.addresses")
directory_mod = import_server_module("mail.directory")
relay = import_server_module("mail.relay")
rewrite = import_server_module("mail.rewrite")
transport_mod = import_server_module("mail.transport")

logger = logging.getLogger(__name__)

router = APIRouter()


def _require_team(team_id: str) -> None:
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")


def _require_directory(team_id: str) -> Dict[str, Any]:
    directory = get_mail_directory(team_id)
    if directory is None:
        raise HTTPException(status_code=404, detail="Email lists are not set up for this team yet")
    return directory


def _bad_request(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


# =============================================================================
# Settings
# =============================================================================

@router.get("/api/teams/{team_id}/mail")
async def get_team_mail(team_id: str, user: dict = Depends(require_team_coach("team_id"))):
    """The whole admin view: settings, addresses, lists with their current
    recipients, contacts (derived coaches included), roster with aliases,
    team members for the import helper, and the quarantine count."""
    _require_team(team_id)
    if get_mail_directory(team_id) is not None:
        purge_expired_quarantine(team_id)
    return directory_mod.directory_view(team_id)


@router.post("/api/teams/{team_id}/mail")
async def configure_team_mail(
    team_id: str,
    slug: str = Body(...),
    displayName: Optional[str] = Body(default=None),
    user: dict = Depends(require_team_coach("team_id")),
):
    """Create the directory (first call) or change the slug / display name.

    Creating also gives every roster player an alias address."""
    _require_team(team_id)
    try:
        clean_slug = addresses.validate_slug(slug)
    except addresses.AddressError as exc:
        raise _bad_request(exc)
    existing = get_mail_directory(team_id)
    try:
        if existing is None:
            name = displayName if displayName is not None else get_team(team_id).get("name", clean_slug)
            create_mail_directory(team_id, clean_slug, name)
            directory_mod.ensure_player_aliases(team_id)
        else:
            update_mail_settings(team_id, slug=clean_slug, display_name=displayName)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return directory_mod.directory_view(team_id)


@router.patch("/api/teams/{team_id}/mail/lists/{kind}")
async def patch_team_mail_list(
    team_id: str, kind: str,
    updates: Dict[str, Any] = Body(...),
    user: dict = Depends(require_team_coach("team_id")),
):
    _require_team(team_id)
    _require_directory(team_id)
    try:
        settings = update_mail_list(team_id, kind, updates)
    except ValueError as exc:
        raise _bad_request(exc)
    return {"kind": kind, "settings": settings}


# =============================================================================
# Contacts
# =============================================================================

@router.post("/api/teams/{team_id}/mail/contacts")
async def create_mail_contact(
    team_id: str,
    contact: Dict[str, Any] = Body(...),
    user: dict = Depends(require_team_coach("team_id")),
):
    _require_team(team_id)
    _require_directory(team_id)
    if contact.get("alias"):
        try:
            contact["alias"] = addresses.validate_alias(contact["alias"])
        except addresses.AddressError as exc:
            raise _bad_request(exc)
    try:
        record = add_mail_contact(team_id, contact)
    except ValueError as exc:
        raise _bad_request(exc)
    return {"status": "created", "contact": record}


@router.patch("/api/teams/{team_id}/mail/contacts/{contact_id}")
async def patch_mail_contact(
    team_id: str, contact_id: str,
    updates: Dict[str, Any] = Body(...),
    user: dict = Depends(require_team_coach("team_id")),
):
    _require_team(team_id)
    _require_directory(team_id)
    if updates.get("alias"):
        try:
            updates["alias"] = addresses.validate_alias(updates["alias"])
        except addresses.AddressError as exc:
            raise _bad_request(exc)
    try:
        record = update_mail_contact(team_id, contact_id, updates)
    except ValueError as exc:
        raise _bad_request(exc)
    if record is None:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"status": "updated", "contact": record}


@router.delete("/api/teams/{team_id}/mail/contacts/{contact_id}")
async def delete_mail_contact(
    team_id: str, contact_id: str,
    user: dict = Depends(require_team_coach("team_id")),
):
    _require_team(team_id)
    if not remove_mail_contact(team_id, contact_id):
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"status": "deleted", "contactId": contact_id}


@router.post("/api/teams/{team_id}/mail/aliases/sync")
async def sync_player_aliases(team_id: str, user: dict = Depends(require_team_coach("team_id"))):
    """Give every roster player without an address one."""
    _require_team(team_id)
    _require_directory(team_id)
    added = directory_mod.ensure_player_aliases(team_id)
    return {"added": added, "count": len(added)}


# =============================================================================
# Quarantine
# =============================================================================

def _preview(raw: bytes, limit: int = 2000) -> str:
    try:
        msg = rewrite.parse_message(raw)
        body = msg.get_body(preferencelist=("plain", "html"))
        if body is None:
            return ""
        text = body.get_content()
        if body.get_content_type() == "text/html":
            import re
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text)
        return text.strip()[:limit]
    except Exception:  # noqa: BLE001 — a preview must never 500 the queue view
        return ""


@router.get("/api/teams/{team_id}/mail/quarantine")
async def list_quarantine(team_id: str, user: dict = Depends(require_team_coach("team_id"))):
    _require_team(team_id)
    purge_expired_quarantine(team_id)
    items = list_mail_quarantine(team_id)
    return {"items": items, "count": len(items)}


@router.get("/api/teams/{team_id}/mail/quarantine/{item_id}")
async def get_quarantine_item(team_id: str, item_id: str, user: dict = Depends(require_team_coach("team_id"))):
    _require_team(team_id)
    found = get_mail_quarantine(team_id, item_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Held message not found")
    item, raw = found
    return {**item, "preview": _preview(raw)}


@router.post("/api/teams/{team_id}/mail/quarantine/{item_id}/release")
async def release_quarantine_item(
    team_id: str, item_id: str,
    addSender: Optional[Dict[str, Any]] = Body(default=None, embed=True),
    user: dict = Depends(require_team_coach("team_id")),
):
    """Deliver a held message. ``addSender`` ({kind, name, playerIds?})
    also adds the sender to the directory first."""
    _require_team(team_id)
    _require_directory(team_id)
    try:
        results = await run_in_threadpool(relay.release_quarantine, team_id, item_id, add_sender=addSender)
    except KeyError:
        raise HTTPException(status_code=404, detail="Held message not found")
    except ValueError as exc:
        raise _bad_request(exc)
    except transport_mod.TransportError as exc:
        raise HTTPException(status_code=502, detail=f"Could not send: {exc}")
    return {"results": [r.as_dict() for r in results]}


@router.delete("/api/teams/{team_id}/mail/quarantine/{item_id}")
async def discard_quarantine_item(team_id: str, item_id: str, user: dict = Depends(require_team_coach("team_id"))):
    _require_team(team_id)
    if not remove_mail_quarantine(team_id, item_id):
        raise HTTPException(status_code=404, detail="Held message not found")
    return {"status": "discarded", "itemId": item_id}


# =============================================================================
# Log and test
# =============================================================================

@router.get("/api/teams/{team_id}/mail/log")
async def get_mail_log(
    team_id: str,
    limit: int = Query(default=50, ge=1, le=500),
    user: dict = Depends(require_team_coach("team_id")),
):
    _require_team(team_id)
    entries = read_mail_log(team_id, limit=limit)
    return {"entries": entries, "count": len(entries)}


@router.post("/api/teams/{team_id}/mail/test")
async def send_mail_test(team_id: str, user: dict = Depends(require_team_coach("team_id"))):
    """Email the requesting coach from the team address."""
    _require_team(team_id)
    _require_directory(team_id)
    profile = get_user(user["id"]) or {}
    to_email = (profile.get("email") or user.get("email") or "").strip().lower()
    if not to_email:
        raise HTTPException(status_code=400, detail="Your account has no email address")
    try:
        provider_id = await run_in_threadpool(
            relay.send_test_message, team_id, to_email, profile.get("displayName") or to_email)
    except transport_mod.TransportError as exc:
        raise HTTPException(status_code=502, detail=f"Could not send: {exc}")
    return {"status": "sent", "to": to_email, "providerId": provider_id,
            "transport": transport_mod.get_transport().name}


# =============================================================================
# Development only: feed a raw message in as if SES had received it
# =============================================================================

@router.post("/api/mail/dev/inbound")
async def dev_inbound(request: Request, to: Optional[str] = Query(default=None)):
    """Process a raw RFC 822 message body exactly like a queue delivery.

    Available only when the API runs with auth disabled (a dev backend) or
    in debug mode — never in production, which has both off. ``to`` is an
    optional comma-separated envelope recipient list; without it the To/Cc
    headers are used.
    """
    if auth_required() and not config.DEBUG:
        raise HTTPException(status_code=404, detail="Not found")
    raw = await request.body()
    if not raw.strip():
        raise HTTPException(status_code=400, detail="Empty message body")
    recipients = [r.strip() for r in to.split(",")] if to else None
    results = await run_in_threadpool(relay.process_inbound, raw, envelope_recipients=recipients, source="dev")
    return {"results": [r.as_dict() for r in results]}
