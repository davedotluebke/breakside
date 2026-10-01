/*
 * Unit tests for the Fun stats level: utils/funStats.js (the shout-outs
 * builder), its place in utils/statsLevel.js, the viewer lock in
 * utils/statsAudience.js, and the Fun export sheet in utils/exportWorkbook.js.
 *
 * The contract under test:
 *  - Goals & Assists lists only players with one, most first; no zero rows
 *  - each shout-out keeps the top 5, plus everyone tied with the 5th
 *  - a category nobody scored in is left out; Comp% needs 10 throws
 *  - nothing negative and no playing time reaches the Fun output
 *  - Fun shows no tagged table column, only identity columns
 *  - viewers of a team set to Fun, and share guests told so, are locked to
 *    Fun; coaches never are
 *  - the Fun export is lists, not a table, and drops the Connections sheet
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { buildFunStats, funStatsEmpty, MIN_COMP_THROWS } = await import('../../utils/funStats.js');
const { StatsLevel, levelIncludes, columnsForLevel, setStatsLevel } = await import('../../utils/statsLevel.js');
const { STATS_COLUMNS, SHEET_STATS_COLUMNS } = await import('../../utils/statsColumns.js');
const { activeStatsLevel, lockedStatsLevel, setGuestStatsLevel } = await import('../../utils/statsAudience.js');
const { buildGameWorkbook } = await import('../../utils/exportWorkbook.js');
const { setCurrentTeam, setCurrentTeamRole } = await import('../../store/storage.js');
setCurrentTeam(null);

const P = (name) => ({ name, id: `${name}-0000` });
const ROSTER = ['Ava', 'Ben', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal'].map(P);
const ids = Object.fromEntries(ROSTER.map(p => [p.name, p.id]));
const names = list => list.map(e => e.name);

test('Goals & Assists lists only players with one, most goals then assists first', () => {
    const fun = buildFunStats(ROSTER, {
        [ids.Ava]: { goals: 1, assists: 3 },
        [ids.Ben]: { goals: 2 },
        [ids.Cal]: { assists: 1 },
        [ids.Dee]: { goals: 0, assists: 0, turnovers: 4, pointsPlayed: 9 },
    });
    assert.deepEqual(names(fun.scorers), ['Ben', 'Ava', 'Cal']);
    assert.equal(fun.scorers[0].goals, 2);
});

test('a shout-out keeps the top 5 and everyone tied with the 5th', () => {
    const stats = {};
    [6, 5, 4, 3, 2, 2, 2, 1].forEach((d, i) => { stats[ROSTER[i].id] = { dPlays: d }; });
    const ds = buildFunStats(ROSTER, stats).shoutouts.find(s => s.key === 'ds');
    assert.deepEqual(names(ds.entries), ['Ava', 'Ben', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus']);
    assert.ok(!names(ds.entries).includes('Hal'));
});

test('empty categories are left out; zero values never listed', () => {
    const fun = buildFunStats(ROSTER, { [ids.Ava]: { hockeyAssists: 1 } });
    assert.deepEqual(fun.shoutouts.map(s => s.key), ['ha']);
    assert.deepEqual(names(fun.shoutouts[0].entries), ['Ava']);
    assert.ok(funStatsEmpty(buildFunStats(ROSTER, {})));
});

test('Comp% needs the minimum throws; ties break on completions', () => {
    const fun = buildFunStats(ROSTER, {
        [ids.Ava]: { completions: 1, totalThrows: 1 },                       // 100% but too few
        [ids.Ben]: { completions: MIN_COMP_THROWS, totalThrows: MIN_COMP_THROWS },
        [ids.Cal]: { completions: 2 * MIN_COMP_THROWS, totalThrows: 2 * MIN_COMP_THROWS },
        [ids.Dee]: { completions: 9, totalThrows: 12 },
    });
    const pct = fun.shoutouts.find(s => s.key === 'compPct');
    assert.deepEqual(names(pct.entries), ['Cal', 'Ben', 'Dee']);
    assert.deepEqual(pct.entries.map(e => e.text), ['100%', '100%', '75%']);
});

test('onlyPlayerId keeps that player\'s lines, ranked against the whole roster', () => {
    const stats = {};
    [6, 5, 4, 3, 2, 1, 0, 0].forEach((d, i) => { stats[ROSTER[i].id] = { dPlays: d, goals: i === 5 ? 1 : 0 }; });
    const fay = buildFunStats(ROSTER, stats, { onlyPlayerId: ids.Fay });
    assert.deepEqual(names(fay.scorers), ['Fay']);
    assert.equal(fay.shoutouts.length, 0, 'sixth in Ds is not a top-5 shout-out');
    const ava = buildFunStats(ROSTER, stats, { onlyPlayerId: ids.Ava });
    assert.deepEqual(ava.shoutouts.map(s => names(s.entries)), [['Ava']]);
});

test('Fun shows no tagged column, only identity columns', () => {
    assert.equal(levelIncludes(StatsLevel.BASIC, StatsLevel.FUN), false);
    assert.equal(levelIncludes(undefined, StatsLevel.FUN), true);
    assert.deepEqual(columnsForLevel(STATS_COLUMNS, StatsLevel.FUN), []);
    assert.deepEqual(columnsForLevel(SHEET_STATS_COLUMNS, StatsLevel.FUN).map(c => c.label), ['Name']);
});

test('viewers of a Fun team are locked to Fun; coaches and other teams are not', () => {
    setStatsLevel(StatsLevel.FULL);
    setCurrentTeam({ id: 't', name: 'Riverside', viewerStatsLevel: 'fun' });
    try {
        setCurrentTeamRole('coach');
        assert.equal(lockedStatsLevel(), null);
        assert.equal(activeStatsLevel(), StatsLevel.FULL);

        setCurrentTeamRole('viewer');
        assert.equal(lockedStatsLevel(), StatsLevel.FUN);
        assert.equal(activeStatsLevel(), StatsLevel.FUN);

        setCurrentTeam({ id: 'u', name: 'Storm', viewerStatsLevel: null });
        assert.equal(activeStatsLevel(), StatsLevel.FULL, 'the device choice survives');

        setCurrentTeam({ id: 'v', name: 'Odd', viewerStatsLevel: 'full' });
        assert.equal(lockedStatsLevel(), null, 'only restrictable levels lock');
    } finally {
        setCurrentTeamRole(null);
        setCurrentTeam(null);
    }
});

test('a share guest told Fun is locked to Fun', () => {
    setStatsLevel(StatsLevel.ADVANCED);
    setGuestStatsLevel('fun');
    try {
        assert.equal(activeStatsLevel(), StatsLevel.FUN);
    } finally {
        setGuestStatsLevel(null);
    }
    assert.equal(activeStatsLevel(), StatsLevel.ADVANCED);
});

// ── export ──────────────────────────────────────────────────────────────

const ALICE = { name: 'Alice', id: 'Alice-1111' };
const BOB = { name: 'Bob', id: 'Bob-2222' };
const GAME = {
    id: 'g1', opponent: 'Storm', team: 'Riverside',
    scores: { team: 2, opponent: 0 },
    rosterSnapshot: { players: [ALICE, BOB] },
    points: ['A', 'B'].map(who => ({
        winner: 'team', players: [ALICE.id, BOB.id], totalPointTime: 60000, startingPosition: 'offense',
        possessions: [{ offensive: true, events: [
            { type: 'Throw', thrower: BOB, receiver: ALICE, drop_flag: true },
            { type: 'Throw', thrower: who === 'A' ? ALICE : BOB, receiver: who === 'A' ? BOB : ALICE, score_flag: true },
        ] }],
    })),
};

test('the Fun export is lists, carries nothing negative, and drops Connections', () => {
    const wb = buildGameWorkbook(GAME, { players: [ALICE, BOB], level: StatsLevel.FUN });
    assert.deepEqual(wb.sheets.map(s => s.name), ['Storm', 'Game Flow']);
    const sheet = wb.sheets[0];
    assert.equal(sheet.filter, null);
    const text = sheet.rows.flat().join(' | ');
    assert.match(text, /Goals & Assists/);
    for (const banned of ['Drops', 'TOs', 'Throwaways', 'Minutes', 'Pts', '+/-']) {
        assert.ok(!sheet.rows.some(r => r.includes(banned)), banned);
    }
    const header = sheet.rows.findIndex(r => r[0] === 'Name');
    assert.deepEqual(sheet.rows[header], ['Name', 'Goals', 'Assists']);
});

test('a single-player Fun export keeps that player\'s lines only', () => {
    const wb = buildGameWorkbook(GAME, { players: [ALICE, BOB], playerId: BOB.id, level: StatsLevel.FUN });
    const names = wb.sheets[0].rows.map(r => r[0]);
    assert.ok(names.includes('Bob'));
    assert.ok(!names.includes('Alice'));
});
