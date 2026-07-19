/*
 * Stats column help — long-press any column header on the player stats
 * tables to surface a short explanation of the metric. Mouse-and-touch
 * friendly (works on desktop press-and-hold and phone long-press).
 */
import { escapeHtml } from './gameLogRenderer.js';

const STATS_COLUMN_HELP = {
    'Name':     { name: 'Player Name',
                  desc: 'Color-coded by gender (purple = FMP, green = MMP).' },
    'Pts':      { name: 'Points Played',
                  desc: 'Number of completed points the player was on the field for.' },
    'Time':     { name: 'Time Played',
                  desc: 'Total field time across completed points (mm:ss).' },
    'Goals':    { name: 'Goals',
                  desc: 'Caught the scoring pass.' },
    'Assists':  { name: 'Assists',
                  desc: 'Threw the scoring pass.' },
    'HA':       { name: 'Hockey Assists',
                  desc: 'Threw the pass that led to the assist (the pass before the goal).' },
    'Huck HA':  { name: 'Huck Hockey Assists',
                  desc: 'Hockey assists where the throw was a huck. Counted in the HA total as well.' },
    'Comp%':    { name: 'Completion Percentage',
                  desc: 'Completed throws ÷ total throws (completions + turnovers).' },
    'Huck%':    { name: 'Huck Completion Percentage',
                  desc: 'Completed hucks ÷ total hucks attempted.' },
    'Ds':       { name: 'Defensive Plays',
                  desc: 'Blocks, layouts, skies, interceptions, Callahans, stalls forced.' },
    'TOs':      { name: 'Turnovers',
                  desc: 'Throwaways, stalls, and drops attributed to the player.' },
    '+/-':      { name: 'Plus / Minus',
                  desc: '+1 for each point won while on the field, −1 for each point lost.' },
    '..per pt': { name: '+/- per Point',
                  desc: 'Plus/minus divided by points played. A rate-adjusted version of +/-.' }
};

/**
 * Attach long-press handlers to the column headers of a stats table.
 * Safe to call repeatedly — clears prior handlers on the same row first.
 * @param {HTMLElement} headerRow - the <tr> containing the header <th>s
 */
function attachStatsColumnHelp(headerRow) {
    if (!headerRow) return;
    Array.from(headerRow.children).forEach(th => {
        const key = (th.textContent || '').trim();
        const help = STATS_COLUMN_HELP[key];
        if (!help) return;
        th.style.cursor = 'help';

        // Detach any handler from a previous render
        if (th._statsHelpCleanup) th._statsHelpCleanup();

        let timer = null;
        let triggered = false;
        const LONG_PRESS_MS = 450;

        const start = (e) => {
            triggered = false;
            timer = setTimeout(() => {
                triggered = true;
                showStatsHelpModal(help);
            }, LONG_PRESS_MS);
        };
        const cancel = () => {
            if (timer) { clearTimeout(timer); timer = null; }
        };
        const click = (e) => {
            // Swallow the trailing click so the sort controller doesn't toggle
            // after a long-press fires.
            if (triggered) { e.stopPropagation(); e.preventDefault(); triggered = false; }
        };

        th.addEventListener('touchstart', start, { passive: true });
        th.addEventListener('touchend', cancel);
        th.addEventListener('touchcancel', cancel);
        th.addEventListener('touchmove', cancel);
        th.addEventListener('mousedown', start);
        th.addEventListener('mouseup', cancel);
        th.addEventListener('mouseleave', cancel);
        th.addEventListener('click', click, true);

        th._statsHelpCleanup = () => {
            cancel();
            th.removeEventListener('touchstart', start);
            th.removeEventListener('touchend', cancel);
            th.removeEventListener('touchcancel', cancel);
            th.removeEventListener('touchmove', cancel);
            th.removeEventListener('mousedown', start);
            th.removeEventListener('mouseup', cancel);
            th.removeEventListener('mouseleave', cancel);
            th.removeEventListener('click', click, true);
        };
    });
}

function showStatsHelpModal(help) {
    let modal = document.getElementById('statsHelpModal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'statsHelpModal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content stats-help-modal-content">
            <div class="dialog-header prominent-dialog-header">
                <h2>${escapeHtml(help.name)}</h2>
                <span class="close">&times;</span>
            </div>
            <div class="stats-help-body">${escapeHtml(help.desc)}</div>
        </div>
    `;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.close').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
}

// --- ES-module exports ---
export { attachStatsColumnHelp };
