/*
 * In-game tab policy — the pure rules for which tab a game opens on and
 * which tab Start Point leaves the Line tab for.
 *
 * A pure leaf module: no DOM, no storage, no imports, so the rules can be
 * unit-tested directly (tests/unit/gameTabPolicy.test.mjs). The runtime half
 * — the segmented control, the persisted state, the panel switching — is
 * ui/panelSystem.js; the point transitions that consult it are in
 * game/pointManagement.js.
 *
 * Two facts are kept per device (both in localStorage, ui/panelSystem.js):
 *   - the active tab: where the coach is right now. A reload mid-point comes
 *     back to it; the point transitions re-read it.
 *   - the tracking-tab preference: the last tab the coach tracked events
 *     from — Simple, Full, Field or All. Every pick of a tracking tab writes
 *     it, so it always reads "the tab used last time", and it is null until
 *     the coach has ever picked one.
 */

/** The tabs events are tracked from. All counts: it shows the Simple PBP
 *  and Line panels together, and a coach who works from there expects to
 *  land back there, not on Simple alone. */
export const TRACKING_TABS = Object.freeze(['simple', 'full', 'field', 'all']);

/** Every tab of the segmented control. Must match TAB_PANELS in ui/panelSystem.js. */
export const GAME_TABS = Object.freeze([...TRACKING_TABS, 'line', 'log']);

/** Where a coach who has never picked a tracking tab starts tracking. */
export const DEFAULT_TRACKING_TAB = 'simple';

/** The tab a game opens on between points: the first thing a coach does is
 *  pick the line. (All, where games used to open, is the advanced layout.) */
export const LAUNCH_TAB = 'line';

export function isTrackingTab(tab) {
    return TRACKING_TABS.includes(tab);
}

/**
 * Whatever was stored → a tab name, or null. The legacy name 'play' (the
 * Simple tab before it was renamed) reads as 'simple'.
 * @param {*} raw
 * @returns {string|null}
 */
export function normalizeGameTab(raw) {
    if (raw === 'play') return 'simple';
    return GAME_TABS.includes(raw) ? raw : null;
}

/** As normalizeGameTab, but only a tracking tab passes. */
export function normalizeTrackingTab(raw) {
    const tab = normalizeGameTab(raw);
    return tab !== null && isTrackingTab(tab) ? tab : null;
}

/**
 * The tab a game opens on — entering it from the team list, Start Game,
 * Continue Game or a scrimmage. Not the point transitions, which keep the
 * tab and apply their own rules, and not a return from a sub-screen
 * (settings, the roster), which comes back to the tab it left.
 *
 * Between points the Line tab, whatever tab was active last. A game
 * re-opened mid-point (a reload during a point) comes back on the tab it
 * was left on, else the tracking preference, else Simple. A viewer (a
 * share-link guest) keeps the tab they had, defaulting to All: the Line tab
 * is a coach's surface, and All is where the viewer's log-only layout lives.
 *
 * @param {object} ctx
 * @param {boolean} ctx.pointInProgress
 * @param {boolean} ctx.viewer
 * @param {string|null} ctx.lastTab      - the persisted active tab
 * @param {string|null} ctx.preferredTab - the tracking-tab preference
 * @returns {string}
 */
export function launchTab({ pointInProgress = false, viewer = false, lastTab = null, preferredTab = null } = {}) {
    const last = normalizeGameTab(lastTab);
    if (viewer) return last || 'all';
    if (!pointInProgress) return LAUNCH_TAB;
    return last || normalizeTrackingTab(preferredTab) || DEFAULT_TRACKING_TAB;
}

/**
 * The tab Start Point leaves the Line tab for.
 *
 * The first point a coach ever starts on this device — no tracking tab
 * picked yet — opens Simple, and the caller shows FIRST_POINT_HINT pointing
 * at Full and Field. From then on the preference, the tracking tab used
 * last time, wins. Landing on Simple records Simple as that preference (the
 * switch does that, as any pick of a tracking tab does), so the hint shows
 * once and a coach who stays on Simple keeps starting there.
 *
 * @param {string|null} preferredTab
 * @returns {{tab: string, firstEver: boolean}}
 */
export function trackingTabAtPointStart(preferredTab) {
    const tab = normalizeTrackingTab(preferredTab);
    if (tab !== null) return { tab, firstEver: false };
    return { tab: DEFAULT_TRACKING_TAB, firstEver: true };
}

/** Hint id (ui/hints.js) and wording for a coach's first point. */
export const FIRST_POINT_HINT_ID = 'first-tracking-tab';
export const FIRST_POINT_HINT =
    "You're in Simple mode. Try the Full and Field tabs for more detailed stat tracking.";
