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
    squadRoster, splitSquads, groupScrimmages, scrimmageSquadNames,
    scrimmageScores, scrimmageLabel, isScrimmageOver,
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

function countBy(ids, fn) {
    const out = {};
    ids.forEach(id => { const k = fn(byId[id]); out[k] = (out[k] || 0) + 1; });
    return out;
}

test('split: every player lands on exactly one squad', () => {
    const { X, Y } = splitSquads(ROSTER);
    assert.equal(X.length + Y.length, ROSTER.length);
    assert.equal(new Set([...X, ...Y]).size, ROSTER.length);
});

test('split: totals within one, genders balanced across the squads', () => {
    const { X, Y } = splitSquads(ROSTER);
    assert.ok(Math.abs(X.length - Y.length) <= 1);
    const gx = countBy(X, p => p.gender), gy = countBy(Y, p => p.gender);
    assert.ok(Math.abs((gx.FMP || 0) - (gy.FMP || 0)) <= 1, `FMP ${gx.FMP} vs ${gy.FMP}`);
    assert.ok(Math.abs((gx.MMP || 0) - (gy.MMP || 0)) <= 1, `MMP ${gx.MMP} vs ${gy.MMP}`);
});

test('split: handlers are spread over both squads', () => {
    const { X, Y } = splitSquads(ROSTER);
    const hx = countBy(X, p => p.position || 'none').handler || 0;
    const hy = countBy(Y, p => p.position || 'none').handler || 0;
    // Four handlers on the roster (two per gender): two a side.
    assert.equal(hx, 2);
    assert.equal(hy, 2);
});

test('split: odd gender groups still leave the totals within one', () => {
    // 3 FMP + 3 MMP + 1 unknown: each group would give one squad the extra
    // player; starting each group with the smaller squad evens it out.
    const roster = [
        player('Alice', 'FMP'), player('Dana', 'FMP'), player('Eve', 'FMP'),
        player('Bob', 'MMP'), player('Hank', 'MMP'), player('Jake', 'MMP'),
        player('Morgan Vale', 'Unknown'),
    ];
    const { X, Y } = splitSquads(roster);
    assert.equal(X.length + Y.length, 7);
    assert.ok(Math.abs(X.length - Y.length) <= 1);
});

test('split: deterministic without shuffle, and stable under a fixed random', () => {
    assert.deepEqual(splitSquads(ROSTER), splitSquads(ROSTER));
    const seq = [0.1, 0.9, 0.3, 0.7, 0.5, 0.2, 0.8, 0.4, 0.6, 0.05];
    const mk = () => { let i = 0; return () => seq[i++ % seq.length]; };
    const a = splitSquads(ROSTER, { shuffle: true, random: mk() });
    const b = splitSquads(ROSTER, { shuffle: true, random: mk() });
    assert.deepEqual(a, b);
    // Shuffled or not, the balance holds.
    assert.ok(Math.abs(a.X.length - a.Y.length) <= 1);
    const gx = countBy(a.X, p => p.gender), gy = countBy(a.Y, p => p.gender);
    assert.ok(Math.abs((gx.FMP || 0) - (gy.FMP || 0)) <= 1);
});

test('split: ignores entries without an id and copes with an empty roster', () => {
    assert.deepEqual(splitSquads([]), { X: [], Y: [] });
    assert.deepEqual(splitSquads(null), { X: [], Y: [] });
    const { X, Y } = splitSquads([{ name: 'ghost' }, player('Alice', 'FMP')]);
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
