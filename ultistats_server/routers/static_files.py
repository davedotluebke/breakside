"""
Static / PWA / landing-page serving.

All handlers funnel through _serve_static_file, which enforces the
first-segment whitelist and the resolved-path containment check
(validation.safe_static_path) against path traversal.

The ``/{filename:path}`` catch-all at the bottom must be the LAST route
registered on the app — main.py includes this router last.
"""
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ._shared import safe_static_path

router = APIRouter()

# Repo root (this file lives at ultistats_server/routers/): the PWA files are
# the main ultistats app in the parent of ultistats_server.
pwa_dir = Path(__file__).parent.parent.parent
pwa_static_files = ["main.css", "main.js", "manifest.json", "service-worker.js", "version.json"]
pwa_static_dirs = ["data", "game", "playByPlay", "screens", "teams", "ui", "utils", "images", "auth", "landing", "store", "narration"]

# Landing page directory
landing_dir = pwa_dir / "landing"

# Media types for static file serving (shared by all PWA/landing handlers).
_STATIC_MEDIA_TYPES = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.html': 'text/html',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json',
}


def _serve_static_file(base_dir: Path, filename: str,
                       allowed_first_parts: Optional[set] = None) -> FileResponse:
    """Serve a static file from ``base_dir``, guarding against path traversal.

    If ``allowed_first_parts`` is given, the first path segment must be in that
    whitelist. In all cases the resolved path is confirmed to stay inside
    ``base_dir`` (``safe_static_path``) so escapes like ``game/../../secret``
    that slip past the first-segment whitelist are rejected.
    """
    if allowed_first_parts is not None:
        first_part = filename.split('/')[0] if '/' in filename else filename
        if first_part not in allowed_first_parts:
            raise HTTPException(status_code=404, detail="File not found")

    safe_path = safe_static_path(base_dir, filename)
    if safe_path is None:
        raise HTTPException(status_code=404, detail="File not found")

    media_type = _STATIC_MEDIA_TYPES.get(safe_path.suffix.lower(), 'application/octet-stream')
    return FileResponse(safe_path, media_type=media_type)


# Whitelisted top-level files/dirs for PWA serving.
_PWA_ALLOWED_FIRST_PARTS = set(pwa_static_files) | set(pwa_static_dirs)


@router.get("/")
async def root():
    """Serve the PWA index.html at root (redirects to /ultistats/ for PWA compatibility)"""
    index_file = pwa_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html")
    return {
        "message": "Ultistats API Server",
        "version": "1.0.0",
        "status": "running"
    }

# =============================================================================
# PWA app routes (primary PWA access point)
# =============================================================================

@router.get("/app/")
@router.get("/app/index.html")
async def app_page():
    """Serve the PWA at /app/ (main entry point for the app)."""
    index_file = pwa_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html")
    raise HTTPException(status_code=404, detail="PWA not found")


@router.get("/app/{filename:path}")
async def serve_app_file(filename: str):
    """Serve PWA files under /app/ path."""
    return _serve_static_file(pwa_dir, filename, _PWA_ALLOWED_FIRST_PARTS)


# =============================================================================
# Join page route (invite redemption)
# =============================================================================

@router.get("/join/{code}")
async def join_page(code: str):
    """
    Serve the join page for invite redemption.

    The code is passed via URL path and read by the JavaScript.
    """
    join_file = landing_dir / "join.html"
    if join_file.exists():
        return FileResponse(join_file, media_type="text/html")
    raise HTTPException(status_code=404, detail="Join page not found")


# =============================================================================
# Landing page routes
# =============================================================================

@router.get("/landing/")
@router.get("/landing/index.html")
async def landing_page():
    """Serve the landing page with login UI."""
    index_file = landing_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html")
    raise HTTPException(status_code=404, detail="Landing page not found")


@router.get("/landing/{filename:path}")
async def serve_landing_file(filename: str):
    """Serve landing page static files."""
    return _serve_static_file(landing_dir, filename)


# =============================================================================
# Viewer redirect (user-friendly URL)
# =============================================================================

@router.get("/viewer/")
@router.get("/viewer")
async def viewer_redirect():
    """Redirect /viewer/ to the static viewer."""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/static/viewer/", status_code=302)


# =============================================================================
# PWA routes under /ultistats/ (matches production path and manifest.json)
# =============================================================================

@router.get("/ultistats/")
@router.get("/ultistats/index.html")
async def ultistats_root():
    """Serve the PWA index.html under /ultistats/ path (for PWA install)"""
    index_file = pwa_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file, media_type="text/html")
    raise HTTPException(status_code=404, detail="index.html not found")

@router.get("/ultistats/{filename:path}")
async def serve_ultistats_file(filename: str):
    """Serve PWA files under /ultistats/ path."""
    return _serve_static_file(pwa_dir, filename, _PWA_ALLOWED_FIRST_PARTS)


# PWA file serving - MUST be last to avoid catching API routes
@router.get("/{filename:path}")
async def serve_pwa_file(filename: str):
    """Serve PWA files from parent directory (only whitelisted files/dirs)."""
    return _serve_static_file(pwa_dir, filename, _PWA_ALLOWED_FIRST_PARTS)
