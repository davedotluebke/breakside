/*
 * Local cleanup after a server-side erasure.
 *
 * Erasure happens on the server. This module is the client's half: once the
 * POST has succeeded, the erased person or team is still sitting in this
 * device's localStorage — in `teamsData`, in the offline entity caches, and,
 * worst of all, possibly in the sync queue as a pending write.
 *
 * That last one is the trap the erasure design calls out. A queued
 * `{type:'player'}` item is a create/update the client still intends to send.
 * Left in place it fires on the next sync and tries to re-POST somebody the
 * coach just erased. The server refuses it (410, via the erasure deny-list),
 * so nothing is resurrected — but the client is then retrying a doomed write
 * forever, and the payload it keeps retrying *contains the erased name*, which
 * is the thing the coach asked to be rid of.
 *
 * So the queue is cleaned, not just the display copy.
 *
 * Deliberately NOT cleaned: queued `{type:'game'}` payloads. A player is
 * referenced deep inside a game's points, possessions and events, and a queued
 * game is by definition work that has not reached the server — a coach's
 * unsynced tournament. Reimplementing the server's deep scrubber here, against
 * data we would then destroy locally with no backup, trades a privacy tidy-up
 * for a plausible data-loss bug. The server scrubs erased players out of every
 * inbound game write (`scrub_erased_from_game`), so the queued game syncs
 * normally and lands clean. Callers surface a note when this applies.
 *
 * Everything here is a pure transform over plain data: no localStorage, no
 * fetch, no DOM. store/sync.js applies the queue and entity-cache transforms to
 * its own in-memory state (which is authoritative — writing localStorage behind
 * its back would just be overwritten by the next saveSyncQueue()), and
 * teams/erasure.js applies the team-record transform to the live `teams` array.
 *
 * Unit-tested in tests/unit/erasureCleanup.test.mjs.
 */

/**
 * Does this queue item name the erased player as its own subject?
 * @param {object} item - Sync queue item: { type, action, id, data }
 * @param {string} playerId
 */
function isPlayerItem(item, playerId) {
    return item && item.type === 'player' && item.id === playerId;
}

/**
 * Every string one player is displayed as, as a lookup set.
 *
 * The nickname is a display name, not decoration: the app renders
 * `nickname || name`, so a stored display string holds the NICKNAME whenever
 * the player has one. The server matches both (see PlayerScrubber's
 * `_display_names`); a client that only knew the real name would leave the
 * nickname behind in local line lists.
 *
 * @param {string|string[]} [names]
 * @returns {Set<string>}
 */
function displayNameSet(names) {
    const list = Array.isArray(names) ? names : [names];
    return new Set(list.filter(n => typeof n === 'string' && n));
}

/**
 * Remove one player from a team record, in place.
 *
 * Handles both live `Team` objects and the serialized payloads that sit in the
 * sync queue and in `teamsData` — they share these field names.
 *
 * `lines[].players` holds display strings that may be either IDs or names
 * (see teams/rosterManagement.js), so both are matched, mirroring the server's
 * `_drop_from_id_list`. Matching a bare name is how a same-named teammate can
 * be caught by somebody else's erasure — the server counts those as
 * `name_only_matches` and warns about them in the preview, which is where the
 * coach is told before they agree to it.
 *
 * @param {object} team - Team object or serialized team payload. Mutated.
 * @param {string} playerId
 * @param {string|string[]} [playerNames] - Display names (name and nickname)
 *   to match in `lines[].players` alongside the ID.
 * @returns {boolean} whether anything was removed.
 */
export function stripPlayerFromTeamRecord(team, playerId, playerNames) {
    if (!team || typeof team !== 'object' || !playerId) return false;
    const names = displayNameSet(playerNames);
    let changed = false;

    if (Array.isArray(team.playerIds)) {
        const kept = team.playerIds.filter(id => id !== playerId);
        if (kept.length !== team.playerIds.length) {
            team.playerIds = kept;
            changed = true;
        }
    }

    if (Array.isArray(team.teamRoster)) {
        const kept = team.teamRoster.filter(p => !p || p.id !== playerId);
        if (kept.length !== team.teamRoster.length) {
            team.teamRoster = kept;
            changed = true;
        }
    }

    if (Array.isArray(team.lines)) {
        for (const line of team.lines) {
            if (!line || !Array.isArray(line.players)) continue;
            const kept = line.players.filter(
                ref => ref !== playerId && !names.has(ref));
            if (kept.length !== line.players.length) {
                line.players = kept;
                changed = true;
            }
        }
    }

    return changed;
}

/**
 * Remove one player from a tournament-event payload, in place.
 * Events carry a roster as an ID list plus optional per-event overrides.
 *
 * @returns {boolean} whether anything was removed.
 */
export function stripPlayerFromEventRecord(event, playerId) {
    if (!event || typeof event !== 'object' || !playerId) return false;
    let changed = false;

    if (Array.isArray(event.playerIds)) {
        const kept = event.playerIds.filter(id => id !== playerId);
        if (kept.length !== event.playerIds.length) {
            event.playerIds = kept;
            changed = true;
        }
    }

    if (event.playerOverrides && typeof event.playerOverrides === 'object'
        && Object.prototype.hasOwnProperty.call(event.playerOverrides, playerId)) {
        delete event.playerOverrides[playerId];
        changed = true;
    }

    return changed;
}

/**
 * Clean an erased player out of a sync queue.
 *
 * @param {Array} queue - Sync queue items. Not mutated; team/event payloads
 *   inside the returned items ARE mutated in place (they are the same objects).
 * @param {string} playerId
 * @param {string|string[]} [playerNames] - Display names (name and nickname).
 * @returns {{queue: Array, dropped: number, scrubbed: number, queuedGames: number}}
 *   `dropped` — items removed outright (the player's own writes).
 *   `scrubbed` — team/event payloads that still mentioned them.
 *   `queuedGames` — unsynced games left alone; the server scrubs those on
 *   arrival, and the caller may want to say so.
 */
export function purgePlayerFromQueue(queue, playerId, playerNames) {
    const items = Array.isArray(queue) ? queue : [];
    let dropped = 0;
    let scrubbed = 0;
    let queuedGames = 0;

    const kept = items.filter(item => {
        if (isPlayerItem(item, playerId)) {
            dropped += 1;
            return false;
        }
        return true;
    });

    for (const item of kept) {
        if (!item || !item.data) {
            if (item && item.type === 'game') queuedGames += 1;
            continue;
        }
        if (item.type === 'team' && stripPlayerFromTeamRecord(item.data, playerId, playerNames)) {
            scrubbed += 1;
        } else if (item.type === 'event' && stripPlayerFromEventRecord(item.data, playerId)) {
            scrubbed += 1;
        } else if (item.type === 'game') {
            queuedGames += 1;
        }
    }

    return { queue: kept, dropped, scrubbed, queuedGames };
}

/**
 * Clean an erased team and its cascade out of a sync queue.
 *
 * The team's games go too: the server deleted them outright, so a queued game
 * write for one of them has nowhere to land. Unlike the player case there is no
 * judgment call here — the games are already gone server-side, and keeping the
 * payload would only keep a roster snapshot of an erased team on the device.
 *
 * @param {Array} queue
 * @param {string} teamId
 * @param {string[]} [gameIds] - Known game IDs for the team. Items are also
 *   matched on their payload's `teamId`, which catches games this device knows
 *   about but the caller did not list.
 * @returns {{queue: Array, dropped: number}}
 */
export function purgeTeamFromQueue(queue, teamId, gameIds = []) {
    const items = Array.isArray(queue) ? queue : [];
    const gameIdSet = new Set(gameIds || []);
    let dropped = 0;

    const kept = items.filter(item => {
        if (!item) return true;
        const belongs =
            (item.type === 'team' && item.id === teamId)
            || (item.type === 'event' && item.data && item.data.teamId === teamId)
            || (item.type === 'game'
                && (gameIdSet.has(item.id) || (item.data && item.data.teamId === teamId)));
        if (belongs) {
            dropped += 1;
            return false;
        }
        return true;
    });

    return { queue: kept, dropped };
}

/**
 * Drop entries from one of sync.js's offline entity maps (`localPlayers`,
 * `localTeams`, `localGames`), keyed by ID.
 *
 * @param {object} map - Mutated in place.
 * @param {function(string, object): boolean} matches
 * @returns {number} how many were removed.
 */
export function dropFromEntityMap(map, matches) {
    if (!map || typeof map !== 'object') return 0;
    let removed = 0;
    for (const key of Object.keys(map)) {
        if (matches(key, map[key])) {
            delete map[key];
            removed += 1;
        }
    }
    return removed;
}

/**
 * Filter the quarantined dead-letter list.
 *
 * Each entry is a whole payload the client failed to sync — for an erased
 * player or team that is a full roster snapshot, complete with names, sitting
 * in localStorage after the coach was told the record was destroyed. It is
 * never retried, so dropping it costs nothing.
 *
 * @param {Array} entries
 * @param {{playerId?: string, teamId?: string, gameIds?: string[]}} target
 * @returns {{entries: Array, dropped: number}}
 */
export function purgeDeadLetter(entries, target = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const { playerId, teamId } = target;
    const gameIdSet = new Set(target.gameIds || []);
    let dropped = 0;

    const kept = list.filter(entry => {
        if (!entry) return true;
        const hit =
            (playerId && entry.type === 'player' && entry.id === playerId)
            || (teamId && entry.type === 'team' && entry.id === teamId)
            || (teamId && entry.data && entry.data.teamId === teamId)
            || (entry.type === 'game' && gameIdSet.has(entry.id));
        if (hit) {
            dropped += 1;
            return false;
        }
        return true;
    });

    return { entries: kept, dropped };
}
