"""
Main FastAPI application for the Ultistats server.

App wiring only: the endpoints live in the routers/ package (games, teams,
players, invites, shares, controller, events, auth_api, misc, static_files)
and share storage/auth imports via routers/_shared.py.
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Dual-mode import: top-level modules (`uvicorn main:app` from inside
# ultistats_server/) or package (`from ultistats_server.main import app`).
# The equivalent resolution for storage/validation/auth happens once in
# routers/_shared.py.
try:
    from config import HOST, PORT, DEBUG, ALLOWED_ORIGINS
    from auth.jwt_validation import assert_auth_configured
    from narration import router as narration_router
    import routers
except ImportError:
    from ultistats_server.config import HOST, PORT, DEBUG, ALLOWED_ORIGINS
    from ultistats_server.auth.jwt_validation import assert_auth_configured
    from ultistats_server.narration import router as narration_router
    from ultistats_server import routers

# Minimal app-wide logging setup. Uvicorn configures its own access/error
# loggers; this covers our module loggers (logging.getLogger(__name__)),
# which otherwise print nothing above WARNING. Under systemd, stdout/stderr
# land in the journal.
logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail fast on a broken auth config (auth required, no JWT secret)
    # instead of 500ing on every request after a seemingly clean boot.
    assert_auth_configured()
    yield


# Create FastAPI app
app = FastAPI(
    title="Ultistats API",
    description="API for the Ultistats PWA - Ultimate Frisbee Statistics Tracker",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount AI narration router (speech-to-events)
app.include_router(narration_router)

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
