/*
 * Team membership roles, as the server defines them
 * (breakside_server/storage/membership_storage.py). A pure leaf: no imports,
 * so store/storage.js and every feature module can read it.
 *
 *   coach       administers the team: roster, settings, invites, members
 *               (and their email addresses), mailing lists, share links,
 *               deleting games — plus everything a stat keeper can do.
 *   statkeeper  records games: starts, tracks and ends them, holds the
 *               Active/Line Coach controller roles. Reads what a viewer
 *               reads. Nothing administrative, no email addresses.
 *   viewer      read-only: watches games live, reads statistics.
 *
 * A null/undefined role is a local-only team (no membership at all), which
 * the app treats as the device owner's own: a coach.
 */

const ROLE_LABELS = Object.freeze({
    coach: 'Coach',
    statkeeper: 'Stat Keeper',
    viewer: 'Viewer',
});

/** Human label for a role; unknown roles come back as given. */
function roleLabel(role) {
    return ROLE_LABELS[role] || role || 'member';
}

/** May this role start, track and end games? */
function canRecordGames(role) {
    return role == null || role === 'coach' || role === 'statkeeper';
}

/** May this role administer the team (roster, settings, invites, members,
 *  mail, shares, deleting games)? */
function canManageTeam(role) {
    return role == null || role === 'coach';
}

export { ROLE_LABELS, roleLabel, canRecordGames, canManageTeam };
