/*
 * Breakside public game viewer — the page behind /view/{hash} share links.
 *
 * One shared game, read through the public /api/share endpoints, polled while
 * the game is live. Nothing here needs an account, and the page never has
 * anywhere else to go.
 *
 * This is an ES module that imports the PWA's LEAF modules by URL-relative
 * path: from /viewer/ on S3 `../` is the PWA root, and from /static/viewer/
 * on the API host it is the /static/{playByPlay,store,utils,settings,css}
 * mounts main.py adds. Only leaf modules may be reached — nothing that
 * touches store/storage.js, utils/helpers.js or game/* — and
 * tests/unit/replayLeafGraph.test.mjs pins the allowlist.
 *
 * What is shared, and therefore never drifts from the app:
 *   - the game log itself: buildGameLogEntries (utils/gameLogRenderer.js)
 *     is THE renderer of the play-by-play; this file only groups its entries
 *     into one card per point and styles them. Event phrasing, possession
 *     boundaries, score lines: all the app's.
 *   - the events: raw share JSON becomes model instances through
 *     hydrateGame (store/models.js) so the entries can summarize() them.
 *   - the field replay: mountReplayView (playByPlay/replayView.js), the
 *     app's own pitch + transport, with the cards as its log (each line
 *     carries data-entry, exactly like the app's Log tab).
 *   - the palette: css/tokens.css, flipped by data-theme (see applyTheme).
 */
import { mountReplayView } from '../playByPlay/replayView.js';
import { hydrateGame } from '../store/models.js';
import { buildGameLogEntries, escapeHtml } from '../utils/gameLogRenderer.js';

// =============================================================================
// API Configuration
// =============================================================================

/**
 * Where the API lives, given where this page is served from: relative on the
 * API host itself, api.breakside.pro from the S3/CloudFront origins,
 * relative (the dev backend) on localhost.
 */
function getApiBaseUrl() {
    const hostname = window.location.hostname;
    if (hostname === 'api.breakside.pro' || hostname === 'api.breakside.us') return '';
    if (hostname === 'www.breakside.pro' || hostname === 'breakside.pro' ||
        hostname === 'www.breakside.us' || hostname === 'breakside.us' ||
        hostname === 'luebke.us' ||
        hostname.endsWith('.breakside.pro') || hostname.endsWith('.breakside.us')) {
        return 'https://api.breakside.pro';
    }
    return '';
}

const API_BASE_URL = getApiBaseUrl();

const POLL_INTERVAL = 3000; // 3 seconds
// A game with no end timestamp counts as LIVE only if it changed this
// recently — otherwise it's just unfinished (coach forgot to end it).
const LIVE_RECENCY_MS = 30 * 60 * 1000;

const $ = id => document.getElementById(id);

// =============================================================================
// Theme
// =============================================================================

// index.html's <head> already set data-theme before first paint from the same
// inputs; this re-applies (idempotent), swaps the wordmark, and follows the
// device while no explicit preference is stored. A signed-in coach's app
// preference is readable here because the viewer shares the PWA's origin.
const THEME_STORAGE_KEY = 'breakside_advanced_settings';
const THEME_SETTING_KEY = 'display.theme';
const THEME_COLOR = { light: '#ffffff', dark: '#0d0d0d' };
const darkQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function themePreference() {
    try {
        const store = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || '{}') || {};
        const pref = store[THEME_SETTING_KEY];
        if (pref === 'light' || pref === 'dark') return pref;
    } catch (e) { /* no storage: follow the device */ }
    return 'auto';
}

function applyTheme() {
    const pref = themePreference();
    const resolved = pref === 'auto' ? ((darkQuery && darkQuery.matches) ? 'dark' : 'light') : pref;
    const root = document.documentElement;
    if (root.getAttribute('data-theme') !== resolved) root.setAttribute('data-theme', resolved);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR[resolved]);
    document.querySelectorAll('img[data-dark-src]').forEach(img => {
        if (!img.getAttribute('data-light-src')) img.setAttribute('data-light-src', img.getAttribute('src'));
        const want = img.getAttribute(resolved === 'dark' ? 'data-dark-src' : 'data-light-src');
        if (want && !img.src.endsWith(want.replace(/^\.\.\//, ''))) img.src = want;
    });
    // fieldPbp.js paints the pitch from computed token values; tell it the
    // palette moved (the same event utils/theme.js dispatches in the app).
    document.dispatchEvent(new CustomEvent('breakside:theme-changed', { detail: { theme: resolved, preference: pref } }));
}

if (darkQuery) {
    const resync = () => applyTheme();
    if (typeof darkQuery.addEventListener === 'function') darkQuery.addEventListener('change', resync);
    else if (typeof darkQuery.addListener === 'function') darkQuery.addListener(resync);
}

// =============================================================================
// Share session state
// =============================================================================

let currentShareHash = null;
let lastShareStamp = null;
let shareFetchInFlight = false;
// Whether a shared game has been rendered at least once. Decides between the
// two "share died" presentations; deliberately NOT keyed on lastShareStamp,
// which stays null against a backend that predates the change stamp.
let shareGameRendered = false;
let pollingInterval = null;

// The game as last rendered: raw share JSON, its hydrated (model-event) twin,
// and the entry options both the cards and the replay engine were built with
// — the replay must build the SAME entry list so indices line up with the
// cards' data-entry attributes.
let rawGame = null;
let hydrated = null;
let entryOptions = null;
// Player id → display name (nickname preferred), from the roster snapshot.
let playerIdToName = {};

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    applyTheme();

    const infoToggle = $('info-toggle');
    if (infoToggle) {
        infoToggle.addEventListener('click', () => $('game-info-panel').classList.toggle('open'));
    }

    // Tapping a point header toggles the card. Delegated: cards are
    // re-rendered on every poll, and an ES module has no globals for
    // inline handlers anyway.
    $('points-container').addEventListener('click', (e) => {
        const header = e.target.closest('.point-header');
        if (!header || e.target.closest('[data-entry]')) return;
        header.nextElementSibling.classList.toggle('expanded');
    });

    const shareHash = new URLSearchParams(window.location.search).get('share');
    if (!shareHash) {
        handleShareDead(404);
        return;
    }
    showSharedGame(shareHash);
});

// =============================================================================
// Share Mode (public /view/{hash} links)
// =============================================================================

/** Enter share mode: single shared game, public endpoints, live polling. */
function showSharedGame(hash) {
    currentShareHash = hash;
    $('game-view').classList.remove('hidden');
    updateConnectionStatus('connecting');
    loadSharedGame();

    pollingInterval = setInterval(pollSharedGame, POLL_INTERVAL);

    // Parents pocket their phones between points: stop polling while the
    // tab is hidden, catch up immediately when it comes back.
    document.addEventListener('visibilitychange', () => {
        if (!currentShareHash) return;
        if (document.visibilityState === 'hidden') {
            if (pollingInterval) {
                clearInterval(pollingInterval);
                pollingInterval = null;
            }
        } else if (!pollingInterval) {
            pollSharedGame();
            pollingInterval = setInterval(pollSharedGame, POLL_INTERVAL);
        }
    });
}

/**
 * Full fetch of the shared game (initial load + whenever the poll stamp
 * moves). 404/410 before anything rendered → dedicated error view;
 * 410 after we have content → banner over the last-known state.
 */
async function loadSharedGame() {
    if (shareFetchInFlight) return;
    shareFetchInFlight = true;
    try {
        const response = await fetch(`${API_BASE_URL}/api/share/${currentShareHash}`);

        if (response.status === 404 || response.status === 410) {
            handleShareDead(response.status);
            return;
        }
        if (!response.ok) {
            throw new Error(`Failed to fetch shared game: ${response.statusText}`);
        }

        const body = await response.json();
        lastShareStamp = body.version || null;

        renderGame(body.game);
        renderShareStatusBadge(body.game);
        shareGameRendered = true;
        updateConnectionStatus('connected');
    } catch (error) {
        console.error('Shared game fetch failed:', error);
        updateConnectionStatus('disconnected');
    } finally {
        shareFetchInFlight = false;
    }
}

/** Cheap poll: change stamp only. Refetch the full game when it moves. */
async function pollSharedGame() {
    if (!currentShareHash) return;
    try {
        const response = await fetch(`${API_BASE_URL}/api/share/${currentShareHash}/poll`);

        // 404 is ambiguous: the share vanished, OR this backend predates the
        // poll endpoint (the frontend deploys on push, the API only on the
        // manual EC2 restart — so that pairing is real, not theoretical).
        // Fall back to a full fetch, which every backend has: if the share
        // is genuinely gone its own 404 handling takes over, and if the
        // backend is simply older the viewer keeps updating, just less
        // cheaply. 410 is unambiguous — that endpoint exists and said no.
        if (response.status === 404) {
            await loadSharedGame();
            return;
        }
        if (response.status === 410) {
            handleShareDead(410);
            return;
        }
        if (!response.ok) throw new Error(response.statusText);

        const { version } = await response.json();
        if (version !== lastShareStamp) {
            await loadSharedGame();
        } else {
            updateConnectionStatus('connected');
        }
    } catch (error) {
        console.error('Share poll failed:', error);
        updateConnectionStatus('disconnected');
    }
}

/**
 * The share stopped resolving (expired, revoked, or never existed).
 * Stop polling; keep whatever is on screen with a banner if we have it.
 */
function handleShareDead(status) {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }

    if (shareGameRendered) {
        // Mid-session death: keep the last state visible, stop pretending
        // it's live.
        $('share-expired-banner').style.display = '';
        setStatusBadge(null);
        updateConnectionStatus('disconnected');
        return;
    }

    $('game-view').classList.add('hidden');
    $('share-error-view').classList.remove('hidden');
    const title = $('share-error-title');
    const message = $('share-error-message');
    if (status === 410) {
        title.textContent = 'This link has expired';
        message.textContent =
            'The coach’s share link for this game has expired or been turned off. ' +
            'Ask them for a fresh link.';
    } else {
        title.textContent = 'Game not found';
        message.textContent =
            'This share link isn’t valid — check that the whole link was copied.';
    }
    updateConnectionStatus('disconnected');
}

/**
 * LIVE / IN PROGRESS / FINAL badge next to the score.
 * LIVE requires recent activity, not just a missing end timestamp —
 * a game abandoned without "End Game" months ago is not live.
 */
function renderShareStatusBadge(game) {
    if (game.gameEndTimestamp) {
        setStatusBadge('final', 'Final');
        return;
    }
    const stampMs = lastShareStamp ? Number(lastShareStamp) / 1e6 : NaN;
    const isRecent = Number.isFinite(stampMs) && (Date.now() - stampMs) < LIVE_RECENCY_MS;
    if (isRecent) {
        setStatusBadge('live', 'Live');
    } else {
        setStatusBadge('stale', 'In progress');
    }
}

function setStatusBadge(kind, label) {
    const badge = $('game-status-badge');
    if (!badge) return;
    if (!kind) {
        badge.style.display = 'none';
        return;
    }
    badge.textContent = label;
    badge.className = `game-status-badge status-${kind}`;
    badge.style.display = '';
}

function updateConnectionStatus(status) {
    const el = $('connection-status');
    if (!el) return;
    el.className = `status-badge ${status}`;
    el.textContent = { connecting: 'Connecting...', connected: 'Connected', disconnected: 'Disconnected' }[status] || status;
}

// =============================================================================
// Player names
// =============================================================================

/**
 * Resolve a player id to its display name (nickname if present, otherwise
 * name). Point rosters and legacy events carry bare NAMES in some data eras
 * and IDS in others; an id that isn't in the roster snapshot falls back to
 * the name portion of the id (everything before the `-hash` suffix).
 */
function resolvePlayerName(playerId) {
    if (!playerId) return 'Unknown';
    if (playerIdToName[playerId]) return playerIdToName[playerId];
    // Not id-shaped (no hyphen + 4-char suffix): already a name.
    if (!playerId.includes('-') || playerId.length < 6) return playerId;
    const lastHyphen = playerId.lastIndexOf('-');
    return lastHyphen > 0 ? playerId.substring(0, lastHyphen) : playerId;
}

/** hydrateGame's resolver: the event's own name wins, else the id lookup. */
function resolveEventName(id, name) {
    if (name) return name;
    return id ? resolvePlayerName(id) : null;
}

function buildPlayerLookup(game) {
    playerIdToName = {};
    const players = (game.rosterSnapshot && game.rosterSnapshot.players) || [];
    players.forEach(player => {
        playerIdToName[player.id] = player.nickname || player.name;
    });
}

/** Jersey numbers for replay actor labels, when the roster snapshot carries them. */
function playerByName(name) {
    const players = (rawGame && rawGame.rosterSnapshot && rawGame.rosterSnapshot.players) || [];
    const p = players.find(x => x && (x.name === name || x.nickname === name));
    return p ? { name, number: p.number != null ? p.number : null } : null;
}

// =============================================================================
// Rendering
// =============================================================================

function renderGame(game) {
    rawGame = game;
    buildPlayerLookup(game);
    hydrated = hydrateGame(game, resolveEventName);
    entryOptions = {
        teamName: game.team || 'Team',
        opponentName: game.opponent || 'Opponent',
        resolvePlayerName: entry => resolvePlayerName(entry),
    };

    renderHeader(game);
    renderCards(game);
    updateReplay(game);
}

function renderHeader(game) {
    $('game-title').textContent = `${game.team} vs ${game.opponent}`;

    const date = new Date(game.gameStartTimestamp);
    $('game-date').textContent = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const scores = game.scores || { team: 0, opponent: 0 };
    const teamScore = scores.team || scores[game.team] || 0;
    const oppScore = scores.opponent || scores[game.opponent] || 0;
    $('game-score').textContent = `${teamScore} - ${oppScore}`;

    $('total-points').textContent = (game.points || []).length;

    // Duration = wall-clock time from start to end. In progress → "--:--":
    // wall-clock from weeks ago is meaningless.
    let duration = '--:--';
    if (game.gameStartTimestamp && game.gameEndTimestamp) {
        duration = formatDuration(Math.floor((new Date(game.gameEndTimestamp) - new Date(game.gameStartTimestamp)) / 1000));
    }
    $('game-duration').textContent = duration;

    // Play Time = sum of point durations (excludes timeouts, halftime, etc.)
    let totalPlayedMs = 0;
    (game.points || []).forEach(point => { if (point.totalPointTime) totalPlayedMs += point.totalPointTime; });
    $('game-play-time').textContent = totalPlayedMs > 0 ? formatDuration(Math.floor(totalPlayedMs / 1000)) : '--:--';
}

/**
 * One card per point, its body the shared game log's entries for that point
 * (everything but the 'roster' entry, which becomes the card title). Each
 * line carries data-entry = its index in the entry list, which is what the
 * replay view marks (rv-cur / rv-future) and seeks by on tap.
 */
function renderCards(game) {
    const container = $('points-container');
    const entries = buildGameLogEntries(hydrated, entryOptions);
    const byPoint = new Map();
    entries.forEach((entry, index) => {
        if (entry.pointIdx === null || entry.pointIdx === undefined) return;
        if (!byPoint.has(entry.pointIdx)) byPoint.set(entry.pointIdx, []);
        byPoint.get(entry.pointIdx).push({ entry, index });
    });

    // Preserve which cards the reader has open across re-renders.
    const expandedPoints = new Set();
    container.querySelectorAll('.point-content.expanded').forEach(el => {
        expandedPoints.add(el.getAttribute('data-point-index'));
    });
    const isNearBottom = (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 100;

    container.innerHTML = '';
    const points = game.points || [];
    points.forEach((point, index) => {
        const card = createPointCard(point, index, byPoint.get(index) || [], game);
        container.appendChild(card);
        const isLast = index === points.length - 1;
        const isInProgress = !point.winner;
        if (expandedPoints.has(String(index)) || (isLast && (isInProgress || expandedPoints.size === 0))) {
            card.querySelector('.point-content').classList.add('expanded');
        }
    });

    if (isNearBottom) window.scrollTo(0, document.body.scrollHeight);
}

// Event types the stylesheet has a pill colour for. `event.type` is
// attacker-controlled and lands in a class attribute, where escaping alone
// would still let it inject extra classes — so the class comes from this
// allowlist and the visible label is escaped separately.
const KNOWN_EVENT_TYPES = ['Throw', 'Turnover', 'Defense', 'Pull', 'Violation', 'Other'];

/**
 * HTML for one game-log entry as a card line. Every non-literal string is
 * escaped: game data reaches the viewer straight from storage, and this page
 * shares the PWA's origin (where the Supabase tokens live), so script
 * execution here would be account takeover, not a contained defacement.
 */
function renderEntry({ entry, index }) {
    const text = escapeHtml(entry.text.trim());
    const attr = `data-entry="${index}"`;
    switch (entry.kind) {
        case 'event':
        case 'after': {
            const type = entry.event ? String(entry.event.type || '') : '';
            const typeClass = KNOWN_EVENT_TYPES.includes(type) ? type : 'Unknown';
            return `<div class="log-line event-item" ${attr}>` +
                `<span class="event-type ${typeClass}">${escapeHtml(type)}</span>` +
                `<span class="event-desc">${text}</span></div>`;
        }
        case 'possession':
            return `<div class="log-line possession-header ${entry.side === 'us' ? 'possession-offense' : 'possession-defense'}" ${attr}>${text}</div>`;
        case 'score':
            return `<div class="log-line score-line ${entry.side === 'us' ? 'our-score' : 'their-score'}" ${attr}>${text}</div>`;
        case 'currentscore':
            return `<div class="log-line current-score" ${attr}>${text}</div>`;
        case 'pullnote':
            return `<div class="log-line pull-note" ${attr}>${text}</div>`;
        case 'periodnote':
            return `<div class="log-line period-note" ${attr}>${text}</div>`;
        default:
            return '';
    }
}

function createPointCard(point, index, pointEntries, game) {
    const div = document.createElement('div');
    div.className = 'point-card';
    div.setAttribute('data-point', index);

    let resultClass = '';
    let resultText = 'In Progress';
    if (point.winner) {
        if (point.winner === 'team' || point.winner === game.team) {
            resultClass = 'our-score';
            resultText = `${game.team} Score`;
        } else {
            resultClass = 'their-score';
            resultText = `${game.opponent} Score`;
        }
    }

    const durationSeconds = point.totalPointTime ? Math.floor(point.totalPointTime / 1000) : 0;
    const rosterList = (point.players || []).map(p => resolvePlayerName(p)).join(', ');
    const lines = pointEntries.filter(({ entry }) => entry.kind !== 'roster').map(renderEntry).join('');

    // rosterList and resultText are coach-entered names; the index is a loop
    // counter and resultClass one of two literals.
    div.innerHTML = `
        <div class="point-header">
            <div class="point-title">
                <span>Point ${index + 1}: ${escapeHtml(rosterList)}</span>
                <span class="point-score-summary">Duration: ${formatDuration(durationSeconds)}</span>
            </div>
            <span class="point-result ${resultClass}">${escapeHtml(resultText)}</span>
        </div>
        <div class="point-content" data-point-index="${index}">
            ${lines || '<div class="log-line empty-line">No plays yet</div>'}
        </div>
    `;
    return div;
}

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// =============================================================================
// Field replay (the PWA's playByPlay/replayView.js above the cards)
// =============================================================================

let view = null;
let offField = null;

/** Keep the card under the playhead open and its line in view. */
function followPlayhead({ index, state }) {
    const host = $('points-container');
    if (!host || !view) return;
    if (state && state.pointIdx !== null && state.pointIdx !== undefined) {
        const content = host.querySelector(`.point-card[data-point="${state.pointIdx}"] .point-content`);
        if (content && !content.classList.contains('expanded')) content.classList.add('expanded');
    }
    const line = host.querySelector(`[data-entry="${index}"]`);
    if (line && typeof line.scrollIntoView === 'function') line.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

/**
 * The page header is sticky too: stack the stage under it, not behind it.
 * The header's height changes with the viewport (it wraps on a phone), so
 * this runs on every update and on resize.
 */
function stackUnderHeader() {
    const host = $('replay-host');
    const header = document.querySelector('.main-header');
    if (!host || !header) return;
    if (/sticky|fixed/.test(getComputedStyle(header).position)) {
        host.style.top = `${Math.round(header.getBoundingClientRect().height)}px`;
    }
}
window.addEventListener('resize', stackUnderHeader);

function updateReplay(game) {
    const host = $('replay-host'), logEl = $('points-container');
    if (!host || !logEl) return;
    stackUnderHeader();
    try {
        if (!view) {
            // Mounts only once the game has located events; until then this
            // returns null and is retried on the next update.
            view = mountReplayView({
                host, logEl,
                getGame: () => hydrated,
                getEntryOptions: () => entryOptions,
                getPlayerByName: playerByName,
                live: !game.gameEndTimestamp,
            });
            if (!view) return;
            offField = view.controller.on('field', followPlayhead);
            view.onShown();
            return;
        }
        // The cards are new elements: let the view rebuild its engine and
        // re-mark the lines (live-follow animates the new tail).
        view.onLogUpdated();
    } catch (err) {
        console.error('Replay update failed:', err);
    }
}
