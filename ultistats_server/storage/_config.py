"""
Single home for the dual-mode config import.

The server runs in two import modes: as top-level modules (``uvicorn main:app``
from inside ``ultistats_server/``, which puts the package dir on sys.path so
``import config`` works) and as a package (``from ultistats_server.main import
app``). Every storage module used to repeat a try/except import dance to
handle both; they now all do ``from ._config import config`` instead.

Modules still snapshot the directory constants they need at import time
(``PLAYERS_DIR = config.PLAYERS_DIR``) so tests can keep patching those
per-module globals.
"""
import importlib

try:
    config = importlib.import_module("config")
except ImportError:
    config = importlib.import_module("ultistats_server.config")
