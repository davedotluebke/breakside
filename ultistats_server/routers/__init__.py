"""
API routers for the Ultistats server.

Each module holds one endpoint group split out of the former 2000-line
main.py. Route paths are written in full in each decorator (no router
prefixes), so every path/method/status/dependency matches the original
exactly. main.py wires these together; include order only matters for
``static_files``, whose ``/{filename:path}`` catch-all must be registered
last.
"""
from . import (
    auth_api,
    controller,
    events,
    games,
    invites,
    misc,
    players,
    shares,
    static_files,
    teams,
)
