/*
 * Unit tests for goal / assist / hockey-assist attribution in
 * accumulateGameStats (utils/statAccumulator.js).
 *
 * The contract under test:
 *  - a scoring Throw credits the goal to its receiver;
 *  - the assist goes to the Throw's explicit `assist` holder when one was
 *    recorded, otherwise to its thrower — the same `assist || thrower` rule
 *    the live counters, event amendment, undo and Connections follow;
 *  - the hockey assist is the coach's call when the scoring Throw carries one
 *    (`hockeyAssist` + `hockeyAssistHuck_flag`, or `noHockeyAssist_flag` for
 *    an explicit none, both set by the Score Attribution dialog); otherwise —
 *    legacy and narrated scores — it goes to the thrower of the previous
 *    Throw in the same possession (skipping non-Throw events), whoever holds
 *    the assist, and counts as a huck HA too when that throw was a huck.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same window/localStorage stubs as fullStats.test.mjs, so the pure leaf's
// import chain can evaluate.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { accumulateGameStats } = await import('../../utils/statAccumulator.js');
// With no stored teams, storage.js builds a "Sample Team" that reuses the
// fixture names under other ids, so a bare name string would resolve as
// ambiguous. Clear it, as connections.test.mjs does.
const { setCurrentTeam } = await import('../../store/storage.js');
setCurrentTeam(null);

// ── helpers ─────────────────────────────────────────────────────────────

const ALICE = { name: 'Alice', id: 'Alice-1111' };
const BOB = { name: 'Bob', id: 'Bob-2222' };
const CHARLIE = { name: 'Charlie', id: 'Charlie-3333' };
const DANA = { name: 'Dana', id: 'Dana-4444' };
const ROSTER = [ALICE, BOB, CHARLIE, DANA];

const pass = (thrower, receiver, flags = {}) => ({ type: 'Throw', thrower, receiver, ...flags });

// One completed point; each entry of `possessions` is one possession's events.
function statsFor(...possessions) {
    const game = {
        rosterSnapshot: { players: ROSTER },
        points: [{
            winner: 'team',
            players: ROSTER.map(p => p.id),
            totalPointTime: 60000,
            startingPosition: 'offense',
            possessions: possessions.map((events, i) => ({ offensive: i % 2 === 0, events }))
        }]
    };
    const stats = {};
    accumulateGameStats(game, stats);
    return stats;
}

const count = (s, player, field) => (s[player.id] ? s[player.id][field] : 0);

// ── goals and assists ───────────────────────────────────────────────────

test('a score credits the goal to the receiver and the assist to the thrower', () => {
    const s = statsFor([pass(ALICE, BOB), pass(BOB, CHARLIE, { score_flag: true })]);
    assert.equal(count(s, CHARLIE, 'goals'), 1);
    assert.equal(count(s, BOB, 'assists'), 1);
    assert.equal(count(s, ALICE, 'assists'), 0);
});

test('an explicit assist holder takes the assist from the thrower', () => {
    const s = statsFor([pass(ALICE, BOB), pass(BOB, CHARLIE, { score_flag: true, assist: DANA })]);
    assert.equal(count(s, DANA, 'assists'), 1);
    assert.equal(count(s, BOB, 'assists'), 0);
    assert.equal(count(s, CHARLIE, 'goals'), 1);
    // The scoring pass is still the thrower's completion.
    assert.equal(count(s, BOB, 'completions'), 1);
    assert.equal(count(s, DANA, 'completions'), 0);
});

test('an explicit assist naming the thrower counts once', () => {
    const s = statsFor([pass(BOB, CHARLIE, { score_flag: true, assist: BOB })]);
    assert.equal(count(s, BOB, 'assists'), 1);
});

test('a legacy name-string assist resolves through the roster snapshot', () => {
    const s = statsFor([pass(BOB, CHARLIE, { score_flag: true, assist: 'Dana' })]);
    assert.equal(count(s, DANA, 'assists'), 1);
    assert.equal(count(s, BOB, 'assists'), 0);
});

// ── hockey assists ──────────────────────────────────────────────────────

test('the hockey assist goes to the thrower of the pass before the assist', () => {
    const s = statsFor([pass(ALICE, BOB), pass(BOB, CHARLIE, { score_flag: true })]);
    assert.equal(count(s, ALICE, 'hockeyAssists'), 1);
    assert.equal(count(s, ALICE, 'huckHockeyAssists'), 0);
    assert.equal(count(s, BOB, 'hockeyAssists'), 0);
});

test('a huck hockey assist counts in both totals', () => {
    const s = statsFor([pass(ALICE, BOB, { huck_flag: true }), pass(BOB, CHARLIE, { score_flag: true })]);
    assert.equal(count(s, ALICE, 'hockeyAssists'), 1);
    assert.equal(count(s, ALICE, 'huckHockeyAssists'), 1);
});

test('the hockey assist skips non-Throw events', () => {
    const s = statsFor([
        pass(ALICE, BOB),
        { type: 'Violation', foul_flag: true },
        pass(BOB, CHARLIE, { score_flag: true })
    ]);
    assert.equal(count(s, ALICE, 'hockeyAssists'), 1);
});

test('a score on the first throw of a possession has no hockey assist', () => {
    // Dana's earlier completion belongs to a previous possession.
    const s = statsFor(
        [pass(DANA, ALICE), { type: 'Turnover', thrower: ALICE, throwaway_flag: true }],
        [{ type: 'Defense', defender: DANA, block_flag: true }],
        [pass(BOB, CHARLIE, { score_flag: true })]
    );
    for (const p of ROSTER) assert.equal(count(s, p, 'hockeyAssists'), 0, p.name);
});

test('the hockey assist follows the throw sequence even with an explicit assist holder', () => {
    const s = statsFor([pass(ALICE, BOB), pass(BOB, CHARLIE, { score_flag: true, assist: DANA })]);
    assert.equal(count(s, ALICE, 'hockeyAssists'), 1);
    assert.equal(count(s, DANA, 'hockeyAssists'), 0);
});

// ── explicit hockey assists (the dialog's judgment call) ───────────────

test('an explicit hockey assist overrides the throw-sequence fallback', () => {
    // Alice threw the pass before the assist, but the coach credited Dana.
    const s = statsFor([pass(ALICE, BOB), pass(BOB, CHARLIE, { score_flag: true, hockeyAssist: DANA })]);
    assert.equal(count(s, DANA, 'hockeyAssists'), 1);
    assert.equal(count(s, ALICE, 'hockeyAssists'), 0);
    assert.equal(count(s, DANA, 'huckHockeyAssists'), 0);
});

test('an explicit hockey assist is a huck HA only by its own flag', () => {
    // The previous throw was a huck, but the coach credited a different throw.
    const plain = statsFor([pass(ALICE, BOB, { huck_flag: true }), pass(BOB, CHARLIE, { score_flag: true, hockeyAssist: DANA })]);
    assert.equal(count(plain, DANA, 'huckHockeyAssists'), 0);
    const huck = statsFor([pass(ALICE, BOB), pass(BOB, CHARLIE, { score_flag: true, hockeyAssist: DANA, hockeyAssistHuck_flag: true })]);
    assert.equal(count(huck, DANA, 'hockeyAssists'), 1);
    assert.equal(count(huck, DANA, 'huckHockeyAssists'), 1);
});

test('an explicit "no hockey assist" stops the fallback', () => {
    const s = statsFor([pass(ALICE, BOB, { huck_flag: true }), pass(BOB, CHARLIE, { score_flag: true, noHockeyAssist_flag: true })]);
    for (const p of ROSTER) {
        assert.equal(count(s, p, 'hockeyAssists'), 0, p.name);
        assert.equal(count(s, p, 'huckHockeyAssists'), 0, p.name);
    }
});

test('a legacy name-string hockey assist resolves through the roster snapshot', () => {
    const s = statsFor([pass(ALICE, BOB), pass(BOB, CHARLIE, { score_flag: true, hockeyAssist: 'Dana' })]);
    assert.equal(count(s, DANA, 'hockeyAssists'), 1);
    assert.equal(count(s, ALICE, 'hockeyAssists'), 0);
});

test('a judged score with no decision recorded still uses the fallback', () => {
    // Neither hockeyAssist nor noHockeyAssist_flag: a narrated or direct
    // createThrow score, same as every game recorded before the dialog.
    const s = statsFor([pass(ALICE, BOB), pass(BOB, CHARLIE, { score_flag: true, hockeyAssist: null })]);
    assert.equal(count(s, ALICE, 'hockeyAssists'), 1);
});
