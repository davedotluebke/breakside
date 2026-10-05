/*
 * Share guest — the app behind /view/{hash} share links.
 *
 * A share link opens the PWA in a read-only GUEST session: no account, no
 * Supabase, no team loaded. Everything is read through the public /api/share
 * endpoints, projected server-side to what an anonymous visitor may see
 * (see routers/shares.py). A hash opens one of two things:
 *
 *   a game   rendered on the Review screen (teams/gameSummary.js) — the
 *            same stats table, game log and field replay a coach sees for a
 *            stored game, with editing and every account-only control
 *            hidden. A live game polls a change stamp and refreshes in
 *            place.
 *   an event the shared-event screen (teams/shareEventScreen.js): the
 *            event's games with a status each and the event's stats, built
 *            in the browser from the games fetched through the link. Tapping
 *            a game shows it on the Review screen exactly as a game share
 *            would, with a back button to the event; the URL carries the
 *            game as ?game=<id> so the browser's own Back works and the
 *            address bar is a link to that game.
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
import { applyTheme, isDark } from '../utils/theme.js';
import { setGuestStatsLevel } from '../utils/statsAudience.js';
import { showScreen } from '../screens/navigation.js';
import { showGameSummaryForShare, refreshGameSummaryForShare } from './gameSummary.js';
import { renderShareEvent } from './shareEventScreen.js';
import { diffEventGames, shareGameParam, shareGuestUrl, LIVE_RECENCY_MS } from '../utils/eventShare.js';

const POLL_INTERVAL = 3000; // 3 seconds

let currentShareHash = null;
// Stamp of whatever is being polled right now: the game (a game share, or
// an event's game on screen) or the event payload.
let lastShareStamp = null;
let shareFetchInFlight = false;
// Whether something has been rendered at least once. Decides between the
// two "share died" presentations; deliberately NOT keyed on lastShareStamp,
// which stays null against a backend that predates the change stamp.
let shareRendered = false;
// Whether the Review screen currently shows a game (so a poll refresh goes
// through refreshGameSummaryForShare and keeps the replay's playhead).
let shareGameRendered = false;
let pollingInterval = null;
// Player id → display name (nickname preferred), from the roster snapshot
// of the game on screen.
let playerIdToName = {};

// Event mode (the hash opened an event). `games` holds the hydrated games
// fetched so far, keyed by id; `stamps` the version each was fetched at.
let eventShare = null;   // { event, cards, games: {}, stamps: {} }
let currentGameId = null; // the event's game on screen, or null = the event screen
let eventLoadInFlight = false;
let popstateWired = false;

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

/** Enter guest mode for one share link: public endpoints, live polling. */
function startShareGuest(hash) {
    currentShareHash = hash;
    document.body.classList.add('share-guest');

    // Theme: utils/theme.js getPreference() knows it is on a share route and
    // ranks the guest's own footer toggle above the app setting, and the
    // device above the app's dark default; index.html's pre-paint boot
    // makes the same call. Nothing to apply here — only the footer to wire.
    wireGuestFooter();

    // An event link may point straight into one of its games.
    currentGameId = shareGameParam(location.search);

    loadShare();
    pollingInterval = setInterval(pollShare, POLL_INTERVAL);

    // Parents pocket their phones between points: stop polling while the
    // tab is hidden, catch up immediately when it comes back.
    document.addEventListener('visibilitychange', () => {
        if (!currentShareHash) return;
        if (document.visibilityState === 'hidden') {
            if (pollingInterval) {
                clearInterval(pollingInterval);
                pollingInterval = null;
            }
        } else if (!pollingInterval && shareRendered) {
            pollShare();
            pollingInterval = setInterval(pollShare, POLL_INTERVAL);
        }
    });
}

// The guest's own theme pick; utils/theme.js reads the same key (and
// index.html's pre-paint boot), so it wins on every later load too.
const GUEST_THEME_KEY = 'breakside_share_theme';
// The public-page notice is dismissed per browser session: a fresh visit
// (new tab, next day) shows it again.
const NOTICE_DISMISSED_KEY = 'breakside_share_notice_dismissed';

/** The footer's light/dark toggle and the dismissable public-page notice. */
function wireGuestFooter() {
    const toggle = $('shareThemeToggle');
    const paintToggle = () => {
        if (!toggle) return;
        const dark = isDark();
        toggle.innerHTML = `<i class="fas ${dark ? 'fa-sun' : 'fa-moon'}"></i>`;
        toggle.title = dark ? 'Switch to light' : 'Switch to dark';
        toggle.setAttribute('aria-label', toggle.title);
    };
    if (toggle) {
        toggle.addEventListener('click', () => {
            const next = isDark() ? 'light' : 'dark';
            try { localStorage.setItem(GUEST_THEME_KEY, next); } catch (e) { /* private mode */ }
            applyTheme();
            paintToggle();
        });
        // theme.js re-applies the resolved preference on DOMContentLoaded;
        // paint after that, and whenever the palette moves (device flip).
        paintToggle();
        document.addEventListener('breakside:theme-changed', paintToggle);
    }

    const notice = $('shareGuestNotice');
    const dismiss = $('shareNoticeDismiss');
    let dismissed = false;
    try { dismissed = sessionStorage.getItem(NOTICE_DISMISSED_KEY) === '1'; } catch (e) { /* no storage */ }
    if (notice && dismissed) notice.style.display = 'none';
    if (dismiss && notice) {
        dismiss.addEventListener('click', () => {
            notice.style.display = 'none';
            try { sessionStorage.setItem(NOTICE_DISMISSED_KEY, '1'); } catch (e) { /* no storage */ }
        });
    }

    // An event's game has a way back to the event (the usual summary back
    // button is hidden for guests: it navigates to team screens).
    const back = $('shareEventBackBtn');
    if (back) back.addEventListener('click', () => backToEvent());
}

/**
 * There is one guest footer (the public-page disclosure and the theme
 * toggle) and two guest screens; move it under whichever is showing.
 */
function placeGuestFooter(screenId) {
    const footer = document.querySelector('.share-guest-footer');
    const screen = $(screenId);
    if (footer && screen && footer.parentElement !== screen) screen.appendChild(footer);
}

// -----------------------------------------------------------------------------
// Fetching
// -----------------------------------------------------------------------------

async function fetchShare(path) {
    const response = await fetch(`${API_BASE_URL}/api/share/${currentShareHash}${path}`);
    if (response.status === 404 || response.status === 410) {
        return { dead: response.status };
    }
    if (!response.ok) throw new Error(`Share fetch failed: ${response.statusText}`);
    return { body: await response.json() };
}

/**
 * Full fetch of what the link opens (initial load + whenever the poll stamp
 * moves). 404/410 before anything rendered → dedicated error screen;
 * 410 after we have content → banner over the last-known state.
 */
async function loadShare() {
    if (shareFetchInFlight) return;
    shareFetchInFlight = true;
    try {
        const { dead, body } = await fetchShare('');
        if (dead) {
            handleShareDead(dead);
            return;
        }
        // The team may hold its viewers (share guests included) to Fun stats.
        setGuestStatsLevel(body.viewerStatsLevel || null);
        if (body.event) {
            await applyEventPayload(body);
        } else {
            lastShareStamp = body.version || null;
            renderSharedGame(body.game);
        }
        shareRendered = true;
        setConnection('connected');
    } catch (error) {
        console.error('Shared fetch failed:', error);
        setConnection('disconnected');
    } finally {
        shareFetchInFlight = false;
    }
}

/** Cheap poll: change stamp only. Refetch when it moves. */
async function pollShare() {
    if (!currentShareHash) return;
    const gameOnScreen = eventShare && currentGameId;
    const pollPath = gameOnScreen ? `/games/${encodeURIComponent(currentGameId)}/poll` : '/poll';
    try {
        const response = await fetch(`${API_BASE_URL}/api/share/${currentShareHash}${pollPath}`);

        // 404 is ambiguous: the share vanished, OR this backend predates the
        // poll endpoint (the frontend deploys on push, the API only on the
        // manual EC2 restart — so that pairing is real, not theoretical).
        // Fall back to a full fetch, which every backend has: if the share
        // is genuinely gone its own 404 handling takes over, and if the
        // backend is simply older the page keeps updating, just less
        // cheaply. 410 is unambiguous — that endpoint exists and said no.
        // For an event's game, a 404 can also mean the game left the event:
        // the full event fetch below notices and shows the event instead.
        if (response.status === 404) {
            await loadShare();
            return;
        }
        if (response.status === 410) {
            handleShareDead(410);
            return;
        }
        if (!response.ok) throw new Error(response.statusText);

        const { version } = await response.json();
        if (version !== lastShareStamp) {
            if (gameOnScreen) await refreshEventGame(currentGameId);
            else await loadShare();
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

    if (shareRendered) {
        // Mid-session death: keep the last state visible, stop pretending
        // it's live. Both guest screens carry a banner.
        ['shareExpiredBanner', 'shareEventExpiredBanner'].forEach(id => {
            const banner = $(id);
            if (banner) banner.style.display = '';
        });
        setStatusBadge(null);
        setConnection('disconnected');
        return;
    }

    // A dead link answers before saying whether it opened a game or an
    // event, so the wording names neither.
    const title = $('shareErrorTitle');
    const message = $('shareErrorMessage');
    if (status === 410) {
        title.textContent = 'This link has expired';
        message.textContent =
            'The coach’s share link has expired or been turned off. ' +
            'Ask them for a fresh link.';
    } else {
        title.textContent = 'Link not found';
        message.textContent =
            'This share link isn’t valid — check that the whole link was copied.';
    }
    showScreen('shareErrorScreen');
}

// -----------------------------------------------------------------------------
// Event mode
// -----------------------------------------------------------------------------

/**
 * Take a fresh event payload: fetch the games whose stamp moved (all of
 * them the first time), drop the ones no longer listed, then draw whatever
 * the guest is looking at — the event screen, or one of its games.
 */
async function applyEventPayload(body) {
    if (!eventShare) {
        eventShare = { event: body.event, cards: body.games || [], games: {}, stamps: {} };
        document.body.classList.add('share-event-guest');
        wirePopstate();
    } else {
        eventShare.event = body.event;
        eventShare.cards = body.games || [];
    }
    // The event screen's stamp; a game on screen polls its own.
    if (!currentGameId) lastShareStamp = body.version || null;

    const { fetch: toFetch, drop } = diffEventGames(eventShare.stamps, eventShare.cards);
    drop.forEach(id => { delete eventShare.games[id]; delete eventShare.stamps[id]; });

    // Draw the list at once (cards are enough for it), then fill the stats
    // as the games arrive. Fetches run together; a failed one is retried by
    // the next poll, since its stamp stays unrecorded.
    if (!currentGameId) renderEventScreen();
    if (eventLoadInFlight) return;
    eventLoadInFlight = true;
    try {
        await Promise.all(toFetch.map(id => loadEventGame(id).catch(err => {
            console.error('Event game fetch failed:', id, err);
        })));
    } finally {
        eventLoadInFlight = false;
    }

    if (currentGameId) {
        if (eventShare.games[currentGameId]) {
            showEventGame(currentGameId);
        } else {
            // Pointed at a game the event no longer lists (or a bad ?game=):
            // the event itself is the useful page.
            currentGameId = null;
            history.replaceState({ share: currentShareHash }, '', shareGuestUrl(location.search, currentShareHash, null));
            lastShareStamp = body.version || null;
            renderEventScreen();
        }
    } else {
        renderEventScreen();
    }
}

/** Fetch one of the event's games through the link and cache it hydrated. */
async function loadEventGame(gameId) {
    const { dead, body } = await fetchShare(`/games/${encodeURIComponent(gameId)}`);
    if (dead === 410) { handleShareDead(410); return null; }
    if (dead) {
        // Removed from the event (or deleted) between the cards and now.
        delete eventShare.games[gameId];
        delete eventShare.stamps[gameId];
        return null;
    }
    const card = eventShare.cards.find(c => c.id === gameId);
    const game = hydrateGame(body.game, resolveEventName);
    // The public projection strips the id and the phase (ARCHITECTURE.md
    // § Share Links); the card carries both, and the stats scope needs them.
    game.id = gameId;
    game.phase = card ? card.phase : null;
    eventShare.games[gameId] = game;
    eventShare.stamps[gameId] = body.version || (card ? card.version : null);
    return game;
}

/** The event's game on screen changed: refetch it and redraw in place. */
async function refreshEventGame(gameId) {
    if (shareFetchInFlight) return;
    shareFetchInFlight = true;
    try {
        const game = await loadEventGame(gameId);
        if (!game) {
            // Gone from the event: back to the event page.
            if (currentGameId === gameId) backToEvent();
            return;
        }
        if (currentGameId === gameId) {
            lastShareStamp = eventShare.stamps[gameId];
            renderGameOnSummary(game);
        }
        setConnection('connected');
    } catch (error) {
        console.error('Shared game refresh failed:', error);
        setConnection('disconnected');
    } finally {
        shareFetchInFlight = false;
    }
}

function renderEventScreen() {
    if (!eventShare) return;
    renderShareEvent(eventShare, { onOpenGame: openEventGame });
    placeGuestFooter('shareEventScreen');
    showScreen('shareEventScreen');
}

/** A tap on a game in the list: show it, with the URL to match. */
function openEventGame(gameId) {
    if (!eventShare || !eventShare.games[gameId]) return;
    history.pushState({ share: currentShareHash, game: gameId }, '',
        shareGuestUrl(location.search, currentShareHash, gameId));
    showEventGame(gameId);
}

/** The event's game on screen → the event page. */
function backToEvent() {
    if (!eventShare) return;
    if (history.state && history.state.game) {
        history.back();      // the popstate handler shows the event
        return;
    }
    history.replaceState({ share: currentShareHash }, '', shareGuestUrl(location.search, currentShareHash, null));
    showEventFromHistory();
}

function showEventFromHistory() {
    currentGameId = null;
    shareGameRendered = false;
    setStatusBadge(null);
    renderEventScreen();
    // Catch up on whatever moved while a game was on screen.
    lastShareStamp = null;
    loadShare();
}

/** Browser Back / Forward between the event page and its games. */
function wirePopstate() {
    if (popstateWired) return;
    popstateWired = true;
    window.addEventListener('popstate', () => {
        if (!eventShare) return;
        const gameId = shareGameParam(location.search);
        if (gameId && eventShare.games[gameId]) showEventGame(gameId);
        else if (gameId) { currentGameId = gameId; loadShare(); }
        else showEventFromHistory();
    });
}

/** Put one of the event's games on the Review screen. */
function showEventGame(gameId) {
    const game = eventShare.games[gameId];
    if (!game) return;
    const switching = currentGameId !== gameId || !shareGameRendered;
    currentGameId = gameId;
    lastShareStamp = eventShare.stamps[gameId] || null;
    if (switching) shareGameRendered = false;
    renderGameOnSummary(game);
    const back = $('shareEventBackBtn');
    if (back) {
        back.style.display = '';
        const label = back.querySelector('.title-bar-back-label');
        if (label) label.textContent = eventShare.event.name || 'Event';
    }
    placeGuestFooter('gameSummaryScreen');
}

// -----------------------------------------------------------------------------
// Rendering a game
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

function indexRosterNames(game) {
    playerIdToName = {};
    ((game.rosterSnapshot && game.rosterSnapshot.players) || []).forEach(p => {
        playerIdToName[p.id] = p.nickname || p.name;
    });
}

/** A single-game share: hydrate the public game and show it. */
function renderSharedGame(raw) {
    indexRosterNames(raw);
    renderGameOnSummary(hydrateGame(raw, resolveEventName));
}

/**
 * Show a hydrated game on the Review screen: a full render the first time
 * (or for a different game), an in-place refresh after a poll so the
 * mounted replay keeps its playhead.
 */
function renderGameOnSummary(game) {
    indexRosterNames(game);
    const live = !game.gameEndTimestamp;
    if (shareGameRendered) {
        refreshGameSummaryForShare(game);
    } else {
        showGameSummaryForShare(game, { live });
        shareGameRendered = true;
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

/** The connection pill on both guest screens. */
function setConnection(state) {
    document.querySelectorAll('.share-connection').forEach(el => {
        el.className = `share-connection ${state}`;
        el.textContent = state === 'connected' ? 'Connected' : 'Disconnected';
    });
}

// --- ES-module exports ---
export { matchShareRoute, startShareGuest, isShareGuest };
