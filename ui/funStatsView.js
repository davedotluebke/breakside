/*
 * The Fun stats panel (StatsLevel.FUN, utils/funStats.js) — the on-screen
 * form, shared by Review, Event Roster + Stats, Team Roster + Stats and the
 * Scrimmages screen. Each screen owns a host element below its table; when the
 * active level is Fun the screen calls renderFunStats(host, …) and the table
 * drops to its identity columns, otherwise clearFunStats(host).
 *
 * A card grid: Goals & Assists first (only players with one), then a card per
 * shout-out category. Lists, not a sortable table, on purpose. Above it, for
 * anyone not held to Fun, one line of options: "Shout out the top [5] players
 * for each stat", and the throws Completion % needs (blank = automatic).
 */
import { buildFunStats, funStatsEmpty } from '../utils/funStats.js';
import { funOptionsEditable, getFunOptions, setFunOptions } from '../utils/statsAudience.js';
import { Gender } from '../store/models.js';

function esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
}

function genderClass(player) {
    if (player.gender === Gender.FMP) return ' player-fmp';
    if (player.gender === Gender.MMP) return ' player-mmp';
    return '';
}

function scorersCard(scorers) {
    if (!scorers.length) return '';
    const rows = scorers.map(s => `
            <tr>
                <td class="fun-name${genderClass(s.player)}">${esc(s.name)}</td>
                <td class="fun-num">${s.goals || ''}</td>
                <td class="fun-num">${s.assists || ''}</td>
            </tr>`).join('');
    return `
        <section class="fun-card fun-card-scorers">
            <h4><i class="fas fa-bullseye" aria-hidden="true"></i> Goals &amp; Assists</h4>
            <table class="fun-scorers">
                <thead><tr><th></th><th class="fun-num">Goals</th><th class="fun-num">Assists</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </section>`;
}

function shoutoutCard(cat) {
    const items = cat.entries.map(e => `
                <li><span class="fun-name${genderClass(e.player)}">${esc(e.name)}</span><span class="fun-num">${esc(e.text)}</span></li>`).join('');
    return `
        <section class="fun-card">
            <h4><i class="fas ${esc(cat.icon)}" aria-hidden="true"></i> ${esc(cat.label)}</h4>
            <p class="fun-hint">${esc(cat.hint)}</p>
            <ol class="fun-list">${items}</ol>
        </section>`;
}

/**
 * The options line. `fun` is the built result, which carries the topN and
 * Comp% minimum actually used (the automatic one when the box is blank).
 */
function optionsLine(fun, opts) {
    return `
        <div class="fun-options">
            <label>Shout out the top
                <input type="number" class="fun-topn" min="1" max="99" inputmode="numeric" value="${fun.topN}" aria-label="How many players each shout-out names">
                players for each stat</label>
            <label>Completion % needs
                <input type="number" class="fun-minthrows" min="1" max="999" inputmode="numeric"
                    value="${opts.minCompThrows || ''}" placeholder="${fun.minCompThrows}" aria-label="Throws needed to count for completion %">
                throws<span class="fun-hint">${opts.minCompThrows ? '' : ' (auto)'}</span></label>
        </div>`;
}

/**
 * Render the Fun panel into `host` and show it.
 * @param {HTMLElement} host
 * @param {Array<object>} players
 * @param {object} playerStats - playerId → accumulated stats
 * @param {object} [opts]
 * @param {string} [opts.emptyText] - shown when nobody has anything yet
 */
function renderFunStats(host, players, playerStats, { emptyText = 'Shout-outs appear here once the team scores.' } = {}) {
    if (!host) return;
    const opts = getFunOptions();
    const fun = buildFunStats(players, playerStats, opts);
    host.hidden = false;
    if (funStatsEmpty(fun)) {
        host.innerHTML = `<p class="fun-empty">${esc(emptyText)}</p>`;
        return;
    }
    const editable = funOptionsEditable();
    host.innerHTML = `
        ${editable ? optionsLine(fun, opts) : ''}
        <div class="fun-stats">
            ${scorersCard(fun.scorers)}
            ${fun.shoutouts.length ? `<h4 class="fun-shoutouts-heading"><i class="fas fa-star" aria-hidden="true"></i> Shout-outs <span class="fun-hint">top ${fun.topN}</span></h4>` : ''}
            ${fun.shoutouts.map(shoutoutCard).join('')}
        </div>`;
    if (!editable) return;
    // 'change' fires on Enter / blur, so typing a two-digit number doesn't
    // re-render (and drop focus) after the first digit.
    const rerender = () => renderFunStats(host, players, playerStats, { emptyText });
    host.querySelector('.fun-topn').addEventListener('change', e => {
        setFunOptions({ topN: e.target.value });
        rerender();
    });
    host.querySelector('.fun-minthrows').addEventListener('change', e => {
        setFunOptions({ minCompThrows: e.target.value });
        rerender();
    });
}

/** Empty and hide a Fun host (the active level is a table level). */
function clearFunStats(host) {
    if (!host) return;
    host.hidden = true;
    host.innerHTML = '';
}

// --- ES-module exports ---
export { renderFunStats, clearFunStats };
