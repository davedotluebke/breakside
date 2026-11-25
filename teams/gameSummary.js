/*
 * Game Summary / Review (from team list)
 * Shows a completed game's player stats table (sortable) and full event log.
 * Reuses the gameSummaryScreen section, adapting it for review from team list.
 *
 * The stats table is the same one the Event Roster + Stats screen renders:
 * both build their columns from utils/statsColumns.js and both honour the
 * Basic / Advanced / Full Stats menu, so reviewing one game and reviewing a
 * whole event show the same stats in the same order. At the Fun level the
 * table hides and the shout-outs panel (ui/funStatsView.js) takes its place;
 * a team can hold its viewers and share guests to Fun (utils/statsAudience.js).
 */
import { Gender, Role } from '../store/models.js';
import { currentTeam, isViewer } from '../store/storage.js';
import {
    currentGame, formatPlayerName, buildPointPlayerLookup,
} from '../utils/helpers.js';
import {
    getGamePlayerStats, getGameTeamStats, formatTeamStatsLine, classifyPoint,
    sumPlayerStats,
} from '../utils/eventStats.js';
import { buildGameLogEntries, buildGameLogText, renderGameLogEntriesHTML } from '../utils/gameLogRenderer.js';
import { mountReplayView } from '../playByPlay/replayView.js';
import { mountGameFlow, mountConnections } from '../ui/gameFlowChart.js';
import { initSummarySections } from '../ui/summarySections.js';
import { createTableSortController } from '../utils/tableSort.js';
import { attachStatsColumnHelp } from '../utils/statsHelp.js';
import { StatsLevel } from '../utils/statsLevel.js';
import {
    activeStatsLevel, lockedStatsLevel, wireActiveStatsLevelSelect, getFunOptions,
} from '../utils/statsAudience.js';
import { renderFunStats, clearFunStats } from '../ui/funStatsView.js';
import { screenStatsColumns } from '../utils/statsColumns.js';
import { buildRosterRow } from './rosterRowHelpers.js';
import { buildGameWorkbook } from '../utils/exportWorkbook.js';
import { summaryRosterPlayers } from '../utils/gameRoster.js';
import { openExportDialog } from '../ui/exportDialog.js';
import { showScreen } from '../screens/navigation.js';
import { showShareGameDialog } from '../game/shareGame.js';
import { gameInfoParts } from '../store/gameInfo.js';

// Track where we came from so back button navigates correctly
let gameSummaryOrigin = 'teamRosterScreen'; // default for post-game flow
let gameSummarySortController = null;
let gameSummarySortState = null; // survives a Stats-level re-render, reset per game
let _lastRenderedGame = null; // the game currently shown on the summary screen

/**
 * Show game summary for a completed game loaded from the team list.
 * @param {object} game - Deserialized Game object (already loaded into currentTeam.games)
 */
function showGameSummaryFromList(game) {
    gameSummaryOrigin = 'selectTeamScreen';
    renderGameSummary(game);
}

/**
 * Show game summary after finishing a game (existing post-game flow).
 * (Replaced the old name-keyed updateGameSummaryRosterDisplay, since removed.)
 */
function showGameSummaryPostGame() {
    gameSummaryOrigin = 'teamRosterScreen';
    const game = typeof currentGame === 'function' ? currentGame() : null;
    if (game) renderGameSummary(game);
}

/**
 * Show a game a share-link GUEST is watching (teams/shareGuest.js): the
 * same screen, read-only — no editing, and the account-only controls are
 * hidden by `body.share-guest` (index.html). `live` offers the replay's
 * Live speed for an in-progress game.
 * @param {object} game - hydrated game (store/models.js hydrateGame)
 */
function showGameSummaryForShare(game, { live = false } = {}) {
    gameSummaryOrigin = 'selectTeamScreen';
    renderGameSummary(game, { guest: true, live });
    watchScorePinned();
}

/**
 * Share guest only: the title bar is sticky (css/tables.css), and while the
 * Score block is scrolled out from under it the bar shows the compact score
 * in place of the "Game Summary" title, so a spectator reading the log still
 * sees the score and the Live badge.
 */
let _scorePinObserver = null;
function watchScorePinned() {
    const bar = document.querySelector('#gameSummaryScreen .screen-title-bar');
    const score = document.getElementById('finalScore');
    if (!bar || !score || typeof IntersectionObserver !== 'function') return;
    if (_scorePinObserver) _scorePinObserver.disconnect();
    // The bar covers the top of the viewport, so the score counts as gone
    // once it is under the bar, not only once it leaves the window.
    _scorePinObserver = new IntersectionObserver(entries => {
        const e = entries[entries.length - 1];
        // A hidden screen reports "not intersecting" with an empty rect.
        const laidOut = e.boundingClientRect.height > 0;
        bar.classList.toggle('score-pinned', laidOut && !e.isIntersecting);
    }, { rootMargin: `-${bar.offsetHeight || 0}px 0px 0px 0px` });
    _scorePinObserver.observe(score);
}

/**
 * A share guest's game changed (the poll stamp moved): redraw score, stats
 * and log lines in place and let the mounted replay pick up the new tail,
 * rather than re-mounting it (which would drop the playhead / live-follow).
 */
function refreshGameSummaryForShare(game) {
    if (!game) return;
    _lastRenderedGame = game;
    renderSummaryScore(game);
    renderGameSummaryStatsTable(game);
    renderGameSummaryTeamStats(game);
    renderGameSummaryFlow(game);
    if (summaryReplayView) {
        _summaryLookup = buildPointPlayerLookup(game);
        _entryOptions = buildSummaryEntryOptions(game, _summaryLookup);
        renderSummaryLogLines({ keepScroll: true });
        summaryReplayView.onLogUpdated();
    } else {
        // Nothing mounted yet (no located events so far) — a full render
        // tries again, mounting once the first located play arrives.
        renderGameSummaryEventLog(game, { live: true, editable: false, keepScroll: true });
    }
}

function renderSummaryScore(game) {
    // "Final Score" is a lie while a share guest watches a game in progress.
    const heading = document.querySelector('#finalScore h3');
    if (heading) heading.textContent = (game.gameEndTimestamp || !document.body.classList.contains('share-guest')) ? 'Final Score' : 'Score';
    const teamNameEl = document.getElementById('teamName');
    const oppNameEl = document.getElementById('opponentName');
    const teamScoreEl = document.getElementById('teamFinalScore');
    const oppScoreEl = document.getElementById('opponentFinalScore');
    if (teamNameEl) teamNameEl.textContent = game.team || 'My Team';
    if (oppNameEl) oppNameEl.textContent = game.opponent || 'Opponent';
    if (teamScoreEl) teamScoreEl.textContent = game.scores?.[Role.TEAM] || game.scores?.team || 0;
    if (oppScoreEl) oppScoreEl.textContent = game.scores?.[Role.OPPONENT] || game.scores?.opponent || 0;
    // The compact copy in the title bar (share guest, once scrolled).
    const mirror = (id, src) => { const el = document.getElementById(id); if (el && src) el.textContent = src.textContent; };
    mirror('summaryBarTeam', teamNameEl);
    mirror('summaryBarOpponent', oppNameEl);
    mirror('summaryBarTeamScore', teamScoreEl);
    mirror('summaryBarOpponentScore', oppScoreEl);
    renderSummaryGameInfo(game);
}

/** Game-to, caps, scheduled time and field under the score; hidden when none is set. */
function renderSummaryGameInfo(game) {
    const el = document.getElementById('summaryGameInfo');
    if (!el) return;
    const parts = gameInfoParts(game);
    el.hidden = parts.length === 0;
    el.replaceChildren(...parts.map(part => {
        const span = document.createElement('span');
        span.className = 'summary-game-info-item';
        span.textContent = part.text;
        if (part.small) {
            const small = document.createElement('small');
            small.textContent = part.small;
            span.append(' ', small);
        }
        return span;
    }));
}

/**
 * Render the full game summary: score, stats table, event log.
 * @param {object} game
 * @param {object} [opts]
 * @param {boolean} [opts.guest] - share-link guest: no editing
 * @param {boolean} [opts.live] - offer the replay's Live speed
 */
function renderGameSummary(game, { guest = false, live = false } = {}) {
    if (!game) return;
    _lastRenderedGame = game;

    // Detach previous sort controller; a new game starts unsorted.
    if (gameSummarySortController) {
        gameSummarySortController.detach();
        gameSummarySortController = null;
    }
    gameSummarySortState = null;

    renderSummaryScore(game);

    // Hide/show footer buttons based on origin
    const anotherGameBtn = document.getElementById('anotherGameBtn');
    if (anotherGameBtn) {
        anotherGameBtn.style.display = gameSummaryOrigin === 'selectTeamScreen' ? 'none' : '';
    }

    renderGameSummaryStatsTable(game);
    renderGameSummaryTeamStats(game);
    renderGameSummaryEventLog(game, { live, editable: !guest });
    renderGameSummaryFlow(game);

    // Export (stats workbook, JSON, game log) once a point has been played
    const exportBtn = document.getElementById('exportGameSummaryBtn');
    const hasStats = !!(game.points && game.points.some(p => p.winner));
    if (exportBtn) exportBtn.style.display = hasStats ? '' : 'none';

    // Share button: any game with a server id can be shared (the dialog
    // handles the never-synced case with a friendly nudge).
    const shareBtn = document.getElementById('shareGameSummaryBtn');
    if (shareBtn) {
        shareBtn.style.display = game.id ? '' : 'none';
    }

    showScreen('gameSummaryScreen');
    // The chart could only measure 0 while the screen was hidden; draw it now
    // that the screen has a width, rather than waiting on its ResizeObserver
    // (whose callback needs a rendering opportunity — see ui/gameFlowChart.js).
    if (summaryFlowView) summaryFlowView.redraw();
}

/**
 * Build the sortable player stats table for a single game. Columns follow the
 * Stats menu (Basic / Advanced / Full), same as the event roster table.
 */
function renderGameSummaryStatsTable(game) {
    const tbody = document.getElementById('gameSummaryRosterList');
    if (!tbody) return;

    // Save and detach the sort controller before rebuilding, so re-rendering
    // at a different Stats level keeps the column the coach sorted by.
    if (gameSummarySortController) {
        gameSummarySortState = gameSummarySortController.getSortState();
        gameSummarySortController.detach();
        gameSummarySortController = null;
    }
    tbody.innerHTML = '';

    // Connections names drops and throwaways per pair, so it follows the
    // level too: re-render the flow section along with the table.
    wireActiveStatsLevelSelect(
        document.getElementById('gameSummaryStatsLevel'),
        () => { renderGameSummaryStatsTable(game); renderGameSummaryFlow(game); }
    );

    const playerStats = typeof getGamePlayerStats === 'function'
        ? getGamePlayerStats(game) : {};
    const hasStats = Object.keys(playerStats).length > 0;
    const level = activeStatsLevel();
    const statsColumns = screenStatsColumns(level);

    const players = resolveSummaryPlayers(game, playerStats);

    // Fun: the shout-outs panel instead of the table.
    const funHost = document.getElementById('gameSummaryFunStats');
    const tableContainer = tbody.closest('.roster-table-container');
    if (level === StatsLevel.FUN) {
        if (tableContainer) tableContainer.hidden = true;
        renderFunStats(funHost, players, playerStats);
        return;
    }
    if (tableContainer) tableContainer.hidden = false;
    clearFunStats(funHost);

    // Header row
    const headerRow = document.createElement('tr');
    ['Name', ...statsColumns.map(col => col.label)].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        th.classList.add('roster-header');
        headerRow.appendChild(th);
    });
    tbody.appendChild(headerRow);

    // Player rows
    const rowStats = [];
    players.forEach(player => {
        const ps = playerStats[player.id] || {};
        rowStats.push(ps);
        tbody.appendChild(createGameSummaryPlayerRow(player, ps, statsColumns));
    });

    // Team aggregate row: summed counters run back through the same column
    // definitions, so rate columns recompute from the totals.
    if (hasStats) {
        const totals = sumPlayerStats(rowStats);
        const aggRow = buildRosterRow([
            { value: 'Team', className: ['roster-name-column', 'team-total-cell'] },
            ...statsColumns.map(col => ({ value: col.value(totals), className: 'team-total-cell' }))
        ]);
        aggRow.classList.add('team-aggregate-row');
        tbody.appendChild(aggRow);
    }

    // Attach sort controller
    if (typeof createTableSortController === 'function') {
        // Column indices shift with the stats level, so derive them.
        const columns = [
            { key: 'name', type: 'string', colIndex: 0 },
            ...statsColumns.map((col, i) => ({ key: col.key, type: col.type, colIndex: i + 1 }))
        ];
        gameSummarySortController = createTableSortController({
            getHeaderRow: () => tbody.querySelector('tr:first-child'),
            getDataRows: () => Array.from(tbody.querySelectorAll('tr:not(:first-child):not(.team-aggregate-row)')),
            getAggregateRows: () => Array.from(tbody.querySelectorAll('.team-aggregate-row')),
            getTbody: () => tbody,
            columns
        });
        gameSummarySortController.attach();
        if (gameSummarySortState) {
            gameSummarySortController.sort(gameSummarySortState.key, gameSummarySortState.direction);
        }
    }
    if (typeof attachStatsColumnHelp === 'function') {
        attachStatsColumnHelp(tbody.querySelector('tr:first-child'));
    }
}

/**
 * The roster this game's table and export both list: the snapshot for
 * historical accuracy (the live team roster when the game captured none, so
 * bench players still appear as zeros), plus anyone who has stats in this
 * game but is on neither — a late arrival checked onto the event roster
 * after the game started, a mid-game team add, a Correct Lineup name. The
 * rule is utils/gameRoster.js summaryRosterPlayers; this binds it to the
 * live team, which may not be this game's team (the share viewer).
 * @param {object} game
 * @param {object} playerStats - map of playerId → ps for this game
 * @returns {Array<object>}
 */
function resolveSummaryPlayers(game, playerStats) {
    const roster = (typeof currentTeam !== 'undefined' && currentTeam
        && currentTeam.teamRoster) ? currentTeam.teamRoster : [];
    return summaryRosterPlayers(game, playerStats, roster);
}

/**
 * Create a player row for the game summary stats table.
 * @param {object} player - roster player {id, name, gender?}
 * @param {object} ps - this player's stats (or {} when they didn't play)
 * @param {Array<object>} statsColumns - the columns the active level shows
 */
function createGameSummaryPlayerRow(player, ps, statsColumns) {
    const nameClasses = ['roster-name-column'];
    if (player.gender === Gender.FMP) nameClasses.push('player-fmp');
    else if (player.gender === Gender.MMP) nameClasses.push('player-mmp');

    return buildRosterRow([
        {
            value: typeof formatPlayerName === 'function' ? formatPlayerName(player) : player.name,
            className: nameClasses
        },
        ...statsColumns.map(col => ({ value: col.value(ps) }))
    ]);
}

/**
 * Render the team-level stats line (breaks, clean/dirty holds) below the
 * player stats table. Hidden if the game has no completed points.
 */
function renderGameSummaryTeamStats(game) {
    const el = document.getElementById('gameSummaryTeamStats');
    if (!el) return;
    if (typeof getGameTeamStats !== 'function') {
        el.style.display = 'none';
        return;
    }
    const stats = getGameTeamStats(game);
    if (!stats || stats.total === 0) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    el.textContent = formatTeamStatsLine(stats);
    el.style.display = '';
}

/**
 * Game Flow (ui/gameFlowChart.js): the score-margin chart and headline lines
 * plus the Connections block, between the team stats line and the log. Each
 * mount hides itself when the game has nothing to show yet (fewer than two
 * completed points; no pass with both ends recorded), and the whole section
 * hides when neither drew. Re-mounted on every render, like the stats table.
 */
let summaryFlowView = null;
let summaryConnView = null;
function renderGameSummaryFlow(game) {
    const section = document.getElementById('gameFlowSection');
    const flowHost = document.getElementById('gameFlowChartHost');
    const connHost = document.getElementById('gameConnectionsHost');
    const connHeading = document.getElementById('gameConnectionsHeading');
    if (!section || !flowHost || !connHost) return;
    if (summaryFlowView) { try { summaryFlowView.destroy(); } catch (e) { /* gone */ } summaryFlowView = null; }
    if (summaryConnView) { try { summaryConnView.destroy(); } catch (e) { /* gone */ } summaryConnView = null; }
    const connView = summaryConnView && summaryConnView.view ? summaryConnView.view() : 'list';

    summaryFlowView = mountGameFlow(flowHost, game, {
        teamName: game.team || 'My Team',
        opponentName: game.opponent || 'Opponent',
        // point.players entries may be ids (id-era games) — same lookup the
        // "Point N roster:" log lines use, read at tap time.
        resolvePlayerName: entry => (_summaryLookup ? _summaryLookup(entry).name : entry),
        onPointTap: pointIdx => scrollSummaryLogToPoint(pointIdx),
    });
    summaryConnView = activeStatsLevel() === StatsLevel.FUN
        ? null : mountConnections(connHost, game, { view: connView });
    if (connHeading) connHeading.style.display = summaryConnView ? '' : 'none';
    connHost.style.display = summaryConnView ? '' : 'none';
    section.style.display = (summaryFlowView || summaryConnView) ? '' : 'none';
}

/**
 * "Show in log" from a chart marker: scroll the log to that point's roster
 * line, flash it, and click it so a mounted replay seeks there too
 * (playByPlay/replayView.js listens for clicks on data-entry lines).
 */
function scrollSummaryLogToPoint(pointIdx) {
    const logEl = document.getElementById('gameSummaryEventLog');
    if (!logEl || !_lastRenderedGame || !_entryOptions) return;
    const entries = buildGameLogEntries(_lastRenderedGame, _entryOptions);
    let i = entries.findIndex(e => e.kind === 'roster' && e.pointIdx === pointIdx);
    if (i < 0) i = entries.findIndex(e => e.pointIdx === pointIdx);
    const line = i >= 0 ? logEl.querySelector(`[data-entry="${i}"]`) : null;
    if (!line) return;
    logEl.querySelectorAll('.gf-flash').forEach(n => n.classList.remove('gf-flash', 'gf-flash-fade'));
    line.scrollIntoView({ block: 'center', behavior: 'smooth' });
    line.classList.add('gf-flash');
    setTimeout(() => line.classList.add('gf-flash-fade'), 900);
    setTimeout(() => line.classList.remove('gf-flash', 'gf-flash-fade'), 2600);
    line.click();
}

/**
 * Human-readable label for a point classification.
 * @param {string} kind - return value of classifyPoint
 * @returns {string|null}
 */
function pointClassificationLabel(kind) {
    switch (kind) {
        case 'break': return 'break';
        case 'cleanHold': return 'clean hold';
        case 'hold': return 'hold';
        case 'broken': return 'broken';
        default: return null; // opponentHold gets no badge
    }
}

/**
 * Render the game event log below the stats table.
 * Same shared renderer as the in-game Game Log panel
 * (utils/gameLogRenderer.js, G6 merge); this surface adds per-point
 * classification badges and omits the version/roster header lines.
 */
function renderGameSummaryEventLog(game, { live = false, editable = true, keepScroll = false } = {}) {
    const logEl = document.getElementById('gameSummaryEventLog');
    if (!logEl) return;

    // "Point N roster:" entries may be player ids (id-era games) — resolve to
    // display names; event lines already carry resolved {name, id} refs.
    _summaryLookup = buildPointPlayerLookup(game);
    _entryOptions = buildSummaryEntryOptions(game, _summaryLookup);
    renderSummaryLogLines({ keepScroll });
    // A game in progress opens on its latest play. (With a replay mounted
    // below, live-follow does the same by scrolling to the current line.)
    if (live && !keepScroll) logEl.scrollTop = logEl.scrollHeight;

    // Replay view (docs/replay-viewer-plan.md step 7): the field playback
    // above the log, for games with field positions. Live only for a share
    // guest watching a game in progress; a coach's summary shows a stored
    // game. Re-mounted on every render since the section is rebuilt per game
    // (a guest's poll refresh goes through refreshGameSummaryForShare instead).
    if (summaryReplayView) { try { summaryReplayView.destroy(); } catch (e) { /* gone */ } summaryReplayView = null; }
    const host = document.getElementById('gameSummaryEventLogSection');
    if (host) {
        const cfg = {
            host: logEl.parentElement || host, logEl,
            getGame: () => _lastRenderedGame,
            getEntryOptions: () => _entryOptions,
            getPlayerByName: name => { const r = _summaryLookup(name); return r && r.obj ? r.obj : null; },
            live,
            // Most games are tracked without field positions (Simple / Full
            // mode). On this screen the transport still earns its place as a
            // log player — step, scrub, Live-follow and the 🔊 narrator —
            // so mount it with the pitch hidden rather than not at all.
            mountWithoutLocations: true,
        };
        if (editable) {
            // Editing (step 8): any coach of the team, not viewers. After a
            // write, redraw the lines in place (the view re-marks them) and
            // recompute the stats tables from the amended events. A share
            // guest gets no canEdit at all, so the ✎ never exists for them.
            Object.assign(cfg, {
                canEdit: () => !isViewer(),
                editDeniedMessage: 'Viewers can’t edit plays',
                onEdited: () => {
                    renderSummaryLogLines({ keepScroll: true });
                    renderGameSummaryStatsTable(_lastRenderedGame);
                    renderGameSummaryTeamStats(_lastRenderedGame);
                    renderGameSummaryFlow(_lastRenderedGame);
                },
            });
        }
        summaryReplayView = mountReplayView(cfg);
        if (summaryReplayView) {
            // mountReplayView prepends to its host — the section's collapsible
            // body (ui/summarySections.js) — so the stage lands under the
            // heading and above the log lines, and hides with them.
            summaryReplayView.onShown();
        }
    }
}
let summaryReplayView = null;
// The lookup and buildGameLogEntries options the log lines were last
// rendered with. The replay reads the SAME options (getEntryOptions) so its
// entry indices line up with the lines' data-entry attributes; a refresh
// replaces both together.
let _summaryLookup = null;
let _entryOptions = null;

function buildSummaryEntryOptions(game, lookup) {
    return {
        teamName: game.team || 'My Team',
        opponentName: game.opponent || 'Opponent',
        scoreBadge: (point) => pointClassificationLabel(classifyPoint(point)),
        resolvePlayerName: entry => lookup(entry).name,
    };
}

/**
 * Draw the log lines. `keepScroll` is for a redraw of the game already on
 * screen (a guest's poll, an edit): a reader parked at the bottom of the log
 * stays at the bottom as new plays arrive, and a reader anywhere else stays
 * exactly where they were.
 */
function renderSummaryLogLines({ keepScroll = false } = {}) {
    const logEl = document.getElementById('gameSummaryEventLog');
    if (!logEl || !_lastRenderedGame || !_entryOptions) return;
    const prevTop = logEl.scrollTop;
    const atBottom = logScrolledToBottom(logEl);
    logEl.innerHTML = renderGameLogEntriesHTML(
        buildGameLogEntries(_lastRenderedGame, _entryOptions), _entryOptions.teamName);
    if (keepScroll) logEl.scrollTop = atBottom ? logEl.scrollHeight : prevTop;
}

/** Within a line or so of the end (or nothing to scroll yet). */
function logScrolledToBottom(el, slack = 32) {
    return el.scrollHeight - el.clientHeight - el.scrollTop <= slack;
}

/**
 * A game's log as plain text, in the Review screen's line format (point
 * classifications on the "scores!" lines, roster ids resolved to names).
 * Shared with the roster screens' single-game exports.
 */
function gameLogText(game) {
    return buildGameLogText(game, buildSummaryEntryOptions(game, buildPointPlayerLookup(game)));
}

/**
 * Open the Export dialog for the game on screen. One game, so there is no
 * scope to choose; a share guest gets the stats workbook and the log, but
 * not the raw game JSON.
 */
function openGameSummaryExport() {
    const game = _lastRenderedGame || (typeof currentGame === 'function' ? currentGame() : null);
    if (!game) return;
    const players = resolveSummaryPlayers(game, getGamePlayerStats(game));
    const guest = document.body.classList.contains('share-guest');
    openExportDialog({
        subject: `${game.team || 'Team'} vs ${game.opponent || 'Opponent'}`,
        scopes: [{ value: 'game', label: 'This game', singleGame: true }],
        scope: 'game',
        level: activeStatsLevel(),
        lockedLevel: lockedStatsLevel(),
        funOptions: getFunOptions(),
        players,
        formats: guest ? ['xlsx', 'sheets', 'text'] : undefined,
        buildWorkbook: async (choice) => buildGameWorkbook(game, {
            players, playerId: choice.playerId, level: choice.level, fun: choice.fun,
        }),
        gameFor: () => game,
        gameText: gameLogText,
    });
}

/**
 * Get the back-navigation target for the game summary screen.
 */
function getGameSummaryBackTarget() {
    return gameSummaryOrigin;
}

// Collapsible sections (stats / Game Flow / log), remembered per device.
// A replay stage mounted while the log was collapsed measures itself once
// the section opens.
initSummarySections();
document.getElementById('gameSummaryEventLogSection')?.addEventListener('summary-section-toggle', ev => {
    if (ev.detail && ev.detail.open && summaryReplayView) summaryReplayView.onShown();
});
document.getElementById('gameFlowSection')?.addEventListener('summary-section-toggle', ev => {
    if (ev.detail && ev.detail.open && summaryFlowView) summaryFlowView.redraw();
});

document.getElementById('exportGameSummaryBtn')?.addEventListener('click', openGameSummaryExport);

// Wire up Share button (public live-link dialog for the rendered game)
document.getElementById('shareGameSummaryBtn')?.addEventListener('click', () => {
    if (_lastRenderedGame) showShareGameDialog(_lastRenderedGame);
});

// --- ES-module exports ---
export {
    showGameSummaryFromList, showGameSummaryPostGame, getGameSummaryBackTarget,
    showGameSummaryForShare, refreshGameSummaryForShare, gameLogText,
};
