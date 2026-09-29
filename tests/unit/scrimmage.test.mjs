/*
 * Unit tests for store/scrimmage.js — the pure half of intrasquad scrimmages.
 *
 * A scrimmage is two linked squad-games sharing a scrimmageId. What is pinned
 * here is the convention the rest of the app relies on: how players are dealt
 * onto squads (balanced by gender, then position, totals within one), how the
 * two halves fold back into one card (tolerating a missing half and disagreeing
 * scores), and how a squad-game's roster is rebuilt from its snapshot.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_SQUAD_NAMES,
    isScrimmageGame, withoutScrimmages, otherSquad, normalizeSquadNames,
    generateScrimmageId, formatShortDate, squadGameFields, buildSquadSnapshot,
    squadRoster, autoFillSquads, groupScrimmages, scrimmageSquadNames,
    scrimmageScores, scrimmageLabel, isScrimmageOver,
    squadStamp, squadDefinition, newerSquadDefinition, applySquadDefinition,
    squadAssignments, squadPatch, describeSquadChange, pruneLinesToSquad,
} from '../../store/scrimmage.js';

// ── fixtures ────────────────────────────────────────────────────────────

function player(name, gender, position = null, number = null) {
    return { id: `${name}-${name.length}a1b`, name, nickname: '', gender, position, defaultLine: null, number };
}

/** The canonical fictional roster: five FMP, five MMP, a mix of positions. */
const ROSTER = [
    player('Alice', 'FMP', 'handler', 7),
    player('Bob', 'MMP', 'cutter', 11),
    player('Charlie', 'MMP', 'handler', 3),
    player('Dana', 'FMP', 'cutter', 22),
    player('Eve', 'FMP', null, 9),
    player('Hank', 'MMP', null, 5),
    player('Iris', 'FMP', 'handler', 14),
    player('Jake', 'MMP', 'cutter', 8),
    player('Kris', 'MMP', 'handler', 2),
    player('Mia', 'FMP', 'cutter', 17),
];

const byId = Object.fromEntries(ROSTER.map(p => [p.id, p]));

/** A server game summary (list_all_games shape) for one squad-game. */
function summary(overrides = {}) {
    return {
        game_id: '2026-09-27_Dark_vs_Light_1',
        team: 'Dark',
        teamId: 'Team-A-1234',
        opponent: 'Light',
        game_start_timestamp: '2026-09-27T18:00:00Z',
        game_end_timestamp: null,
        scores: { team: 0, opponent: 0 },
        points_count: 0,
        eventId: null,
        phase: null,
        scrimmageId: 'Scrimmage-2026-09-27-ab12',
        scrimmageSquad: 'X',
        scrimmageName: null,
        ...overrides,
    };
}

const DARK = summary({ scores: { team: 7, opponent: 5 }, points_count: 12 });
const LIGHT = summary({
    game_id: '2026-09-27_Light_vs_Dark_2', team: 'Light', opponent: 'Dark',
    scrimmageSquad: 'Y', scores: { team: 5, opponent: 7 }, points_count: 12,
});

// ── identity ────────────────────────────────────────────────────────────

test('a game is a scrimmage half iff it carries a scrimmageId', () => {
    assert.equal(isScrimmageGame(DARK), true);
    assert.equal(isScrimmageGame(summary({ scrimmageId: null })), false);
    assert.equal(isScrimmageGame({ opponent: 'Rival City' }), false);
    assert.equal(isScrimmageGame(null), false);
});

test('withoutScrimmages keeps the real games, in order', () => {
    const real = summary({ game_id: 'real', scrimmageId: null, opponent: 'Rival City' });
    assert.deepEqual(withoutScrimmages([DARK, real, LIGHT]).map(g => g.game_id), ['real']);
    assert.deepEqual(withoutScrimmages(null), []);
});

test('otherSquad flips X and Y', () => {
    assert.equal(otherSquad('X'), 'Y');
    assert.equal(otherSquad('Y'), 'X');
});

// ── names and ids ───────────────────────────────────────────────────────

test('squad names: trimmed, defaulted, never identical', () => {
    assert.deepEqual(normalizeSquadNames({ X: '  Dark ', Y: 'Light' }), { X: 'Dark', Y: 'Light' });
    assert.deepEqual(normalizeSquadNames({}), DEFAULT_SQUAD_NAMES);
    assert.deepEqual(normalizeSquadNames({ X: '', Y: '   ' }), DEFAULT_SQUAD_NAMES);
    // Same name on both sides would give both games the same team and
    // opponent (and the same id stem); disambiguate rather than refuse.
    assert.deepEqual(normalizeSquadNames({ X: 'White', Y: 'white' }), { X: 'White X', Y: 'white Y' });
});

test('scrimmage ids are dated and carry a hash suffix', () => {
    const id = generateScrimmageId(new Date(2026, 8, 27, 18, 0, 0));
    assert.match(id, /^Scrimmage-2026-09-27-[a-z0-9]{4}$/);
    assert.notEqual(generateScrimmageId(new Date(2026, 8, 27)), generateScrimmageId(new Date(2026, 8, 27)));
});

test('formatShortDate matches the team list (MM/DD/YY, local time)', () => {
    assert.equal(formatShortDate(new Date(2026, 8, 27, 12)), '09/27/26');
    assert.equal(formatShortDate('not a date'), '??/??/??');
});

test('squadGameFields: team is this squad, opponent the other', () => {
    const names = { X: 'Dark', Y: 'Light' };
    assert.deepEqual(squadGameFields({ scrimmageId: 'S-1', squad: 'X', squadNames: names, name: ' Tuesday ' }), {
        scrimmageId: 'S-1', scrimmageSquad: 'X', scrimmageName: 'Tuesday', team: 'Dark', opponent: 'Light',
    });
    assert.deepEqual(squadGameFields({ scrimmageId: 'S-1', squad: 'Y', squadNames: names }), {
        scrimmageId: 'S-1', scrimmageSquad: 'Y', scrimmageName: null, team: 'Light', opponent: 'Dark',
    });
});

// ── dealing ─────────────────────────────────────────────────────────────

function countBy(ids, fn, lookup = byId) {
    const out = {};
    ids.forEach(id => { const k = fn(lookup[id]); out[k] = (out[k] || 0) + 1; });
    return out;
}

/** A deterministic random from a seed, so a property holds across many deals. */
function seededRandom(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** Every group of `fn` differs by at most `within` between the squads. */
function assertBalanced({ X, Y }, fn, label, lookup = byId, within = 1) {
    const cx = countBy(X, fn, lookup), cy = countBy(Y, fn, lookup);
    new Set([...Object.keys(cx), ...Object.keys(cy)]).forEach(k => {
        assert.ok(Math.abs((cx[k] || 0) - (cy[k] || 0)) <= within, `${label} ${k}: ${cx[k] || 0} vs ${cy[k] || 0}`);
    });
}

test('auto: every player lands on exactly one squad, in roster order', () => {
    const { X, Y } = autoFillSquads(ROSTER, new Map());
    assert.equal(X.length + Y.length, ROSTER.length);
    assert.equal(new Set([...X, ...Y]).size, ROSTER.length);
    const order = ROSTER.map(p => p.id);
    [X, Y].forEach(ids => assert.deepEqual(ids, ids.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b))));
});

test('auto: totals, genders, positions and lines all balance within one, whatever the random', () => {
    const roster = ROSTER.map((p, i) => ({ ...p, defaultLine: ['O', 'D', null][i % 3] }));
    const here = Object.fromEntries(roster.map(p => [p.id, p]));
    for (let seed = 1; seed <= 60; seed++) {
        const deal = autoFillSquads(roster, new Map(), { random: seededRandom(seed) });
        assert.ok(Math.abs(deal.X.length - deal.Y.length) <= 1, `seed ${seed}: totals`);
        assertBalanced(deal, p => p.gender, `seed ${seed} gender`, here);
        assertBalanced(deal, p => p.position || 'hybrid', `seed ${seed} position`, here);
        assertBalanced(deal, p => p.defaultLine || 'Crossover', `seed ${seed} line`, here);
    }
});

test('auto: handlers are spread over both squads', () => {
    const { X, Y } = autoFillSquads(ROSTER, new Map());
    // Four handlers on the roster (two per gender): two a side.
    assert.equal(countBy(X, p => p.position || 'none').handler || 0, 2);
    assert.equal(countBy(Y, p => p.position || 'none').handler || 0, 2);
});

test('auto: odd gender groups still leave the totals within one', () => {
    const roster = [
        player('Alice', 'FMP'), player('Dana', 'FMP'), player('Eve', 'FMP'),
        player('Bob', 'MMP'), player('Hank', 'MMP'), player('Jake', 'MMP'),
        player('Morgan Vale', 'Unknown'),
    ];
    const { X, Y } = autoFillSquads(roster, new Map());
    assert.equal(X.length + Y.length, 7);
    assert.ok(Math.abs(X.length - Y.length) <= 1);
    assert.equal(X.length, 4);   // X picks first when the squads are level
});

test('auto: keeps what the coach assigned and fills only the rest, around it', () => {
    // Two handlers already on X: Auto sends the other two handlers to Y.
    const handlers = ROSTER.filter(p => p.position === 'handler').map(p => p.id);
    const assignment = new Map([[handlers[0], 'X'], [handlers[1], 'X']]);
    const { X, Y } = autoFillSquads(ROSTER, assignment);
    assert.ok(X.includes(handlers[0]) && X.includes(handlers[1]));
    assert.ok(Y.includes(handlers[2]) && Y.includes(handlers[3]));
    assert.ok(Math.abs(X.length - Y.length) <= 1);
    assert.equal(X.length + Y.length, ROSTER.length);
});

test('auto: an assigned player not in the list is ignored, not dealt', () => {
    const present = ROSTER.slice(0, 6);
    const absent = ROSTER[9].id;
    const { X, Y } = autoFillSquads(present, new Map([[absent, 'X']]));
    assert.equal(X.length + Y.length, 6);
    assert.ok(!X.includes(absent) && !Y.includes(absent));
});

test('auto: unset position and line count as hybrid and Crossover, and spread evenly', () => {
    const roster = [
        player('Alice', 'FMP', 'handler'), player('Dana', 'FMP', 'handler'),
        player('Eve', 'FMP', null), player('Iris', 'FMP', null),
    ];
    const here = Object.fromEntries(roster.map(p => [p.id, p]));
    for (let seed = 1; seed <= 20; seed++) {
        const { X, Y } = autoFillSquads(roster, new Map(), { random: seededRandom(seed) });
        assert.equal(countBy(X, p => p.position || 'hybrid', here).handler, 1, `seed ${seed}`);
        assert.equal(countBy(Y, p => p.position || 'hybrid', here).handler, 1, `seed ${seed}`);
    }
});

test("auto: the coach's factor order decides when position and O/D line disagree", () => {
    // X holds a handler on the O line, Y a cutter on the D line. The two
    // left: a handler on the D line and a cutter on the O line. Position
    // balance wants the cutter on X; line balance wants the D player on X.
    const a = { ...player('Alice', 'FMP', 'handler'), defaultLine: 'O' };
    const b = { ...player('Bob', 'MMP', 'cutter'), defaultLine: 'D' };
    const c = { ...player('Charlie', 'MMP', 'handler'), defaultLine: 'D' };
    const d = { ...player('Dana', 'FMP', 'cutter'), defaultLine: 'O' };
    const assignment = new Map([[a.id, 'X'], [b.id, 'Y']]);
    // Genders are level either way (a and d are FMP; b and c MMP) — wait,
    // they are not: X has one FMP, Y one MMP, so gender would pull Dana to
    // Y and Charlie to X regardless. Use one gender throughout.
    [a, b, c, d].forEach(p => { p.gender = 'MMP'; });
    const positionFirst = autoFillSquads([a, b, c, d], assignment, { priorityOrder: ['position', 'rest', 'od', 'pt'] });
    assert.ok(positionFirst.X.includes(d.id), 'position first: the cutter joins the handler');
    const lineFirst = autoFillSquads([a, b, c, d], assignment, { priorityOrder: ['od', 'position'] });
    assert.ok(lineFirst.X.includes(c.id), 'line first: the D player joins the O player');
    // A malformed order falls back to the default (position first).
    assert.ok(autoFillSquads([a, b, c, d], assignment, { priorityOrder: 'junk' }).X.includes(d.id));
});

test('auto: ties are random — different randoms give different deals, the same random the same deal', () => {
    const deals = new Set();
    for (let seed = 1; seed <= 12; seed++) {
        deals.add(JSON.stringify(autoFillSquads(ROSTER, new Map(), { random: seededRandom(seed) })));
    }
    assert.ok(deals.size > 1, 'a fresh deal each time');
    assert.deepEqual(
        autoFillSquads(ROSTER, new Map(), { random: seededRandom(7) }),
        autoFillSquads(ROSTER, new Map(), { random: seededRandom(7) }));
});

test('auto: ignores entries without an id and copes with an empty roster', () => {
    assert.deepEqual(autoFillSquads([], new Map()), { X: [], Y: [] });
    assert.deepEqual(autoFillSquads(null, null), { X: [], Y: [] });
    const { X, Y } = autoFillSquads([{ name: 'ghost' }, player('Alice', 'FMP')], null);
    assert.equal(X.length + Y.length, 1);
});

// ── snapshots and rosters ───────────────────────────────────────────────

test('buildSquadSnapshot keeps roster order and only the squad', () => {
    const ids = [byId['Mia-3a1b'].id, byId['Alice-5a1b'].id];
    const snap = buildSquadSnapshot(ROSTER, ids, new Date('2026-09-27T18:00:00Z'));
    assert.deepEqual(snap.players.map(p => p.name), ['Alice', 'Mia']);
    assert.deepEqual(snap.players[0], {
        id: 'Alice-5a1b', name: 'Alice', nickname: '', number: 7, gender: 'FMP',
        position: 'handler', defaultLine: null,
    });
    assert.equal(snap.capturedAt, '2026-09-27T18:00:00.000Z');
});

test('buildSquadSnapshot is null for an empty squad (createRosterSnapshot convention)', () => {
    assert.equal(buildSquadSnapshot(ROSTER, []), null);
    assert.equal(buildSquadSnapshot(ROSTER, ['nobody-0000']), null);
});

test('squadRoster resolves snapshot entries to the live Players', () => {
    const game = { rosterSnapshot: { players: [{ id: 'Alice-5a1b', name: 'Alice (old name)' }] } };
    const roster = squadRoster(game, ROSTER);
    assert.equal(roster.length, 1);
    assert.equal(roster[0], byId['Alice-5a1b'], 'the live object, not a copy');
});

test('squadRoster rebuilds a player who has since left the team', () => {
    const game = { rosterSnapshot: { players: [
        { id: 'Zoe-9z9z', name: 'Zoe', gender: 'FMP', number: 21, position: 'cutter', defaultLine: 'O' },
    ] } };
    const [zoe] = squadRoster(game, ROSTER);
    assert.equal(zoe.id, 'Zoe-9z9z');
    assert.equal(zoe.name, 'Zoe');
    assert.equal(zoe.gender, 'FMP');
    assert.equal(zoe.number, 21);
    assert.equal(zoe.position, 'cutter');
    assert.equal(zoe.defaultLine, 'O');
});

test('squadRoster is empty without a snapshot', () => {
    assert.deepEqual(squadRoster({}, ROSTER), []);
    assert.deepEqual(squadRoster(null, ROSTER), []);
});

// ── grouping the halves ─────────────────────────────────────────────────

test('groupScrimmages folds the two halves into one card, newest first', () => {
    const older = summary({
        game_id: 'old-x', scrimmageId: 'Scrimmage-2026-09-20-zz01',
        game_start_timestamp: '2026-09-20T18:00:00Z', scrimmageName: 'Tuesday',
    });
    const real = summary({ game_id: 'real', scrimmageId: null });
    const groups = groupScrimmages([older, LIGHT, real, DARK]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].id, 'Scrimmage-2026-09-27-ab12');
    assert.equal(groups[0].squads.X, DARK);
    assert.equal(groups[0].squads.Y, LIGHT);
    assert.equal(groups[0].games.length, 2);
    assert.equal(groups[0].startTs, Date.parse('2026-09-27T18:00:00Z'));
    assert.equal(groups[1].id, 'Scrimmage-2026-09-20-zz01');
    assert.equal(groups[1].name, 'Tuesday');
    assert.equal(groups[1].squads.Y, undefined, 'a missing half leaves its slot empty');
});

test('groupScrimmages works on Game objects too (Date timestamps, camelCase)', () => {
    const game = {
        id: 'g1', scrimmageId: 'S-1', scrimmageSquad: 'Y', team: 'Light', opponent: 'Dark',
        gameStartTimestamp: new Date('2026-09-27T18:00:00Z'), scores: { team: 3, opponent: 4 },
    };
    const [s] = groupScrimmages([game]);
    assert.equal(s.squads.Y, game);
    assert.equal(s.startTs, Date.parse('2026-09-27T18:00:00Z'));
});

test('groupScrimmages: a half without a squad letter takes the first free slot', () => {
    const a = summary({ game_id: 'a', scrimmageSquad: null });
    const b = summary({ game_id: 'b', scrimmageSquad: null, team: 'Light', opponent: 'Dark' });
    const [s] = groupScrimmages([a, b]);
    assert.equal(s.squads.X, a);
    assert.equal(s.squads.Y, b);
});

test('scrimmageSquadNames reads whichever half exists', () => {
    assert.deepEqual(scrimmageSquadNames({ squads: { X: DARK, Y: LIGHT } }), { X: 'Dark', Y: 'Light' });
    assert.deepEqual(scrimmageSquadNames({ squads: { Y: LIGHT } }), { X: 'Dark', Y: 'Light' });
    assert.deepEqual(scrimmageSquadNames({ squads: {} }), DEFAULT_SQUAD_NAMES);
});

test('scrimmageScores: mirrored halves agree', () => {
    const s = scrimmageScores({ squads: { X: DARK, Y: LIGHT } });
    assert.deepEqual(s.X, { us: 7, them: 5 });
    assert.deepEqual(s.Y, { us: 5, them: 7 });
    assert.deepEqual(s.tracked, { X: true, Y: true });
    assert.equal(s.agree, true);
    assert.deepEqual(s.score, { us: 7, them: 5 });
});

test('scrimmageScores: a missed point shows as disagreement, not a verdict', () => {
    const light = { ...LIGHT, scores: { team: 5, opponent: 6 } };
    const s = scrimmageScores({ squads: { X: DARK, Y: light } });
    assert.equal(s.agree, false);
    // One half alone can't disagree with anything.
    assert.equal(scrimmageScores({ squads: { X: DARK } }).agree, true);
    assert.equal(scrimmageScores({ squads: { X: DARK } }).Y, null);
    assert.deepEqual(scrimmageScores({ squads: { X: DARK } }).score, { us: 7, them: 5 });
});

test('scrimmageScores: a half nobody has tracked yet is not a disagreement', () => {
    // The other coach hasn't started (or only one coach keeps stats): the
    // untracked half sits at 0–0 with no points, and the card shows the
    // tracked half's score rather than flagging a mismatch.
    const untrackedLight = { ...LIGHT, scores: { team: 0, opponent: 0 }, points_count: 0 };
    const s = scrimmageScores({ squads: { X: DARK, Y: untrackedLight } });
    assert.deepEqual(s.tracked, { X: true, Y: false });
    assert.equal(s.agree, true);
    assert.deepEqual(s.score, { us: 7, them: 5 });

    // Only Y tracked: the score is read from Y's side, mirrored to X's.
    const untrackedDark = { ...DARK, scores: { team: 0, opponent: 0 }, points_count: 0 };
    const t = scrimmageScores({ squads: { X: untrackedDark, Y: LIGHT } });
    assert.deepEqual(t.tracked, { X: false, Y: true });
    assert.equal(t.agree, true);
    assert.deepEqual(t.score, { us: 7, them: 5 });

    // Nothing tracked yet: 0–0.
    const u = scrimmageScores({ squads: { X: untrackedDark, Y: untrackedLight } });
    assert.deepEqual(u.score, { us: 0, them: 0 });
    assert.equal(u.agree, true);

    // Game objects count their points array the same way.
    const g = scrimmageScores({ squads: {
        X: { scores: { team: 2, opponent: 1 }, points: [{}, {}, {}] },
        Y: { scores: { team: 0, opponent: 0 }, points: [] },
    } });
    assert.deepEqual(g.tracked, { X: true, Y: false });
    assert.deepEqual(g.score, { us: 2, them: 1 });
});

test('scrimmageLabel: the coach\'s label, else the dated default', () => {
    assert.equal(scrimmageLabel({ name: 'Tryouts day 2', startTs: 1 }), 'Tryouts day 2');
    const ts = new Date(2026, 8, 27, 18).getTime();
    assert.equal(scrimmageLabel({ name: null, startTs: ts }), 'Scrimmage 09/27/26');
    assert.equal(scrimmageLabel({ name: null, startTs: 0 }), 'Scrimmage');
});

test('isScrimmageOver once every present half has ended', () => {
    const ended = { ...DARK, game_end_timestamp: '2026-09-27T19:00:00Z' };
    assert.equal(isScrimmageOver({ games: [ended, LIGHT] }), false);
    assert.equal(isScrimmageOver({ games: [ended, { ...LIGHT, game_end_timestamp: '2026-09-27T19:01:00Z' }] }), true);
    assert.equal(isScrimmageOver({ games: [{ gameEndTimestamp: new Date() }] }), true);
});

// ── editing squads after creation ───────────────────────────────────────

const T0 = '2026-09-29T18:00:00.000Z';
const T1 = '2026-09-29T18:10:00.000Z';

/** A squad-game (Game shape) for squad X with the named players. */
function half(names, capturedAt = T0, overrides = {}) {
    return {
        id: 'g-x', scrimmageId: 'Scrimmage-2026-09-29-ab12', scrimmageSquad: 'X',
        scrimmageName: null, team: 'Dark', opponent: 'Light',
        rosterSnapshot: { players: names.map(n => byId[`${n}-${n.length}a1b`]), capturedAt },
        ...overrides,
    };
}

test('squadStamp reads the snapshot stamp; unstamped is 0', () => {
    assert.equal(squadStamp(half(['Alice'])), Date.parse(T0));
    assert.equal(squadStamp({ rosterSnapshot: { players: [] } }), 0);
    assert.equal(squadStamp({ rosterSnapshot: { players: [], capturedAt: 'garbage' } }), 0);
    assert.equal(squadStamp(null), 0);
});

test('newerSquadDefinition: only a strictly newer server copy of a squad-game is adopted', () => {
    const local = half(['Alice', 'Bob']);
    const server = half(['Alice', 'Eve'], T1, { team: 'Red', opponent: 'Blue', scrimmageName: 'Tuesday' });
    const adopted = newerSquadDefinition(local, server);
    assert.deepEqual(adopted.rosterSnapshot.players.map(p => p.name), ['Alice', 'Eve']);
    assert.equal(adopted.rosterSnapshot.capturedAt, T1);
    assert.equal(adopted.team, 'Red');
    assert.equal(adopted.opponent, 'Blue');
    assert.equal(adopted.scrimmageName, 'Tuesday');
    assert.notEqual(adopted.rosterSnapshot, server.rosterSnapshot, 'a copy, not the server object');

    // Same stamp: this device's own copy coming back.
    assert.equal(newerSquadDefinition(local, half(['Alice', 'Eve'])), null);
    // Older: a stale copy.
    assert.equal(newerSquadDefinition(server, local), null);
    // Unstamped on either side: no version to compare.
    assert.equal(newerSquadDefinition(half(['Alice'], null), server), null);
    assert.equal(newerSquadDefinition(local, half(['Alice'], null)), null);
    // Not a scrimmage: never.
    assert.equal(newerSquadDefinition({ ...local, scrimmageId: null }, { ...server, scrimmageId: null }), null);
});

test('applySquadDefinition writes only the fields the definition carries', () => {
    const game = half(['Alice']);
    game.points = [{ i: 0 }];
    applySquadDefinition(game, { rosterSnapshot: { players: [], capturedAt: T1 }, team: 'Red' });
    assert.equal(game.team, 'Red');
    assert.equal(game.opponent, 'Light');
    assert.equal(game.rosterSnapshot.capturedAt, T1);
    assert.deepEqual(game.points, [{ i: 0 }]);
    assert.equal(applySquadDefinition(null, {}), null);
});

test('squadAssignments reads who is on which squad from the two snapshots', () => {
    const games = {
        X: half(['Alice', 'Bob']),
        Y: half(['Charlie'], T0, { scrimmageSquad: 'Y', team: 'Light', opponent: 'Dark' }),
    };
    const a = squadAssignments(games);
    assert.equal(a.get('Alice-5a1b'), 'X');
    assert.equal(a.get('Bob-3a1b'), 'X');
    assert.equal(a.get('Charlie-7a1b'), 'Y');
    assert.equal(a.get('Dana-4a1b'), undefined);
    assert.equal(squadAssignments({ Y: games.Y }).get('Charlie-7a1b'), 'Y', 'a missing half is fine');
    assert.equal(squadAssignments({}).size, 0);
});

test('squadPatch: null when nothing about the half changes, whatever the player order', () => {
    const game = half(['Alice', 'Bob']);
    const proposal = {
        players: [byId['Bob-3a1b'], byId['Alice-5a1b']],
        squadNames: { X: 'Dark', Y: 'Light' }, label: null,
    };
    assert.equal(squadPatch(game, proposal), null);
    assert.equal(squadPatch(game, { ...proposal, label: '  ' }), null, 'a blank label is no label');
});

test('squadPatch: a changed squad is the whole definition, freshly stamped', () => {
    const game = half(['Alice', 'Bob']);
    const now = new Date('2026-09-29T18:20:00.000Z');
    const patch = squadPatch(game, {
        players: [byId['Alice-5a1b'], byId['Eve-3a1b']],
        squadNames: { X: 'Dark', Y: 'Light' }, label: null, now,
    });
    assert.deepEqual(patch.rosterSnapshot.players.map(p => p.name), ['Alice', 'Eve']);
    assert.equal(patch.rosterSnapshot.capturedAt, now.toISOString());
    assert.equal(patch.rosterSnapshot.players[1].gender, 'FMP', 'the snapshot shape createRosterSnapshot writes');
    assert.equal(patch.team, 'Dark');
    assert.equal(patch.opponent, 'Light');
    assert.equal(patch.scrimmageName, null);
});

test('squadPatch: a rename or relabel alone re-stamps the snapshot too', () => {
    const game = half(['Alice', 'Bob']);
    const now = new Date('2026-09-29T18:20:00.000Z');
    const renamed = squadPatch(game, {
        players: [byId['Alice-5a1b'], byId['Bob-3a1b']],
        squadNames: { X: 'Red', Y: 'Blue' }, label: 'Tuesday practice', now,
    });
    assert.equal(renamed.team, 'Red');
    assert.equal(renamed.opponent, 'Blue');
    assert.equal(renamed.scrimmageName, 'Tuesday practice');
    assert.equal(renamed.rosterSnapshot.capturedAt, now.toISOString());
    assert.deepEqual(renamed.rosterSnapshot.players.map(p => p.name), ['Alice', 'Bob']);

    // The other half sees the same rename from its side.
    const other = half(['Charlie'], T0, { scrimmageSquad: 'Y', team: 'Light', opponent: 'Dark' });
    const otherPatch = squadPatch(other, {
        players: [byId['Charlie-7a1b']], squadNames: { X: 'Red', Y: 'Blue' }, label: null, now,
    });
    assert.equal(otherPatch.team, 'Blue');
    assert.equal(otherPatch.opponent, 'Red');
});

test('squadPatch refuses to empty a squad', () => {
    assert.equal(squadPatch(half(['Alice']), {
        players: [], squadNames: { X: 'Dark', Y: 'Light' }, label: null,
    }), null);
});

test('describeSquadChange names who joined and left, and the renames', () => {
    const before = half(['Alice', 'Bob', 'Charlie']);
    const after = half(['Alice', 'Eve', 'Mia'], T1);
    assert.equal(describeSquadChange(before, after),
        'Squads updated: Eve and Mia joined Dark; Bob and Charlie left.');
    assert.equal(describeSquadChange(before, half(['Alice', 'Bob', 'Charlie', 'Eve'], T1)),
        'Squads updated: Eve joined Dark.');
    assert.equal(describeSquadChange(before, half(['Alice'], T1)),
        'Squads updated: Bob and Charlie left.');
    assert.equal(describeSquadChange(before, half(['Alice', 'Dana', 'Eve', 'Mia'], T1)),
        'Squads updated: Dana, Eve and Mia joined Dark; Bob and Charlie left.');
    assert.equal(describeSquadChange(before, half(['Alice', 'Bob', 'Charlie'], T1,
        { team: 'Red', opponent: 'Blue', scrimmageName: 'Tuesday' })),
        'Squads updated: Dark is now Red; Light is now Blue; labelled “Tuesday”.');
    assert.equal(describeSquadChange(half(['Alice'], T0, { scrimmageName: 'Tuesday' }), half(['Alice'], T1)),
        'Squads updated: label removed.');
});

test('describeSquadChange: nothing visible changed → null; a live point is mentioned', () => {
    const before = half(['Alice', 'Bob']);
    assert.equal(describeSquadChange(before, half(['Bob', 'Alice'], T1)), null, 'same squad, re-stamped');
    assert.equal(describeSquadChange(before, half(['Alice'], T1), { pointInProgress: true }),
        'Squads updated: Bob left. The point on the field keeps its line; the new squad plays from the next point.');
    // A rename during a point changes nothing on the field: no next-point note.
    assert.equal(describeSquadChange(before, half(['Alice', 'Bob'], T1, { team: 'Red' }), { pointInProgress: true }),
        'Squads updated: Dark is now Red.');
    // Nicknames are what the app displays.
    const nick = { ...byId['Eve-3a1b'], nickname: 'Evie' };
    assert.equal(describeSquadChange(before, { ...half(['Alice', 'Bob'], T1), rosterSnapshot: {
        players: [byId['Alice-5a1b'], byId['Bob-3a1b'], nick], capturedAt: T1,
    } }), 'Squads updated: Evie joined Dark.');
});

test('pruneLinesToSquad drops departed players from every planned line and stamps the changed ones', () => {
    const now = new Date('2026-09-29T18:20:00.000Z');
    const pending = {
        oLine: ['Alice', 'Bob', 'Charlie'], oLineModifiedAt: T0,
        dLine: ['Alice'], dLineModifiedAt: T0,
        odLine: ['Bob', 'Alice-5a1b'], odLineModifiedAt: null,
        odOnDeckLine: [], odOnDeckLineModifiedAt: null,
        activeType: 'od',
    };
    const snapshot = { players: [byId['Alice-5a1b'], byId['Charlie-7a1b']], capturedAt: T1 };
    const removed = pruneLinesToSquad(pending, snapshot, now);
    assert.deepEqual(removed, ['Bob']);
    assert.deepEqual(pending.oLine, ['Alice', 'Charlie']);
    assert.equal(pending.oLineModifiedAt, now.toISOString());
    assert.deepEqual(pending.dLine, ['Alice']);
    assert.equal(pending.dLineModifiedAt, T0, 'an untouched line keeps its stamp');
    assert.deepEqual(pending.odLine, ['Alice-5a1b'], 'ids count as on the squad too');
    assert.equal(pending.odLineModifiedAt, now.toISOString());
    assert.equal(pending.odOnDeckLineModifiedAt, null);
    assert.equal(pending.activeType, 'od');

    assert.deepEqual(pruneLinesToSquad(pending, snapshot, now), [], 'idempotent');
    assert.deepEqual(pruneLinesToSquad(null, snapshot), []);
    assert.deepEqual(pruneLinesToSquad(pending, null), []);
});

test('squadDefinition copies the four fields', () => {
    const def = squadDefinition(half(['Alice'], T0, { scrimmageName: '' }));
    assert.deepEqual(Object.keys(def).sort(), ['opponent', 'rosterSnapshot', 'scrimmageName', 'team']);
    assert.equal(def.scrimmageName, null);
    assert.equal(squadDefinition({ team: 'Dark' }).rosterSnapshot, null);
});
