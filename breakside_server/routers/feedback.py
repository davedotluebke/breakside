"""
In-app feedback: ``POST /api/feedback`` emails a signed-in user's message to
the support address. The work is in mail/feedback.py; this maps its refusals
to HTTP statuses the app's Give Feedback dialog understands.
"""
from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from ._shared import get_current_user, get_user, import_server_module

feedback = import_server_module("mail.feedback")
transport_mod = import_server_module("mail.transport")

router = APIRouter()


@router.post("/api/feedback")
async def post_feedback(body: dict = Body(...), user: dict = Depends(get_current_user)):
    """Send feedback. Body: ``{"message": str, "diagnostics": {key: value}}``.

    400 for an empty or over-long message, 429 (with Retry-After) past the
    hourly limits, 503 when no ``help=`` forward is configured, 502 when the
    mail provider refuses. The dialog keeps the user's text on every one of
    these and offers a plain email link instead.
    """
    profile = get_user(user["id"]) or {}
    try:
        await run_in_threadpool(
            feedback.send_feedback,
            user=user, profile=profile,
            message=body.get("message"), diagnostics=body.get("diagnostics"),
        )
    except feedback.InvalidFeedback as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except feedback.RateLimited as exc:
        raise HTTPException(status_code=429, detail=str(exc),
                            headers={"Retry-After": str(exc.retry_after)})
    except feedback.NotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except transport_mod.TransportError:
        raise HTTPException(status_code=502, detail="Could not send your feedback right now.")
    return {"status": "sent"}
