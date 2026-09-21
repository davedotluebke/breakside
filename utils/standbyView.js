/*
 * Standby view — the pure half of the standby screen (ui/standbyScreen.js).
 *
 * A pure leaf module: no DOM, no timers, no imports, no side effects, so the
 * two decisions the black screen makes can be unit-tested directly
 * (tests/unit/standbyView.test.mjs) instead of through a browser:
 *
 *   - what to call the two teams under the score, and
 *   - whether the next-point countdown is running, from what the game's own
 *     countdown box is currently showing.
 *
 * Everything the standby screen displays is mirrored from elements the game
 * already keeps current; this module only decides how to read them.
 */

/** Longest team/opponent name shown under the score before falling back. */
export const LABEL_MAX = 16;

/**
 * The labels under the score.
 *
 * Same priority as the game header's identity slots, minus the icon (an image
 * is lit pixels, which is what standby exists to avoid): a team symbol if the
 * team has one, else a short name, else "Us"; the opponent's name if short,
 * else "Them". The cap is longer than the header's six characters because the
 * labels have the whole width of the screen to themselves.
 *
 * @param {object} [ctx]
 * @param {{teamSymbol?: string, name?: string}|null} [ctx.team]
 * @param {string|null} [ctx.opponent]
 * @param {number} [ctx.maxLen]
 * @returns {{us: string, them: string}}
 */
export function standbyLabels(ctx) {
    const team = (ctx && ctx.team) || null;
    const opponent = clean(ctx && ctx.opponent);
    const maxLen = (ctx && Number.isFinite(ctx.maxLen) && ctx.maxLen > 0) ? ctx.maxLen : LABEL_MAX;

    const symbol = clean(team && team.teamSymbol);
    const name = clean(team && team.name);

    const us = symbol
        || (name && name.length <= maxLen ? name : '')
        || 'Us';
    const them = (opponent && opponent.length <= maxLen) ? opponent : 'Them';

    return { us, them };
}

/**
 * Whether the between-points countdown is running, and what it reads.
 *
 * game/pointManagement.js shows its countdown box by setting an inline
 * `display` when a point ends and hides it (`none`) when the next one starts;
 * the box exists at all times, so the inline style is the only signal. The
 * text is passed through untouched (it is already `MM:SS`), and the box's
 * red final-seconds state is surfaced as `urgent` so standby can brighten the
 * number for the last few seconds without owning a threshold of its own.
 *
 * @param {object} [ctx]
 * @param {string} [ctx.display] - the countdown box's inline display value
 * @param {string} [ctx.text]    - the countdown box's current text
 * @param {boolean} [ctx.danger] - the box carries its danger class
 * @returns {{running: boolean, text: string, urgent: boolean}}
 */
export function countdownState(ctx) {
    const display = clean(ctx && ctx.display);
    const running = !!display && display !== 'none';
    const text = running ? clean(ctx && ctx.text) : '';
    return {
        running,
        text,
        urgent: running && !!(ctx && ctx.danger)
    };
}

function clean(v) {
    return (v === null || v === undefined) ? '' : String(v).trim();
}
