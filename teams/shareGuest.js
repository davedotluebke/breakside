/*
 * Share guest — the app behind /view/{hash} share links.
 *
 * A share link opens the PWA in a read-only GUEST session: no account, no
 * Supabase, no team loaded. The shared game is read through the public
 * /api/share endpoints, projected server-side to what an anonymous visitor
 * may see (see routers/shares.py), and rendered on the Review screen
 * (teams/gameSummary.js) — the same stats table, game log and field replay
 * a coach sees for a stored game, with editing and every account-only
 * control hidden. Live games poll a change stamp and refresh in place.
 *
 * Until 2026-09 this was a separate viewer app under breakside_server/
 * static/viewer/ with its own copy of the event phrasing and its own
 * palette; the route now lives here so those never drift again.
 *
 * Boot: main.js initializeApp() calls matchShareRoute() BEFORE auth and
 * hands off to startShareGuest() when the URL is a share link. The route is
 * reachable on every origin: S3's 404 fallback serves index.html for
 * /view/*, scripts/dev-server.sh does the same, and the API host redirects
 * to the canonical www URL.
 */
import { API_BASE_URL } from '../store/sync.js';
import { hydrateGame } from '../store/models.js';
import { applyTheme, getPreference } from '../utils/theme.js';
import { showScreen } from '../screens/navigation.js';
import { showGameSummaryForShare, refreshGameSummaryForShare } from './gameSummary.js';

const POLL_INTERVAL = 3000; // 3 seconds
// A game with no end timestamp counts as LIVE only if it changed this
// recently — otherwise it's just unfinished (coach forgot to end it).
const LIVE_RECENCY_MS = 30 * 60 * 1000;
const THEME_STORAGE_KEY = 'breakside_advanced_settings';

let currentShareHash = null;
let lastShareStamp = null;
let shareFetchInFlight = false;
// Whether the game has been rendered at least once. Decides between the
// two "share died" presentations; deliberately NOT keyed on lastShareStamp,
// which stays null against a backend that predates the change stamp.
let shareGameRendered = false;
let pollingInterval = null;
// Player id → display name (nickname preferred), from the roster snapshot.
let playerIdToName = {};

const $ = id => document.getElementById(id);

/**
 * The share hash when the current URL is a share link, else null.
 * /view/<hash> is the canonical form (what the Share dialog mints);
 * ?share=<hash> is accepted too.
 */
function matchShareRoute() {
    const m = location.pathname.match(/^\/view\/([A-Za-z0-9]+)\/?$/);
    if (m) return m[1];
    const q = new URLSearchParams(location.search).get('share');
    return (q && /^[A-Za-z0-9]+$/.test(q)) ? q : null;
}

function isShareGuest() {
    return currentShareHash !== null;
}

/** Enter guest mode for one shared game: public endpoints, live polling. */
function startShareGuest(hash) {
    currentShareHash = hash;
    document.body.classList.add('share-guest');

    // A guest has no reason to sit on the app's dark-by-default: the app
    // defaults to dark for sideline battery life, a spectator's phone should
    // just follow the device. A stored preference (a coach opening a link
    // on their own phone) still wins — index.html's pre-paint boot makes the
    // same call, so this only re-applies it.
    if (!hasStoredThemePreference()) applyTheme('auto');

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
        } else if (!pollingInterval && shareGameRendered) {
            pollSharedGame();
            pollingInterval = setInterval(pollSharedGame, POLL_INTERVAL);
        }
    });
}

function hasStoredThemePreference() {
    try {
        const store = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || '{}') || {};
        return ['auto', 'light', 'dark'].includes(store['display.theme']);
    } catch (e) {
        return false;
    }
}

/**
 * Full fetch of the shared game (initial load + whenever the poll stamp
 * moves). 404/410 before anything rendered → dedicated error screen;
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
        renderSharedGame(body.game);
        shareGameRendered = true;
        setConnection('connected');
    } catch (error) {
        console.error('Shared game fetch failed:', error);
        setConnection('disconnected');
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
        // backend is simply older the page keeps updating, just less
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
            setConnection('connected');
        }
    } catch (error) {
        console.error('Share poll failed:', error);
        setConnection('disconnected');
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
        const banner = $('shareExpiredBanner');
        if (banner) banner.style.display = '';
        setStatusBadge(null);
        setConnection('disconnected');
        return;
    }

    const title = $('shareErrorTitle');
    const message = $('shareErrorMessage');
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
    showScreen('shareErrorScreen');
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

/**
 * Resolve a player id to its display name (nickname if present, otherwise
 * name). Point rosters and legacy events carry bare NAMES in some data eras
 * and IDS in others; an id that isn't in the roster snapshot falls back to
 * the name portion of the id (everything before the `-hash` suffix).
 */
function resolvePlayerName(playerId) {
    if (!playerId) return 'Unknown';
    if (playerIdToName[playerId]) return playerIdToName[playerId];
    if (!playerId.includes('-') || playerId.length < 6) return playerId;
    const lastHyphen = playerId.lastIndexOf('-');
    return lastHyphen > 0 ? playerId.substring(0, lastHyphen) : playerId;
}

/** hydrateGame's resolver: the event's own name wins, else the id lookup. */
function resolveEventName(id, name) {
    if (name) return name;
    return id ? resolvePlayerName(id) : null;
}

function renderSharedGame(raw) {
    playerIdToName = {};
    ((raw.rosterSnapshot && raw.rosterSnapshot.players) || []).forEach(p => {
        playerIdToName[p.id] = p.nickname || p.name;
    });
    const game = hydrateGame(raw, resolveEventName);
    const live = !game.gameEndTimestamp;
    if (shareGameRendered) {
        refreshGameSummaryForShare(game);
    } else {
        showGameSummaryForShare(game, { live });
    }
    renderStatusBadge(game);
}

/**
 * LIVE / IN PROGRESS / FINAL badge next to the score.
 * LIVE requires recent activity, not just a missing end timestamp —
 * a game abandoned without "End Game" months ago is not live.
 */
function renderStatusBadge(game) {
    if (game.gameEndTimestamp) {
        setStatusBadge('final', 'Final');
        return;
    }
    const stampMs = lastShareStamp ? Number(lastShareStamp) / 1e6 : NaN;
    const isRecent = Number.isFinite(stampMs) && (Date.now() - stampMs) < LIVE_RECENCY_MS;
    setStatusBadge(isRecent ? 'live' : 'stale', isRecent ? 'Live' : 'In progress');
}

function setStatusBadge(kind, label) {
    const badge = $('shareStatusBadge');
    if (!badge) return;
    if (!kind) {
        badge.style.display = 'none';
        return;
    }
    badge.textContent = label;
    badge.className = `share-status-badge status-${kind}`;
    badge.style.display = '';
}

function setConnection(state) {
    const el = $('shareConnection');
    if (!el) return;
    el.className = `share-connection ${state}`;
    el.textContent = state === 'connected' ? 'Connected' : 'Disconnected';
}

// --- ES-module exports ---
export { matchShareRoute, startShareGuest, isShareGuest };
