/*
 * A uniformly random ordering (Fisher–Yates). The one shuffle behind every
 * "ties are random" pick in the app: the Line tab's Auto (game/selectLine.js
 * computeAutoLine) and the scrimmage dealer (store/scrimmage.js
 * autoFillSquads) each shuffle their candidates once and then let the first
 * of any tie win, which makes the tie random without touching the
 * comparators. `random` is injectable so tests can pin a deal.
 */

/**
 * @template T
 * @param {Iterable<T>|null|undefined} list
 * @param {() => number} [random] - a source in [0, 1); Math.random by default
 * @returns {T[]} a new array, `list` in random order
 */
export function shuffled(list, random = Math.random) {
    const out = list ? [...list] : [];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
