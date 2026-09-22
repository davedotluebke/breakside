/*
 * Game flow — the shape of a game, point by point.
 *
 * Pure functions over an already-loaded Game (or the share viewer's hydrated
 * game-shaped object): no DOM, no network, no app state. The Review /
 * post-game summary screen (teams/gameSummary.js) renders the result through
 * ui/gameFlowChart.js as a score-margin chart plus a few headline lines
 * ("biggest run", "lead changes", the score at half).
 *
 * Only completed points (those with a `winner`) count. Running scores are
 * recounted from the winners rather than read from game.scores — the same
 * thing utils/gameLogRenderer.js does for its "Current score" lines — so the
 * chart always agrees with the log even when game.scores was hand-edited.
 *
 * Unit tests: tests/unit/gameFlow.test.mjs.
 */
import { classifyPoint } from './statAccumulator.js';

const WE_WON = winner => winner === 'team';   // Role.TEAM; 'opponent' is theirs

/**
 * The between-point / administrative events recorded on a point, read off
 * its `Other` events: halftime (a period break — the log prints it after the
 * score line), the hard cap, and timeouts by side. Legacy timeouts carry no
 * `calledBy`; those count as `timeoutsUnknown`.
 */
function pointBreakEvents(point) {
    const out = { halftime: false, hardCap: false, timeoutsUs: 0, timeoutsThem: 0, timeoutsUnknown: 0 };
    (point.possessions || []).forEach(poss => {
        (poss.events || []).forEach(ev => {
            if (!ev || ev.type !== 'Other') return;
            if (ev.halftime_flag) out.halftime = true;
            if (ev.timecap_flag) out.hardCap = true;
            if (ev.timeout_flag) {
                if (ev.calledBy === 'us') out.timeoutsUs++;
                else if (ev.calledBy === 'them') out.timeoutsThem++;
                else out.timeoutsUnknown++;
            }
        });
    });
    return out;
}

/**
 * @typedef {object} FlowPoint
 * @property {number} idx - index into game.points (matches the log's "Point N" with N = idx + 1)
 * @property {number} number - idx + 1
 * @property {'us'|'them'} winner
 * @property {number} us - our score after this point
 * @property {number} them - their score after this point
 * @property {number} diff - us − them after this point
 * @property {'O'|'D'} startedOn - which line we started the point on
 * @property {string|null} kind - classifyPoint() of the point
 * @property {number} durationMs - point.totalPointTime (0 when untimed)
 * @property {boolean} halftimeAfter - a halftime was recorded on this point
 * @property {boolean} hardCapAfter - the hard cap was called on this point
 * @property {number} timeoutsUs
 * @property {number} timeoutsThem
 * @property {Array<string>} players - point.players as stored (names or ids;
 *   the renderer resolves them, see utils/helpers.js buildPointPlayerLookup)
 */

/**
 * @typedef {object} FlowRun
 * @property {'us'|'them'} side
 * @property {number} from - idx of the first point of the run
 * @property {number} to - idx of the last point of the run
 * @property {number} length
 */

/**
 * Build the flow of a game.
 *
 * @param {object} game
 * @returns {{
 *   points: FlowPoint[],
 *   final: {us: number, them: number},
 *   runs: FlowRun[],                      every streak of 2+ consecutive points by one side
 *   biggestRun: {us: FlowRun|null, them: FlowRun|null},   longest streak per side, null below 2
 *   leadChanges: number,                  times the lead passed from one side to the other
 *   ties: number,                         points that ended level (0–0 before the first point excluded)
 *   largestLead: {us: number, them: number},
 *   halftimeAfter: number|null,           idx of the point a halftime was recorded on
 *   halfScores: {first: {us, them}, second: {us, them}}|null,
 *   longestPoint: FlowPoint|null,         the point with the largest totalPointTime, if any is timed
 *   timeouts: {us: number, them: number, unknown: number},
 *   inProgress: boolean,                  the game has a point without a winner
 * }}
 */
function buildGameFlow(game) {
    const points = [];
    let us = 0, them = 0;
    let inProgress = false;
    ((game && game.points) || []).forEach((point, idx) => {
        if (!point || !point.winner) { inProgress = true; return; }
        const weWon = WE_WON(point.winner);
        if (weWon) us++; else them++;
        const breaks = pointBreakEvents(point);
        points.push({
            idx, number: idx + 1,
            winner: weWon ? 'us' : 'them',
            us, them, diff: us - them,
            startedOn: point.startingPosition === 'offense' ? 'O' : 'D',
            kind: classifyPoint(point),
            durationMs: Number(point.totalPointTime) > 0 ? Number(point.totalPointTime) : 0,
            halftimeAfter: breaks.halftime,
            hardCapAfter: breaks.hardCap,
            timeoutsUs: breaks.timeoutsUs,
            timeoutsThem: breaks.timeoutsThem,
            timeoutsUnknown: breaks.timeoutsUnknown,
            players: Array.isArray(point.players) ? point.players.slice() : [],
        });
    });

    // Runs: maximal streaks by one side.
    const runs = [];
    let cur = null;
    points.forEach(p => {
        if (cur && cur.side === p.winner) { cur.to = p.idx; cur.length++; }
        else { cur = { side: p.winner, from: p.idx, to: p.idx, length: 1 }; runs.push(cur); }
    });
    const longest = side => runs.filter(r => r.side === side && r.length >= 2)
        .reduce((best, r) => (!best || r.length > best.length) ? r : best, null);
    const biggestRun = { us: longest('us'), them: longest('them') };

    // Lead changes and ties. A tie does not change the leader; the lead
    // changes when the other side is in front after a point.
    let leadChanges = 0, ties = 0, leader = null;
    const largestLead = { us: 0, them: 0 };
    points.forEach(p => {
        if (p.diff === 0) ties++;
        const now = p.diff > 0 ? 'us' : p.diff < 0 ? 'them' : leader;
        if (leader && now && now !== leader) leadChanges++;
        leader = now;
        if (p.diff > largestLead.us) largestLead.us = p.diff;
        if (-p.diff > largestLead.them) largestLead.them = -p.diff;
    });

    // Halftime: the first point carrying a halftime marker splits the halves.
    const halfPoint = points.find(p => p.halftimeAfter) || null;
    const halftimeAfter = halfPoint ? halfPoint.idx : null;
    let halfScores = null;
    if (halfPoint) {
        const last = points[points.length - 1];
        halfScores = {
            first: { us: halfPoint.us, them: halfPoint.them },
            second: { us: last.us - halfPoint.us, them: last.them - halfPoint.them },
        };
    }

    const longestPoint = points.reduce((best, p) =>
        (p.durationMs > 0 && (!best || p.durationMs > best.durationMs)) ? p : best, null);

    const timeouts = points.reduce((t, p) => {
        t.us += p.timeoutsUs; t.them += p.timeoutsThem; t.unknown += p.timeoutsUnknown; return t;
    }, { us: 0, them: 0, unknown: 0 });

    return {
        points,
        final: { us, them },
        runs: runs.filter(r => r.length >= 2),
        biggestRun,
        leadChanges,
        ties,
        largestLead,
        halftimeAfter,
        halfScores,
        longestPoint,
        timeouts,
        inProgress,
    };
}

/** mm:ss for a duration in ms (h:mm:ss past an hour). */
function formatDuration(ms) {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Headline lines for the summary screen (and the xlsx footer), in display
 * order. Empty array for a game with fewer than two completed points —
 * nothing here means anything until the game has some shape.
 *
 * @param {ReturnType<buildGameFlow>} flow
 * @param {{teamName?: string, opponentName?: string}} [names]
 * @returns {string[]}
 */
function describeGameFlow(flow, { teamName = 'We', opponentName = 'They' } = {}) {
    if (!flow || flow.points.length < 2) return [];
    const lines = [];
    const nameOf = side => side === 'us' ? teamName : opponentName;
    const runText = run => {
        const first = flow.points.find(p => p.idx === run.from);
        const last = flow.points.find(p => p.idx === run.to);
        const range = `points ${first.number}–${last.number}`;
        return `${nameOf(run.side)} ${run.length}–0 (${range})`;
    };

    const runs = [flow.biggestRun.us, flow.biggestRun.them].filter(Boolean)
        .sort((a, b) => b.length - a.length || a.from - b.from);
    if (runs.length) lines.push(`Biggest run: ${runs.map(runText).join(' · ')}`);

    const leadBits = [];
    leadBits.push(`Lead changes: ${flow.leadChanges}`);
    leadBits.push(flow.ties === 1 ? 'Tied once' : `Tied ${flow.ties} times`);
    const leads = [];
    if (flow.largestLead.us > 0) leads.push(`${teamName} +${flow.largestLead.us}`);
    if (flow.largestLead.them > 0) leads.push(`${opponentName} +${flow.largestLead.them}`);
    if (leads.length) leadBits.push(`Largest lead: ${leads.join(', ')}`);
    lines.push(leadBits.join(' · '));

    if (flow.halfScores) {
        const h = flow.halfScores;
        const half = h.first.us === h.first.them
            ? `${h.first.us}–${h.first.them}`
            : (h.first.us > h.first.them
                ? `${h.first.us}–${h.first.them} ${teamName}`
                : `${h.first.them}–${h.first.us} ${opponentName}`);
        lines.push(`Halftime: ${half} · Second half: ${teamName} ${h.second.us}, ${opponentName} ${h.second.them}`);
    }

    if (flow.longestPoint) {
        lines.push(`Longest point: #${flow.longestPoint.number}, ${formatDuration(flow.longestPoint.durationMs)}`);
    }

    const t = flow.timeouts;
    if (t.us || t.them || t.unknown) {
        const parts = [];
        if (t.us) parts.push(`${teamName} ${t.us}`);
        if (t.them) parts.push(`${opponentName} ${t.them}`);
        if (t.unknown) parts.push(`${t.unknown} unattributed`);
        lines.push(`Timeouts: ${parts.join(', ')}`);
    }
    return lines;
}

// --- ES-module exports ---
export { buildGameFlow, describeGameFlow, pointBreakEvents, formatDuration };
