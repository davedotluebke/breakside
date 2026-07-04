"""
Event endpoints (tournaments / multi-game events).

Authorization runs through the shared require_* dependencies (which
centralize admin bypass + the AUTH_REQUIRED short-circuit), like the rest
of the API — no inline ``if auth_required():`` checks here.
"""
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from ._shared import (
    event_exists,
    get_event,
    get_json_body,
    list_team_events,
    require_body_team_coach,
    require_event_team_access,
    require_event_team_coach,
    require_team_access,
    save_event,
    team_exists,
    update_event,
    validate_id,
)
from ._shared import delete_event as delete_event_storage

router = APIRouter()


@router.post("/api/events")
async def create_event(
    event_data: Dict[str, Any] = Depends(get_json_body),
    user: dict = Depends(require_body_team_coach)
):
    """Create a new event. Requires coach access to the event's team."""
    # require_body_team_coach already enforced this when auth is on; repeat
    # for auth-disabled dev servers so events never land without a team.
    if not event_data.get('teamId'):
        raise HTTPException(status_code=400, detail="teamId is required")

    event_id = save_event(event_data)
    return {"status": "created", "event_id": event_id, "event": get_event(event_id)}


@router.get("/api/events/{event_id}")
async def get_event_endpoint(
    event_id: str,
    user: dict = Depends(require_event_team_access)
):
    """Get an event by ID. Requires coach or viewer access to the event's team."""
    validate_id(event_id, "event_id")
    if not event_exists(event_id):
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found")
    return get_event(event_id)


@router.put("/api/events/{event_id}")
async def update_event_endpoint(
    event_id: str,
    event_data: Dict[str, Any] = Depends(get_json_body),
    user: dict = Depends(require_event_team_coach)
):
    """Update an event. Requires coach access to the event's team."""
    validate_id(event_id, "event_id")
    if not event_exists(event_id):
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found")

    # Preserve teamId from existing — an update can't move the event to
    # another team (authorization above checked the stored team).
    event_data['teamId'] = get_event(event_id).get('teamId')
    update_event(event_id, event_data)
    return {"status": "updated", "event": get_event(event_id)}


@router.delete("/api/events/{event_id}")
async def delete_event_endpoint(
    event_id: str,
    user: dict = Depends(require_event_team_coach)
):
    """Delete an event. Requires coach access to the event's team."""
    validate_id(event_id, "event_id")
    if not event_exists(event_id):
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found")

    delete_event_storage(event_id)
    return {"status": "deleted", "event_id": event_id}


@router.get("/api/teams/{team_id}/events")
async def get_team_events(
    team_id: str,
    user: dict = Depends(require_team_access("team_id"))
):
    """List all events for a team. Requires coach or viewer access to the team."""
    if not team_exists(team_id):
        raise HTTPException(status_code=404, detail=f"Team {team_id} not found")

    events = list_team_events(team_id)
    return {"events": events}
