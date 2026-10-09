/*
 * Who a game lists, and what changed in who it offers — pure helpers, no DOM
 * and no app state, shared by Review (teams/gameSummary.js) and the in-game
 * event refresh (game/gameScreenSync.js). Unit-tested in
 * tests/unit/gameRoster.test.mjs.
 */

/**
 * The players a game's Review table and export list. The roster snapshot
 * comes first, for historical accuracy (a renamed or since-removed player
 * shows as they were), or the live team roster when the game captured no
 * snapshot — and in either case everyone who has stats in this game but is
 * on neither list is appended: a late arrival checked onto the event roster
 * after the game started (before 2.13.0 a game's snapshot never grew), a
 * player added to the team mid-game, a name entered through Correct Lineup.
 * Listing only the snapshot hid such a player's whole game. Extras come
 * after the listed players, by name; a team player is listed as their live
 * roster record (gender and number), anyone else as {id, name}.
 * @param {object} game
 * @param {object} playerStats - map of stats key → stats (getGamePlayerStats);
 *   a key is a player id, or `unresolved:<name>` / `ambiguous:<name>` for a
 *   name the resolver could not pin to one id
 * @param {Array<object>} [teamRoster] - the live team roster
 * @returns {Array<object>}
 */
function summaryRosterPlayers(game, playerStats, teamRoster = []) {
    const roster = Array.isArray(teamRoster) ? teamRoster : [];
    const snapshot = game && game.rosterSnapshot && Array.isArray(game.rosterSnapshot.players)
        ? game.rosterSnapshot.players.filter(Boolean) : [];
    const listed = snapshot.length > 0 ? snapshot : roster;
    const haveIds = new Set(listed.map(p => p.id).filter(Boolean));
    const byId = new Map(roster.filter(p => p && p.id).map(p => [p.id, p]));
    const extras = Object.entries(playerStats || {})
        .filter(([key]) => key && !haveIds.has(key))
        .map(([key, stats]) => byId.get(key) || {
            id: key,
            name: (stats && stats.name) || String(key).replace(/^(unresolved|ambiguous):/, ''),
        })
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    return [...listed, ...extras];
}

/** One string per roster that is equal exactly when the Line tab would look the same. */
function rosterKey(roster) {
    if (!roster) return 'none';
    const ids = [...(roster.playerIds || [])].map(String).sort();
    const pickups = (roster.pickupPlayers || []).filter(Boolean)
        .map(p => [p.id, p.name, p.gender || '', p.number || '', p.position || '', p.defaultLine || ''])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    // An override entry that sets nothing changes nothing.
    const overrides = Object.keys(roster.overrides || {}).sort()
        .map(id => [id, (roster.overrides[id] || {}).position || '', (roster.overrides[id] || {}).defaultLine || ''])
        .filter(([, position, line]) => position || line);
    return JSON.stringify({ ids, pickups, overrides });
}

/**
 * Whether two event rosters differ in anything the Line tab shows: the
 * checked team players, the pickups (and their details), or the per-event
 * position/line overrides. Order does not count.
 * @param {object|null} before - an event's `roster`
 * @param {object|null} after
 * @returns {boolean}
 */
function eventRosterDiffers(before, after) {
    return rosterKey(before) !== rosterKey(after);
}

/** "Bob", "Bob and Eve", "Bob, Eve and Mia". */
function listNames(names) {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What a coach in a game should be told when the event roster changed under
 * them (another coach edited it) — the body of the toast. Names who was
 * added and who was removed; a change the Line tab shows but that adds or
 * removes nobody (an override, a pickup's number) gets the generic line.
 * null when nothing the Line tab shows changed, so a device's own edit
 * coming back from the server says nothing.
 * @param {object|null} before - an event's `roster` before
 * @param {object|null} after - and after
 * @param {Array<object>} [teamRoster] - the live team roster, for the names
 * @returns {string|null}
 */
function describeEventRosterChange(before, after, teamRoster = []) {
    const roster = Array.isArray(teamRoster) ? teamRoster : [];
    const nameOf = id => {
        const player = roster.find(p => p && p.id === id);
        return player ? player.name : id;
    };
    const names = r => {
        const map = new Map();
        ((r && r.playerIds) || []).forEach(id => map.set(id, nameOf(id)));
        ((r && r.pickupPlayers) || []).forEach(p => { if (p && p.id) map.set(p.id, p.name || p.id); });
        return map;
    };
    const was = names(before);
    const now = names(after);
    const added = [...now].filter(([id]) => !was.has(id)).map(([, name]) => name);
    const removed = [...was].filter(([id]) => !now.has(id)).map(([, name]) => name);
    const parts = [];
    if (added.length) parts.push(`${listNames(added)} added`);
    if (removed.length) parts.push(`${listNames(removed)} removed`);
    if (parts.length) return `Event roster updated: ${parts.join('; ')}`;
    return eventRosterDiffers(before, after) ? 'Event roster updated' : null;
}

export { summaryRosterPlayers, eventRosterDiffers, describeEventRosterChange };
