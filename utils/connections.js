/*
 * Connections — who throws to whom.
 *
 * Pure aggregation over loaded Game objects (or the share viewer's hydrated
 * game-shaped objects): no DOM, no network, no app state. For every
 * thrower→receiver pair that appears in the event stream it counts completed
 * passes, goals, hucks, and the incompletions aimed at that pair. Rendered by
 * ui/gameFlowChart.js on the Review / post-game summary (top connections plus
 * an optional full matrix) and on the Event Roster + Stats screen.
 *
 * Attribution follows utils/statAccumulator.js so the two never disagree on
 * what a throw was:
 *   - a Throw with a thrower and a receiver is a completion for that pair;
 *   - a Turnover with drop_flag and both refs is an attempt the pair did not
 *     complete (charged as a drop). The per-player stats deliberately leave a
 *     drop out of the thrower's Throws/Comp%; the pair's attempt count keeps
 *     it, because "how often does this pair connect" is a question about the
 *     pair, not a fault ruling;
 *   - a throwaway/stall that recorded an intended receiver is likewise an
 *     attempt at that pair; one without a receiver belongs to no pair.
 * Player refs may be resolved objects ({name, id}) or bare name strings
 * (legacy data); ids come from the game's own name resolver, the same one
 * accumulateGameStats keys its stats by.
 *
 * Unit tests: tests/unit/connections.test.mjs.
 */
import { buildPlayerNameResolver } from './helpers.js';

function pairKey(throwerId, receiverId) { return `${throwerId}→${receiverId}`; }

function emptyPair(thrower, receiver) {
    return {
        throwerId: thrower.id, throwerName: thrower.name,
        receiverId: receiver.id, receiverName: receiver.name,
        completions: 0, attempts: 0, goals: 0, hucks: 0, huckAttempts: 0, drops: 0, throwaways: 0,
    };
}

/**
 * Fold one game's throws into `acc` ({ pairs: Map, players: Map }).
 * Shared by buildConnections for single- and multi-game callers.
 */
function accumulateConnections(game, acc) {
    const resolveName = buildPlayerNameResolver(game, { quiet: true });
    const resolveRef = ref => {
        if (ref && typeof ref === 'object') {
            const id = ref.id || (ref.name ? resolveName(ref.name) : null);
            return { name: (id && resolveName.nameOf(id)) || ref.name || null, id };
        }
        if (ref) return { name: resolveName.nameOf(resolveName(ref)) || ref, id: resolveName(ref) };
        return { name: null, id: null };
    };
    const ensurePlayer = (id, name) => {
        if (!acc.players.has(id)) {
            acc.players.set(id, { id, name, thrown: 0, caught: 0, assists: 0, goals: 0, attemptsThrown: 0, attemptsCaught: 0 });
        }
        return acc.players.get(id);
    };
    const ensurePair = (t, r) => {
        const key = pairKey(t.id, r.id);
        if (!acc.pairs.has(key)) acc.pairs.set(key, emptyPair(t, r));
        return acc.pairs.get(key);
    };

    (game && game.points || []).forEach(point => {
        if (!point || !point.winner) return;   // in-progress point, same rule as the stats
        (point.possessions || []).forEach(poss => {
            (poss.events || []).forEach(ev => {
                if (!ev) return;
                if (ev.type === 'Throw') {
                    const t = resolveRef(ev.thrower), r = resolveRef(ev.receiver);
                    if (!t.id || !r.id || !t.name || !r.name) return;
                    const pair = ensurePair(t, r);
                    pair.completions++; pair.attempts++;
                    if (ev.huck_flag) { pair.hucks++; pair.huckAttempts++; }
                    if (ev.score_flag) pair.goals++;
                    const tp = ensurePlayer(t.id, t.name), rp = ensurePlayer(r.id, r.name);
                    tp.thrown++; tp.attemptsThrown++;
                    rp.caught++; rp.attemptsCaught++;
                    if (ev.score_flag) { tp.assists++; rp.goals++; }
                } else if (ev.type === 'Turnover') {
                    const t = resolveRef(ev.thrower), r = resolveRef(ev.receiver);
                    if (!t.id || !r.id || !t.name || !r.name) return;
                    const pair = ensurePair(t, r);
                    pair.attempts++;
                    if (ev.huck_flag) pair.huckAttempts++;
                    if (ev.drop_flag) pair.drops++; else pair.throwaways++;
                    ensurePlayer(t.id, t.name).attemptsThrown++;
                    ensurePlayer(r.id, r.name).attemptsCaught++;
                }
            });
        });
    });
}

/**
 * Build the connections for one game or a list of games.
 *
 * @param {object|Array<object>} games
 * @returns {{
 *   pairs: Array<object>,     every thrower→receiver pair, most completions first
 *   players: Array<object>,   {id, name, thrown, caught, assists, goals, …}, most involved first
 *   totals: {completions: number, attempts: number, goals: number},
 * }}
 */
function buildConnections(games) {
    const list = Array.isArray(games) ? games : (games ? [games] : []);
    const acc = { pairs: new Map(), players: new Map() };
    list.forEach(g => accumulateConnections(g, acc));

    const byName = (a, b) => a.throwerName.localeCompare(b.throwerName) || a.receiverName.localeCompare(b.receiverName);
    const pairs = Array.from(acc.pairs.values()).sort((a, b) =>
        b.completions - a.completions || b.attempts - a.attempts || b.goals - a.goals || byName(a, b));
    const players = Array.from(acc.players.values()).sort((a, b) =>
        (b.thrown + b.caught) - (a.thrown + a.caught) || a.name.localeCompare(b.name));
    const totals = pairs.reduce((t, p) => {
        t.completions += p.completions; t.attempts += p.attempts; t.goals += p.goals; return t;
    }, { completions: 0, attempts: 0, goals: 0 });
    return { pairs, players, totals };
}

/**
 * The matrix form: throwers down the side (by passes thrown), receivers
 * across the top (by passes caught), and a lookup of the pair in each cell.
 * `max` is the largest completion count, for shading.
 *
 * @param {ReturnType<buildConnections>} conn
 */
function buildConnectionMatrix(conn) {
    const throwers = conn.players.filter(p => p.attemptsThrown > 0)
        .sort((a, b) => b.thrown - a.thrown || a.name.localeCompare(b.name));
    const receivers = conn.players.filter(p => p.attemptsCaught > 0)
        .sort((a, b) => b.caught - a.caught || a.name.localeCompare(b.name));
    const cells = {};
    let max = 0;
    conn.pairs.forEach(pair => {
        (cells[pair.throwerId] ||= {})[pair.receiverId] = pair;
        if (pair.completions > max) max = pair.completions;
    });
    return { throwers, receivers, cells, max };
}

/**
 * Each thrower's favourite target and each receiver's main source, from the
 * sorted pair list (first pair seen per player wins, i.e. most completions).
 * Only pairs with at least one completion count.
 */
function favouriteTargets(conn) {
    const targetOf = new Map(), sourceOf = new Map();
    conn.pairs.forEach(pair => {
        if (pair.completions < 1) return;
        if (!targetOf.has(pair.throwerId)) targetOf.set(pair.throwerId, pair);
        if (!sourceOf.has(pair.receiverId)) sourceOf.set(pair.receiverId, pair);
    });
    return { targetOf, sourceOf };
}

// --- ES-module exports ---
export { buildConnections, buildConnectionMatrix, favouriteTargets, accumulateConnections };
