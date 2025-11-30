/**
 * Game Viewer Logic
 * Handles fetching and rendering game data
 */

const POLL_INTERVAL = 3000; // 3 seconds
let currentGameId = null;
let lastVersion = null;
let isPolling = false;

// Parse query parameters
const urlParams = new URLSearchParams(window.location.search);
currentGameId = urlParams.get('game_id');

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
        if (!currentGameId) {
            showError('No game ID specified. Please use ?game_id=YOUR_GAME_ID');
            return;
        }

        // Setup Info Toggle
        const infoToggle = document.getElementById('info-toggle');
        const infoPanel = document.getElementById('game-info-panel');
        infoToggle.addEventListener('click', () => {
            infoPanel.classList.toggle('open');
        });

        // Start polling
        startPolling();
    });

async function startPolling() {
    if (isPolling) return;
    isPolling = true;

    updateConnectionStatus('connecting');

    try {
        await loadGame();
    } catch (error) {
        console.error('Initial load failed:', error);
        updateConnectionStatus('disconnected');
    }

    // Poll interval
    setInterval(async () => {
        try {
            await loadGame();
            updateConnectionStatus('connected');
        } catch (error) {
            console.error('Poll failed:', error);
            updateConnectionStatus('disconnected');
        }
    }, POLL_INTERVAL);
}

async function loadGame() {
    const response = await fetch(`/games/${currentGameId}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch game: ${response.statusText}`);
    }

    const gameData = await response.json();
    
    // Simple check to see if we need to re-render
    // In a real app, we might check a version timestamp or hash
    // For now, we'll just re-render if the data JSON string is different
    // Optimization: The server returns "version" in sync response, but get_game returns the raw game data.
    // We can implement a smarter check later.
    const currentDataJson = JSON.stringify(gameData);
    if (lastVersion !== currentDataJson) {
        console.log('Game data updated', gameData);
        if (gameData.points && gameData.points.length > 0) {
            const lastPoint = gameData.points[gameData.points.length - 1];
            console.log(`Last point (index ${gameData.points.length-1}):`, lastPoint);
            console.log(`Last point possessions:`, lastPoint.possessions ? lastPoint.possessions.length : 0);
        }
        lastVersion = currentDataJson;
        renderGame(gameData);
    }
}

function updateConnectionStatus(status) {
    const badge = document.getElementById('connection-status');
    badge.className = `status-badge ${status}`;
    
    if (status === 'connected') badge.textContent = 'Live';
    else if (status === 'connecting') badge.textContent = 'Connecting...';
    else if (status === 'disconnected') badge.textContent = 'Disconnected';
}

function showError(message) {
    const container = document.getElementById('points-container');
    container.innerHTML = `<div class="error-message">${message}</div>`;
}

function renderGame(game) {
    // Render Header
    document.getElementById('game-title').textContent = `${game.team} vs ${game.opponent}`;
    
    const date = new Date(game.gameStartTimestamp);
    document.getElementById('game-date').textContent = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    const scores = game.scores || { team: 0, opponent: 0 };
    // Try to get keys if they differ from "team"/"opponent" (based on Role enum)
    const teamScore = scores.team || scores[game.team] || 0;
    const oppScore = scores.opponent || scores[game.opponent] || 0;
    
    document.getElementById('game-score').textContent = `${teamScore} - ${oppScore}`;
    
    // Stats
    document.getElementById('total-points').textContent = (game.points || []).length;
    
    if (game.gameStartTimestamp) {
        const start = new Date(game.gameStartTimestamp);
        // Use current time for game duration if game is in progress
        const end = game.gameEndTimestamp ? new Date(game.gameEndTimestamp) : new Date();
        const diffMs = end - start;
        const diffSeconds = Math.floor(diffMs / 1000);
        document.getElementById('game-duration').textContent = formatDuration(diffSeconds);
    }

    // Render Points
    const pointsContainer = document.getElementById('points-container');
    
    // Save which points are expanded
    const expandedPoints = new Set();
    document.querySelectorAll('.point-content.expanded').forEach(el => {
        expandedPoints.add(el.getAttribute('data-point-index'));
    });

    // Check if user is near bottom before update (for auto-scroll)
    const isNearBottom = (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 100;

    pointsContainer.innerHTML = ''; // Clear current

    // Reverse points to show newest first
    const reversedPoints = [...(game.points || [])].reverse();
    const totalPoints = (game.points || []).length;

    // BUT for the viewer, we actually want to see the OLDEST point at the top and NEWEST at the bottom
    // So let's iterate through the original points array instead of reversed
    (game.points || []).forEach((point, index) => {
        const pointEl = createPointElement(point, index + 1, game.team, game.opponent);
        pointsContainer.appendChild(pointEl);

        // Restore expanded state or expand latest point by default
        // Expand if:
        // 1. It was previously expanded by the user (in expandedPoints)
        // 2. It is the LAST point AND it is in progress (no winner)
        // 3. It is the LAST point AND this is the initial load (!lastVersion)
        const isLast = index === totalPoints - 1;
        const isInProgress = !point.winner;
        
        if (expandedPoints.has(String(index)) || (isLast && (isInProgress || (!lastVersion && expandedPoints.size === 0)))) {
            const content = pointEl.querySelector('.point-content');
            content.classList.add('expanded');
            content.setAttribute('data-point-index', index);
        } else {
            const content = pointEl.querySelector('.point-content');
             content.setAttribute('data-point-index', index);
        }
    });

    // Auto-scroll if was near bottom
    if (isNearBottom) {
        window.scrollTo(0, document.body.scrollHeight);
    }
}

function createPointElement(point, pointNumber, teamName, opponentName) {
    const div = document.createElement('div');
    div.className = 'point-card';
    
    // Determine result
    let resultClass = '';
    let resultText = 'In Progress';
    
    if (point.winner) {
        if (point.winner === 'team' || point.winner === teamName) {
            resultClass = 'our-score';
            resultText = `${teamName} Score`;
        } else {
            resultClass = 'their-score';
            resultText = `${opponentName} Score`;
        }
    }

    // Convert milliseconds to seconds for formatting
    const durationSeconds = point.totalPointTime ? Math.floor(point.totalPointTime / 1000) : 0;
    const summary = `Duration: ${formatDuration(durationSeconds)}`;
    
    // Format roster list
    const rosterList = (point.players || []).join(', ');

    div.innerHTML = `
        <div class="point-header" onclick="togglePoint(this)">
            <div class="point-title">
                <span>Point ${pointNumber}: ${rosterList}</span>
                <span class="point-score-summary">${summary}</span>
            </div>
            <span class="point-result ${resultClass}">${resultText}</span>
        </div>
        <div class="point-content">
            ${renderPossessions(point.possessions)}
        </div>
    `;
    return div;
}

function renderPossessions(possessions) {
    if (!possessions || possessions.length === 0) return '<div class="possession">No possessions yet</div>';
    
    return possessions.map((pos, index) => `
        <div class="possession">
            <div class="possession-header">
                ${pos.offensive ? 'Offense' : 'Defense'}
            </div>
            <div class="events-list">
                ${(pos.events || []).map(event => renderEvent(event)).join('')}
            </div>
        </div>
    `).join('');
}

function renderEvent(event) {
    let type = event.type;
    let desc = '';
    
    // Basic description logic based on event type matching models.js logic
    if (type === 'Throw') {
        let verb = event.huck_flag ? 'hucks' : 'throws';
        desc = `${event.thrower || 'Unknown'} ${verb} `;
        let throwType = '';
        if (event.break_flag)        { throwType += 'break '; }
        if (event.hammer_flag)       { throwType += 'hammer '; }
        if (event.dump_flag)         { throwType += 'dump '; }
        if (throwType)              { desc += `a ${throwType}`; }
        if (event.receiver)         { desc += `to ${event.receiver} `; }
        if (event.sky_flag || event.layout_flag) {
            desc += `for a ${event.sky_flag ? "sky ":""}${event.layout_flag ? "layout ":""}catch `;
        }        
        if (event.score_flag) desc += 'for the score!';
        
    } else if (type === 'Turnover') {
        const t = event.thrower || "Unknown";
        const r = event.receiver || "Unknown";
        const hucktxt = event.huck_flag ? 'on a huck' : '';
        const defensetxt = event.defense_flag ? 'due to good defense' : '';
        if (event.throwaway_flag)    { desc = `${t} throws it away ${hucktxt} ${defensetxt}`; }
        else if (event.drop_flag)    { desc = `${r} misses the catch from ${t} ${hucktxt} ${defensetxt}`; }
        else if (event.defense_flag) { desc = `Turnover ${defensetxt}`; }
        else if (event.stall_flag)   { desc = `${t} gets stalled ${defensetxt}`; }
        else { desc = `Turnover by ${t}`; }

    } else if (type === 'Defense') {
        let summary = '';
        let defender = event.defender || '';
        if (event.interception_flag)     { summary += 'Interception '; }
        if (event.layout_flag)           { summary += 'Layout D '; }
        if (event.sky_flag)              { summary += 'Sky D '; }
        if (event.Callahan_flag)         { summary += 'Callahan '; }
        if (event.stall_flag)            { summary += 'Stall '; }
        if (event.unforcedError_flag)    { summary += 'Unforced error '; }
        if (defender) {
            summary += (summary ? summary : 'Turnover caused ') + `by ${defender}`;
        } else {
            summary = (summary ? summary : 'Unforced turnover by opponent');
        }
        desc = summary;

    } else if (type === 'Pull') {
        let pullerName = event.puller || 'Unknown';
        desc = `Pull by ${pullerName}`;
        if (event.quality) {
            desc += ` (${event.quality})`;
        }
        let pullType = [];
        if (event.flick_flag) pullType.push('Flick');
        if (event.roller_flag) pullType.push('Roller');
        if (event.io_flag) pullType.push('IO');
        if (event.oi_flag) pullType.push('OI');
        if (pullType.length > 0) {
            desc += ` - ${pullType.join(', ')}`;
        }

    } else if (type === 'Violation') {
        let summary = 'Violation called: ';
        if (event.ofoul_flag)        { summary += 'Offensive foul '; }
        if (event.strip_flag)            { summary += 'Strip '; }
        if (event.pick_flag)             { summary += 'Pick '; }
        if (event.travel_flag)           { summary += 'Travel '; }
        if (event.contest_flag)        { summary += 'Contested foul '; }
        if (event.dblteam_flag)       { summary += 'Double team '; }
        desc = summary;

    } else if (type === 'Other') {
        let summary = '';
        if (event.timeout_flag)      { summary += 'Timeout called. '; }
        if (event.injury_flag)       { summary += 'Injury sub called '; }
        if (event.timecap_flag)      { summary += 'Hard cap called; game over '; }
        if (event.switchsides_flag)  { summary += 'O and D switch sides '; }
        if (event.halftime_flag)     { summary += 'Halftime '; }
        desc = summary;

    } else {
        desc = type;
    }

    return `
        <div class="event-item">
            <span class="event-type ${type}">${type}</span>
            <span class="event-desc">${desc}</span>
        </div>
    `;
}

function togglePoint(header) {
    const content = header.nextElementSibling;
    content.classList.toggle('expanded');
}

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

