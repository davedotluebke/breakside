"""
Dual-mode import shim for the mail package (same dance as routers/_shared.py).

The server runs either as top-level modules (``uvicorn main:app`` from inside
``breakside_server/``) or as a package (``from breakside_server.main import
app``). Resolve ``config`` and ``storage`` once here so the mail modules can
``from ._shared import config, storage``. Identity matters: tests patch
``storage.mail_storage.MAIL_DIR`` and expect this package to see the patch,
which it does because both resolve the same module object.
"""
import importlib


def import_server_module(name: str):
    try:
        module = importlib.import_module(name)
        # A bare frontend dir (e.g. ``auth/``, no __init__.py) imports as an
        # empty namespace package with no __file__ when running from the repo
        # root; that is not our module.
        if getattr(module, "__file__", None):
            return module
    except ImportError:
        pass
    return importlib.import_module(f"breakside_server.{name}")


config = import_server_module("config")
storage = import_server_module("storage")
