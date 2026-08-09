/*
 * Per-possession set tagging — the shared bits the Full and Field play-by-play
 * surfaces both need, kept in one pure leaf so the two can't drift.
 *
 * A possession's `set` is a plain string snapshotted at tag time, NOT a
 * reference into the team's configured lists. Editing Team Settings → Set
 * Tracking changes only what's offered next; it never renames or removes a tag
 * already recorded on a possession. See ARCHITECTURE.md § Possession Sets.
 */

/**
 * The set labels for one side of the disc.
 *
 * The primary controls key off the LIVE MODE rather than off a possession,
 * because the two diverge at a change of possession: win the disc on a block
 * and the mode is already offense while the last possession is still the
 * defensive one (possessions are created on the first recorded event). Offering
 * labels from the stale possession there hands a coach naming their O set a
 * list of defensive sets.
 *
 * @param {boolean} wantOffensive
 * @returns {Array<string>} [] when the team hasn't opted in, or hasn't
 *   configured that side (in which case no control should render at all)
 */
function setLabelsForSide(team, wantOffensive) {
    if (!team || !team.setsEnabled) return [];
    const labels = wantOffensive ? team.sets?.offensive : team.sets?.defensive;
    return Array.isArray(labels) ? labels : [];
}

/**
 * The set labels that apply to an existing possession — its own side's list.
 * Use this for controls bound to a specific possession (e.g. the modifier-row
 * chip); use setLabelsForSide for ones bound to the live mode.
 */
function setLabelsFor(team, possession) {
    if (!possession) return [];
    // Mirrors the app-wide convention: defensive iff `offensive === false`.
    return setLabelsForSide(team, possession.offensive !== false);
}

/**
 * Next value in the tap cycle: — → label1 → … → labelN → —.
 *
 * A tag whose label has since been deleted from the team's list isn't in the
 * cycle at all, so it sits one step "before" it: the first tap clears it to
 * unspecified, the next reaches label1. Clearing it explicitly is the point —
 * nothing else rewrites recorded possessions, so tapping is the only way to
 * resolve an orphaned tag, and it should be visible when you do.
 */
function nextSetValue(current, labels) {
    const cycle = [null, ...labels];
    const idx = cycle.indexOf(current);
    return cycle[(idx === -1 ? 0 : idx + 1) % cycle.length];
}

/** Caption for the set control: "Set: —" or "Set: Zone". */
function setControlLabel(possession) {
    return `Set: ${(possession && possession.set) || '—'}`;
}

/**
 * The last possession of a point, or null.
 *
 * Possessions are created lazily on the first recorded event (see
 * ensurePossessionExists), so this is null at the very start of a point, and
 * right after a change of possession it is still the PREVIOUS side's — which
 * is why the primary controls read their labels from the live mode
 * (setLabelsForSide) and use this only to decide whether a possession for that
 * side already exists. When it doesn't, they materialize one on write through
 * ensurePossessionExists rather than dropping the pick; in practice the first
 * throw or turnover lands in that same possession moments later.
 */
function taggablePossession(point) {
    const possessions = (point && point.possessions) || [];
    return possessions.length ? possessions[possessions.length - 1] : null;
}

export { setLabelsFor, setLabelsForSide, nextSetValue, setControlLabel, taggablePossession };
