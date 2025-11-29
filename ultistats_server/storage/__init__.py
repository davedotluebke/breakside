"""
Storage module for JSON file-based game storage.
"""
from .game_storage import (
    save_game_version,
    get_game_current,
    get_game_version,
    list_game_versions,
    game_exists,
    delete_game,
    list_all_games,
)

__all__ = [
    "save_game_version",
    "get_game_current",
    "get_game_version",
    "list_game_versions",
    "game_exists",
    "delete_game",
    "list_all_games",
]

