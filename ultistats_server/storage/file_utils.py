"""
Shared helpers for safe file-based storage.

Two concerns this module centralizes:

1. **Atomic writes** — every storage module previously did
   ``open(path, 'w'); json.dump(...)`` directly on the live file. A crash (or
   two writers interleaving) mid-dump leaves a truncated / corrupt JSON file
   that all later reads fail on. ``atomic_write_json`` writes to a temp file in
   the same directory and ``os.replace``s it into place — readers always see
   either the old or the new complete file, never a partial one.

2. **Per-entity locking** — read-modify-write sequences (incrementing an
   invite's ``uses``, adding to ``_index.json``, etc.) race under concurrent
   requests: both read the old value, both write back, one update is lost.
   ``entity_lock(key)`` returns a process-wide lock for a logical key so those
   sequences can be serialized. The server runs single-worker (see
   ``controller_storage``), so an in-process ``threading.Lock`` is sufficient.

3. **Startup writability check** — ``assert_data_dir_writable`` fails fast at
   boot when the configured data dir can't be written (see the app lifespan in
   main.py), instead of 500ing on every later save.
"""
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from ._config import config

logger = logging.getLogger(__name__)


def atomic_write_json(path, data: Any, indent: int = 2) -> None:
    """Write ``data`` as JSON to ``path`` atomically (temp file + os.replace)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with open(tmp, "w") as f:
            json.dump(data, f, indent=indent)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)  # atomic on POSIX
    finally:
        # Clean up the temp file if os.replace didn't consume it (error path).
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


# How many unwritable nested dirs to name explicitly in the startup log
# before summarizing the rest ("... and N more").
_MAX_UNWRITABLE_LISTED = 20


def assert_data_dir_writable() -> None:
    """Startup guard: verify the configured data dir is actually writable.

    Called from the app lifespan in main.py (same fail-fast pattern as
    ``assert_auth_configured``). Motivated by a real staging incident
    (2026-07-03): a root-owned ``versions/`` dir under one game made every
    sync of that game 500 with PermissionError, and nothing at startup had
    noticed the broken ownership. Two tiers:

    - **The data dir itself** (``config.DATA_DIR``): created if missing, then
      probed with a REAL file write (``os.access`` can lie under ACLs). If
      the probe fails, raises RuntimeError so uvicorn refuses to start — and
      systemd marks the unit failed — instead of booting a server on which
      every save would 500.
    - **Nested dirs** (``games/<id>/versions/`` etc.): each unwritable one is
      logged as a prominent ERROR, but startup proceeds — version-backup
      writes degrade gracefully (see game_storage), and one root-owned dir
      under one old game must not take the whole API down.

    Also warns when running as root: root-created files are exactly what
    breaks the service user's writes later (never run servers/scripts that
    touch the data dir as root).

    Raises:
        RuntimeError: if DATA_DIR cannot be created or written.
    """
    data_dir = Path(config.DATA_DIR)

    if hasattr(os, "geteuid") and os.geteuid() == 0:
        logger.warning(
            "Server is running as ROOT. Files it creates under %s will be "
            "root-owned and will break writes for the normal service user "
            "later. Never run servers/scripts touching this data dir as root.",
            data_dir,
        )

    # Tier 1: the data dir itself must accept a real write.
    probe = data_dir / f".writable-probe-{os.getpid()}.tmp"
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        with open(probe, "w") as f:
            f.write("probe")
        probe.unlink()
    except OSError as exc:
        raise RuntimeError(
            f"Data directory {data_dir} is not writable ({exc!r}). "
            "The server could boot but every save would fail with a 500. "
            "Fix ownership/permissions (e.g. chown -R to the service user); "
            "this usually means something touched the data dir as root."
        ) from exc

    # Tier 2: sweep nested dirs; log loudly but do not block startup.
    # Only dirs matter: atomic writes (temp file + os.replace) need write+exec
    # on the containing DIRECTORY, not write permission on the target file.
    unwritable = []
    for dirpath, dirnames, _filenames in os.walk(data_dir):
        for name in dirnames:
            path = os.path.join(dirpath, name)
            if not os.access(path, os.W_OK | os.X_OK):
                unwritable.append(path)
    if unwritable:
        listed = unwritable[:_MAX_UNWRITABLE_LISTED]
        more = len(unwritable) - len(listed)
        suffix = f" ... and {more} more" if more > 0 else ""
        logger.error(
            "DATA DIR CHECK: %d unwritable director%s under %s — writes "
            "there will fail (version backups degrade; other saves 500). "
            "Fix with chown -R to the service user. Affected: %s%s",
            len(unwritable), "y" if len(unwritable) == 1 else "ies",
            data_dir, ", ".join(listed), suffix,
        )


_locks: dict = {}
_locks_guard = threading.Lock()


def entity_lock(key: str) -> threading.Lock:
    """Return a process-wide lock for ``key`` (created on first use).

    Use the same key string for every read-modify-write of the same logical
    resource, e.g. ``entity_lock(f"membership-index")`` or
    ``entity_lock(f"invite:{invite_id}")``.
    """
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _locks[key] = lock
        return lock
