/*
 * Game Flow — draws what utils/gameFlow.js and utils/connections.js compute:
 * the score-margin chart with its headline lines, and the Connections block
 * (top thrower→receiver pairs, expandable to the full matrix). Mounted by
 * teams/gameSummary.js on the Review / post-game summary — which a share
 * guest also sees — and, connections only, by teams/eventRoster.js on
 * Event Roster + Stats.
 *
 * Inline SVG + plain DOM. Colors come from ui/gameFlowChart.css (classes on
 * the SVG nodes, never presentation attributes) so both themes hold. The
 * chart draws at the host's real width and re-draws on width changes via
 * ResizeObserver: the summary screen renders while still display:none, so
 * the first real draw happens when the screen appears. The observer's
 * callback is delivered at a rendering opportunity, which a page nobody is
 * looking at may not get for a while, so the summary screen also calls
 * redraw() itself once the screen is shown and when the section is opened.
 */
import { buildGameFlow, describeGameFlow, formatDuration } from '../utils/gameFlow.js';
import { buildConnections, buildConnectionMatrix } from '../utils/connections.js';
import { escapeHtml } from '../utils/gameLogRenderer.js';

const KIND_CLASS = { break: 'break', cleanHold: 'hold', hold: 'hold', broken: 'broken', opponentHold: 'opphold' };
const KIND_LABEL = { break: 'Break', cleanHold: 'Clean hold', hold: 'Hold', broken: 'Broken', opponentHold: 'Their hold' };

const CHART_H = 190;
const PAD = { top: 24, right: 16, bottom: 28, left: 34 };
const MARKER_R = 4.5;
const HIT_R = 13;
let clipSerial = 0;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/** Score as "5–3 Team A" (leader named), or "4–4". */
function scoreText(us, them, teamName, opponentName) {
    if (us === them) return `${us}–${them}`;
    return us > them ? `${us}–${them} ${teamName}` : `${them}–${us} ${opponentName}`;
}

/* ------------------------------------------------------------------------
 * The chart
 * ---------------------------------------------------------------------- */

/**
 * Build the SVG markup for a flow at a given pixel width. Pure string work,
 * so it is cheap to redo on resize.
 */
function chartSVG(flow, width) {
    const pts = flow.points;
    const n = pts.length;
    const plotW = Math.max(40, width - PAD.left - PAD.right);
    const plotH = CHART_H - PAD.top - PAD.bottom;
    const step = plotW / n;
    const x = i => PAD.left + (i + 1) * step;       // i = -1 is the 0–0 start
    // Vertical range: the margins the game actually reached, plus one step
    // past zero on the other side so the baseline never sits on an edge. A
    // wire-to-wire game thus uses the whole height instead of half of it.
    const maxD = Math.max(1, ...pts.map(p => p.diff));
    const minD = Math.min(-1, ...pts.map(p => p.diff));
    const y = d => PAD.top + (maxD - d) * plotH / (maxD - minD);
    const f = v => Math.round(v * 10) / 10;

    const linePts = [[x(-1), y(0)], ...pts.map((p, i) => [x(i), y(p.diff)])];
    const lineStr = linePts.map(([a, b]) => `${f(a)},${f(b)}`).join(' ');
    const areaStr = `${lineStr} ${f(x(n - 1))},${f(y(0))} ${f(x(-1))},${f(y(0))}`;
    const id = `gf${++clipSerial}`;

    let out = `<svg viewBox="0 0 ${width} ${CHART_H}" width="${width}" height="${CHART_H}" role="img" aria-label="Score margin by point">`;
    out += `<defs>
        <clipPath id="${id}a"><rect x="0" y="0" width="${width}" height="${f(y(0))}"/></clipPath>
        <clipPath id="${id}b"><rect x="0" y="${f(y(0))}" width="${width}" height="${f(CHART_H - y(0))}"/></clipPath>
    </defs>`;

    // Grid: integer margins, thinned when the range is wide.
    const span = maxD - minD;
    const gridStep = span <= 12 ? 1 : span <= 24 ? 2 : 5;
    for (let d = Math.ceil(minD / gridStep) * gridStep; d <= maxD; d += gridStep) {
        if (d === 0) continue;
        out += `<line class="gf-grid" x1="${PAD.left}" x2="${f(PAD.left + plotW)}" y1="${f(y(d))}" y2="${f(y(d))}"/>`;
    }
    out += `<line class="gf-zero" x1="${PAD.left}" x2="${f(PAD.left + plotW)}" y1="${f(y(0))}" y2="${f(y(0))}"/>`;
    out += `<text class="gf-label" x="${PAD.left - 6}" y="${f(y(maxD) + 4)}" text-anchor="end">+${maxD}</text>`;
    out += `<text class="gf-label" x="${PAD.left - 6}" y="${f(y(0) + 4)}" text-anchor="end">0</text>`;
    out += `<text class="gf-label" x="${PAD.left - 6}" y="${f(y(minD) + 4)}" text-anchor="end">−${-minD}</text>`;

    // Half-plane washes, then the biggest runs, then the line itself.
    out += `<polygon class="gf-area-us" points="${areaStr}" clip-path="url(#${id}a)"/>`;
    out += `<polygon class="gf-area-them" points="${areaStr}" clip-path="url(#${id}b)"/>`;
    ['us', 'them'].forEach(side => {
        const run = flow.biggestRun[side];
        if (!run) return;
        const seg = [];
        for (let i = run.from - 1; i <= run.to; i++) {
            const idx = pts.findIndex(p => p.idx === i);
            if (i < pts[0].idx) seg.push(linePts[0]);
            else if (idx >= 0) seg.push(linePts[idx + 1]);
        }
        if (seg.length > 1) out += `<polyline class="gf-run-${side}" points="${seg.map(([a, b]) => `${f(a)},${f(b)}`).join(' ')}"/>`;
    });
    out += `<polyline class="gf-line-path" points="${lineStr}"/>`;

    // Halftime, between the marked point and the next.
    if (flow.halftimeAfter != null) {
        const i = pts.findIndex(p => p.idx === flow.halftimeAfter);
        if (i >= 0) {
            const hx = f(x(i) + step / 2);
            out += `<line class="gf-half" x1="${hx}" x2="${hx}" y1="${PAD.top - 4}" y2="${f(PAD.top + plotH)}"/>`;
            out += `<text class="gf-label-strong" x="${hx}" y="${PAD.top - 8}" text-anchor="middle">½</text>`;
        }
    }

    // Point-number axis: every k-th label, always the last.
    const k = Math.max(1, Math.ceil(n / 12));
    pts.forEach((p, i) => {
        if ((i + 1) % k === 0 || i === n - 1 || i === 0) {
            out += `<text class="gf-label" x="${f(x(i))}" y="${CHART_H - 10}" text-anchor="middle">${p.number}</text>`;
        }
    });

    // Timeouts: a T above the marker for ours, below for theirs.
    pts.forEach((p, i) => {
        const cx = f(x(i)), cy = y(p.diff);
        if (p.timeoutsUs) out += `<text class="gf-to-us" x="${cx}" y="${f(cy - 9)}" text-anchor="middle">T${p.timeoutsUs > 1 ? p.timeoutsUs : ''}</text>`;
        if (p.timeoutsThem) out += `<text class="gf-to-them" x="${cx}" y="${f(cy + 16)}" text-anchor="middle">T${p.timeoutsThem > 1 ? p.timeoutsThem : ''}</text>`;
    });

    // Final score beside the last marker, kept inside the plot.
    const last = pts[n - 1];
    const lx = f(x(n - 1) - 8), ly = f(y(last.diff) + (last.diff >= 0 ? -10 : 18));
    out += `<text class="gf-label-strong" x="${lx}" y="${ly}" text-anchor="end">${last.us}–${last.them}</text>`;

    // Markers last so they sit on top; hit circles over them.
    pts.forEach((p, i) => {
        out += `<circle class="gf-pt gf-pt-${KIND_CLASS[p.kind] || 'opphold'}" cx="${f(x(i))}" cy="${f(y(p.diff))}" r="${MARKER_R}" data-idx="${p.idx}"/>`;
    });
    pts.forEach((p, i) => {
        out += `<circle class="gf-hit" cx="${f(x(i))}" cy="${f(y(p.diff))}" r="${HIT_R}" data-idx="${p.idx}"><title>Point ${p.number}: ${p.us}–${p.them}</title></circle>`;
    });
    out += '</svg>';
    return out;
}

/**
 * Mount the Game Flow block (headline lines + chart + legend) into `host`.
 * Returns a handle with destroy(), or null when the game has fewer than two
 * completed points (nothing to draw yet).
 *
 * @param {HTMLElement} host
 * @param {object} game
 * @param {object} [opts]
 * @param {string} [opts.teamName]
 * @param {string} [opts.opponentName]
 * @param {(entry: string) => string} [opts.resolvePlayerName] - maps a raw
 *   point.players entry (name or id) to a display name for the tooltip
 * @param {(pointIdx: number) => void} [opts.onPointTap] - "Show in log"
 */
function mountGameFlow(host, game, {
    teamName = (game && game.team) || 'My Team',
    opponentName = (game && game.opponent) || 'Opponent',
    resolvePlayerName = null,
    onPointTap = null,
} = {}) {
    if (!host) return null;
    host.innerHTML = '';
    const flow = buildGameFlow(game);
    if (flow.points.length < 2) return null;

    const lines = describeGameFlow(flow, { teamName, opponentName });
    if (lines.length) {
        const linesEl = el('div', 'gf-lines');
        lines.forEach(t => linesEl.appendChild(el('div', 'gf-line', t)));
        host.appendChild(linesEl);
    }

    const chart = el('div', 'gf-chart');
    const caption = el('div', 'gf-caption');
    caption.innerHTML = `<span>Margin: <b>${escapeHtml(teamName)}</b> minus <b>${escapeHtml(opponentName)}</b>, point by point</span>`
        + (flow.inProgress ? '<span>in progress</span>' : '');
    const svgHost = el('div', 'gf-svg-host');
    const tip = el('div', 'gf-tip');
    tip.hidden = true;
    chart.append(caption, svgHost, tip);
    host.appendChild(chart);

    const legend = el('div', 'gf-legend');
    [['break', 'break'], ['hold', 'hold'], ['broken', 'broken'], ['opphold', 'their hold']].forEach(([cls, label]) => {
        legend.appendChild(el('span', `gf-lg-${cls}`, label));
    });
    if (flow.biggestRun.us || flow.biggestRun.them) legend.appendChild(el('span', 'gf-lg-plain', 'thick segment = biggest run'));
    host.appendChild(legend);

    // --- tooltip ---
    let pinnedIdx = null;
    const byIdx = new Map(flow.points.map(p => [p.idx, p]));
    function hideTip() {
        tip.hidden = true;
        pinnedIdx = null;
        svgHost.querySelectorAll('.gf-pt-active').forEach(c => c.classList.remove('gf-pt-active'));
    }
    function showTip(idx, pin) {
        const p = byIdx.get(idx);
        const marker = svgHost.querySelector(`.gf-pt[data-idx="${idx}"]`);
        if (!p || !marker) return;
        svgHost.querySelectorAll('.gf-pt-active').forEach(c => c.classList.remove('gf-pt-active'));
        marker.classList.add('gf-pt-active');
        const names = (p.players || []).map(e => (resolvePlayerName ? resolvePlayerName(e) : e)).filter(Boolean);
        const bits = [KIND_LABEL[p.kind] || (p.winner === 'us' ? 'We scored' : 'They scored'), `started on ${p.startedOn}`];
        if (p.durationMs) bits.push(formatDuration(p.durationMs));
        const timeouts = [];
        if (p.timeoutsUs) timeouts.push(`${teamName} ×${p.timeoutsUs}`);
        if (p.timeoutsThem) timeouts.push(`${opponentName} ×${p.timeoutsThem}`);
        tip.innerHTML = `<div class="gf-tip-title">Point ${p.number} · ${escapeHtml(scoreText(p.us, p.them, teamName, opponentName))}</div>`
            + `<div class="gf-tip-line">${escapeHtml(bits.join(' · '))}</div>`
            + (timeouts.length ? `<div class="gf-tip-line">Timeout: ${escapeHtml(timeouts.join(', '))}</div>` : '')
            + (p.halftimeAfter ? '<div class="gf-tip-line">Halftime after this point</div>' : '')
            + (names.length ? `<div class="gf-tip-line">Line: ${escapeHtml(names.join(', '))}</div>` : '')
            + (onPointTap ? '<button type="button" class="gf-tip-link">Show in log ›</button>' : '');
        tip.hidden = false;
        pinnedIdx = pin ? idx : null;
        // Position beside the marker, kept inside the chart box.
        const cRect = chart.getBoundingClientRect();
        const mRect = marker.getBoundingClientRect();
        const cx = mRect.left + mRect.width / 2 - cRect.left;
        const cy = mRect.top + mRect.height / 2 - cRect.top;
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let left = cx - tw / 2;
        left = Math.max(4, Math.min(left, cRect.width - tw - 4));
        let top = cy + 14;
        if (top + th > cRect.height - 4) top = Math.max(4, cy - th - 14);
        tip.style.left = `${Math.round(left)}px`;
        tip.style.top = `${Math.round(top)}px`;
        const link = tip.querySelector('.gf-tip-link');
        if (link) link.addEventListener('click', ev => { ev.stopPropagation(); hideTip(); onPointTap(idx); });
    }
    function idxOf(target) {
        const hit = target && target.closest ? target.closest('.gf-hit, .gf-pt') : null;
        return hit ? Number(hit.dataset.idx) : null;
    }
    const onClick = ev => {
        const idx = idxOf(ev.target);
        if (idx == null) { if (!tip.contains(ev.target)) hideTip(); return; }
        ev.stopPropagation();
        if (pinnedIdx === idx) hideTip(); else showTip(idx, true);
    };
    const onMove = ev => {
        if (pinnedIdx != null || ev.pointerType === 'touch') return;
        const idx = idxOf(ev.target);
        if (idx == null) { if (!tip.hidden) hideTip(); return; }
        showTip(idx, false);
    };
    const onLeave = () => { if (pinnedIdx == null) hideTip(); };
    const onDocClick = ev => { if (!chart.contains(ev.target)) hideTip(); };
    chart.addEventListener('click', onClick);
    svgHost.addEventListener('pointermove', onMove);
    svgHost.addEventListener('pointerleave', onLeave);
    document.addEventListener('click', onDocClick);

    // --- draw at the real width, and again whenever it changes ---
    let drawnWidth = 0;
    function draw() {
        const w = Math.round(svgHost.clientWidth);
        if (w < 60 || w === drawnWidth) return;
        drawnWidth = w;
        hideTip();
        svgHost.innerHTML = chartSVG(flow, w);
    }
    const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver(() => draw()) : null;
    if (ro) ro.observe(svgHost);
    draw();

    return {
        flow,
        redraw() { drawnWidth = 0; draw(); },
        destroy() {
            if (ro) ro.disconnect();
            document.removeEventListener('click', onDocClick);
            hideTip();
        },
    };
}

/* ------------------------------------------------------------------------
 * Connections
 * ---------------------------------------------------------------------- */

const LIST_LIMIT = 6;

function pairBadges(pair) {
    const parts = [];
    if (pair.goals) parts.push(`<span class="gf-goal">${pair.goals} G</span>`);
    if (pair.hucks) parts.push(`${pair.hucks} huck${pair.hucks > 1 ? 's' : ''}`);
    return parts.join(' · ');
}

function pairTitle(pair) {
    const bits = [`${pair.completions} of ${pair.attempts} completed`];
    if (pair.goals) bits.push(`${pair.goals} goal${pair.goals > 1 ? 's' : ''}`);
    if (pair.hucks) bits.push(`${pair.hucks} huck${pair.hucks > 1 ? 's' : ''}`);
    if (pair.drops) bits.push(`${pair.drops} drop${pair.drops > 1 ? 's' : ''}`);
    if (pair.throwaways) bits.push(`${pair.throwaways} throwaway${pair.throwaways > 1 ? 's' : ''}`);
    return `${pair.throwerName} → ${pair.receiverName}: ${bits.join(', ')}`;
}

function renderPairList(body, conn, showAll) {
    body.innerHTML = '';
    const list = el('div', 'gf-pairs');
    const max = conn.pairs[0] ? conn.pairs[0].completions : 0;
    const rows = showAll ? conn.pairs : conn.pairs.slice(0, LIST_LIMIT);
    rows.forEach(pair => {
        const row = el('div', 'gf-pair');
        row.title = pairTitle(pair);
        const pct = max > 0 ? Math.round(100 * pair.completions / max) : 0;
        row.innerHTML = `<span class="gf-pair-names">${escapeHtml(pair.throwerName)}<span class="gf-arrow">→</span>${escapeHtml(pair.receiverName)}</span>`
            + `<span class="gf-pair-bar"><i style="width:${pct}%"></i></span>`
            + `<span class="gf-pair-num">${pair.completions}<small>/${pair.attempts}</small></span>`
            + `<span class="gf-pair-badges">${pairBadges(pair)}</span>`;
        list.appendChild(row);
    });
    body.appendChild(list);
    if (!showAll && conn.pairs.length > LIST_LIMIT) {
        const more = el('button', 'gf-conn-more', `Show all ${conn.pairs.length} pairs`);
        more.type = 'button';
        more.addEventListener('click', () => renderPairList(body, conn, true));
        body.appendChild(more);
    }
}

function heatClass(completions, max) {
    if (!completions || !max) return '';
    const r = completions / max;
    return `gf-heat-${r >= 0.8 ? 5 : r >= 0.6 ? 4 : r >= 0.4 ? 3 : r >= 0.2 ? 2 : 1}`;
}

function renderMatrix(body, conn) {
    body.innerHTML = '';
    const m = buildConnectionMatrix(conn);
    const scroll = el('div', 'gf-matrix-scroll');
    const table = el('table', 'gf-matrix');
    let html = '<thead><tr><th class="gf-corner">Thrower ↓ / Receiver →</th>';
    m.receivers.forEach(r => { html += `<th class="gf-col">${escapeHtml(r.name)}</th>`; });
    html += '<th class="gf-total">Thrown</th></tr></thead><tbody>';
    m.throwers.forEach(t => {
        html += `<tr><th class="gf-row">${escapeHtml(t.name)}</th>`;
        m.receivers.forEach(r => {
            const pair = m.cells[t.id] && m.cells[t.id][r.id];
            if (!pair) { html += '<td class="gf-cell"></td>'; return; }
            const cls = pair.completions ? heatClass(pair.completions, m.max) : 'gf-miss';
            const goals = pair.goals ? `<span class="gf-cell-goals"> ${'★'.repeat(Math.min(pair.goals, 3))}</span>` : '';
            html += `<td class="gf-cell ${cls}" title="${escapeHtml(pairTitle(pair))}">${pair.completions}${goals}</td>`;
        });
        html += `<td class="gf-total">${t.thrown}</td></tr>`;
    });
    html += '</tbody><tfoot><tr><th class="gf-row gf-total">Caught</th>';
    m.receivers.forEach(r => { html += `<td class="gf-total">${r.caught}</td>`; });
    html += `<td class="gf-total">${conn.totals.completions}</td></tr></tfoot>`;
    table.innerHTML = html;
    scroll.appendChild(table);
    body.appendChild(scroll);
    body.appendChild(el('div', 'gf-empty', '★ marks a goal-scoring connection. Tap a cell for the full count.'));
}

/**
 * Mount the Connections block into `host` for one game or a list of games.
 * Returns a handle with destroy(), or null when no pass has both a thrower
 * and a receiver (Simple-mode games record only the scoring throw, so a
 * game can have a few pairs and still be worth showing).
 */
function mountConnections(host, games, { view = 'list' } = {}) {
    if (!host) return null;
    host.innerHTML = '';
    const conn = buildConnections(games);
    if (!conn.pairs.length) return null;

    const head = el('div', 'gf-conn-head');
    const pairWord = conn.pairs.length === 1 ? 'pair' : 'pairs';
    head.appendChild(el('span', 'gf-conn-title',
        `${conn.totals.completions} completed pass${conn.totals.completions === 1 ? '' : 'es'} between ${conn.pairs.length} ${pairWord}`
        + (conn.totals.attempts > conn.totals.completions ? ` (${conn.totals.attempts - conn.totals.completions} incomplete)` : '')));
    const toggle = el('button', '', view === 'matrix' ? 'List' : 'Matrix');
    toggle.type = 'button';
    toggle.setAttribute('aria-pressed', view === 'matrix' ? 'true' : 'false');
    toggle.title = 'Switch between the top pairs and the full thrower × receiver grid';
    head.appendChild(toggle);
    const body = el('div', 'gf-conn-body');
    host.append(head, body);

    let current = view;
    function render() {
        if (current === 'matrix') renderMatrix(body, conn); else renderPairList(body, conn, false);
        toggle.textContent = current === 'matrix' ? 'List' : 'Matrix';
        toggle.setAttribute('aria-pressed', current === 'matrix' ? 'true' : 'false');
    }
    toggle.addEventListener('click', () => { current = current === 'matrix' ? 'list' : 'matrix'; render(); });
    render();
    return { conn, view: () => current, destroy() { host.innerHTML = ''; } };
}

// --- ES-module exports ---
export { mountGameFlow, mountConnections, chartSVG };
