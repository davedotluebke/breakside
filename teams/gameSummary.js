/*
 * Game Summary (from team list)
 * Shows a completed game's player stats table (sortable) and full event log.
 * Reuses the gameSummaryScreen section, adapting it for review from team list.
 */
import { Gender, Role } from '../store/models.js';
import { currentTeam } from '../store/storage.js';
import { currentGame, formatPlayerName, formatPlayTime } from '../utils/helpers.js';
import {
    getGamePlayerStats, getGameTeamStats, formatTeamStatsLine, classifyPoint,
} from '../utils/eventStats.js';
import { createTableSortController } from '../utils/tableSort.js';
import { attachStatsColumnHelp } from '../utils/statsHelp.js';
import {
    buildStatsSheetAoA, aoaToFormattedSheet, downloadWorkbook,
    safeSheetName, safeFilename,
} from '../utils/xlsxExport.js';
import { showScreen } from '../screens/navigation.js';

// Track where we came from so back button navigates correctly
let gameSummaryOrigin = 'teamRosterScreen'; // default for post-game flow
let gameSummarySortController = null;
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
 * Render the full game summary: score, stats table, event log.
 */
function renderGameSummary(game) {
    if (!game) return;
    _lastRenderedGame = game;

    // Detach previous sort controller
    if (gameSummarySortController) {
        gameSummarySortController.detach();
        gameSummarySortController = null;
    }

    // Score header
    const teamNameEl = document.getElementById('teamName');
    const oppNameEl = document.getElementById('opponentName');
    const teamScoreEl = document.getElementById('teamFinalScore');
    const oppScoreEl = document.getElementById('opponentFinalScore');
    if (teamNameEl) teamNameEl.textContent = game.team || 'My Team';
    if (oppNameEl) oppNameEl.textContent = game.opponent || 'Opponent';
    if (teamScoreEl) teamScoreEl.textContent = game.scores?.[Role.TEAM] || game.scores?.team || 0;
    if (oppScoreEl) oppScoreEl.textContent = game.scores?.[Role.OPPONENT] || game.scores?.opponent || 0;

    // Hide/show footer buttons based on origin
    const anotherGameBtn = document.getElementById('anotherGameBtn');
    if (anotherGameBtn) {
        anotherGameBtn.style.display = gameSummaryOrigin === 'selectTeamScreen' ? 'none' : '';
    }

    renderGameSummaryStatsTable(game);
    renderGameSummaryTeamStats(game);
    renderGameSummaryEventLog(game);

    // Show CSV export button if there are stats
    const exportBtn = document.getElementById('exportGameSummaryBtn');
    if (exportBtn) {
        const hasStats = game.points && game.points.some(p => p.winner);
        exportBtn.style.display = hasStats ? '' : 'none';
    }

    showScreen('gameSummaryScreen');
}

/**
 * Build the sortable player stats table for a single game.
 */
function renderGameSummaryStatsTable(game) {
    const tbody = document.getElementById('gameSummaryRosterList');
    if (!tbody) return;
    tbody.innerHTML = '';

    const playerStats = typeof getGamePlayerStats === 'function'
        ? getGamePlayerStats(game) : {};
    const hasStats = Object.keys(playerStats).length > 0;

    // Determine players to display: rosterSnapshot for historical accuracy.
    // Some games saved an *empty* rosterSnapshot.players (the snapshot object
    // exists but captured nobody); guard on length so we don't render a blank
    // table when getGamePlayerStats actually has data. When the snapshot is
    // empty, show the live team roster (so bench players still appear as
    // zeros) unioned with anyone who actually has stats — so whoever played
    // is always listed even if currentTeam isn't this game's team.
    let players = [];
    if (game.rosterSnapshot && game.rosterSnapshot.players
            && game.rosterSnapshot.players.length > 0) {
        players = game.rosterSnapshot.players;
    } else {
        const base = (typeof currentTeam !== 'undefined' && currentTeam
            && currentTeam.teamRoster) ? currentTeam.teamRoster : [];
        const haveIds = new Set(base.map(p => p.id));
        const fromStats = Object.entries(playerStats)
            .filter(([id]) => !haveIds.has(id))
            .map(([id, s]) => ({ id, name: s.name || id }));
        players = [...base, ...fromStats];
    }

    // Header row
    const headerRow = document.createElement('tr');
    const headers = ['Name', 'Pts', 'Time', 'Goals', 'Assists', 'HA', 'Huck HA', 'Comp%', 'Huck%', 'Ds', 'TOs', '+/-', '..per pt'];
    headers.forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        th.classList.add('roster-header');
        headerRow.appendChild(th);
    });
    tbody.appendChild(headerRow);

    // Aggregate totals
    const totals = {
        pointsPlayed: 0, timePlayed: 0, goals: 0, assists: 0,
        hockeyAssists: 0, huckHockeyAssists: 0,
        completions: 0, totalThrows: 0, huckCompletions: 0, totalHucks: 0,
        dPlays: 0, turnovers: 0, plusMinus: 0
    };

    // Player rows
    players.forEach(player => {
        const ps = playerStats[player.id] || {};
        const row = createGameSummaryPlayerRow(player, ps, totals);
        tbody.appendChild(row);
    });

    // Team aggregate row
    if (hasStats) {
        const aggRow = document.createElement('tr');
        aggRow.classList.add('team-aggregate-row');

        const teamCell = document.createElement('td');
        teamCell.textContent = 'Team';
        teamCell.classList.add('roster-name-column', 'team-total-cell');
        aggRow.appendChild(teamCell);

        const teamCompPct = totals.totalThrows > 0
            ? ((totals.completions / totals.totalThrows) * 100).toFixed(0) : '-';
        const teamHuckPct = totals.totalHucks > 0
            ? ((totals.huckCompletions / totals.totalHucks) * 100).toFixed(0) : '-';
        const totalPoints = totals.pointsPlayed > 0 ? totals.pointsPlayed : 0;
        const pmPerPt = totalPoints > 0 ? (totals.plusMinus / totalPoints).toFixed(2) : '0.0';

        const aggValues = [
            totals.pointsPlayed,
            typeof formatPlayTime === 'function' ? formatPlayTime(totals.timePlayed) : '',
            totals.goals,
            totals.assists,
            totals.hockeyAssists,
            totals.huckHockeyAssists,
            teamCompPct !== '-' ? `${teamCompPct}%` : teamCompPct,
            teamHuckPct !== '-' ? `${teamHuckPct}%` : teamHuckPct,
            totals.dPlays,
            totals.turnovers,
            totals.plusMinus > 0 ? `+${totals.plusMinus}` : totals.plusMinus,
            pmPerPt > 0 ? `+${pmPerPt}` : pmPerPt
        ];

        aggValues.forEach(val => {
            const td = document.createElement('td');
            td.textContent = val;
            td.classList.add('team-total-cell');
            aggRow.appendChild(td);
        });

        tbody.appendChild(aggRow);
    }

    // Attach sort controller
    if (typeof createTableSortController === 'function') {
        const columns = [
            { key: 'name', type: 'string', colIndex: 0 },
            { key: 'pts', type: 'number', colIndex: 1 },
            { key: 'time', type: 'time', colIndex: 2 },
            { key: 'goals', type: 'number', colIndex: 3 },
            { key: 'assists', type: 'number', colIndex: 4 },
            { key: 'hockeyAssists', type: 'number', colIndex: 5 },
            { key: 'huckHockeyAssists', type: 'number', colIndex: 6 },
            { key: 'compPct', type: 'percentage', colIndex: 7 },
            { key: 'huckPct', type: 'percentage', colIndex: 8 },
            { key: 'ds', type: 'number', colIndex: 9 },
            { key: 'tos', type: 'number', colIndex: 10 },
            { key: 'plusMinus', type: 'number', colIndex: 11 },
            { key: 'pmPerPt', type: 'number', colIndex: 12 }
        ];
        gameSummarySortController = createTableSortController({
            getHeaderRow: () => tbody.querySelector('tr:first-child'),
            getDataRows: () => Array.from(tbody.querySelectorAll('tr:not(:first-child):not(.team-aggregate-row)')),
            getAggregateRows: () => Array.from(tbody.querySelectorAll('.team-aggregate-row')),
            getTbody: () => tbody,
            columns
        });
        gameSummarySortController.attach();
    }
    if (typeof attachStatsColumnHelp === 'function') {
        attachStatsColumnHelp(tbody.querySelector('tr:first-child'));
    }
}

/**
 * Create a player row for the game summary stats table.
 */
function createGameSummaryPlayerRow(player, ps, totals) {
    const row = document.createElement('tr');

    // Name
    const tdName = document.createElement('td');
    tdName.classList.add('roster-name-column');
    tdName.textContent = typeof formatPlayerName === 'function' ? formatPlayerName(player) : player.name;
    if (player.gender === Gender.FMP) tdName.classList.add('player-fmp');
    else if (player.gender === Gender.MMP) tdName.classList.add('player-mmp');
    row.appendChild(tdName);

    const pts = ps.pointsPlayed || 0;
    const time = ps.timePlayed || 0;
    const goals = ps.goals || 0;
    const assists = ps.assists || 0;
    const hockeyAssists = ps.hockeyAssists || 0;
    const huckHockeyAssists = ps.huckHockeyAssists || 0;
    const completions = ps.completions || 0;
    const totalThrows = ps.totalThrows || 0;
    const huckCompletions = ps.huckCompletions || 0;
    const totalHucks = ps.totalHucks || 0;
    const dPlays = ps.dPlays || 0;
    const turnovers = ps.turnovers || 0;
    const pm = ps.plusMinus || 0;

    // Accumulate totals
    totals.pointsPlayed += pts;
    totals.timePlayed += time;
    totals.goals += goals;
    totals.assists += assists;
    totals.hockeyAssists += hockeyAssists;
    totals.huckHockeyAssists += huckHockeyAssists;
    totals.completions += completions;
    totals.totalThrows += totalThrows;
    totals.huckCompletions += huckCompletions;
    totals.totalHucks += totalHucks;
    totals.dPlays += dPlays;
    totals.turnovers += turnovers;
    totals.plusMinus += pm;

    const compPct = totalThrows > 0 ? ((completions / totalThrows) * 100).toFixed(0) : '-';
    const huckPct = totalHucks > 0 ? ((huckCompletions / totalHucks) * 100).toFixed(0) : '-';
    const pmPerPt = pts > 0 ? (pm / pts).toFixed(2) : '0.0';

    const values = [
        pts,
        typeof formatPlayTime === 'function' ? formatPlayTime(time) : '0:00',
        goals,
        assists,
        hockeyAssists,
        huckHockeyAssists,
        compPct !== '-' ? `${compPct}%` : compPct,
        huckPct !== '-' ? `${huckPct}%` : huckPct,
        dPlays,
        turnovers,
        pm > 0 ? `+${pm}` : pm,
        pmPerPt > 0 ? `+${pmPerPt}` : pmPerPt
    ];

    values.forEach(val => {
        const td = document.createElement('td');
        td.textContent = val;
        row.appendChild(td);
    });

    return row;
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
 * Uses the same line-formatting logic as the in-game Game Log panel.
 */
function renderGameSummaryEventLog(game) {
    const logEl = document.getElementById('gameSummaryEventLog');
    if (!logEl) return;

    const teamName = game.team || 'My Team';
    const opponent = game.opponent || 'Opponent';

    // Build summary text (same logic as summarizeGame but parameterized)
    let summary = `Game Summary: ${teamName} vs. ${opponent}.\n`;
    let numPoints = 0;
    let runningScoreUs = 0;
    let runningScoreThem = 0;
    // How the current period opened — flips at each period break (halftime /
    // switch sides); drives the "who pulls next" note. Mirrors summarizeGame.
    let periodOpening = game.startingPosition;

    (game.points || []).forEach(point => {
        let switchsides = false;
        let forceswap = false;
        numPoints++;
        summary += `\nPoint ${numPoints} roster:`;
        (point.players || []).forEach(player => summary += ` ${player}`);

        if (point.startingPosition === 'offense') {
            summary += `\n${opponent} pulls to ${teamName}.`;
        } else {
            summary += `\n${teamName} pulls to ${opponent}.`;
        }

        // Events recorded AFTER the point ended (between-points timeouts,
        // switch sides) are deferred past the score lines below so the log
        // reads in real-world order (matches summarizeGame).
        const afterPointLines = [];
        (point.possessions || []).forEach(possession => {
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
            });
        });

        const kindLabel = typeof classifyPoint === 'function'
            ? pointClassificationLabel(classifyPoint(point)) : null;
        const badgeSuffix = kindLabel ? `  [${kindLabel}]` : '';
        if (point.winner === 'team') {
            summary += `\n${teamName} scores!${badgeSuffix} `;
            runningScoreUs++;
        }
        if (point.winner === 'opponent') {
            summary += `\n${opponent} scores!${badgeSuffix} `;
            runningScoreThem++;
        }
        if (point.winner) {
            summary += `\nCurrent score: ${teamName} ${runningScoreUs}, ${opponent} ${runningScoreThem}`;
        }
        afterPointLines.forEach(line => summary += `\n${line}`);
        // Manual Swap O & D corrections flip the period bookkeeping too
        // (matches determineStartingPosition / summarizeGame).
        if (forceswap) {
            periodOpening = (periodOpening === 'offense') ? 'defense' : 'offense';
        }
        if (switchsides) {
            // Period break: next point opens with the period-opening roles
            // swapped, regardless of who won this point (matches
            // determineStartingPosition).
            periodOpening = (periodOpening === 'offense') ? 'defense' : 'offense';
            if (periodOpening === 'offense') {
                summary += `\n${teamName} will receive the pull and play O. `;
            } else {
                summary += `\n${teamName} will pull to ${opponent} and play D. `;
            }
        }
    });

    // Format lines with CSS classes (same pattern as updateGameLogEvents)
    const lines = summary.split('\n');
    let html = '';
    for (const line of lines) {
        if (!line.trim()) continue;

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
        } else if (line.startsWith('Game Summary:')) {
            lineClass += ' game-log-header';
        } else if (line.includes('roster:')) {
            lineClass += ' game-log-roster';
        }

        // late-bound back-edge (escapeHtml's owner game/gameScreenSync.js lives
        // "above" this layer — importing it would create a cycle via
        // gameScreenEvents→gameSummary); the owner keeps its window shim.
        const escaped = window.escapeHtml(line);
        html += `<div class="${lineClass}">${escaped}</div>`;
    }

    logEl.innerHTML = html;
}

/**
 * Export game summary stats to an .xlsx workbook (single sheet) and
 * trigger download. Builds the same player table + team-stats footer
 * shown on screen, with proper Excel number / percent / time types.
 */
function exportGameSummaryXLSX() {
    const game = _lastRenderedGame || (typeof currentGame === 'function' ? currentGame() : null);
    if (!game) { alert('No game to export.'); return; }

    const playerStats = typeof getGamePlayerStats === 'function'
        ? getGamePlayerStats(game) : {};
    const teamStats = typeof getGameTeamStats === 'function'
        ? getGameTeamStats(game) : null;

    let players = [];
    if (game.rosterSnapshot && game.rosterSnapshot.players) {
        players = game.rosterSnapshot.players;
    } else if (typeof currentTeam !== 'undefined' && currentTeam) {
        players = currentTeam.teamRoster || [];
    }

    const teamName = game.team || 'Team';
    const opponent = game.opponent || 'Opponent';
    const teamScore = game.scores?.[Role.TEAM] || game.scores?.team || 0;
    const oppScore = game.scores?.[Role.OPPONENT] || game.scores?.opponent || 0;
    const titleRow = `${teamName} ${teamScore} — ${oppScore} ${opponent}`;

    const aoa = buildStatsSheetAoA(players, playerStats, teamStats, { titleRow });
    const ws = aoaToFormattedSheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(opponent));
    downloadWorkbook(wb, `${safeFilename(opponent)}-stats.xlsx`);
}

/**
 * Get the back-navigation target for the game summary screen.
 */
function getGameSummaryBackTarget() {
    return gameSummaryOrigin;
}

// Wire up XLSX export button
document.getElementById('exportGameSummaryBtn')?.addEventListener('click', exportGameSummaryXLSX);

// --- ES-module exports ---
export { showGameSummaryFromList, showGameSummaryPostGame, getGameSummaryBackTarget };
