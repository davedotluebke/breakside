"""
Shared JSON index-file plumbing for storage modules.

membership/invite/share storage each keep a small ``_index.json`` next to
their entity files mapping lookups (byUser/byTeam, byCode/byTeam,
byHash/byGame), and each had copy-pasted load/save/add/remove/rebuild logic.
:class:`JsonIndex` is that pattern written once, with the atomic-write +
locking discipline built in: :meth:`update` serializes every
read-modify-write behind one ``entity_lock`` and saves atomically, so two
concurrent index writers can't overwrite each other (previously a dropped
membership meant that user silently lost team access until a manual rebuild).

The index path is a zero-arg callable so tests can keep patching the
module-level ``INDEX_FILE`` constants after import.
"""
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict

from .file_utils import atomic_write_json, entity_lock


class JsonIndex:
    def __init__(
        self,
        path_getter: Callable[[], Path],
        lock_key: str,
        empty: Callable[[], Dict[str, Any]],
    ):
        """
        Args:
            path_getter: Zero-arg callable returning the index file path.
            lock_key: entity_lock key serializing all writers of this index.
            empty: Factory for the empty index structure.
        """
        self._path = path_getter
        self._lock_key = lock_key
        self._empty = empty

    def load(self) -> Dict[str, Any]:
        """Load the index, or the empty structure if missing/unreadable."""
        path = self._path()
        if not path.exists():
            return self._empty()

        try:
            with open(path, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return self._empty()

    def save(self, index: Dict[str, Any]) -> None:
        """Save the index atomically."""
        atomic_write_json(self._path(), index)

    @contextmanager
    def update(self):
        """Serialized read-modify-write: lock, load, yield the index, save."""
        with entity_lock(self._lock_key):
            index = self.load()
            yield index
            self.save(index)

    def rebuild(self, entities_dir: Path, add_entry: Callable[[Dict[str, Any], dict], None]) -> Dict[str, Any]:
        """
        Rebuild the index from scratch by scanning ``entities_dir``.

        ``add_entry(index, entity)`` records one entity in the fresh index.
        Files starting with ``_`` (the index itself) and unparseable files are
        skipped. Useful if the index gets corrupted or out of sync.

        Returns:
            The rebuilt index
        """
        index = self._empty()

        if entities_dir.exists():
            for entity_file in entities_dir.glob("*.json"):
                if entity_file.name.startswith("_"):
                    continue  # Skip index file

                try:
                    with open(entity_file, "r") as f:
                        entity = json.load(f)
                    add_entry(index, entity)
                except (json.JSONDecodeError, IOError, KeyError):
                    continue

        self.save(index)
        return index


def add_to_bucket(index: Dict[str, Any], bucket: str, key: str, value: str) -> None:
    """Append ``value`` to the ``index[bucket][key]`` list (deduplicated)."""
    entries = index[bucket].setdefault(key, [])
    if value not in entries:
        entries.append(value)


def remove_from_bucket(index: Dict[str, Any], bucket: str, key: str, value: str) -> None:
    """Remove ``value`` from ``index[bucket][key]``, dropping the key when empty."""
    if key in index[bucket]:
        index[bucket][key] = [v for v in index[bucket][key] if v != value]
        if not index[bucket][key]:
            del index[bucket][key]
