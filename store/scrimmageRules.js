/*
 * Scrimmage variations — the pure half (no DOM, no network, no app state).
 *
 * A scrimmage (store/scrimmage.js) can be played under a rules variation:
 * a drill where the same squad pulls every point and a point ends when its
 * possessions run out (the ten-pull drill, ten possessions), a conversion
 * rule where a score must be followed up (double score, extra point), and
 * an independent "two-point plays" toggle. The variation is stored on each
 * squad-game as `game.scrimmageRules` — the same object on both halves:
 *
 *   { variation: 'tenPull', twoPointPlays: false, puller: 'X' }
 *
 * `null` on every real game and on a plain scrimmage. Each variation is a
 * row of VARIATIONS below; a new variation is a new row (and, when it needs
 * a knob the existing rows do not have, a new knob read here). The
 * in-game side effects live in game/gameLogic.js (`recordScore`,
 * `settlePointAfterTurnover`) and read only the decisions made here.
 *
 * Two Point fields carry the variation state:
 *   point.pendingConversion  'team' | 'opponent' | null — the side that has
 *                            scored and must now convert (conversion rules).
 *   point.pendingValue       the points that side has at stake: 1 under a
 *                            conversion rule; the unbanked run under Bank.
 *   point.pointValue         the points the winner earned when the point
 *                            ended (1 ordinarily; 2 for a two-point play or
 *                            a converted extra point; the banked run; 0 for
 *                            NO_SCORE).
 *   point.banked             true when the point ended on a Bank — nothing
 *                            on the event stream marks it, so Undo needs this.
 *
 * See ARCHITECTURE.md § Scrimmage variations; tests/unit/scrimmageRules.test.mjs.
 */
import { Role } from './models.js';

/** `point.winner` for a point that ended with nobody scoring (a drill rep). */
const NO_SCORE = 'none';

/**
 * The variations a coach can pick. Knobs:
 *   possessionLimit  the point is over once this many possessions have been
 *                    played (the rep's disc is dead), whoever has the disc
 *   fixedPuller      the same squad (`rules.puller`) pulls every point
 *   conversion       'double' — a score counts only once the scoring squad
 *                    brings the disc out and scores again; a turn voids it
 *                    and play goes on. 'extraPoint' — a score counts for one
 *                    and the scoring squad gets one more possession worth a
 *                    second point; the point ends either way. 'bank' — a
 *                    score goes onto the scoring squad's unbanked run and
 *                    they choose: bank it (the point ends, the run is theirs,
 *                    the other squad takes the disc with no pull) or press on
 *                    for more; a turn forfeits the run and play goes on
 *   noPull           no point starts with a pull: the side on offense simply
 *                    has the disc (Bank: from outside the endzone)
 */
const VARIATIONS = [
    {
        id: 'standard', label: 'Standard scrimmage',
        hint: 'A normal game between the squads: the scoring squad pulls.',
    },
    {
        id: 'tenPull', label: 'Ten-pull drill', possessionLimit: 2, fixedPuller: true,
        hint: 'The same squad pulls every point. The receiving squad has one possession to score; '
            + 'if they turn it, the pulling squad has one possession. Then the point is over, '
            + 'scored or not, and the pull is repeated.',
    },
    {
        id: 'tenPossession', label: 'Ten possessions', possessionLimit: 1, fixedPuller: true,
        hint: 'The same squad pulls every point and the receiving squad gets one possession to score. '
            + 'Swap who pulls in Game Settings when it is the other squad’s turn.',
    },
    {
        id: 'doubleScore', label: 'Double score', conversion: 'double',
        hint: 'A score only counts once the scoring squad brings the disc out and scores again. '
            + 'A turn before then voids the score and play goes on.',
    },
    {
        id: 'extraPoint', label: 'Extra point', conversion: 'extraPoint',
        hint: 'A score counts for one. The scoring squad then brings the disc out for one more '
            + 'possession worth a second point; the point ends either way.',
    },
    {
        id: 'bank', label: 'Bank', conversion: 'bank', noPull: true,
        hint: 'One squad has the disc, no pull. Each score adds to their unbanked run; after it they '
            + 'choose to bank the run (the other squad then takes the disc) or press on for more. '
            + 'A turn forfeits the unbanked run and the other squad plays on.',
    },
];

const TWO_POINT_HINT = 'Two-point plays: a checkbox on the score dialog awards two points for a '
    + 'score the coach calls special (a huck, a cross-gender throw, everyone touched it…).';

function variationById(id) {
    return VARIATIONS.find(v => v.id === id) || VARIATIONS[0];
}

/**
 * The stored rules object, normalized — or null when nothing varies from a
 * plain scrimmage (standard variation, no two-point plays), so a game with
 * no rules and a game whose rules were reset read the same.
 * @param {object|null|undefined} raw - `game.scrimmageRules` as stored or as edited
 * @returns {{variation: string, twoPointPlays: boolean, puller: 'X'|'Y'|null}|null}
 */
function normalizeRules(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const variation = variationById(raw.variation).id;
    const twoPointPlays = !!raw.twoPointPlays;
    if (variation === 'standard' && !twoPointPlays) return null;
    const puller = raw.puller === 'X' || raw.puller === 'Y' ? raw.puller : null;
    return { variation, twoPointPlays, puller };
}

/** The game's normalized rules, or null. */
function gameRules(game) {
    return normalizeRules(game && game.scrimmageRules);
}

function definitionOf(game) {
    const rules = gameRules(game);
    return rules ? variationById(rules.variation) : null;
}

/** How many possessions end a point under the game's rules, or null. */
function possessionLimit(game) {
    const def = definitionOf(game);
    return (def && def.possessionLimit) || null;
}

/** True when no point starts with a pull (Bank). */
function noPull(game) {
    const def = definitionOf(game);
    return !!(def && def.noPull);
}

/** 'double' | 'extraPoint' | 'bank' | null */
function conversionRule(game) {
    const def = definitionOf(game);
    return (def && def.conversion) || null;
}

function twoPointPlaysEnabled(game) {
    const rules = gameRules(game);
    return !!(rules && rules.twoPointPlays);
}

/**
 * Which side the next point starts on when the rules fix the puller:
 * 'defense' when this squad-game's squad pulls, 'offense' when the other
 * does; null when the normal rule (the scoring team pulls) applies.
 */
function fixedPointStart(game) {
    const rules = gameRules(game);
    const def = definitionOf(game);
    if (!rules || !def || !def.fixedPuller || !rules.puller || !game.scrimmageSquad) return null;
    return rules.puller === game.scrimmageSquad ? 'defense' : 'offense';
}

/**
 * The decision for a score by `scorer` ('team' | 'opponent') in the current
 * point, with the two-point box ticked or not.
 *   { action: 'end', winner, value }        the point is over, winner scores value
 *   { action: 'pending', by, value, voided? } the scorer must now convert (value 1),
 *                                           or under Bank has `value` unbanked;
 *                                           `voided` names a side whose own
 *                                           pending score this one wiped (double
 *                                           score, or a Bank run that was never
 *                                           recorded as turned over)
 *   { action: 'end', winner, value, missed: true, dropped }
 *                                           extra point: the other side scored while
 *                                           a conversion was pending, so the pending
 *                                           side's point ends at one and the new
 *                                           score (`dropped`) is not recorded — the
 *                                           coach should have tapped the miss first
 * Under a conversion rule the two-point bonus is read on the score that
 * ends the point only; under Bank every score adds 1 + bonus to the run.
 */
function scoreOutcome(game, point, scorer, { twoPoint = false } = {}) {
    const bonus = twoPoint ? 1 : 0;
    const conversion = conversionRule(game);
    const pending = (point && point.pendingConversion) || null;
    if (!conversion) return { action: 'end', winner: scorer, value: 1 + bonus };
    if (conversion === 'bank') {
        const run = pending === scorer ? pendingValueOf(point) : 0;
        const out = { action: 'pending', by: scorer, value: run + 1 + bonus };
        if (pending && pending !== scorer) out.voided = pending;
        return out;
    }
    if (!pending) return { action: 'pending', by: scorer, value: 1 };
    if (pending === scorer) {
        return { action: 'end', winner: scorer, value: (conversion === 'extraPoint' ? 2 : 1) + bonus, converted: true };
    }
    if (conversion === 'double') return { action: 'pending', by: scorer, value: 1, voided: pending };
    return { action: 'end', winner: pending, value: 1, missed: true, dropped: scorer };
}

/**
 * Bank the unbanked run: the point ends for the side with the run.
 *   { action: 'end', winner, value, banked: true } | { action: 'none' }
 */
function bankOutcome(game, point) {
    const pending = (point && point.pendingConversion) || null;
    if (conversionRule(game) !== 'bank' || !pending) return { action: 'none' };
    return { action: 'end', winner: pending, value: pendingValueOf(point), banked: true };
}

/**
 * The decision once the disc changes hands (any turnover, either side), or
 * when the coach says a conversion was missed: the pending conversion is
 * over, and under a possession limit the rep may be too.
 *   { action: 'none' }
 *   { action: 'clearPending', missedBy }   double score: the score is void, play on
 *   { action: 'clearPending', missedBy, forfeited }  Bank: the unbanked run is lost, play on
 *   { action: 'end', winner, value: 1, missed: true }  extra point: one point, point over
 *   { action: 'end', winner: NO_SCORE, value: 0, dead: true }  possessions used up
 */
function turnoverOutcome(game, point) {
    const conversion = conversionRule(game);
    const pending = (point && point.pendingConversion) || null;
    if (conversion && pending) {
        if (conversion === 'bank') return { action: 'clearPending', missedBy: pending, forfeited: pendingValueOf(point) };
        return conversion === 'double'
            ? { action: 'clearPending', missedBy: pending }
            : { action: 'end', winner: pending, value: 1, missed: true };
    }
    const limit = possessionLimit(game);
    const played = (point && point.possessions ? point.possessions.length : 0);
    if (limit && played >= limit) return { action: 'end', winner: NO_SCORE, value: 0, dead: true };
    return { action: 'none' };
}

/**
 * The manual controls the coach needs right now (Simple mode records no
 * turnovers, so these are its only way to say so), in display order:
 *   bank      Bank the unbanked run (Bank, a run pending)
 *   turnover  the run was turned over and forfeited (Bank, a run pending)
 *   missed    the conversion was missed (double score / extra point, pending)
 *   dead      the possessions are used up, no score (possession limit)
 * @returns {Array<{kind: string, label: string, title: string}>}
 */
function manualControls(game, point) {
    const conversion = conversionRule(game);
    const pending = !!(point && point.pendingConversion);
    if (conversion === 'bank') {
        if (!pending) return [];
        const n = pendingValueOf(point);
        return [
            { kind: 'bank', label: `Bank ${n}`, title: `Bank the ${n} unbanked point${n === 1 ? '' : 's'}: the point ends, the other squad takes the disc` },
            { kind: 'turnover', label: 'Turnover', title: `The run was turned over: the ${n} unbanked point${n === 1 ? '' : 's'} are forfeited, play on` },
        ];
    }
    if (conversion && pending) {
        return [{ kind: 'missed', label: 'Missed', title: 'The conversion was missed' }];
    }
    if (possessionLimit(game)) {
        return [{ kind: 'dead', label: 'No Score', title: 'The possessions are used up: end the point with no score' }];
    }
    return [];
}

/** True for the two sides that can hold the disc. */
function isScoringSide(winner) {
    return winner === Role.TEAM || winner === Role.OPPONENT;
}

/** What the pending side has at stake: the unbanked run under Bank, 1 under a conversion rule. */
function pendingValueOf(point) {
    if (!point || !point.pendingConversion) return 0;
    const v = Number(point.pendingValue);
    return Number.isFinite(v) && v > 0 ? v : 1;
}

/** The points an ended point put on the board (0 for NO_SCORE, 1 by default). */
function pointValueOf(point) {
    if (!point || !point.winner || point.winner === NO_SCORE) return 0;
    const v = Number(point.pointValue);
    return Number.isFinite(v) && v >= 0 ? v : 1;
}

/** Scores recomputed from the points — what store/storage.js checks the stored scores against. */
function recountScores(points) {
    const scores = { [Role.TEAM]: 0, [Role.OPPONENT]: 0 };
    (points || []).forEach(point => {
        if (point && isScoringSide(point.winner)) scores[point.winner] += pointValueOf(point);
    });
    return scores;
}

/**
 * One line for a card or header: "Ten-pull drill · Dark pulls · two-point plays".
 * @param {object} game - a squad-game (or summary) carrying scrimmageRules + scrimmageSquad
 * @param {{X: string, Y: string}} [squadNames]
 */
function rulesSummary(game, squadNames) {
    const rules = gameRules(game);
    if (!rules) return '';
    const def = variationById(rules.variation);
    const parts = [];
    if (def.id !== 'standard') parts.push(def.label);
    if (def.fixedPuller && rules.puller) {
        const name = squadNames && squadNames[rules.puller];
        parts.push(`${name || `Squad ${rules.puller}`} pulls`);
    }
    if (rules.twoPointPlays) parts.push('two-point plays');
    return parts.join(' · ');
}

export {
    NO_SCORE, VARIATIONS, TWO_POINT_HINT,
    variationById, normalizeRules, gameRules,
    possessionLimit, conversionRule, noPull, twoPointPlaysEnabled, fixedPointStart,
    scoreOutcome, turnoverOutcome, bankOutcome, manualControls,
    isScoringSide, pendingValueOf, pointValueOf, recountScores, rulesSummary,
};
