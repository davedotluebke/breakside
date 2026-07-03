"""
Event endpoints (tournaments / multi-game events).
"""
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException

from ._shared import (
    auth_required,
    event_exists,
    get_current_user,
    get_event,
    get_user_team_role,
    list_team_events,
    save_event,
    team_exists,
    update_event,
    validate_id,
)
from ._shared import delete_event as delete_event_storage

router = APIRouter()


@router.post("/api/events")
async def create_event(
    event_data: Dict[str, Any] = Body(...),
    user: dict = Depends(get_current_user)
):
    """Create a new event. Requires coach access to the event's team."""
    team_id = event_data.get('teamId')
    if not team_id:
        raise HTTPException(status_code=400, detail="teamId is required")

    # Verify coach access to team
    if auth_required():
        role = get_user_team_role(user['id'], team_id)
        if role != 'coach':
            raise HTTPException(status_code=403, detail="Coach access required")

    event_id = save_event(event_data)
    return {"status": "created", "event_id": event_id, "event": get_event(event_id)}


@router.get("/api/events/{event_id}")
async def get_event_endpoint(
    event_id: str,
    user: dict = Depends(get_current_user)
):
    """Get an event by ID."""
    validate_id(event_id, "event_id")
    if not event_exists(event_id):
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found")
    return get_event(event_id)


@router.put("/api/events/{event_id}")
async def update_event_endpoint(
    event_id: str,
    event_data: Dict[str, Any] = Body(...),
    user: dict = Depends(get_current_user)
):
    """Update an event. Requires coach access to the event's team."""
    validate_id(event_id, "event_id")
    if not event_exists(event_id):
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found")

    existing = get_event(event_id)
    team_id = existing.get('teamId')

    if auth_required() and team_id:
        role = get_user_team_role(user['id'], team_id)
        if role != 'coach':
            raise HTTPException(status_code=403, detail="Coach access required")

    # Preserve teamId from existing
    event_data['teamId'] = team_id
    update_event(event_id, event_data)
    return {"status": "updated", "event": get_event(event_id)}


@router.delete("/api/events/{event_id}")
async def delete_event_endpoint(
    event_id: str,
    user: dict = Depends(get_current_user)
):
    """Delete an event. Requires coach access to the event's team."""
    validate_id(event_id, "event_id")
    if not event_exists(event_id):
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found")

    existing = get_event(event_id)
    team_id = existing.get('teamId')

    if auth_required() and team_id:
        role = get_user_team_role(user['id'], team_id)
        if role != 'coach':
            raise HTTPException(status_code=403, detail="Coach access required")

    delete_event_storage(event_id)
    return {"status": "deleted", "event_id": event_id}


@router.get("/api/teams/{team_id}/events")
async def get_team_events(
    team_id: str,
    user: dict = Depends(get_current_user)
):
    """List all events for a team."""
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    events = list_team_events(team_id)
    return {"events": events}
