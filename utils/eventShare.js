/*
 * Event share links — the pure half (no DOM, no fetch), unit-tested.
 *
 * An event share link (teams/shareGuest.js) opens an event's public payload:
 * the event (name, phases) and a card per game (names, score, timing, and a
 * per-game change stamp). This module turns those cards into what the event
 * screen draws (teams/shareEventScreen.js) and works out, on each poll, which
 * games have to be refetched.
 */

// A game with no end timestamp counts as LIVE only if it changed this
// recently — otherwise it's just unfinished (coach forgot to end it). Same
// threshold the single-game guest uses for its badge.
const LIVE_RECENCY_MS = 30 * 60 * 1000;

/**
 * Bucket an event's game cards by phase, in the event's phase order, with an
 * "Unassigned" bucket last for games carrying no (or an unknown) phase. An
 * event with no phases yields one unlabelled bucket. Empty buckets are left
 * out. Mirrors the coach's team list (teams/teamList.js renderEventContainer).
 *
 * @param {Array<object>} cards - public game cards, already in display order
 * @param {Array<string>} [phases]
 * @returns {Array<{label: string|null, games: Array<object>, unassigned: boolean}>}
 */
function groupCardsByPhase(cards, phases) {
    const list = cards || [];
    const order = (phases || []).filter(p => typeof p === 'string' && p);
    if (!order.length) return list.length ? [{ label: null, games: list, unassigned: false }] : [];
    const buckets = new Map(order.map(p => [p, []]));
    const unassigned = [];
    list.forEach(card => {
        if (card.phase && buckets.has(card.phase)) buckets.get(card.phase).push(card);
        else unassigned.push(card);
    });
    const out = [];
    buckets.forEach((games, label) => { if (games.length) out.push({ label, games, unassigned: false }); });
    if (unassigned.length) out.push({ label: 'Unassigned', games: unassigned, unassigned: true });
    return out;
}

/**
 * A card's status: 'final' once the game ended; 'live' while unfinished and
 * recently changed; 'stale' when unfinished and quiet (abandoned, or the
 * coach never tapped End Game).
 * @param {object} card - {gameEndTimestamp, updatedAt}
 * @param {number} [now] - epoch ms
 */
function cardStatus(card, now = Date.now()) {
    if (!card) return 'stale';
    if (card.gameEndTimestamp) return 'final';
    const changed = card.updatedAt ? Date.parse(card.updatedAt) : NaN;
    return Number.isFinite(changed) && (now - changed) < LIVE_RECENCY_MS ? 'live' : 'stale';
}

/** The label a status chip shows. */
function statusLabel(status) {
    return status === 'final' ? 'Final' : status === 'live' ? 'Live' : 'In progress';
}

/**
 * Which games a guest has to (re)fetch after the event payload moved: cards
 * whose stamp is new or differs from the one held. Also which held games are
 * no longer listed (removed from the event, or deleted), to drop from the
 * cache.
 *
 * @param {Object<string,string>} held - gameId → version the guest holds
 * @param {Array<object>} cards - the fresh cards ({id, version})
 * @returns {{fetch: Array<string>, drop: Array<string>}}
 */
function diffEventGames(held, cards) {
    const current = new Set((cards || []).map(c => c.id));
    const fetch = (cards || []).filter(c => !held || held[c.id] !== c.version).map(c => c.id);
    const drop = Object.keys(held || {}).filter(id => !current.has(id));
    return { fetch, drop };
}

/**
 * The `game` a share URL points into (`/?share=<hash>&game=<id>`), or null.
 * Ids are `{sanitized-name}-{hash}` / `{date}_{team}_vs_{opp}_{hash}`: only
 * [A-Za-z0-9_-], which is also what the server's validate_id accepts.
 * @param {string} search - location.search
 */
function shareGameParam(search) {
    const id = new URLSearchParams(search || '').get('game');
    return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/**
 * The URL for the event screen (`gameId` null) or one of its games, on the
 * root path with every other query parameter kept (a dev `?api=` override).
 * @param {string} search - location.search
 * @param {string} hash
 * @param {string|null} gameId
 */
function shareGuestUrl(search, hash, gameId) {
    const q = new URLSearchParams(search || '');
    q.set('share', hash);
    if (gameId) q.set('game', gameId); else q.delete('game');
    return `/?${q.toString()}`;
}

// --- ES-module exports ---
export {
    groupCardsByPhase, cardStatus, statusLabel, diffEventGames,
    shareGameParam, shareGuestUrl, LIVE_RECENCY_MS,
};
