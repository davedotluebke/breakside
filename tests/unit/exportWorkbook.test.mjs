/*
 * Unit tests for utils/exportWorkbook.js (the format-neutral export model the
 * Export dialog builds) and the pure request builders in utils/sheetsExport.js.
 *
 * The contract under test:
 *  - the stats level is an argument: the sheet's columns follow it, not the
 *    persisted Stats menu, so an export can differ from what the table shows
 *  - a single-player export writes one player row, but the Team row still
 *    sums the whole roster, and it drops the Game Flow / Connections sheets
 *  - breakdown off = one sheet; on = the per-phase / per-game / per-event
 *    sheets, with empty phases skipped and repeated tab names de-duplicated
 *  - the filter range covers the header + player rows only
 *  - the Google Sheets body carries numbers as numbers, strings as literal
 *    text (never formulas), and one setBasicFilter per filtered sheet
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// utils/helpers.js publishes window hooks via store/storage.js at import time.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const {
    buildGameWorkbook, buildEventWorkbook, buildTeamWorkbook, uniqueSheetName,
} = await import('../../utils/exportWorkbook.js');
const { buildSpreadsheetBody, buildFilterRequests } = await import('../../utils/sheetsExport.js');
const { setCurrentTeam } = await import('../../store/storage.js');
// No team: resolve names from each game's roster snapshot, as a share guest does.
setCurrentTeam(null);

const ALICE = { name: 'Alice', id: 'Alice-1111' };
const BOB = { name: 'Bob', id: 'Bob-2222' };
const PLAYERS = [ALICE, BOB];

function point(winner, events) {
    return {
        winner,
        players: [ALICE.id, BOB.id],
        totalPointTime: 60000,
        startingPosition: 'offense',
        possessions: [{ offensive: true, events }],
    };
}

function makeGame(id, opponent, phase) {
    return {
        id, opponent, phase, team: 'Riverside',
        scores: { team: 2, opponent: 0 },
        rosterSnapshot: { players: PLAYERS },
        points: [
            point('team', [{ type: 'Throw', thrower: ALICE, receiver: BOB, score_flag: true }]),
            point('team', [{ type: 'Throw', thrower: BOB, receiver: ALICE, score_flag: true }]),
        ],
    };
}

const G1 = makeGame('g1', 'Storm', 'Pool');
const G2 = makeGame('g2', 'Storm', 'Bracket');
const G3 = makeGame('g3', 'Tide', 'Pool');
const EVENT = { name: 'Spring Classic', phases: ['Pool', 'Bracket', 'Consolation'] };

const headerOf = sheet => sheet.rows[sheet.filter.r0];
const rowLabels = sheet => sheet.rows.slice(sheet.filter.r0 + 1, sheet.filter.r1 + 1).map(r => r[0]);
const teamRow = sheet => sheet.rows[sheet.filter.r1 + 1];

test('columns follow the level argument', () => {
    const basic = buildGameWorkbook(G1, { players: PLAYERS, level: 'basic' }).sheets[0];
    const full = buildGameWorkbook(G1, { players: PLAYERS, level: 'full' }).sheets[0];
    assert.ok(headerOf(full).length > headerOf(basic).length);
    assert.equal(basic.widths.length, headerOf(basic).length);
});

test('a whole-team game export carries Game Flow and Connections', () => {
    const wb = buildGameWorkbook(G1, { players: PLAYERS, level: 'advanced' });
    assert.deepEqual(wb.sheets.map(s => s.name), ['Storm', 'Game Flow', 'Connections']);
    assert.equal(wb.stem, 'Storm-stats');
    assert.deepEqual(rowLabels(wb.sheets[0]), ['Alice', 'Bob']);
    assert.equal(teamRow(wb.sheets[0])[0], 'Team');
});

test('a single-player export narrows the rows but not the Team total', () => {
    const all = buildGameWorkbook(G1, { players: PLAYERS, level: 'basic' }).sheets[0];
    const wb = buildGameWorkbook(G1, { players: PLAYERS, playerId: BOB.id, level: 'basic' });
    assert.deepEqual(wb.sheets.map(s => s.name), ['Storm'], 'no sheets naming other players');
    assert.deepEqual(rowLabels(wb.sheets[0]), ['Bob']);
    assert.deepEqual(teamRow(wb.sheets[0]), teamRow(all));
    assert.match(wb.sheets[0].rows[0][0], /^Bob — /);
    assert.equal(wb.stem, 'Bob-Storm-stats');
});

test('event export without breakdown is one sheet', () => {
    const wb = buildEventWorkbook(EVENT, [G1, G2, G3], {}, { players: PLAYERS, level: 'basic', breakdown: false });
    assert.deepEqual(wb.sheets.map(s => s.name), ['All games']);
});

test('event breakdown: phases (empty ones skipped), then games with unique names', () => {
    const wb = buildEventWorkbook(EVENT, [G1, G2, G3], {}, { players: PLAYERS, level: 'basic', breakdown: true });
    assert.deepEqual(wb.sheets.map(s => s.name),
        ['All games', 'Pool', 'Bracket', 'v. Storm', 'v. Storm (2)', 'v. Tide']);
});

test('one phase with breakdown: that phase, then its games', () => {
    const wb = buildEventWorkbook(EVENT, [G1, G2, G3], { phase: 'Pool' }, { players: PLAYERS, level: 'basic', breakdown: true });
    assert.deepEqual(wb.sheets.map(s => s.name), ['Pool', 'v. Storm', 'v. Tide']);
    assert.equal(wb.stem, 'Spring-Classic-Pool-stats');
});

test('team breakdown: a sheet per event plus standalone games', () => {
    const lone = { ...makeGame('g4', 'Wind'), eventId: undefined };
    const wb = buildTeamWorkbook({ name: 'Riverside' }, [G1, G2, lone],
        [{ name: 'Spring Classic', gameIds: ['g1', 'g2'] }],
        { players: PLAYERS, level: 'basic', breakdown: true });
    assert.deepEqual(wb.sheets.map(s => s.name), ['All games', 'Spring Classic', 'Standalone']);
    assert.match(wb.sheets[0].rows[0][0], /\(3 games\)$/);
});

test('the filter covers header + player rows, not the title or Team row', () => {
    const s = buildGameWorkbook(G1, { players: PLAYERS, level: 'basic' }).sheets[0];
    assert.equal(s.filter.r0, 1, 'row 0 is the title');
    assert.equal(s.filter.r1, 3, 'two player rows');
    assert.equal(s.frozenRows, 2);
});

test('uniqueSheetName respects the 31-character limit', () => {
    const used = new Set();
    const long = 'x'.repeat(40);
    assert.equal(uniqueSheetName(long, used).length, 31);
    const second = uniqueSheetName(long, used);
    assert.equal(second.length, 31);
    assert.ok(second.endsWith(' (2)'));
});

test('Google Sheets body: typed cells, literal text, sheet ids, filters', () => {
    const wb = buildGameWorkbook(G1, { players: [{ id: 'x-1', name: '=HYPERLINK("evil")' }, ...PLAYERS], level: 'advanced' });
    const body = buildSpreadsheetBody(wb, 'Storm stats');
    assert.equal(body.properties.title, 'Storm stats');
    assert.deepEqual(body.sheets.map(s => s.properties.sheetId), [0, 1, 2]);
    const rows = body.sheets[0].data[0].rowData;
    const evil = rows[2].values[0];
    assert.deepEqual(evil.userEnteredValue, { stringValue: '=HYPERLINK("evil")' });
    assert.ok(rows[1].values[0].userEnteredFormat.textFormat.bold, 'header row is bold');
    const numeric = rows[3].values.find(v => v.userEnteredValue && 'numberValue' in v.userEnteredValue);
    assert.ok(numeric, 'numbers stay numbers');

    const filters = buildFilterRequests(wb);
    assert.equal(filters.length, wb.sheets.length);
    assert.deepEqual(filters[0].setBasicFilter.filter.range, {
        sheetId: 0, startRowIndex: 1, endRowIndex: 5, startColumnIndex: 0,
        endColumnIndex: headerOf(wb.sheets[0]).length,
    });
});
