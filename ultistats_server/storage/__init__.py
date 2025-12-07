"""
Storage module for JSON file-based storage of games, players, teams, and index.
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

from .player_storage import (
    generate_player_id,
    save_player,
    get_player,
    list_players,
    update_player,
    delete_player,
    player_exists,
)

from .team_storage import (
    generate_team_id,
    save_team,
    get_team,
    list_teams,
    update_team,
    delete_team,
    team_exists,
    get_team_players,
)

from .index_storage import (
    rebuild_index,
    get_index,
    get_index_status,
    get_player_games,
    get_team_games,
    get_game_players,
    get_player_teams,
    update_index_for_game,
    update_index_for_team,
)

__all__ = [
    # Game storage
    "save_game_version",
    "get_game_current",
    "get_game_version",
    "list_game_versions",
    "game_exists",
    "delete_game",
    "list_all_games",
    # Player storage
    "generate_player_id",
    "save_player",
    "get_player",
    "list_players",
    "update_player",
    "delete_player",
    "player_exists",
    # Team storage
    "generate_team_id",
    "save_team",
    "get_team",
    "list_teams",
    "update_team",
    "delete_team",
    "team_exists",
    "get_team_players",
    # Index storage
    "rebuild_index",
    "get_index",
    "get_index_status",
    "get_player_games",
    "get_team_games",
    "get_game_players",
    "get_player_teams",
    "update_index_for_game",
    "update_index_for_team",
]
