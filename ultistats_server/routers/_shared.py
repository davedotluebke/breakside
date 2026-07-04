"""
Shared import shim for the API routers.

The server runs in two import modes: as top-level modules (``uvicorn main:app``
from inside ``ultistats_server/``, which puts the package dir on sys.path) and
as a package (``from ultistats_server.main import app``). main.py used to
repeat a ~100-line import block twice to handle both; this module performs
that resolution once and re-exports the names routers use, so a router can
write ``from ._shared import save_game_version, require_game_team_coach``.

Identity matters for the auth dependencies: tests override
``app.dependency_overrides[get_current_user]`` with the function imported from
``auth.jwt_validation``, so the objects re-exported here must be the same ones
the ``auth`` package exposes (they are — this is a re-export, not a wrapper).
"""
import importlib


def import_server_module(name: str):
    """Import a server module by its top-level name (``config``) or its
    package-qualified form (``ultistats_server.config``), whichever matches
    how the process was started."""
    try:
        module = importlib.import_module(name)
        # Guard against namespace-package false positives: when the process
        # runs from the repo root, a bare frontend directory like auth/ (JS,
        # no __init__.py) imports as an empty namespace package with no
        # __file__. That's not our module — fall through to the qualified
        # import instead.
        if getattr(module, "__file__", None):
            return module
    except ImportError:
        pass
    return importlib.import_module(f"ultistats_server.{name}")


config = import_server_module("config")
validation = import_server_module("validation")
storage = import_server_module("storage")
auth = import_server_module("auth")

# Re-export every public storage name (storage.__all__ is the canonical list)
# so routers can import them bare, exactly as main.py used to.
globals().update({_name: getattr(storage, _name) for _name in storage.__all__})

# Auth dependencies — explicit so they stay greppable.
get_current_user = auth.get_current_user
get_optional_user = auth.get_optional_user
get_json_body = auth.get_json_body
is_admin = auth.is_admin
require_admin = auth.require_admin
require_team_coach = auth.require_team_coach
require_team_access = auth.require_team_access
require_game_team_coach = auth.require_game_team_coach
require_game_sync_coach = auth.require_game_sync_coach
require_game_team_access = auth.require_game_team_access
require_event_team_coach = auth.require_event_team_coach
require_event_team_access = auth.require_event_team_access
require_body_team_coach = auth.require_body_team_coach
require_player_edit_access = auth.require_player_edit_access
require_player_read_access = auth.require_player_read_access
assert_player_edit_access = auth.assert_player_edit_access

# Validation + config helpers
validate_id = validation.validate_id
safe_static_path = validation.safe_static_path
auth_required = config.auth_required
