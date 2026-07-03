"""
Shared CRUD for one-JSON-file-per-entity storage (players, teams, events).

Each of those modules stores entities as ``{dir}/{id}.json`` and used to
copy-paste identical save/get/list/update/delete/exists logic.
:class:`JsonEntityStore` is that logic written once, with the atomic-write +
per-entity locking discipline from ``file_utils`` built in.

The modules keep their public function APIs and their module-level ``*_DIR``
constants (tests patch those after import), so the store takes a zero-arg
``dir_getter`` and resolves the directory on every call rather than capturing
a Path at construction.
"""
import json
from datetime import datetime
from pathlib import Path
from typing import Callable, List, Optional

from .file_utils import atomic_write_json, entity_lock
from .id_utils import generate_entity_id, ensure_unique_id


class JsonEntityStore:
    def __init__(
        self,
        kind: str,
        dir_getter: Callable[[], Path],
        sort_key: Callable[[dict], object],
        sort_reverse: bool = False,
        strip_fields: tuple = (),
        apply_defaults: Optional[Callable[[dict], None]] = None,
    ):
        """
        Args:
            kind: Capitalized entity name ("Player") — used in error messages;
                its lowercase form is the lock-key prefix and ID fallback.
            dir_getter: Zero-arg callable returning the storage directory.
            sort_key / sort_reverse: Ordering for :meth:`list`.
            strip_fields: Client-side-only fields removed on save.
            apply_defaults: Optional hook that fills required fields on save.
        """
        self.kind = kind
        self.key = kind.lower()
        self._dir = dir_getter
        self._sort_key = sort_key
        self._sort_reverse = sort_reverse
        self._strip_fields = strip_fields
        self._apply_defaults = apply_defaults

    def _file(self, entity_id: str) -> Path:
        return self._dir() / f"{entity_id}.json"

    def exists(self, entity_id: str) -> bool:
        """Check if an entity exists."""
        return self._file(entity_id).exists()

    def generate_unique_id(self, name: str) -> str:
        """Generate a collision-free ID from a display name."""
        return ensure_unique_id(generate_entity_id(name, self.key), self.exists)

    def save(self, data: dict, entity_id: Optional[str] = None) -> str:
        """
        Save an entity. If no ID provided, generates one from ``data['name']``.

        Note: mutates ``data`` in place (strips client-only fields, sets
        id/createdAt/updatedAt) — long-standing behavior callers rely on.

        Returns:
            The entity ID
        """
        self._dir().mkdir(parents=True, exist_ok=True)

        if not entity_id:
            entity_id = self.generate_unique_id(data.get('name', 'Unknown'))

        # Strip client-side-only fields
        for field in self._strip_fields:
            data.pop(field, None)

        # Add metadata
        now = datetime.now().isoformat()
        if 'createdAt' not in data:
            data['createdAt'] = now
        data['updatedAt'] = now
        data['id'] = entity_id

        if self._apply_defaults:
            self._apply_defaults(data)

        atomic_write_json(self._file(entity_id), data)

        return entity_id

    def get(self, entity_id: str) -> dict:
        """
        Get an entity by ID.

        Raises:
            FileNotFoundError: If the entity doesn't exist
        """
        entity_file = self._file(entity_id)
        if not entity_file.exists():
            raise FileNotFoundError(f"{self.kind} {entity_id} not found")

        with open(entity_file, 'r') as f:
            return json.load(f)

    def list(self) -> List[dict]:
        """List all entities, sorted per the store's sort key."""
        entities = []
        directory = self._dir()
        if not directory.exists():
            return entities

        for entity_file in directory.glob("*.json"):
            try:
                with open(entity_file, 'r') as f:
                    entities.append(json.load(f))
            except (json.JSONDecodeError, KeyError):
                # Skip invalid files
                continue

        entities.sort(key=self._sort_key, reverse=self._sort_reverse)
        return entities

    def update(self, entity_id: str, data: dict) -> str:
        """
        Update an existing entity, preserving its createdAt.

        Raises:
            FileNotFoundError: If the entity doesn't exist
        """
        # Serialize the read (createdAt) + write so concurrent updates to the
        # same entity can't interleave and lose each other.
        with entity_lock(f"{self.key}:{entity_id}"):
            if not self.exists(entity_id):
                raise FileNotFoundError(f"{self.kind} {entity_id} not found")

            existing = self.get(entity_id)
            data['createdAt'] = existing.get('createdAt', datetime.now().isoformat())

            return self.save(data, entity_id)

    def delete(self, entity_id: str) -> bool:
        """
        Delete an entity.

        Returns:
            True if deleted, False if it didn't exist
        """
        entity_file = self._file(entity_id)
        if not entity_file.exists():
            return False

        entity_file.unlink()
        return True
