/*
 * Game Summary (from team list)
 * Shows a completed game's player stats table (sortable) and full event log.
 * Reuses the gameSummaryScreen section, adapting it for review from team list.
 */

// Track where we came from so back button navigates correctly
let gameSummaryOrigin = 'teamRosterScreen'; // default for post-game flow
let gameSummarySortController = null;

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
 * Called instead of the old updateGameSummaryRosterDisplay.
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

    // Determine players to display: rosterSnapshot for historical accuracy
    let players = [];
    if (game.rosterSnapshot && game.rosterSnapshot.players) {
        players = game.rosterSnapshot.players;
    } else if (typeof currentTeam !== 'undefined' && currentTeam) {
        players = currentTeam.teamRoster || [];
    }

    // Header row
    const headerRow = document.createElement('tr');
    const headers = ['Name', 'Pts', 'Time', 'Goals', 'Assists', 'Comp%', 'Huck%', 'Ds', 'TOs', '+/-', '..per pt'];
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
        completions: 0, totalThrows: 0, huckCompletions: 0, totalHucks: 0,
        dPlays: 0, turnovers: 0, plusMinus: 0
    };

    // Player rows
    players.forEach(player => {
        const ps = playerStats[player.name] || {};
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
            '',
            typeof formatPlayTime === 'function' ? formatPlayTime(totals.timePlayed) : '',
            totals.goals,
            totals.assists,
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
            { key: 'compPct', type: 'percentage', colIndex: 5 },
            { key: 'huckPct', type: 'percentage', colIndex: 6 },
            { key: 'ds', type: 'number', colIndex: 7 },
            { key: 'tos', type: 'number', colIndex: 8 },
            { key: 'plusMinus', type: 'number', colIndex: 9 },
            { key: 'pmPerPt', type: 'number', colIndex: 10 }
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

    (game.points || []).forEach(point => {
        let switchsides = false;
        numPoints++;
        summary += `\nPoint ${numPoints} roster:`;
        (point.players || []).forEach(player => summary += ` ${player}`);

        if (point.startingPosition === 'offense') {
            summary += `\n${opponent} pulls to ${teamName}.`;
        } else {
            summary += `\n${teamName} pulls to ${opponent}.`;
        }

        (point.possessions || []).forEach(possession => {
            (possession.events || []).forEach(event => {
                if (typeof event.summarize === 'function') {
                    summary += `\n${event.summarize()}`;
                }
                if (event.type === 'Other' && event.switchsides_flag) {
                    switchsides = true;
                }
            });
        });

        if (point.winner === 'team') {
            summary += `\n${teamName} scores! `;
            runningScoreUs++;
        }
        if (point.winner === 'opponent') {
            summary += `\n${opponent} scores! `;
            runningScoreThem++;
        }
        if (point.winner) {
            summary += `\nCurrent score: ${teamName} ${runningScoreUs}, ${opponent} ${runningScoreThem}`;
        }
        if (switchsides) {
            summary += `\nO and D switching sides for next point. `;
            if (point.winner === 'team') {
                summary += `\n${teamName} will receive pull and play O. `;
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

        const escaped = escapeHtml(line);
        html += `<div class="${lineClass}">${escaped}</div>`;
    }

    logEl.innerHTML = html;
}

/**
 * Export game summary stats to CSV and trigger download.
 * Same pattern as exportEventRosterCSV but without the checkbox column.
 */
function exportGameSummaryCSV() {
    const tbody = document.getElementById('gameSummaryRosterList');
    if (!tbody) return;

    const rows = tbody.querySelectorAll('tr');
    if (rows.length === 0) return;

    const csvRows = [];
    rows.forEach(row => {
        const cells = [];
        Array.from(row.children).forEach((cell, colIdx) => {
            let text = cell.textContent.trim();
            // Convert MM:SS time column to decimal minutes for spreadsheets
            if (colIdx === 2 && cell.tagName !== 'TH') {
                const parts = text.split(':');
                if (parts.length === 2) {
                    const mins = parseInt(parts[0], 10) || 0;
                    const secs = parseInt(parts[1], 10) || 0;
                    text = (mins + secs / 60).toFixed(1);
                }
            } else if (colIdx === 2 && cell.tagName === 'TH') {
                text = 'Minutes';
            }
            // Escape quotes and wrap in quotes if contains comma/quote/newline
            if (text.includes('"') || text.includes(',') || text.includes('\n')) {
                text = '"' + text.replace(/"/g, '""') + '"';
            }
            cells.push(text);
        });
        csvRows.push(cells.join(','));
    });

    const csv = csvRows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const game = typeof currentGame === 'function' ? currentGame() : null;
    const opponent = game?.opponent || 'game';
    const filename = opponent.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-') + '-stats.csv';

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Get the back-navigation target for the game summary screen.
 */
function getGameSummaryBackTarget() {
    return gameSummaryOrigin;
}

// Wire up CSV export button
document.getElementById('exportGameSummaryBtn')?.addEventListener('click', exportGameSummaryCSV);

window.showGameSummaryFromList = showGameSummaryFromList;
window.showGameSummaryPostGame = showGameSummaryPostGame;
window.getGameSummaryBackTarget = getGameSummaryBackTarget;
