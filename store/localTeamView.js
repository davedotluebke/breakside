/*
 * Locally-stored teams, reshaped into what the cloud team list renders from.
 *
 * The team list has exactly one renderer (~200 lines of DOM building in
 * teams/teamList.js) and it is written against the API's shape. When the server
 * is unreachable, everything the coach recorded is still in localStorage — so
 * rather than give the offline case its own renderer that would drift within a
 * release, this translates the local shape into the server's and lets the same
 * code draw it. See docs/offline-no-account-audit.md § 2.
 *
 * The translation is the whole risk: get one field name wrong and the list
 * renders happily with a blank opponent or a 1970 date. Pure leaf module (no
 * DOM, no imports, no globals) so every field can be pinned in a unit test.
 */

/**
 * @param {Array} localTeams - the `teams` array from store/storage.js
 * @returns {{userTeams: Array, allGames: Array, eventsByTeamId: Object}}
 */
export function buildLocalTeamData(localTeams) {
    const source = Array.isArray(localTeams) ? localTeams : [];
    const userTeams = [];
    const allGames = [];

    for (const team of source) {
        if (!team || !team.id) continue;

        // 'coach' matches resumeCloudGame's existing `role || 'coach'` default.
        // A viewer would have nothing to show here anyway: local data exists
        // because this device recorded it.
        userTeams.push({ team, role: 'coach' });

        const games = Array.isArray(team.games) ? team.games : [];
        for (const game of games) {
            if (!game || !game.id) continue;
            allGames.push({
                // Client name          ->  the name the renderer reads
                game_id: game.id,
                game_start_timestamp: game.gameStartTimestamp,
                game_end_timestamp: game.gameEndTimestamp || null,
                teamId: team.id,
                eventId: game.eventId || null,
                opponent: game.opponent,
                scores: game.scores,
                phase: game.phase || null,
                // Who is live in a game is in-memory on the server. Empty reads
                // as "not active", which is correct offline — there is no live
                // anything — and keeps isGameActive() honest rather than
                // painting a stale "active now" dot.
                activeCoaches: [],
            });
        }
    }

    // Events (tournaments) exist only server-side, so games render in the flat
    // per-team list rather than grouped. Better than inventing groupings.
    return { userTeams, allGames, eventsByTeamId: {} };
}
