/*
 * Game Log Renderer — THE single source of truth for the linear game log.
 *
 * Renders a game's points→possessions→events stream as the shared "game log"
 * line format (text) and as classed HTML lines. Consumed by:
 *   - game/gameLogic.js summarizeGame()            (Copy Summary clipboard text,
 *     and the in-game Log tab via gameScreenSync.updateGameLogEvents)
 *   - game/gameScreenSync.js updateGameLogEvents() (in-game Game Log panel HTML)
 *   - teams/gameSummary.js renderGameSummaryEventLog() (post-game summary HTML)
 *
 * History: these were three drifting near-copies (the 2026-07-05 betweenPoints
 * ordering fix had to be written twice; the Turnover possession-boundary logic
 * only ever landed in summarizeGame). Merged 2026-07-19 (G6). Any format change
 * now lands here, once.
 *
 * The public viewer (ultistats_server/static/viewer/viewer.js) renders per-point
 * cards from the same event stream but is a separate origin/app that cannot
 * import PWA modules — it stays bespoke; see the keep-in-sync note there.
 *
 * This module is a pure leaf (no imports, no DOM) so node:test can exercise it
 * directly: tests/unit/gameLogRenderer.test.mjs.
 */

/**
 * Build the game log as plain text (one line per `\n`).
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
 * @returns {string}
 */
function buildGameLogText(game, {
    teamName = game ? game.team : undefined,
    opponentName = game ? game.opponent : undefined,
    versionInfo = '',
    rosterNames = null,
    scoreBadge = null,
    resolvePlayerName = null,
} = {}) {
    let summary = versionInfo + `Game Summary: ${teamName} vs. ${opponentName}.\n`;
    if (rosterNames) {
        summary += `${teamName} roster:`;
        rosterNames.forEach(name => summary += ` ${name}`);
    }
    let numPoints = 0;
    let runningScoreUs = 0;
    let runningScoreThem = 0;
    // How the current period opened — flips at each period break (halftime /
    // switch sides), driving the "who pulls next" note below. Mirrors
    // determineStartingPosition().
    let periodOpening = game ? game.startingPosition : undefined;
    ((game && game.points) || []).forEach(point => {
        let switchsides = false;
        let forceswap = false;
        numPoints += 1;
        summary += `\nPoint ${numPoints} roster:`;
        (point.players || []).forEach(player =>
            summary += ` ${resolvePlayerName ? resolvePlayerName(player) : player}`);
        // indicate which team pulls and which receives (thus starting on offense)
        if (point.startingPosition === 'offense') {
            summary += `\n${opponentName} pulls to ${teamName}.`;
        } else {
            summary += `\n${teamName} pulls to ${opponentName}.`;
        }
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
        const afterPointLines = [];
        (point.possessions || []).forEach(possession => {
            if (!suppressNextPossessionDelimiter) {
                const role = possession.offensive ? 'offense' : 'defense';
                summary += `\n— ${teamName} on ${role} —`;
            }
            suppressNextPossessionDelimiter = false;
            (possession.events || []).forEach(event => {
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
                        afterPointLines.push(event.summarize());
                    }
                    return;
                }
                if (typeof event.summarize === 'function') {
                    summary += `\n${event.summarize()}`;
                }
                if (event.type === 'Turnover') {
                    // Possession just ended — emit the boundary so the log
                    // shows it even when no Defense event has yet been
                    // recorded (e.g. inferred Turnover from the pill,
                    // or a Turnover before the user logs any D events).
                    summary += `\n— ${teamName} on defense —`;
                    suppressNextPossessionDelimiter = true;
                }
            });
        });
        // if most recent event is a score, indicate which team scored
        const badgeLabel = scoreBadge ? scoreBadge(point) : null;
        const badgeSuffix = badgeLabel ? `  [${badgeLabel}]` : '';
        if (point.winner === 'team') {
            summary += `\n${teamName} scores!${badgeSuffix} `;
            runningScoreUs++;
        }
        if (point.winner === 'opponent') {
            summary += `\n${opponentName} scores!${badgeSuffix} `;
            runningScoreThem++;
        }
        if (point.winner) {
            summary += `\nCurrent score: ${teamName} ${runningScoreUs}, ${opponentName} ${runningScoreThem}`;
        }
        afterPointLines.forEach(line => summary += `\n${line}`);
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
                summary += `\n${teamName} will receive the pull and play O. `;
            } else {
                summary += `\n${teamName} will pull to ${opponentName} and play D. `;
            }
        }
    });
    return summary;
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
    } else if (line.startsWith('— ') && / on (offense|defense) —$/.test(line)) {
        // Possession delimiter line, e.g. "— Breakside on offense —"
        lineClass += ' game-log-possession-header';
        if (line.endsWith('on offense —')) {
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
export { buildGameLogText, classifyGameLogLine, renderGameLogHTML, escapeHtml };
