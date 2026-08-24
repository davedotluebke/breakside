"""
Self-service account deletion (erasure spec § C).

Owns the *policy* for ``DELETE /api/auth/me``: what an account deletion is
allowed to destroy, what it must refuse, and in what order the destruction
happens. ``routers/auth_api.py`` is a thin HTTP wrapper over
``plan_account_deletion()`` / ``execute_account_deletion()``.

Three rules shape everything here:

1. **Self only.** Nothing in this module takes a target user id from a
   request. The router passes the id off the validated JWT and nothing else.

2. **The Supabase auth identity dies first.** If the admin API call fails —
   no ``SUPABASE_SERVICE_KEY``, network error, non-2xx — the whole operation
   fails and *nothing local is touched*. The alternative failure mode
   (local data gone, auth identity alive) leaves someone who can still sign
   in to an account whose server-side record has vanished; every subsequent
   ``GET /api/auth/me`` would silently re-create it. Half-deleting in the
   other direction (identity gone, some local rows left) is recoverable by an
   operator and unreachable by any user, so that is the direction we fail in.

3. **A team is not one person's to destroy.** See ``plan_account_deletion``.
"""

import json
import logging
import secrets
from typing import Any, Dict, List, Optional

try:  # Both import modes — see routers/_shared.py.
    import config
    from storage import invite_storage, player_storage, share_storage
    from storage.file_utils import atomic_write_json
    from storage.event_storage import delete_event, list_team_events
    from storage.game_storage import delete_game, list_all_games, list_game_versions
    from storage.index_storage import get_team_games, rebuild_index
    from storage.invite_storage import delete_invite, list_team_invites
    from storage.membership_storage import (
        delete_membership,
        get_team_memberships,
        get_user_memberships,
    )
    from storage.share_storage import delete_share, list_game_shares
    from storage.team_storage import delete_team, get_team, list_teams, team_exists
    from storage.user_storage import delete_user, get_user
except ImportError:  # pragma: no cover - exercised by the package import mode
    from ultistats_server import config
    from ultistats_server.storage import invite_storage, player_storage, share_storage
    from ultistats_server.storage.file_utils import atomic_write_json
    from ultistats_server.storage.event_storage import delete_event, list_team_events
    from ultistats_server.storage.game_storage import (
        delete_game,
        list_all_games,
        list_game_versions,
    )
    from ultistats_server.storage.index_storage import get_team_games, rebuild_index
    from ultistats_server.storage.invite_storage import delete_invite, list_team_invites
    from ultistats_server.storage.membership_storage import (
        delete_membership,
        get_team_memberships,
        get_user_memberships,
    )
    from ultistats_server.storage.share_storage import delete_share, list_game_shares
    from ultistats_server.storage.team_storage import (
        delete_team,
        get_team,
        list_teams,
        team_exists,
    )
    from ultistats_server.storage.user_storage import delete_user, get_user

logger = logging.getLogger(__name__)


# The counter keys of the shared preview shape (erasure spec § "Endpoint
# contract"). Player erasure (§ A) fills in "players"; account deletion never
# does — see the orphaned-players warning in _plan_team_cascade().
COUNT_KEYS = (
    "players", "teams", "games", "versions",
    "events", "memberships", "shares", "invites",
)


class AccountDeletionError(Exception):
    """Base for the refusals this module can raise."""


class TeamHandoverRequired(AccountDeletionError):
    """The user is the last coach of a team other people are still using.

    Carries the offending teams so the caller can name them.
    """

    def __init__(self, teams: List[Dict[str, Any]]):
        self.teams = teams
        names = ", ".join(t.get("name") or t["teamId"] for t in teams)
        super().__init__(
            "You are the only coach of a team that other people are still "
            f"members of ({names}). Promote another coach, or remove the other "
            "members, before deleting your account."
        )


class TeamCascadeNotConfirmed(AccountDeletionError):
    """Deleting would destroy teams; the caller has not said yes to that."""

    def __init__(self, teams: List[Dict[str, Any]]):
        self.teams = teams
        super().__init__(
            "Deleting your account will permanently erase teams where you are "
            "the only member. Re-send with confirm_erase_teams=true once the "
            "user has seen the preview."
        )


class AuthIdentityDeletionFailed(AccountDeletionError):
    """The Supabase auth user could not be deleted, so nothing else was.

    ``configured`` distinguishes "the server cannot do this at all" (no
    service key — an operator problem, 503) from "the call was made and
    failed" (502).
    """

    def __init__(self, reason: str, configured: bool = True):
        self.reason = reason
        self.configured = configured
        super().__init__(reason)


def _empty_counts() -> Dict[str, int]:
    return {key: 0 for key in COUNT_KEYS}


# =============================================================================
# Supabase admin identity deletion
# =============================================================================

async def delete_supabase_auth_user(user_id: str) -> None:
    """Delete the Supabase ``auth.users`` row for ``user_id``.

    Requires the service key, which is why this is the *first* destructive
    step: a deployment without it must not be able to strip a user's data and
    leave them able to sign back in.

    A 404 counts as success — the identity is gone, which is all this step is
    asked to guarantee, and it makes a retry after a partial failure work.

    Raises:
        AuthIdentityDeletionFailed: on missing config, transport error, or a
            non-2xx/404 response. The caller must abort without touching disk.
    """
    # Read through the module so a test (or a runtime env change) can patch it.
    base_url = (getattr(config, "SUPABASE_URL", "") or "").rstrip("/")
    service_key = getattr(config, "SUPABASE_SERVICE_KEY", "") or ""

    if not base_url or not service_key:
        raise AuthIdentityDeletionFailed(
            "This server is not configured to delete Supabase accounts "
            "(SUPABASE_SERVICE_KEY is not set). Nothing was deleted.",
            configured=False,
        )

    import httpx

    url = f"{base_url}/auth/v1/admin/users/{user_id}"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.delete(url, headers=headers)
    except httpx.HTTPError as exc:
        raise AuthIdentityDeletionFailed(
            f"Could not reach the authentication service ({exc}). "
            "Nothing was deleted."
        ) from exc

    if response.status_code == 404:
        logger.info("Supabase auth user %s was already gone", user_id)
        return
    if response.status_code >= 400:
        raise AuthIdentityDeletionFailed(
            "The authentication service refused to delete this account "
            f"(HTTP {response.status_code}). Nothing was deleted."
        )


# =============================================================================
# Team cascade — SEAM for erasure spec § B
# =============================================================================
#
# The real team cascade (spec § B: rewrite/erase every game, version backup,
# share, invite and index entry) is being built alongside this module. Account
# deletion only ever cascades a team whose *only* member is the departing user,
# so the fallback below is deliberately narrow: it reuses the existing
# delete_game()/delete_team() primitives, which already rmtree a game
# directory including its versions/.
#
# When § B lands, that module should call ``set_team_eraser(erase_team)`` once
# at import time (or this module's fallback can be deleted outright and the
# import wired directly). The contract is:
#
#     erase_team(team_id: str, *, dry_run: bool) -> Dict[str, int]
#
# returning the COUNT_KEYS shape for what it did (or would do). Anything it
# also handles that the fallback does not — orphaned-player erasure, tombstone
# rewrites — is strictly additive from account deletion's point of view.

_team_eraser = None


def set_team_eraser(fn) -> None:
    """Register the § B team-erasure cascade. See the seam note above."""
    global _team_eraser
    _team_eraser = fn


def get_team_eraser():
    """The cascade in force — the § B implementation if registered."""
    return _team_eraser or _fallback_erase_team


def _team_game_ids(team_id: str) -> List[str]:
    """Every game belonging to ``team_id``.

    Union of the index bucket and a full scan of stored games: the index is a
    cache and a stale entry here means a game survives an "erasure", which is
    exactly the failure this feature exists to prevent.
    """
    ids = set(get_team_games(team_id) or [])
    for meta in list_all_games():
        if meta.get("teamId") == team_id:
            ids.add(meta["game_id"])
    return sorted(ids)


def _fallback_erase_team(team_id: str, *, dry_run: bool = False) -> Dict[str, int]:
    """Minimal team cascade used until spec § B lands. See the seam note."""
    counts = _empty_counts()

    game_ids = _team_game_ids(team_id)
    for game_id in game_ids:
        counts["versions"] += len(list_game_versions(game_id))
        for share in list_game_shares(game_id):
            counts["shares"] += 1
            if not dry_run:
                delete_share(share["id"])
        counts["games"] += 1
        if not dry_run:
            delete_game(game_id)

    for event in list_team_events(team_id):
        counts["events"] += 1
        if not dry_run:
            delete_event(event["id"])

    for invite in list_team_invites(team_id):
        counts["invites"] += 1
        if not dry_run:
            delete_invite(invite["id"])

    for membership in get_team_memberships(team_id):
        counts["memberships"] += 1
        if not dry_run:
            delete_membership(membership["id"])

    if team_exists(team_id):
        counts["teams"] += 1
        if not dry_run:
            delete_team(team_id)

    return counts


# =============================================================================
# Scrubbing the user id out of records that survive
# =============================================================================
#
# Deleting the user's own files is not enough. A user id is written into other
# people's records as an audit field — who created this share, who invited this
# member, who redeemed this invite — and every one of those is a live reference
# to an account that is supposed to be gone. Erasing the referring record
# instead would destroy somebody else's data (a share the team's parents are
# still watching, a membership that is not ours to revoke), so the reference is
# replaced with an opaque per-erasure tombstone and the record itself is left
# alone. Same reasoning as the player tombstones in spec § A.
#
# Every persisted field that holds a user id (grep for the names below):
#     players/*.json       createdBy
#     shares/*.json        createdBy, revokedBy
#     invites/*.json       createdBy, revokedBy, usedBy[].userId
#     memberships/*.json   userId, invitedBy   <- userId records are deleted
#                                                 outright; invitedBy is scrubbed
# Controller state (roles, coach pings) is in-memory only and dies with the
# process, so there is nothing to scrub there.

def _mint_user_tombstone() -> str:
    """Per-erasure opaque stand-in, e.g. ``deleted-user-9f2c``.

    Per-erasure rather than one global sentinel for the same reason § A mints
    one per player: two different deleted accounts must not collapse into a
    single apparent actor in an audit trail.
    """
    return f"deleted-user-{secrets.token_hex(2)}"


def _scrub_json_file(path, user_id: str, tombstone: str, dry_run: bool) -> int:
    """Replace ``user_id`` with ``tombstone`` in one entity file.

    Returns the number of fields that changed (0 if the file did not mention
    the user). Raw read/modify/write rather than the storage modules' save()
    helpers deliberately: this must not bump ``updatedAt``, re-run defaults, or
    re-index somebody else's record just to redact one audit field.
    """
    try:
        with open(path, "r") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return 0
    if not isinstance(data, dict):
        return 0

    changed = 0
    for field in ("createdBy", "revokedBy", "invitedBy"):
        if data.get(field) == user_id:
            data[field] = tombstone
            changed += 1
    for entry in data.get("usedBy") or []:
        if isinstance(entry, dict) and entry.get("userId") == user_id:
            entry["userId"] = tombstone
            changed += 1

    if changed and not dry_run:
        atomic_write_json(path, data)
    return changed


def _scrub_user_references(user_id: str, tombstone: str, dry_run: bool) -> int:
    """Redact ``user_id`` from every surviving record that names them.

    Directories are read off the storage modules at call time (not captured at
    import) so a patched test data dir is honoured.
    """
    changed = 0
    dirs = [
        getattr(player_storage, "PLAYERS_DIR", None),
        getattr(share_storage, "SHARES_DIR", None),
        getattr(invite_storage, "INVITES_DIR", None),
        _memberships_dir(),
    ]
    for directory in dirs:
        if not directory or not directory.exists():
            continue
        for path in directory.glob("*.json"):
            if path.name.startswith("_"):  # index files, not entities
                continue
            changed += _scrub_json_file(path, user_id, tombstone, dry_run)
    return changed


def _memberships_dir():
    try:
        from storage import membership_storage
    except ImportError:  # pragma: no cover
        from ultistats_server.storage import membership_storage
    return getattr(membership_storage, "MEMBERSHIPS_DIR", None)


# =============================================================================
# Planning (drives both the preview and the guard rails on the real delete)
# =============================================================================

def _team_name(team_id: str) -> str:
    try:
        return get_team(team_id).get("name") or team_id
    except (FileNotFoundError, KeyError):
        return team_id


def _orphaned_player_count(team_ids: List[str]) -> int:
    """How many players would be left on no team by erasing ``team_ids``.

    Reported, never acted on: erasing a *person's* record is spec § A, has its
    own authorization, and is not something one departing coach gets to do to
    their teammates by ticking a box on their own account page.
    """
    if not team_ids:
        return 0
    doomed = set(team_ids)
    on_doomed, on_surviving = set(), set()
    for team in list_teams():
        bucket = on_doomed if team.get("id") in doomed else on_surviving
        bucket.update(team.get("playerIds") or [])
    return len(on_doomed - on_surviving)


def plan_account_deletion(user_id: str) -> Dict[str, Any]:
    """Work out exactly what deleting ``user_id`` would destroy. Read-only.

    The same traversal backs ``GET /api/auth/me/delete-preview`` and the guard
    rails inside ``execute_account_deletion``, so the confirm dialog cannot
    describe one outcome while the delete performs another.

    The sole-coach question splits three ways, and the split is the whole
    design decision:

    * **Sole coach, other members present** → *blocked*. Cascading would
      destroy a team other people are actively using, and skipping the team
      would leave it with no one able to administer it, invite anyone, or
      delete it. Neither is this user's call to make unilaterally, so the
      account deletion refuses and names the teams. The remedy is in the app
      already: promote another coach, or remove the other members.
    * **Sole coach and sole member** → *cascade, on explicit confirmation*.
      The account is the team's entire population; leaving it behind creates
      an unreachable orphan whose contents are the departing user's own
      roster and games. Erasing it is the privacy-correct outcome, but it is
      never a side effect: the caller has to pass ``confirm_erase_teams``
      after the user has seen these counts.
    * **Not the sole coach (or only a viewer)** → nothing special. The
      membership goes, the team carries on.

    Returns a superset of the spec's preview shape: ``willErase`` + ``warnings``
    plus the structured fields the confirm dialog needs.
    """
    memberships = get_user_memberships(user_id)

    blocking_teams: List[Dict[str, Any]] = []
    cascade_team_ids: List[str] = []

    for membership in memberships:
        team_id = membership["teamId"]
        if membership.get("role") != "coach":
            continue
        team_members = get_team_memberships(team_id)
        other_coaches = [
            m for m in team_members
            if m.get("role") == "coach" and m["userId"] != user_id
        ]
        if other_coaches:
            continue
        others = [m for m in team_members if m["userId"] != user_id]
        if others:
            blocking_teams.append({
                "teamId": team_id,
                "name": _team_name(team_id),
                "otherMemberCount": len(others),
            })
        elif team_exists(team_id):
            cascade_team_ids.append(team_id)
        # A membership pointing at a team file that no longer exists is stale:
        # it is deleted with the rest in step 4, and cascading it would be a
        # no-op anyway.

    counts = _empty_counts()
    teams_to_erase: List[Dict[str, Any]] = []
    eraser = get_team_eraser()
    for team_id in cascade_team_ids:
        team_counts = eraser(team_id, dry_run=True)
        for key, value in team_counts.items():
            counts[key] = counts.get(key, 0) + value
        teams_to_erase.append({
            "teamId": team_id,
            "name": _team_name(team_id),
            "games": team_counts.get("games", 0),
        })

    # Memberships on surviving teams, plus the invites this user minted there.
    # The cascade already counted the memberships and invites of the teams it
    # erases, so only the remainder is added here.
    cascaded = set(cascade_team_ids)
    surviving_team_ids = [
        m["teamId"] for m in memberships if m["teamId"] not in cascaded
    ]
    counts["memberships"] += len(surviving_team_ids)
    counts["invites"] += len(_surviving_invites(user_id, surviving_team_ids))

    warnings: List[str] = []
    orphaned = _orphaned_player_count(cascade_team_ids)
    if orphaned:
        warnings.append(
            f"{orphaned} player record{'s' if orphaned != 1 else ''} will be "
            "left on no team. Player records are erased separately."
        )
    surviving_shares = _surviving_share_count(surviving_team_ids, user_id)
    if surviving_shares:
        warnings.append(
            f"{surviving_shares} public share link{'s' if surviving_shares != 1 else ''} "
            "you created stay live on teams that continue without you. Their "
            "coaches can revoke them."
        )
    if counts["games"]:
        warnings.append(
            f"{counts['games']} game{'s' if counts['games'] != 1 else ''} and "
            f"{counts['versions']} stored version{'s' if counts['versions'] != 1 else ''} "
            "will be permanently deleted."
        )
    # Deliberately unnumbered: the dry run cannot tell which of these records
    # the team cascade is about to delete anyway, so a count here would be an
    # over-estimate. The real number comes back on the delete.
    if _scrub_user_references(user_id, "", dry_run=True):
        warnings.append(
            "Records on teams that continue without you (share and invite "
            "history) will have your account ID replaced with an anonymous "
            "placeholder."
        )

    return {
        "willErase": counts,
        "warnings": warnings,
        "blockers": [
            f"You are the only coach of \"{t['name']}\", which has "
            f"{t['otherMemberCount']} other member"
            f"{'s' if t['otherMemberCount'] != 1 else ''}."
            for t in blocking_teams
        ],
        "blockingTeams": blocking_teams,
        "teamsToErase": teams_to_erase,
        "canDelete": not blocking_teams,
        "requiresTeamCascadeConfirmation": bool(teams_to_erase),
        "user": _public_user(user_id),
    }


def _public_user(user_id: str) -> Optional[Dict[str, Any]]:
    user = get_user(user_id)
    if not user:
        return None
    return {
        "id": user.get("id"),
        "email": user.get("email"),
        "displayName": user.get("displayName"),
    }


def _surviving_invites(user_id: str, team_ids: List[str]) -> List[Dict[str, Any]]:
    """Invites this user minted on teams that outlive them.

    They are deleted along with the account: an invite is a live credential
    granting membership on the authority of a coach who no longer exists. The
    remaining coaches can issue a new one in two taps.
    """
    invites = []
    for team_id in team_ids:
        for invite in list_team_invites(team_id):
            if invite.get("createdBy") == user_id:
                invites.append(invite)
    return invites


def _surviving_share_count(team_ids: List[str], user_id: str) -> int:
    """Public share links this user created on games that outlive them.

    Counted for the warning only. Revoking them would break live viewing for
    parents and players of a team that is carrying on without this user, and
    the share exposes the *team's* game rather than this user's identity.
    """
    count = 0
    for team_id in team_ids:
        for game_id in _team_game_ids(team_id):
            for share in list_game_shares(game_id):
                if share.get("createdBy") == user_id and not share.get("revokedAt"):
                    count += 1
    return count


# =============================================================================
# Execution
# =============================================================================

async def execute_account_deletion(
    user_id: str,
    confirm_erase_teams: bool = False,
) -> Dict[str, Any]:
    """Irreversibly delete ``user_id``. See the module docstring for ordering.

    Raises:
        TeamHandoverRequired: sole coach of a team others still use.
        TeamCascadeNotConfirmed: teams would be erased and the caller has not
            confirmed that.
        AuthIdentityDeletionFailed: the Supabase identity survived, so nothing
            local was touched.
    """
    plan = plan_account_deletion(user_id)

    if plan["blockingTeams"]:
        raise TeamHandoverRequired(plan["blockingTeams"])
    if plan["teamsToErase"] and not confirm_erase_teams:
        raise TeamCascadeNotConfirmed(plan["teamsToErase"])

    # Step 1 — the auth identity. Anything raised here leaves disk untouched.
    await delete_supabase_auth_user(user_id)

    erased = _empty_counts()
    eraser = get_team_eraser()

    # Step 2 — teams whose only member was this account.
    cascaded_team_ids = [t["teamId"] for t in plan["teamsToErase"]]
    for team_id in cascaded_team_ids:
        for key, value in eraser(team_id, dry_run=False).items():
            erased[key] = erased.get(key, 0) + value

    # Step 3 — invites minted by this user on teams that survive.
    surviving_team_ids = [
        m["teamId"] for m in get_user_memberships(user_id)
    ]
    for invite in _surviving_invites(user_id, surviving_team_ids):
        if delete_invite(invite["id"]):
            erased["invites"] += 1

    # Step 4 — remaining memberships. Re-read rather than reusing the plan's
    # list: the cascade above already removed its own.
    for membership in get_user_memberships(user_id):
        if delete_membership(membership["id"]):
            erased["memberships"] += 1

    # Step 5 — redact the user id from records that legitimately survive.
    # After the deletions above, so nothing is rewritten on its way to the bin.
    references_scrubbed = _scrub_user_references(
        user_id, _mint_user_tombstone(), dry_run=False
    )

    # Step 6 — the user record itself. Last, so a crash before here leaves a
    # user whose memberships are gone rather than memberships pointing at a
    # user who isn't there. Reported outside ``erased``, which keeps exactly
    # the spec's counter keys.
    user_record_deleted = delete_user(user_id)

    if cascaded_team_ids:
        # Cheap enough for a once-per-account operation, and it cannot leave a
        # stale bucket pointing at an erased team the way targeted edits can.
        rebuild_index()

    logger.info(
        "Account %s deleted: %s (cascaded teams: %s)",
        user_id, erased, cascaded_team_ids or "none",
    )

    return {
        "erased": erased,
        "warnings": plan["warnings"],
        "userRecordDeleted": user_record_deleted,
        "referencesScrubbed": references_scrubbed,
    }
