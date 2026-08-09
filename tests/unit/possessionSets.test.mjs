/*
 * Unit tests for utils/possessionSets.js — the set-tagging logic shared by the
 * Full and Field play-by-play surfaces.
 *
 * The bug these pin: the Full tab's chip originally rendered only for
 * OFFENSIVE possessions (defensive sets were picked in the pull dialog), so a
 * team that configured only defensive labels — the primary zone-tracking case
 * — never saw a set control anywhere on that tab. Side selection is now the
 * whole job of setLabelsFor, and both surfaces call it.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { setLabelsFor, setLabelsForSide, nextSetValue, setControlLabel, taggablePossession } =
    await import('../../utils/possessionSets.js');

const TEAM = {
    setsEnabled: true,
    sets: { offensive: ['Vert', 'Ho'], defensive: ['Zone', 'Match'] }
};
const oPoss = set => ({ offensive: true, set: set ?? null });
const dPoss = set => ({ offensive: false, set: set ?? null });

// ── which labels apply ──────────────────────────────────────────────────

test('offensive possession offers the offensive labels', () => {
    assert.deepEqual(setLabelsFor(TEAM, oPoss()), ['Vert', 'Ho']);
});

test('defensive possession offers the defensive labels', () => {
    assert.deepEqual(setLabelsFor(TEAM, dPoss()), ['Zone', 'Match']);
});

test('a defensive-only team still gets a control on defense', () => {
    // The exact shape that showed no chip anywhere before this change.
    const team = { setsEnabled: true, sets: { offensive: [], defensive: ['Zone'] } };
    assert.deepEqual(setLabelsFor(team, dPoss()), ['Zone']);
    assert.deepEqual(setLabelsFor(team, oPoss()), [], 'nothing to offer on offense');
});

test('opted-out team offers nothing on either side', () => {
    const team = { setsEnabled: false, sets: { offensive: ['Vert'], defensive: ['Zone'] } };
    assert.deepEqual(setLabelsFor(team, oPoss()), []);
    assert.deepEqual(setLabelsFor(team, dPoss()), []);
});

test('missing team / possession / sets are all safe', () => {
    assert.deepEqual(setLabelsFor(null, oPoss()), []);
    assert.deepEqual(setLabelsFor(TEAM, null), []);
    assert.deepEqual(setLabelsFor({ setsEnabled: true }, oPoss()), []);
    assert.deepEqual(setLabelsFor({ setsEnabled: true, sets: {} }, dPoss()), []);
});

test('possession with no explicit offensive flag counts as offensive', () => {
    // App-wide convention: defensive iff `offensive === false`.
    assert.deepEqual(setLabelsFor(TEAM, { set: null }), ['Vert', 'Ho']);
});

// ── live-mode keying (the change-of-possession case) ────────────────────

test('setLabelsForSide keys off the side in play, not a possession', () => {
    assert.deepEqual(setLabelsForSide(TEAM, true), ['Vert', 'Ho']);
    assert.deepEqual(setLabelsForSide(TEAM, false), ['Zone', 'Match']);
    assert.deepEqual(setLabelsForSide({ setsEnabled: false, sets: TEAM.sets }, true), []);
    assert.deepEqual(setLabelsForSide(null, true), []);
    assert.deepEqual(setLabelsForSide({ setsEnabled: true, sets: {} }, true), []);
});

test('just after winning the disc, the live side is offense while the last possession is still defensive', () => {
    // The reported bug: a block flips the mode to offense, but no offensive
    // possession exists yet (they're created on the first recorded event), so
    // keying off the last possession offered DEFENSIVE labels to a coach
    // naming their O set.
    const point = { possessions: [oPoss(), dPoss('Zone')] };  // block landed in the D possession
    const last = taggablePossession(point);
    assert.equal(last.offensive, false, 'last possession is still the defensive one');

    // Wrong (old) behaviour — labels from the stale possession:
    assert.deepEqual(setLabelsFor(TEAM, last), ['Zone', 'Match']);
    // Right behaviour — labels from the live mode:
    assert.deepEqual(setLabelsForSide(TEAM, /* offense */ true), ['Vert', 'Ho']);
});

test('side-match test decides whether a possession already exists for the live side', () => {
    const matches = (poss, wantOffensive) =>
        !!poss && ((poss.offensive !== false) === wantOffensive);
    assert.equal(matches(oPoss(), true), true);
    assert.equal(matches(dPoss(), true), false, 'defensive possession, offense in play → none yet');
    assert.equal(matches(dPoss(), false), true);
    assert.equal(matches(null, true), false);
    assert.equal(matches({ set: null }, true), true, 'missing flag counts as offensive');
});

// ── the tap cycle ───────────────────────────────────────────────────────

test('cycles unspecified → each label → back to unspecified', () => {
    const labels = ['Zone', 'Match'];
    assert.equal(nextSetValue(null, labels), 'Zone');
    assert.equal(nextSetValue('Zone', labels), 'Match');
    assert.equal(nextSetValue('Match', labels), null);
});

test('a tag whose label was deleted clears first, then rejoins the cycle', () => {
    // Recorded possessions are never rewritten when the team edits its lists,
    // so tapping is the only way to resolve an orphaned tag. It sits one step
    // before the cycle: clear it, then walk the current labels.
    assert.equal(nextSetValue('Junk', ['Zone', 'Match']), null);
    assert.equal(nextSetValue(null, ['Zone', 'Match']), 'Zone');
});

test('single-label list toggles on and off', () => {
    assert.equal(nextSetValue(null, ['Zone']), 'Zone');
    assert.equal(nextSetValue('Zone', ['Zone']), null);
});

// ── caption + target ────────────────────────────────────────────────────

test('caption shows the tag or an em dash', () => {
    assert.equal(setControlLabel(dPoss('Zone')), 'Set: Zone');
    assert.equal(setControlLabel(dPoss()), 'Set: —');
    assert.equal(setControlLabel(null), 'Set: —');
});

test('the control targets the live (last) possession', () => {
    const a = dPoss('Zone'), b = oPoss('Vert');
    assert.equal(taggablePossession({ possessions: [a, b] }), b);
});

test('no possession yet → nothing to tag', () => {
    // O points create their first possession on the first throw, so the
    // control correctly renders nothing until then.
    assert.equal(taggablePossession({ possessions: [] }), null);
    assert.equal(taggablePossession(null), null);
    assert.deepEqual(setLabelsFor(TEAM, taggablePossession({ possessions: [] })), []);
});
