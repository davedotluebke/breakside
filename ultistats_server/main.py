"""
Main FastAPI application for the Ultistats server.

App wiring only: the endpoints live in the routers/ package (games, teams,
players, invites, shares, controller, events, auth_api, misc, static_files)
and share storage/auth imports via routers/_shared.py.
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

# Dual-mode import: top-level modules (`uvicorn main:app` from inside
# ultistats_server/) or package (`from ultistats_server.main import app`).
# The equivalent resolution for storage/validation/auth happens once in
# routers/_shared.py.
try:
    from config import HOST, PORT, DEBUG, ALLOWED_ORIGINS
    from auth.jwt_validation import assert_auth_configured
    from storage.file_utils import assert_data_dir_writable
    from narration import router as narration_router
    from narration_lineup import router as narration_lineup_router
    import routers
except ImportError:
    from ultistats_server.config import HOST, PORT, DEBUG, ALLOWED_ORIGINS
    from ultistats_server.auth.jwt_validation import assert_auth_configured
    from ultistats_server.storage.file_utils import assert_data_dir_writable
    from ultistats_server.narration import router as narration_router
    from ultistats_server.narration_lineup import router as narration_lineup_router
    from ultistats_server import routers

# Minimal app-wide logging setup. Uvicorn configures its own access/error
# loggers; this covers our module loggers (logging.getLogger(__name__)),
# which otherwise print nothing above WARNING. Under systemd, stdout/stderr
# land in the journal.
logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail fast on a broken auth config (auth required, no JWT secret)
    # instead of 500ing on every request after a seemingly clean boot.
    assert_auth_configured()
    # Fail fast if the data dir isn't writable (and log any unwritable
    # nested dirs) instead of 500ing on every later save. Root-owned dirs
    # from scripts run as root are the known way this breaks (2026-07-03).
    assert_data_dir_writable()
    yield


# Create FastAPI app
app = FastAPI(
    title="Ultistats API",
    description="API for the Ultistats PWA - Ultimate Frisbee Statistics Tracker",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware.
# NOTE: keep this config in sync with _cors_headers_for_error below, which
# mirrors it for unhandled-exception responses (they bypass this middleware).
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _cors_headers_for_error(request: Request, allowed_origins=None) -> dict:
    """CORS headers for an error response, mirroring CORSMiddleware exactly.

    Why this exists: an UNHANDLED exception propagates past CORSMiddleware
    without sending a response through it — Starlette's ServerErrorMiddleware
    (outermost, where Exception handlers run) builds the 500 outside the CORS
    layer, so the bare 500 reaches the browser with no CORS headers. The
    browser then blocks the response and fetch() rejects with an opaque
    TypeError ("Load failed" on Safari), which the client sync layer can't
    distinguish from being offline — the poison-pill root cause of the
    2026-07-03 staging incident. Normal HTTPExceptions are unaffected: they
    are handled by ExceptionMiddleware INSIDE the CORS layer and already get
    headers.

    Mirrors the simple-response logic of the CORSMiddleware configured above
    (allow_origins=ALLOWED_ORIGINS, allow_credentials=True), per Starlette:
      - No Origin request header -> not a CORS request -> no headers.
      - Credentials are allowed -> always Access-Control-Allow-Credentials.
      - Wildcard mode ("*" in origins) -> Allow-Origin "*", EXCEPT for
        credentialed (cookie-bearing) requests, which must echo the explicit
        Origin (+ Vary: Origin) because browsers reject "*" with credentials.
      - Explicit-origins mode -> echo the Origin (+ Vary: Origin) ONLY if it
        is in the allowlist; a disallowed origin gets no Allow-Origin header,
        so the browser still (correctly) blocks it.

    ``allowed_origins`` overrides ALLOWED_ORIGINS for tests.
    """
    origins = ALLOWED_ORIGINS if allowed_origins is None else allowed_origins
    origin = request.headers.get("origin")
    if origin is None:
        return {}

    headers = {"Access-Control-Allow-Credentials": "true"}
    allow_all = "*" in origins
    if allow_all:
        if "cookie" in request.headers:
            headers["Access-Control-Allow-Origin"] = origin
            headers["Vary"] = "Origin"
        else:
            headers["Access-Control-Allow-Origin"] = "*"
    elif origin in origins:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Vary"] = "Origin"
    return headers


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Turn unhandled exceptions into 500 JSON responses WITH CORS headers.

    Registered for bare Exception, so Starlette wires it into
    ServerErrorMiddleware as the 500 handler. It must attach CORS headers
    itself (see _cors_headers_for_error) — its response never passes through
    CORSMiddleware. Starlette re-raises the exception after sending the
    response, so uvicorn still logs the traceback as usual.
    """
    logger.error(
        "Unhandled exception on %s %s", request.method, request.url.path,
        exc_info=exc,
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers=_cors_headers_for_error(request),
    )

# Mount AI narration router (speech-to-events)
app.include_router(narration_router)
# Mount lineup narration router (speech-to-lineup for the Lines tab —
# separate layer from in-point narration; see narration_lineup.py)
app.include_router(narration_lineup_router)

# Mount static files (viewer, etc.) - html=True enables serving index.html for directories
static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir), html=True), name="static")

# API routers. All API paths carry the /api/ prefix (or are fixed paths like
# /health), so their relative order doesn't matter...
app.include_router(routers.misc.router)
app.include_router(routers.auth_api.router)
app.include_router(routers.events.router)
app.include_router(routers.games.router)
app.include_router(routers.controller.router)
app.include_router(routers.shares.router)
app.include_router(routers.invites.router)
app.include_router(routers.teams.router)
app.include_router(routers.players.router)

# ...except static_files, whose /{filename:path} catch-all would swallow any
# route registered after it. It MUST stay last.
app.include_router(routers.static_files.router)


if __name__ == "__main__":
    import uvicorn
    # Single-worker by construction: passing the app *object* means uvicorn
    # cannot spawn workers. Required — controller state is in-memory
    # (see storage/controller_storage.py).
    uvicorn.run(app, host=HOST, port=PORT, log_level="debug" if DEBUG else "info")
