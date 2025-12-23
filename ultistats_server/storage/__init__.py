"""
Storage module for JSON file-based storage of games, players, teams, users, and memberships.
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

from .user_storage import (
    user_exists,
    get_user,
    save_user,
    create_or_update_user,
    update_user,
    delete_user,
    list_users,
    set_admin,
)

from .membership_storage import (
    membership_exists,
    get_membership,
    create_membership,
    update_membership_role,
    delete_membership,
    get_user_memberships,
    get_team_memberships,
    get_user_team_membership,
    get_user_team_role,
    get_user_teams,
    get_team_coaches,
    get_team_viewers,
    rebuild_membership_index,
)

from .share_storage import (
    share_exists,
    get_share,
    get_share_by_hash,
    is_share_valid,
    create_share_link,
    list_game_shares,
    revoke_share,
    delete_share,
    rebuild_share_index,
)

from .invite_storage import (
    invite_exists,
    get_invite,
    get_invite_by_code,
    is_invite_valid,
    get_invite_validity_reason,
    create_invite,
    list_team_invites,
    redeem_invite,
    revoke_invite,
    delete_invite,
    rebuild_invite_index,
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
    # User storage
    "user_exists",
    "get_user",
    "save_user",
    "create_or_update_user",
    "update_user",
    "delete_user",
    "list_users",
    "set_admin",
    # Membership storage
    "membership_exists",
    "get_membership",
    "create_membership",
    "update_membership_role",
    "delete_membership",
    "get_user_memberships",
    "get_team_memberships",
    "get_user_team_membership",
    "get_user_team_role",
    "get_user_teams",
    "get_team_coaches",
    "get_team_viewers",
    "rebuild_membership_index",
    # Share storage
    "share_exists",
    "get_share",
    "get_share_by_hash",
    "is_share_valid",
    "create_share_link",
    "list_game_shares",
    "revoke_share",
    "delete_share",
    "rebuild_share_index",
    # Invite storage
    "invite_exists",
    "get_invite",
    "get_invite_by_code",
    "is_invite_valid",
    "get_invite_validity_reason",
    "create_invite",
    "list_team_invites",
    "redeem_invite",
    "revoke_invite",
    "delete_invite",
    "rebuild_invite_index",
]
