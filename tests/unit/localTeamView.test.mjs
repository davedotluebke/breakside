/*
 * The offline team list is a field-name translation, and every way it can be
 * wrong is quiet: the list still renders, just with a blank opponent, a 1970
 * date, or a phantom "active now" dot. So each mapped field is pinned by name.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLocalTeamData } from '../../store/localTeamView.js';

/** A team as store/storage.js deserializes it. */
function localTeam(overrides = {}) {
    return {
        id: 'Breakside-7f3a',
        name: 'Breakside',
        iconUrl: null,
        games: [],
        ...overrides,
    };
}

/** A game as store/models.js constructs it (client field names). */
function localGame(overrides = {}) {
    return {
        id: '2026-08-17_Breakside_vs_Rivals_1234',
        opponent: 'Rivals',
        scores: { team: 13, opponent: 11 },
        eventId: null,
        phase: null,
        gameStartTimestamp: '2026-08-17T18:00:00Z',
        gameEndTimestamp: null,
        points: [],
        ...overrides,
    };
}

test('a game is translated into every field the renderer reads', () => {
    const { allGames } = buildLocalTeamData([
        localTeam({ games: [localGame()] }),
    ]);

    assert.equal(allGames.length, 1);
    const g = allGames[0];

    // teams/teamList.js renderGameItem + isGameActive + getMostRecentGameTimestamp
    assert.equal(g.game_id, '2026-08-17_Breakside_vs_Rivals_1234');
    assert.equal(g.game_start_timestamp, '2026-08-17T18:00:00Z');
    assert.equal(g.game_end_timestamp, null);
    assert.equal(g.teamId, 'Breakside-7f3a');
    assert.equal(g.opponent, 'Rivals');
    assert.deepEqual(g.scores, { team: 13, opponent: 11 });
    assert.equal(g.eventId, null);
    assert.equal(g.phase, null);
    assert.deepEqual(g.activeCoaches, []);
});

test('a finished game keeps its end timestamp', () => {
    // renderGameItem branches on this for Review-vs-Resume, so dropping it
    // would offer "Resume" on a game that is over.
    const { allGames } = buildLocalTeamData([
        localTeam({ games: [localGame({ gameEndTimestamp: '2026-08-17T19:30:00Z' })] }),
    ]);
    assert.equal(allGames[0].game_end_timestamp, '2026-08-17T19:30:00Z');
});

test('the date the list sorts and displays by is not lost', () => {
    // getMostRecentGameTimestamp does `new Date(g.game_start_timestamp || 0)`.
    // A missed rename here silently sorts every game to 1970.
    const { allGames } = buildLocalTeamData([
        localTeam({ games: [localGame()] }),
    ]);
    const ms = new Date(allGames[0].game_start_timestamp || 0).getTime();
    assert.ok(ms > Date.UTC(2020, 0, 1), 'timestamp did not survive translation');
});

test('no game is ever reported as having live coaches offline', () => {
    // There is no live anything without a network; a stale "active" dot would
    // invite a coach to join a game nobody is in.
    const { allGames } = buildLocalTeamData([
        localTeam({ games: [localGame(), localGame({ id: 'g2' })] }),
    ]);
    assert.ok(allGames.every(g => Array.isArray(g.activeCoaches) && g.activeCoaches.length === 0));
});

test('teams are wrapped as {team, role} with a coach role', () => {
    const team = localTeam();
    const { userTeams } = buildLocalTeamData([team]);
    assert.equal(userTeams.length, 1);
    assert.equal(userTeams[0].team, team, 'the team object is passed through by reference');
    assert.equal(userTeams[0].role, 'coach');
});

test('games from several teams are keyed back to the right team', () => {
    const { allGames } = buildLocalTeamData([
        localTeam({ id: 'A-0001', games: [localGame({ id: 'a1' })] }),
        localTeam({ id: 'B-0002', games: [localGame({ id: 'b1' }), localGame({ id: 'b2' })] }),
    ]);
    assert.deepEqual(
        allGames.map(g => [g.game_id, g.teamId]),
        [['a1', 'A-0001'], ['b1', 'B-0002'], ['b2', 'B-0002']],
    );
});

test('events are empty — they exist only server-side', () => {
    const { eventsByTeamId } = buildLocalTeamData([localTeam({ games: [localGame()] })]);
    assert.deepEqual(eventsByTeamId, {});
});

test('junk in localStorage cannot break the list', () => {
    // This data has been through JSON round-trips and schema migrations; the
    // list must degrade rather than throw, or offline shows an error again.
    for (const input of [undefined, null, [], 'nonsense', {}, [null], [{}], [{ id: '' }]]) {
        const out = buildLocalTeamData(input);
        assert.ok(Array.isArray(out.userTeams), `userTeams for ${JSON.stringify(input)}`);
        assert.ok(Array.isArray(out.allGames));
    }
    assert.deepEqual(buildLocalTeamData([{ id: 'ok' }]).allGames, [],
        'a team with no games array is fine');
    assert.deepEqual(buildLocalTeamData([{ id: 'ok', games: [null, {}, { id: '' }] }]).allGames, [],
        'games without an id are skipped, not rendered blank');
});
