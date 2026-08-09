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
 * The set labels that apply to a possession — the team's offensive list for an
 * offensive possession, the defensive list for a defensive one.
 * @returns {Array<string>} [] when the team hasn't opted in, or hasn't
 *   configured that side (in which case no control should render at all)
 */
function setLabelsFor(team, possession) {
    if (!team || !team.setsEnabled || !possession) return [];
    // Mirrors the app-wide convention: defensive iff `offensive === false`.
    const labels = possession.offensive === false
        ? team.sets?.defensive
        : team.sets?.offensive;
    return Array.isArray(labels) ? labels : [];
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
 * The possession a set control should tag: the live (last) one, or null.
 *
 * Possessions are created lazily on the first recorded event (see
 * ensurePossessionExists), so this is null at the very start of an O point and
 * the control renders nothing until the first throw. On a D point the pull
 * itself creates the possession, so the control is available immediately after
 * it. A set tap deliberately does NOT materialize a possession — empty
 * possessions carry their own undo/cleanup edge cases.
 */
function taggablePossession(point) {
    const possessions = (point && point.possessions) || [];
    return possessions.length ? possessions[possessions.length - 1] : null;
}

export { setLabelsFor, nextSetValue, setControlLabel, taggablePossession };
