"""
Miscellaneous endpoints: API info, health check, image proxy, index admin.
"""
from fastapi import APIRouter, Body, Depends, HTTPException

from ._shared import (
    get_current_user,
    get_index_status,
    rebuild_index,
    require_admin,
)

router = APIRouter()


@router.get("/api")
async def api_info():
    """API information endpoint."""
    return {
        "message": "Ultistats API Server",
        "version": "1.0.0",
        "status": "running"
    }


# Health check
@router.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy"}


# =============================================================================
# Image Proxy endpoint
# =============================================================================

def _assert_public_http_url(url: str) -> None:
    """Reject a URL whose host resolves to a non-public IP (SSRF guard).

    Resolves the hostname and raises HTTP 400 if ANY resolved address is
    private, loopback, link-local (incl. the cloud metadata 169.254.169.254),
    reserved, multicast or unspecified. This blocks server-side fetches of
    internal services and instance-metadata endpoints.

    Note: a fully robust guard would also pin the socket to the validated IP to
    defeat DNS-rebinding (TOCTOU between this check and httpx's own resolution);
    combined with redirects disabled, this check closes the practical vectors.
    """
    import socket
    import ipaddress
    from urllib.parse import urlparse

    host = urlparse(url).hostname
    if not host:
        raise HTTPException(status_code=400, detail="Invalid URL: missing host")

    # If the host is a literal IP, validate it directly; otherwise resolve.
    candidates = set()
    try:
        ipaddress.ip_address(host)
        candidates.add(host)
    except ValueError:
        try:
            for info in socket.getaddrinfo(host, None):
                candidates.add(info[4][0])
        except socket.gaierror:
            raise HTTPException(status_code=400, detail="Could not resolve image host")

    if not candidates:
        raise HTTPException(status_code=400, detail="Could not resolve image host")

    for addr in candidates:
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid resolved address")
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise HTTPException(
                status_code=400,
                detail="URL host is not allowed (resolves to a non-public address)"
            )


@router.post("/api/proxy-image")
async def proxy_image(body: dict = Body(...), user: dict = Depends(get_current_user)):
    """
    Proxy and resize an image from a URL.

    This endpoint fetches an image from a URL (bypassing CORS),
    resizes it to max 128x128, and returns it as a base64 data URL.

    Requires authentication. To prevent SSRF, the target host is resolved and
    rejected if it maps to a private/loopback/link-local address (e.g. the EC2
    metadata endpoint 169.254.169.254 or internal services), and redirects are
    disabled so a public URL can't bounce to an internal one.

    Request body:
        url: str - The image URL to fetch

    Returns:
        dataUrl: str - The resized image as a data URL (PNG format)
        originalUrl: str - The original URL that was fetched
    """
    import httpx
    import base64
    from io import BytesIO

    url = body.get("url")
    if not url:
        raise HTTPException(status_code=400, detail="Missing 'url' in request body")

    # Validate URL format
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid URL format")

    # SSRF guard: reject hosts that resolve to non-public addresses.
    _assert_public_http_url(url)

    MAX_SIZE = 256
    MAX_FILE_SIZE = 5 * 1024 * 1024  # 5MB max download

    try:
        # Fetch the image. Redirects are disabled so a public URL can't 302 to
        # an internal address that bypassed the pre-flight DNS check.
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            response = await client.get(url, headers={
                "User-Agent": "Breakside/1.0 (Team Icon Fetcher)"
            })

            if response.status_code != 200:
                raise HTTPException(
                    status_code=400,
                    detail=f"Failed to fetch image: HTTP {response.status_code}"
                )

            content_type = response.headers.get("content-type", "")
            if not content_type.startswith("image/"):
                raise HTTPException(
                    status_code=400,
                    detail=f"URL does not point to an image (got {content_type})"
                )

            if len(response.content) > MAX_FILE_SIZE:
                raise HTTPException(
                    status_code=400,
                    detail="Image too large (max 5MB)"
                )

            image_data = response.content

        # Resize the image using Pillow
        try:
            from PIL import Image
        except ImportError:
            # Pillow not installed - return original image as base64
            data_url = f"data:{content_type};base64,{base64.b64encode(image_data).decode()}"
            return {"dataUrl": data_url, "originalUrl": url}

        # Open and resize the image
        img = Image.open(BytesIO(image_data))

        # Convert to RGBA if necessary (for PNG transparency support)
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            img = img.convert("RGBA")
        else:
            img = img.convert("RGB")

        # Calculate new dimensions maintaining aspect ratio
        width, height = img.size
        if width > MAX_SIZE or height > MAX_SIZE:
            if width > height:
                new_height = int(height * MAX_SIZE / width)
                new_width = MAX_SIZE
            else:
                new_width = int(width * MAX_SIZE / height)
                new_height = MAX_SIZE
            img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

        # Save to bytes
        output = BytesIO()
        if img.mode == "RGBA":
            img.save(output, format="PNG", optimize=True)
            mime_type = "image/png"
        else:
            img.save(output, format="PNG", optimize=True)
            mime_type = "image/png"

        output.seek(0)
        encoded = base64.b64encode(output.read()).decode()
        data_url = f"data:{mime_type};base64,{encoded}"

        return {"dataUrl": data_url, "originalUrl": url}

    except HTTPException:
        # Don't let the generic handler below mask our own 400s (bad
        # status / not-an-image / too-large) as 500s.
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=408, detail="Timeout fetching image")
    except httpx.RequestError as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch image: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing image: {str(e)}")


# =============================================================================
# Index endpoints
# =============================================================================

@router.post("/api/index/rebuild")
async def rebuild_index_endpoint(user: dict = Depends(require_admin)):
    """
    Force rebuild of the index.

    Requires: Admin access.
    """
    index = rebuild_index()
    return {
        "status": "rebuilt",
        "lastRebuilt": index.get("lastRebuilt"),
        "playerCount": len(index.get("playerGames", {})),
        "teamCount": len(index.get("teamGames", {})),
        "gameCount": len(index.get("gameRoster", {})),
    }


@router.get("/api/index/status")
async def get_index_status_endpoint():
    """Get index status and statistics."""
    return get_index_status()
