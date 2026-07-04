/*
 * pendingNextLine state machine — the pure logic (F3 cleanup extraction).
 *
 * game.pendingNextLine carries the between-points line-planning state that
 * two coaches edit concurrently across devices:
 *   - odLine / oLine / dLine / odOnDeckLine (+ *ModifiedAt timestamps)
 *   - lineupReadyAt/By (LC → AC fire-and-forget ping)
 *   - lineCoachViewing/At (LC's current view, AC renders it)
 *   - useSeparateLines/At (combined vs separate planning mode)
 *
 * The three moving parts extracted here (previously spread across
 * store/sync.js, game/selectLine.js, and game/gameScreenEvents.js):
 *   - mergePendingNextLine: newer-wins field-group merge for cloud refresh
 *   - resolveEffectiveLine: which line the next point will actually use
 *   - resetPendingLinesAtPointEnd: pre-fill lines from the just-played 7
 *
 * Everything here is pure with respect to the outside world (mutating only
 * the passed game/pending objects, no UI/globals/imports) so it can be
 * unit-tested — tests/unit/pendingLineLogic.test.mjs pins the behavior.
 */

/**
 * Normalize a timestamp to epoch milliseconds for comparison. Accepts epoch-ms
 * numbers (e.g. lineupReadyAt, documented as epoch ms), ISO-8601 strings, or
 * Date objects; returns 0 for null/undefined/unparseable values so a missing
 * timestamp always loses the "newer wins" comparison. Using this everywhere
 * keeps the pendingNextLine merge from mixing raw `>` (epoch ms) with
 * `new Date(...).getTime()` (ISO) and silently mis-ordering if a writer drifts.
 */
function toMs(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? 0 : t;
}

/**
 * Merge server pendingNextLine into local, newer-wins per field group on
 * that group's own timestamp. Shared by refreshPendingLineFromCloud and
 * refreshGameStateFromCloud so the two polling paths can't diverge on which
 * fields they merge.
 *
 * Field groups:
 * - Each line type (oLine/dLine/odLine/odOnDeckLine) on its *ModifiedAt.
 * - "Lineup Ready" multi-coach signal: the Line Coach is the sole writer;
 *   Active Coach reads. Fire-and-forget — the AC's polling shows a toast on
 *   advance; no persistent latch.
 * - LC-viewing signal (only the LC writes this) — the AC reads it to render
 *   the "Line Coach: viewing the X line" sub-header.
 * - Combined/Separate planning mode (either coach may flip it).
 *
 * Note: activeType is intentionally NOT synced — it's local UI state; each
 * user independently chooses which line type to view/edit.
 *
 * Mutates and returns localPending.
 */
function mergePendingNextLine(serverPending, localPending) {
    // Check each line type and use whichever is newer
    ['oLine', 'dLine', 'odLine', 'odOnDeckLine'].forEach(lineKey => {
        const modKey = lineKey.replace('Line', 'LineModifiedAt');
        if (toMs(serverPending[modKey]) > toMs(localPending[modKey])) {
            // Server has newer data for this line type
            localPending[lineKey] = serverPending[lineKey] || [];
            localPending[modKey] = serverPending[modKey];
        }
    });

    if (toMs(serverPending.lineupReadyAt) > toMs(localPending.lineupReadyAt)) {
        localPending.lineupReadyAt = serverPending.lineupReadyAt;
        localPending.lineupReadyBy = serverPending.lineupReadyBy || null;
    }

    if (toMs(serverPending.lineCoachViewingAt) > toMs(localPending.lineCoachViewingAt)) {
        localPending.lineCoachViewing = serverPending.lineCoachViewing || null;
        localPending.lineCoachViewingAt = serverPending.lineCoachViewingAt;
    }

    if (toMs(serverPending.useSeparateLinesAt) > toMs(localPending.useSeparateLinesAt)) {
        localPending.useSeparateLines = !!serverPending.useSeparateLines;
        localPending.useSeparateLinesAt = serverPending.useSeparateLinesAt;
    }

    return localPending;
}

/**
 * Determine which pending line the next point will actually use.
 *
 * The side (O vs D) is fixed by who scored — `isOffense` is passed in
 * (game/selectLine.js derives it from determineStartingPosition()); this
 * function only decides which *stored line* to use on that side.
 * (Downstream, applyStartPointButtonState reads source 'o'→offense /
 * 'd'→defense, so a side-flipped source would mislabel the button and
 * field the wrong unit.)
 *
 * Priority order:
 *
 *   1. LC view preference. If `lineCoachViewing` is set and its
 *      timestamp is newer than every relevant *ModifiedAt, honor the
 *      LC's current view — but only as combined-OD vs side-specific:
 *      'od' → odLine; anything else → the determined side's line. The
 *      LC's view never flips the side.
 *
 *   2. Per-axis most-recent edit. For an upcoming O point compare oLine
 *      vs odLine timestamps; for a D point, dLine vs odLine. Newer
 *      non-empty side wins.
 *
 *   3. Same-side fallback. If the winner was empty, fall through to the
 *      other same-side option (this-side typed ↔ odLine) — never the
 *      opposite side.
 *
 *   4. lastPoint safety net. If all same-side options are still empty
 *      (cross-device sync lag, edge case), surface the just-played
 *      lineup so the AC's Start Point button stays actionable.
 *
 * Returns `{ source, line }` where `source` is `'o' | 'd' | 'od'`.
 */
function resolveEffectiveLine(game, isOffense) {
    if (!game || !game.pendingNextLine) return { source: 'od', line: [] };

    const typeKey = isOffense ? 'o' : 'd';

    const p = game.pendingNextLine;
    const typedLine = p[typeKey + 'Line'] || [];
    const odLine    = p.odLine            || [];
    const typedTime = toMs(p[typeKey + 'LineModifiedAt']);
    const odTime    = toMs(p.odLineModifiedAt);

    // ── Priority 1: LC view preference ────────────────────────────────
    // The LC's current view (synced via lineCoachViewing) is a soft
    // tiebreaker. If it's newer than every relevant *ModifiedAt, treat
    // it as "this is what they're planning around" — 'od' means combined
    // OD line, anything else means use the determined side's line. The
    // side itself is fixed by who scored; the view never flips it.
    // 'odOnDeck' is NOT a Next-line view — it's the point-after-next. Treat it
    // as "no Next-line view preference" here, else Priority 1 would resolve an
    // On Deck view into a Next bucket (it falls through to typeKey).
    const lcView   = (p.lineCoachViewing === 'odOnDeck') ? null : p.lineCoachViewing;
    const lcViewAt = toMs(p.lineCoachViewingAt);
    if (lcView && lcViewAt > typedTime && lcViewAt > odTime) {
        const viewSource = (lcView === 'od') ? 'od' : typeKey;
        const viewLine = p[viewSource + 'Line'] || [];
        if (viewLine.length > 0) {
            return { source: viewSource, line: viewLine };
        }
        // View points at an empty line — fall through.
    }

    // ── Priority 2: per-axis most-recent edit ─────────────────────────
    // For an upcoming O point compare oLine vs odLine timestamps; for D
    // compare dLine vs odLine. Newer non-empty side wins. Per-axis (not
    // global) so that prepping a D line for the next defense point
    // doesn't surface an empty O line if the team scores instead.
    const typedNewer = typedTime > odTime;
    if (typedNewer && typedLine.length > 0) {
        return { source: typeKey, line: typedLine };
    }
    if (!typedNewer && odLine.length > 0) {
        return { source: 'od', line: odLine };
    }

    // ── Priority 3: empty-axis fallback ───────────────────────────────
    // The most-recent-edit winner was empty. Surface the OTHER same-side
    // option (this-side typed ↔ odLine) rather than a blank lineup — but
    // NEVER the opposite side's line. Falling back to the opposite side
    // would flip O↔D, contradicting who scored (this was the bug behind
    // "Start Point (O-line)" showing up right after we scored).
    if (typedLine.length > 0) {
        return { source: typeKey, line: typedLine };
    }
    if (odLine.length > 0) {
        return { source: 'od', line: odLine };
    }

    // ── Priority 4: last-point safety net ─────────────────────────────
    // Both same-side options are empty. transitionToBetweenPoints normally
    // pre-fills these from the just-played lineup, but defend against
    // cross-device sync lag (the AC may see this function run before the
    // LC's edits or the reset has reached this client). Surfacing the
    // most recent lineup keeps the Start Point button actionable — better
    // than a permanently greyed button stuck with no players. Tagged as
    // the determined side so the label matches reality.
    const lastPoint = game.points && game.points[game.points.length - 1];
    const lastPlayers = (lastPoint && lastPoint.players) || [];
    if (lastPlayers.length > 0) {
        return { source: typeKey, line: [...lastPlayers] };
    }
    return { source: typeKey, line: [] };
}

/**
 * At point end, default the pending line selections to the 7 who finished
 * the point (reflects any mid-point subs) — but only when the coach hasn't
 * made a fresher explicit choice:
 *
 * - O/D (combined) line: overwrite only if NOT modified during the
 *   just-finished point's window, i.e. its ModifiedAt predates the point
 *   start. We can't use lastPoint.startTimestamp for "point start" — the
 *   score handlers null it to stop the timer and updateScore re-sets it to
 *   score-time — so the *previous* point's endTimestamp (never mutated) is
 *   used instead; for the first point, gameStartTimestamp. ALSO overwrite
 *   if the line is currently empty: an emptied line shouldn't poison every
 *   subsequent point with an unstartable lineup.
 *
 * - O and D (separate) lines: overwrite only if NEVER modified this game
 *   (ModifiedAt predates gameStartTimestamp) OR currently empty (same
 *   empty-line reasoning; without it, an emptied O/D line stays empty
 *   across points and leaves the AC's Start Point button greyed forever).
 *
 * Mutates game.pendingNextLine in place. No-op when the game has no points,
 * the last point has no players, or there's no pendingNextLine.
 */
function resetPendingLinesAtPointEnd(game) {
    const lastPoint = game.points && game.points.length > 0
        ? game.points[game.points.length - 1] : null;
    if (!lastPoint || !lastPoint.players || lastPoint.players.length === 0
        || !game.pendingNextLine) {
        return;
    }

    const previousPoint = game.points.length > 1
        ? game.points[game.points.length - 2]
        : null;
    const pointStartTime = previousPoint && previousPoint.endTimestamp
        ? toMs(previousPoint.endTimestamp)
        : toMs(game.gameStartTimestamp);
    const endingLine = [...lastPoint.players];

    const odLineCur = game.pendingNextLine.odLine || [];
    const odModTime = toMs(game.pendingNextLine.odLineModifiedAt);
    if (odModTime <= pointStartTime || odLineCur.length === 0) {
        game.pendingNextLine.odLine = endingLine;
    }

    const gameStartTime = toMs(game.gameStartTimestamp);
    ['o', 'd'].forEach(type => {
        const lineKey = type + 'Line';
        const modKey = lineKey + 'ModifiedAt';
        const lineCur = game.pendingNextLine[lineKey] || [];
        const modTime = toMs(game.pendingNextLine[modKey]);
        if (modTime <= gameStartTime || lineCur.length === 0) {
            game.pendingNextLine[lineKey] = endingLine;
        }
    });
}

export { toMs, mergePendingNextLine, resolveEffectiveLine, resetPendingLinesAtPointEnd };
