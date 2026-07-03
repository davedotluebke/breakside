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
"""
import json
import os
import threading
from pathlib import Path
from typing import Any


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
