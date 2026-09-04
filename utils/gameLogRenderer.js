/*
 * Game Log Renderer — THE single source of truth for the linear game log.
 *
 * Renders a game's points→possessions→events stream as a list of structured
 * ENTRIES (buildGameLogEntries), from which the shared "game log" line format
 * (buildGameLogText) and the classed HTML lines (renderGameLogHTML /
 * renderGameLogEntriesHTML) both derive. Consumed by:
 *   - game/gameLogic.js summarizeGame()            (Copy Summary clipboard text)
 *   - game/gameScreenSync.js updateGameLogEvents() (in-game Log tab HTML)
 *   - teams/gameSummary.js renderGameSummaryEventLog() (post-game summary HTML)
 *   - playByPlay/replayEngine.js                   (replay timeline — the entry
 *     list IS the replay's scrub axis; see docs/replay-viewer-plan.md)
 *
 * History: these were three drifting near-copies (the 2026-07-05 betweenPoints
 * ordering fix had to be written twice; the Turnover possession-boundary logic
 * only ever landed in summarizeGame). Merged 2026-07-19 (G6). Entries added
 * 2026-09 (replay step 2) — the TEXT output is byte-identical to before; the
 * golden test pins it. Any format change now lands here, once.
 *
 * The public viewer (ultistats_server/static/viewer/viewer.js) renders per-point
 * cards from the same event stream but is a separate origin/app that cannot
 * import PWA modules — it stays bespoke; see the keep-in-sync note there.
 *
 * This module is a pure leaf (no imports, no DOM) so node:test can exercise it
 * directly: tests/unit/gameLogRenderer.test.mjs.
 */

/**
 * @typedef {object} GameLogEntry
 * @property {string} kind - 'header' (version / "Game Summary:" lines),
 *   'teamroster' (the "<team> roster:" line — text '' when the caller passed
 *   no rosterNames, which keeps the blank line the clipboard format has
 *   always had there), 'roster' ("Point N roster: …"), 'pullnote'
 *   ("X pulls to Y."), 'possession' (O/D delimiter), 'event' (an event's
 *   summarize() line), 'score' ("X scores!"), 'currentscore',
 *   'after' (an event recorded after the point ended, deferred past the
 *   score lines), 'periodnote' ("will pull … and play D").
 * @property {string} text - the line exactly as buildGameLogText prints it
 * @property {number|null} pointIdx - index into game.points, or null
 * @property {number|null} possIdx - index into point.possessions, or null
 * @property {number|null} eventIdx - index into possession.events, or null
 * @property {object|null} event - the event object for 'event' / 'after'
 * @property {number|null} at - epoch ms when this happened, or null when
 *   the data carries no timing (see ARCHITECTURE.md § Event timestamps —
 *   never synthesized). 'event'/'after' → event.at; 'possession' → the
 *   possession's startedAt (an inline Turnover boundary uses the NEXT
 *   possession's, falling back to the turnover's own at); 'roster' /
 *   'pullnote' → the point's first timed event, else point.startTimestamp
 *   (only ever non-null for the in-progress point — it is nulled on pause
 *   and at point end); 'score' / 'currentscore' → point.endTimestamp.
 * @property {'us'|'opp'|null} side - who the line is about: for 'possession'
 *   whoever holds the disc (offense → 'us'), for 'score' who scored.
 */

const msOf = d => {
    if (d == null) return null;
    if (typeof d === 'number') return Number.isFinite(d) ? d : null;
    if (d instanceof Date) { const t = d.getTime(); return Number.isFinite(t) ? t : null; }
    if (typeof d === 'string') { const t = Date.parse(d); return Number.isFinite(t) ? t : null; }
    return null;
};
const atOf = e => (e && typeof e.at === 'number') ? e.at : null;

/**
 * Build the game log as structured entries (see GameLogEntry). Same options
 * as buildGameLogText; joining the entries' `text` with '\n' reproduces its
 * output exactly.
 *
 * Line stream per point: "Point N roster: …", the pull line, possession
 * delimiters ("— Team on offense —"), each event's summarize() line (Turnover
 * re-emits the defense delimiter inline — see comment below), the score lines,
 * then any events recorded AFTER the point ended (betweenPoints flag), then
 * the period-break "who pulls next" note.
 *
 * @param {object} game - Game (or deserialized game-shaped object)
 * @param {object} [options]
 * @param {string} [options.teamName] - display name for our team
 *   (default game.team — callers pass their surface's existing fallback)
 * @param {string} [options.opponentName] - display name for the opponent
 * @param {string} [options.versionInfo] - preformatted header prefix ending in
 *   '\n' (e.g. "App Version: …\n"), or '' for none. In-game/clipboard surface.
 * @param {string[]|null} [options.rosterNames] - team roster names for a
 *   "<team> roster: …" header line, or null to omit. In-game/clipboard surface.
 * @param {(point: object) => string|null} [options.scoreBadge] - returns a
 *   classification label ("break", "clean hold", …) to append to that point's
 *   "scores!" line as "  [label]", or null for none. Post-game summary surface.
 * @param {(entry: string) => string} [options.resolvePlayerName] - maps a raw
 *   point.players entry to a display name for the "Point N roster:" lines.
 *   The entries are bare strings that are player NAMES in some data eras and
 *   player IDS in others (see utils/helpers.js buildPlayerNameResolver);
 *   callers pass buildPointPlayerLookup-based resolution so id-era rosters
 *   don't print raw ids. Default null = print entries as stored (keeps this
 *   module a pure leaf with no resolver dependency).
 * @returns {GameLogEntry[]}
 */
function buildGameLogEntries(game, {
    teamName = game ? game.team : undefined,
    opponentName = game ? game.opponent : undefined,
    versionInfo = '',
    rosterNames = null,
    scoreBadge = null,
    resolvePlayerName = null,
} = {}) {
    const entries = [];
    const push = (kind, text, extra) => {
        entries.push(Object.assign({
            kind, text, pointIdx: null, possIdx: null, eventIdx: null, event: null, at: null, side: null,
        }, extra));
        return entries[entries.length - 1];
    };

    // versionInfo is a '\n'-terminated prefix (possibly several lines); each
    // line is its own header entry so the join reproduces the prefix.
    if (versionInfo) {
        versionInfo.split('\n').forEach((line, i, arr) => {
            if (i === arr.length - 1 && line === '') return;   // the terminator
            push('header', line);
        });
    }
    push('header', `Game Summary: ${teamName} vs. ${opponentName}.`);
    push('teamroster', rosterNames ? `${teamName} roster:` + rosterNames.map(n => ` ${n}`).join('') : '');

    let runningScoreUs = 0;
    let runningScoreThem = 0;
    // How the current period opened — flips at each period break (halftime /
    // switch sides), driving the "who pulls next" note below. Mirrors
    // determineStartingPosition().
    let periodOpening = game ? game.startingPosition : undefined;
    ((game && game.points) || []).forEach((point, pointIdx) => {
        let switchsides = false;
        let forceswap = false;
        const allPossessions = point.possessions || [];

        // Point-start time: the first timed event, else the (in-progress-only)
        // startTimestamp. Never synthesized.
        let pointAt = null;
        for (const poss of allPossessions) {
            for (const e of (poss.events || [])) {
                if (atOf(e) !== null) { pointAt = atOf(e); break; }
            }
            if (pointAt !== null) break;
        }
        if (pointAt === null) pointAt = msOf(point.startTimestamp);
        const pointEndAt = msOf(point.endTimestamp);

        const rosterText = `Point ${pointIdx + 1} roster:` + (point.players || [])
            .map(player => ` ${resolvePlayerName ? resolvePlayerName(player) : player}`).join('');
        push('roster', rosterText, { pointIdx, at: pointAt });
        // indicate which team pulls and which receives (thus starting on offense)
        const pullText = point.startingPosition === 'offense'
            ? `${opponentName} pulls to ${teamName}.`
            : `${teamName} pulls to ${opponentName}.`;
        push('pullnote', pullText, { pointIdx, at: pointAt });

        // O/D delimiter is emitted per logical possession boundary, not per
        // Possession object — a Turnover event lives inside the offensive
        // Possession that just ended (since ensurePossessionExists(true) is
        // called for it everywhere), so without an inline emission a
        // possession turned over by Turnover-only events (no following
        // Defense event yet) wouldn't show the boundary at all. Inline
        // emission after each Turnover, paired with suppression of the
        // very next possession's delimiter, gives a correct boundary
        // either way (Turnover-then-Defense or Turnover-only-so-far).
        let suppressNextPossessionDelimiter = false;
        // Events recorded AFTER the point ended (between-points timeouts,
        // switch sides) are deferred past the score lines below so the log
        // reads in real-world order.
        const afterPointEntries = [];
        // Set tag (zone tracking): "— Team on defense (Zone) —".
        const setTagFor = poss => (poss && poss.set) ? ` (${poss.set})` : '';
        const startedAtOf = poss => poss ? msOf(poss.startedAt) : null;
        allPossessions.forEach((possession, possIdx) => {
            if (!suppressNextPossessionDelimiter) {
                const role = possession.offensive ? 'offense' : 'defense';
                push('possession', `— ${teamName} on ${role}${setTagFor(possession)} —`, {
                    pointIdx, possIdx, at: startedAtOf(possession),
                    side: possession.offensive ? 'us' : 'opp',
                });
            }
            suppressNextPossessionDelimiter = false;
            (possession.events || []).forEach((event, eventIdx) => {
                // Halftime implies the side switch; two breaks on the same
                // point cancel (accidental tap + correction), so toggle.
                if (event.type === 'Other' && (event.switchsides_flag || event.halftime_flag)) {
                    switchsides = !switchsides;
                }
                if (event.type === 'Other' && event.forceswap_flag) {
                    forceswap = !forceswap;
                }
                if (event.type === 'Other' && event.betweenPoints) {
                    if (typeof event.summarize === 'function') {
                        afterPointEntries.push({
                            kind: 'after', text: event.summarize(),
                            pointIdx, possIdx, eventIdx, event, at: atOf(event), side: null,
                        });
                    }
                    return;
                }
                if (typeof event.summarize === 'function') {
                    push('event', event.summarize(), { pointIdx, possIdx, eventIdx, event, at: atOf(event) });
                }
                if (event.type === 'Turnover') {
                    // Possession just ended — emit the boundary so the log
                    // shows it even when no Defense event has yet been
                    // recorded (e.g. inferred Turnover from the pill,
                    // or a Turnover before the user logs any D events).
                    //
                    // This delimiter STANDS IN for the next possession's own
                    // (suppressed just below), so it has to carry that
                    // possession's set tag — a defensive set tagged after a
                    // turnover lives there, not on the possession holding
                    // this Turnover. Reading it off `possession` instead is
                    // what made mid-point defensive sets invisible in the log
                    // while offensive ones showed fine.
                    const next = allPossessions[possIdx + 1];
                    const nextAt = startedAtOf(next);
                    push('possession', `— ${teamName} on defense${setTagFor(next)} —`, {
                        pointIdx, possIdx: next ? possIdx + 1 : null,
                        at: nextAt !== null ? nextAt : atOf(event),
                        side: 'opp',
                    });
                    suppressNextPossessionDelimiter = true;
                }
            });
        });
        // if most recent event is a score, indicate which team scored
        const badgeLabel = scoreBadge ? scoreBadge(point) : null;
        const badgeSuffix = badgeLabel ? `  [${badgeLabel}]` : '';
        if (point.winner === 'team') {
            push('score', `${teamName} scores!${badgeSuffix} `, { pointIdx, at: pointEndAt, side: 'us' });
            runningScoreUs++;
        }
        if (point.winner === 'opponent') {
            push('score', `${opponentName} scores!${badgeSuffix} `, { pointIdx, at: pointEndAt, side: 'opp' });
            runningScoreThem++;
        }
        if (point.winner) {
            push('currentscore', `Current score: ${teamName} ${runningScoreUs}, ${opponentName} ${runningScoreThem}`,
                { pointIdx, at: pointEndAt });
        }
        afterPointEntries.forEach(e => entries.push(e));
        // Manual Swap O & D corrections flip the period bookkeeping too
        // (matches determineStartingPosition), so the note below and any
        // later halftime read from the corrected orientation.
        if (forceswap) {
            periodOpening = (periodOpening === 'offense') ? 'defense' : 'offense';
        }
        if (switchsides) {
            // Period break: the next point opens with the period-opening
            // roles swapped — the team that pulled to open the previous
            // period receives — regardless of who won this point.
            periodOpening = (periodOpening === 'offense') ? 'defense' : 'offense';
            if (periodOpening === 'offense') {
                push('periodnote', `${teamName} will receive the pull and play O. `, { pointIdx });
            } else {
                push('periodnote', `${teamName} will pull to ${opponentName} and play D. `, { pointIdx });
            }
        }
    });
    return entries;
}

/**
 * Build the game log as plain text (one line per `\n`). Thin wrapper over
 * buildGameLogEntries — see it for the options.
 * @returns {string}
 */
function buildGameLogText(game, options = {}) {
    return buildGameLogEntries(game, options).map(e => e.text).join('\n');
}

/**
 * Map one game-log text line to its CSS classes.
 * @param {string} line - a single (non-empty) line from buildGameLogText
 * @param {string} teamName - our team's display name (us/them score detection)
 * @returns {string} space-separated class list, always starting 'game-log-line'
 */
function classifyGameLogLine(line, teamName) {
    let lineClass = 'game-log-line';

    if (line.includes(' scores!')) {
        lineClass += ' game-log-score-event';
        if (line.includes(teamName)) {
            lineClass += ' game-log-us-scores';
        } else {
            lineClass += ' game-log-them-scores';
        }
    } else if (line.startsWith('Point ') && line.includes('roster:')) {
        lineClass += ' game-log-point-header';
    } else if (line.includes('Current score:')) {
        lineClass += ' game-log-current-score';
    } else if (line.includes('pulls to')) {
        lineClass += ' game-log-pull';
    } else if (line.startsWith('— ') && / on (offense|defense)( \([^)]+\))? —$/.test(line)) {
        // Possession delimiter line, e.g. "— Breakside on offense —" or,
        // with a set tag, "— Breakside on defense (Zone) —"
        lineClass += ' game-log-possession-header';
        if (/ on offense( \([^)]+\))? —$/.test(line)) {
            lineClass += ' game-log-possession-offense';
        } else {
            lineClass += ' game-log-possession-defense';
        }
    } else if (line.startsWith('App Version:') || line.startsWith('Game Summary:')) {
        lineClass += ' game-log-header';
    } else if (line.includes('roster:')) {
        lineClass += ' game-log-roster';
    }

    return lineClass;
}

/**
 * Render game-log text to HTML: one classed, escaped <div> per non-blank line.
 * Styling lives in ui/panelSystem.css (.game-log-*).
 * @param {string} summaryText - output of buildGameLogText
 * @param {string} teamName - our team's display name (us/them score detection)
 * @returns {string} HTML string
 */
function renderGameLogHTML(summaryText, teamName) {
    const lines = summaryText.split('\n');
    let html = '';
    for (const line of lines) {
        if (!line.trim()) continue;
        html += `<div class="${classifyGameLogLine(line, teamName)}">${escapeHtml(line)}</div>`;
    }
    return html;
}

/**
 * Render entries to HTML: the same classed, escaped <div>s as
 * renderGameLogHTML, each carrying `data-entry="<index into entries>"` so a
 * line can be mapped back to its entry (the replay viewer's seek-by-tap).
 * Blank-text entries (the teamroster placeholder) are skipped, exactly as
 * the text renderer skips blank lines.
 * @param {GameLogEntry[]} entries - output of buildGameLogEntries
 * @param {string} teamName - our team's display name (us/them score detection)
 * @returns {string} HTML string
 */
function renderGameLogEntriesHTML(entries, teamName) {
    let html = '';
    entries.forEach((entry, i) => {
        if (!entry.text || !entry.text.trim()) return;
        html += `<div class="${classifyGameLogLine(entry.text, teamName)}" data-entry="${i}">${escapeHtml(entry.text)}</div>`;
    });
    return html;
}

/**
 * Escape HTML entities to prevent XSS. String-based (no DOM) so this module
 * stays node-testable; escapes the same entities the old DOM-based
 * div.textContent/innerHTML round-trip did for element-content contexts.
 * @param {string} text - Text to escape
 * @returns {string}
 */
function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// --- ES-module exports ---
export {
    buildGameLogEntries, buildGameLogText, classifyGameLogLine,
    renderGameLogHTML, renderGameLogEntriesHTML, escapeHtml,
};
