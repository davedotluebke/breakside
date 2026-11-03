/**
 * Team Mail — the coach-only admin screen for a team's email lists.
 *
 * Everything here talks to /api/teams/{id}/mail (routers/mail.py). The screen
 * is reached from Team Settings and renders from one payload: settings and
 * addresses, the per-list policy, the directory (guardians, players, managers,
 * plus coaches derived from memberships), the roster with each player's
 * alias, the event lists (a roster subset plus pickup players and their
 * parents, at <slug>-<event>@), the quarantine queue and the delivery log.
 * See TODO.Comms.md § Phase 0 for the design.
 */
import { currentTeam } from '../store/storage.js';
import { authFetch, API_BASE_URL } from '../store/sync.js';
import { showScreen } from '../screens/navigation.js';
import { showTeamSettingsScreen, getTeamSettingsReturnScreen } from './teamSettings.js';
import { parseEmailList } from './mailAddressInput.js';
import { matches, contactFields, playerFields, highlight, looksLikeAddress, joinLabels, tokens } from './mailSearch.js';

const KIND_LABELS = {
    coach: 'Coach', guardian: 'Parent / guardian', player: 'Player', manager: 'Team manager', other: 'Other',
};
const LIST_LABELS = {
    all: 'Everyone', parents: 'Parents', coaches: 'Coaches', staff: 'Staff', players: 'Players', player: 'Player addresses',
};
const LIST_BLURBS = {
    all: 'Delivers to everyone in the directory. Replies go to the coaches by default so one question does not become a reply-all storm.',
    parents: 'Parents/guardians, coaches and managers.',
    coaches: 'Coaches only. Anyone on the team may write to it — it is the "contact the coaches" address.',
    staff: 'Coaches and team managers.',
    players: 'Players and coaches (coaches are always copied). Off by default; turn on for older teams.',
    player: 'One address per player: the player (if they have an address), all of their guardians, and every coach.',
};
const POSTER_KINDS = ['coach', 'manager', 'guardian', 'player', 'other'];
const REASON_LABELS = {
    'unknown-sender': 'Sender not in the directory',
    'not-allowed-to-post': 'Sender may not post to this list',
    'not-on-event': 'Sender is not on this event\'s list',
    'dmarc-fail': 'Possible spoof (sender domain check failed)',
    'auth-fail': 'Possible spoof (both sender checks failed)',
    'list-disabled': 'List is turned off',
    'unknown-alias': 'No player has this address',
    'too-many-recipients': 'Too many recipients',
    'loop-own-header': 'Already relayed by Breakside (loop)',
    'loop-precedence': 'Bulk or list mail',
    'loop-auto-submitted': 'Auto-generated mail',
    'loop-auto-reply': 'Auto-reply',
    'loop-own-address': 'Sent from a list address',
    'auto-delivery-report': 'Delivery report from a mail server (the bounce is noted on the contact)',
    'auto-report': 'Automated report from a mail server',
    'auto-mailer-daemon': 'Automated mail from a mail server',
    'auto-null-sender': 'Automated mail (no sender address)',
};

let state = null;          // last /mail payload
let busy = false;
// Directory order: 'role' (coaches, managers, parents, other; by name within
// each) or 'name'. Remembered per device.
const SORT_KEY = 'breakside_mailDirectorySort';
const KIND_ORDER = { coach: 0, manager: 1, guardian: 2, other: 3 };
let directorySort = loadDirectorySort();
// Contact ids whose inline editor is open. Field saves update the row in
// place (a full re-render would steal the focus mid-tab), so the set only
// matters when something structural re-renders the screen.
const openEditors = new Set();
// Directory search (teams/mailSearch.js). One box above the Directory and
// Player addresses cards filters both; a query that is an address also asks
// the server what the relay would do with mail from it (the lookup banner).
// Not remembered across visits: the question is usually "who is this?" once.
let peopleQuery = '';
const lookupCache = new Map();   // normalized address -> /lookup payload, cleared on every reload of state
let lookupTimer = null;
let lookupSeq = 0;
// Fields save when you leave them; a save in flight must land before a
// structural refresh reads the directory back, or the refresh shows stale
// data and the editor closes on top of it.
let pendingSave = Promise.resolve();
let dialogOpen = false;
// Which <details> of each event card are open, keyed "<eventId>:<section>".
// A card is redrawn in place after every change to it (a pickup added, a
// player ticked), and must come back the way the coach had it.
const openEventSections = new Set();
const EVENT_SECTIONS_OPEN_BY_DEFAULT = ['players', 'pickups'];

// =============================================================================
// Screen
// =============================================================================

function showTeamMailScreen() {
    if (!currentTeam) {
        alert('No team selected');
        return;
    }
    showScreen('teamMailScreen');
    peopleQuery = '';
    refresh();
}

function initializeTeamMail() {
    document.getElementById('openTeamMailBtn')?.addEventListener('click', showTeamMailScreen);
    document.getElementById('backFromTeamMailBtn')?.addEventListener('click', () => showTeamSettingsScreen(getTeamSettingsReturnScreen()));
    document.getElementById('teamMailContent')?.addEventListener('click', onContentClick);
    document.getElementById('teamMailContent')?.addEventListener('change', onContentChange);
    document.getElementById('teamMailContent')?.addEventListener('submit', onContentSubmit);
    document.getElementById('teamMailContent')?.addEventListener('focusout', onFieldBlur);
    document.getElementById('teamMailContent')?.addEventListener('input', onContentInput);
    // "toggle" does not bubble; capture it so a redrawn event card keeps its sections as they were.
    document.getElementById('teamMailContent')?.addEventListener('toggle', onDetailsToggle, true);
}

async function api(path, options = {}) {
    const response = await authFetch(`${API_BASE_URL}/api/teams/${currentTeam.id}/mail${path}`, options);
    let body = null;
    try { body = await response.json(); } catch (_) { body = null; }
    if (!response.ok) {
        const detail = body?.detail;
        throw new Error(typeof detail === 'string' ? detail : (response.status === 403
            ? 'Only coaches of this team can manage its email lists.'
            : `Request failed (${response.status})`));
    }
    return body;
}

async function refresh() {
    const content = document.getElementById('teamMailContent');
    if (!content) return;
    const auth = window.breakside?.auth;
    if (!auth?.isAuthenticated?.()) {
        content.innerHTML = '<p class="info-message">Sign in to manage email lists.</p>';
        return;
    }
    content.innerHTML = '<p class="loading-message">Loading…</p>';
    try {
        state = await api('');
        lookupCache.clear();
        render();
    } catch (error) {
        console.error('teamMail: load failed', error);
        content.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
}

// =============================================================================
// Rendering
// =============================================================================

function render() {
    const content = document.getElementById('teamMailContent');
    if (!content || !state) return;
    if (!state.configured) {
        content.innerHTML = renderSetup();
        return;
    }
    content.innerHTML = [
        renderAddresses(),
        renderQuarantine(),
        // Directory and player addresses sit side by side on a wide screen,
        // each scrolling inside its card (css/teams-manage.css .mail-people);
        // the add form is its own section below both.
        renderPeopleSearch(),
        `<div class="mail-people">${renderDirectory()}${renderRoster()}</div>`,
        renderAddContact(),
        renderEvents(),
        renderLists(),
        renderLog(),
    ].join('');
    loadLog();
    updateLookup(true);
}

function renderSetup() {
    const suggestion = slugify(currentTeam?.name || '');
    return `
        <div class="settings-section">
            <h3>Set up email lists</h3>
            <p class="section-description">Pick a short name for your team's addresses. It becomes
                <code>${esc(suggestion || 'team')}@${esc(state.domain)}</code>,
                <code>parents-${esc(suggestion || 'team')}@${esc(state.domain)}</code> and so on.
                Every player also gets <code>&lt;name&gt;-${esc(suggestion || 'team')}@${esc(state.domain)}</code>.</p>
            <form class="identity-form" data-form="setup">
                <div class="form-group">
                    <label for="mailSlugInput">Address name (letters, digits, hyphens)</label>
                    <input type="text" id="mailSlugInput" name="slug" class="url-input" value="${esc(suggestion)}" maxlength="24" autocapitalize="none" autocomplete="off" required>
                </div>
                <div class="form-group">
                    <label for="mailDisplayInput">Short team name for subject tags and "via" lines</label>
                    <input type="text" id="mailDisplayInput" name="displayName" class="url-input" value="${esc(currentTeam?.name || '')}" maxlength="40">
                </div>
                <button type="submit" class="save-identity-btn"><i class="fas fa-envelope"></i> Create addresses</button>
            </form>
            ${renderTransportNote()}
        </div>`;
}

function renderTransportNote() {
    if (state.transport === 'ses' && state.inboundEnabled) return '';
    return `<p class="mail-transport-note">Delivery is <strong>${esc(state.transport)}</strong> on this server${state.inboundEnabled ? '' : ' and inbound mail is not connected'} — fine for testing, nothing will reach real inboxes.</p>`;
}

function renderAddresses() {
    const a = state.addresses;
    const row = (label, addr, extra = '') => `
        <div class="mail-address-row">
            <span class="mail-address-label">${esc(label)}</span>
            <code class="mail-address">${esc(addr)}</code>
            <button class="icon-button copy-address-btn" data-copy="${escAttr(addr)}" title="Copy address"><i class="fas fa-copy"></i></button>
            ${extra}
        </div>`;
    return `
        <div class="settings-section">
            <h3>Addresses</h3>
            <p class="section-description">Mail sent to these addresses from anyone in the directory is relayed to the people on that list. Mail from anyone else is held for your review.</p>
            ${row('Everyone', a.all)}
            ${row('Parents', a.parents)}
            ${row('Coaches', a.coaches)}
            ${row('Staff', a.staff)}
            ${state.lists.players.enabled ? row('Players', a.players) : ''}
            ${row('Each player', a.playerPattern)}
            ${(state.events || []).length ? row('Each event', a.eventPattern) : ''}
            <form class="mail-inline-form" data-form="settings">
                <label>Address name <input type="text" name="slug" value="${escAttr(state.slug)}" maxlength="24" autocapitalize="none" class="url-input" required></label>
                <label>Short name <input type="text" name="displayName" value="${escAttr(state.displayName)}" maxlength="40" class="url-input"></label>
                <button type="submit" class="save-identity-btn"><i class="fas fa-save"></i> Save</button>
                <button type="button" class="invite-btn viewer-invite" data-action="send-test"><i class="fas fa-paper-plane"></i> Email me a test</button>
            </form>
            <p id="mailSettingsStatus" class="icon-status"></p>
            ${renderTransportNote()}
        </div>`;
}

function renderQuarantine() {
    const n = state.quarantineCount || 0;
    return `
        <div class="settings-section" id="mailQuarantineSection">
            <h3>Held messages${n ? ` <span class="mail-badge">${n}</span>` : ''}</h3>
            <p class="section-description">Messages from addresses that are not in the directory, or that a list's policy does not allow. Release delivers the message; add the sender first if they belong on the team. Held messages are discarded after 14 days.</p>
            <div id="mailQuarantineList">${n ? '<p class="loading-message">Loading…</p>' : '<p class="info-message">Nothing held.</p>'}</div>
        </div>`;
}

function loadDirectorySort() {
    try { return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'role'; } catch (_) { return 'role'; }
}

function setDirectorySort(sort) {
    directorySort = sort === 'name' ? 'name' : 'role';
    try { localStorage.setItem(SORT_KEY, directorySort); } catch (_) { /* private mode */ }
}

function sortedDirectory(contacts) {
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    const people = contacts.filter(c => c.kind !== 'player');
    if (directorySort === 'name') return people.sort(byName);
    return people.sort((a, b) => ((KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)) || byName(a, b));
}

/** Re-render just the Directory and Player addresses cards (sort toggle,
 * search); field saves have already landed in state. The search box itself
 * sits outside both cards, so typing never loses the focus. */
async function rerenderPeople() {
    await pendingSave;
    if (!state?.configured) return;
    const directory = document.querySelector('[data-section="directory"]');
    if (directory) directory.outerHTML = renderDirectory();
    const roster = document.querySelector('[data-section="roster"]');
    if (roster) roster.outerHTML = renderRoster();
    const clear = document.querySelector('[data-action="clear-search"]');
    if (clear) clear.hidden = !peopleQuery;
}

// =============================================================================
// Directory search
// =============================================================================

function renderPeopleSearch() {
    return `
        <div class="mail-search" data-section="search">
            <div class="mail-search-box">
                <i class="fas fa-search mail-search-icon" aria-hidden="true"></i>
                <input type="search" id="mailPeopleSearch" data-search class="url-input mail-search-input"
                    placeholder="Find a name, address or player" value="${escAttr(peopleQuery)}"
                    autocomplete="off" autocapitalize="none" spellcheck="false"
                    aria-label="Search the directory and player addresses">
                <button type="button" class="icon-button mail-search-clear" data-action="clear-search" title="Clear search" ${peopleQuery ? '' : 'hidden'}><i class="fas fa-times"></i></button>
            </div>
            <div id="mailSearchResult" class="mail-search-result" hidden></div>
        </div>`;
}

function setQuery(value) {
    peopleQuery = value || '';
    rerenderPeople();
    updateLookup();
}

/** Put an address (from the log, a held message) into the search box and show the answer. */
function findAddress(email) {
    const input = document.getElementById('mailPeopleSearch');
    if (input) input.value = email;
    setQuery(email);
    document.querySelector('.mail-search')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    input?.focus({ preventScroll: true });
}

function matchCount(shown, total, noun) {
    if (!peopleQuery) return '';
    if (!shown) return `<p class="mail-search-count">No ${noun} match “${esc(peopleQuery.trim())}”.</p>`;
    return `<p class="mail-search-count">${shown} of ${total} ${noun} match.</p>`;
}

/**
 * The lookup banner: when the query is an address, ask the server who
 * carries it and what the relay would do with mail from it. Debounced
 * while typing; immediate after a full render (the DOM was rebuilt) or
 * when the answer is already cached.
 */
function updateLookup(immediate = false) {
    clearTimeout(lookupTimer);
    const box = document.getElementById('mailSearchResult');
    if (!box) return;
    const q = peopleQuery.trim().toLowerCase();
    if (!looksLikeAddress(q)) {
        box.hidden = true;
        box.innerHTML = '';
        return;
    }
    const run = async () => {
        const seq = ++lookupSeq;
        let r = lookupCache.get(q);
        try {
            if (!r) {
                r = await api(`/lookup?email=${encodeURIComponent(q)}`);
                lookupCache.set(q, r);
            }
        } catch (error) {
            console.warn('teamMail: lookup failed', error);
            return;
        }
        if (seq !== lookupSeq || peopleQuery.trim().toLowerCase() !== q) return;   // typed on
        const target = document.getElementById('mailSearchResult');
        if (!target) return;
        target.innerHTML = renderLookup(r);
        target.hidden = false;
    };
    if (immediate || lookupCache.has(q)) run();
    else lookupTimer = setTimeout(run, 250);
}

function ordinal(n) {
    return ['first', 'second', 'third', 'fourth', 'fifth'][n - 1] || `${n}th`;
}

function renderLookup(r) {
    if (!r || r.configured === false) return '';
    const addr = `<code>${esc(r.email)}</code>`;
    const lines = [];
    for (const c of r.contacts || []) {
        const who = `<strong>${esc(c.name)}</strong>`;
        const role = c.kind === 'guardian' && c.playerNames.length
            ? `parent / guardian of ${esc(joinLabels(c.playerNames))}`
            : c.kind === 'player' ? `the player${c.playerNames.length ? ` ${esc(c.playerNames[0])}` : ''}`
            : c.derived ? 'coach, from the team\'s members'
            : esc((KIND_LABELS[c.kind] || c.kind).toLowerCase());
        const position = c.addressCount > 1
            ? `the ${ordinal(c.addressIndex)} of ${c.addressCount} addresses on`
            : 'the address of';
        const status = c.status !== 'active' ? ` <span class="mail-flag">${esc(c.status)}</span>`
            : !c.deliverable ? ' <span class="mail-flag">bounced</span>' : '';
        lines.push(`${addr} is ${position} ${who} (${role})${status}.`);
    }
    const events = r.events || [];
    for (const ev of events) {
        for (const c of ev.contacts || []) {
            const role = c.kind === 'guardian' && c.playerNames.length
                ? `parent / guardian of pickup player ${esc(joinLabels(c.playerNames))}`
                : c.kind === 'player' ? 'pickup player' : esc(c.kind);
            const position = c.addressCount > 1 ? `the ${ordinal(c.addressIndex)} of ${c.addressCount} addresses on` : 'the address of';
            const status = c.status !== 'active' ? ` <span class="mail-flag">${esc(c.status)}</span>`
                : !c.deliverable ? ' <span class="mail-flag">bounced</span>' : '';
            lines.push(`${addr} is ${position} <strong>${esc(c.name)}</strong> (${role}) on the event list <strong>${esc(ev.name)}</strong> only${status}.`);
        }
    }
    if (!lines.length) {
        lines.push(`${addr} is not in the directory. Mail from it to any list is held for your review.`);
        if (r.member) {
            lines.push(`It belongs to team member <strong>${esc(r.member.displayName || r.email)}</strong> (${esc(r.member.role || 'member')}). `
                + `<button type="button" class="invite-btn viewer-invite mail-search-add" data-action="prefill" data-name="${escAttr(r.member.displayName || '')}" data-email="${escAttr(r.email)}"><i class="fas fa-plus"></i> Add to directory</button>`);
        }
        return `<p>${lines.join('</p><p>')}</p>`;
    }
    const postLabels = (r.mayPost || []).map(k => LIST_LABELS[k] || k);
    if (r.mayPostToPlayerAddresses) postLabels.push("any player's address");
    const receiveLabels = (r.receives || []).map(k => LIST_LABELS[k] || k);
    const behind = r.playerAddresses || [];
    const aliasCount = (state?.roster || []).filter(p => p.alias).length;
    if (behind.length > 1 && behind.length >= aliasCount) receiveLabels.push("every player's address");   // a coach
    else for (const p of behind) receiveLabels.push(`${esc(p.playerName)}'s address`);
    for (const ev of events) {
        const label = `the event list ${esc(ev.name)}${ev.enabled ? '' : ' (turned off)'}`;
        if (ev.mayPost) postLabels.push(label);
        if (ev.receives) receiveLabels.push(label);
    }
    lines.push(postLabels.length ? `May post to: ${joinLabels(postLabels)}.` : 'May not post to any list; mail from it is held for your review.');
    lines.push(receiveLabels.length ? `Receives: ${joinLabels(receiveLabels)}.` : 'Receives nothing right now.');
    if (r.member && !(r.contacts || []).some(c => c.derived)) lines.push(`Also a team member (${esc(r.member.displayName || r.email)}, ${esc(r.member.role || 'member')}).`);
    return `<p>${lines.join('</p><p>')}</p>`;
}

function renderDirectory() {
    const everyone = sortedDirectory([...(state.contacts || [])]);
    const roster = state.roster || [];
    const people = everyone.filter(c => openEditors.has(c.id) || matches(contactFields(c, roster, KIND_LABELS[c.kind] || c.kind), peopleQuery));
    const unlisted = (state.members || []).filter(m => m.email && !m.inDirectory && m.role !== 'coach')
        .filter(m => matches([m.displayName, m.email], peopleQuery));
    const sortBtn = (sort, label) => `<button type="button" class="mail-sort-btn${directorySort === sort ? ' is-active' : ''}" data-action="sort-directory" data-sort="${sort}" aria-pressed="${directorySort === sort}">${label}</button>`;
    return `
        <div class="settings-section" data-section="directory">
            <h3 class="mail-head-row">Directory <span class="mail-sort" aria-label="Sort directory by">Sort by ${sortBtn('role', 'Role')}${sortBtn('name', 'Name')}</span></h3>
            <p class="section-description">Who can send to and receive from the lists. Coaches come from the team's members automatically; add parents and managers with the form below. Players have their own section. A person can have several addresses, comma-separated: each one receives list mail and any of them may post.</p>
            <div class="mail-scroll">
            ${matchCount(people.length, everyone.length, 'people')}
            <div class="members-list">
                ${people.map(renderContact).join('')}
                ${peopleQuery || people.some(c => c.kind !== 'coach') ? '' : '<p class="info-message">No parents or managers yet.</p>'}
            </div>
            ${unlisted.length ? `
            <details class="mail-import"${peopleQuery ? ' open' : ''}>
                <summary>${unlisted.length} team member${unlisted.length === 1 ? '' : 's'} with an account but not in the directory</summary>
                <div class="members-list">
                    ${unlisted.map(m => `
                        <div class="member-item">
                            <div class="member-info">
                                <div class="member-details">
                                    <span class="member-name">${highlight(m.displayName || m.email, peopleQuery)}</span>
                                    <span class="member-email">${highlight(m.email, peopleQuery)}</span>
                                </div>
                            </div>
                            <button class="invite-btn viewer-invite" data-action="prefill" data-name="${escAttr(m.displayName || '')}" data-email="${escAttr(m.email)}"><i class="fas fa-plus"></i> Add</button>
                        </div>`).join('')}
                </div>
            </details>` : ''}
            </div>
        </div>`;
}

function renderAddContact() {
    return `
        <div class="settings-section">
            <h3>Add a parent, guardian or manager</h3>
            <form class="mail-add-form" data-form="add-contact">
                <div class="mail-form-grid">
                    <label>Name <input type="text" name="name" class="url-input" maxlength="80" required></label>
                    <label>Email (one or more, comma-separated) <input type="email" multiple name="email" class="url-input" required autocapitalize="none" placeholder="parent@example.com, other@example.com"></label>
                    <label>Role
                        <select name="kind">
                            <option value="guardian">Parent / guardian</option>
                            <option value="manager">Team manager (staff)</option>
                            <option value="other">Other (everyone list only)</option>
                        </select>
                    </label>
                    <label data-player-picker>Player(s) — for guardians
                        <select name="playerIds" multiple size="4">
                            ${(state.roster || []).map(p => `<option value="${escAttr(p.id)}">${esc(p.name)}</option>`).join('')}
                        </select>
                    </label>
                </div>
                <button type="submit" class="save-identity-btn"><i class="fas fa-user-plus"></i> Add to directory</button>
                <p class="icon-status" data-status></p>
            </form>
        </div>`;
}

function contactEmails(c) {
    const list = Array.isArray(c.emails) && c.emails.length ? c.emails : [c.email];
    return list.filter(Boolean);
}

function contactBounces(c) {
    const map = c.bounces && typeof c.bounces === 'object' ? c.bounces : {};
    const entries = Object.entries(map);
    if (!entries.length && c.bounce && c.email) entries.push([c.email, c.bounce]);   // pre-multi-address shape
    return entries;
}

// A hard bounce or a complaint stops delivery to the address until a coach
// clears it (policy.py). A soft bounce is one failed delivery (mailbox full,
// server busy); later mail is still sent, so the note is only worth showing
// while it is recent — after that, mail that did not bounce is the better
// signal, and the "bounce" label just reads as a problem that is not there.
const BLOCKING_BOUNCES = new Set(['hard', 'complaint']);
const SOFT_BOUNCE_SHOWN_DAYS = 30;

function bounceBlocks(b) {
    return BLOCKING_BOUNCES.has(b?.kind);
}

function daysSince(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
}

function fmtAgo(iso) {
    const d = daysSince(iso);
    if (d === null) return '';
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 14) return `${d} days ago`;
    if (d < 60) return `${Math.round(d / 7)} weeks ago`;
    try {
        return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (_) {
        return '';
    }
}

/** The contact's bounces worth a flag: blocking ones always, soft ones while recent. */
function shownBounces(c) {
    return contactBounces(c).filter(([, b]) => bounceBlocks(b) || (daysSince(b.at) ?? 0) <= SOFT_BOUNCE_SHOWN_DAYS);
}

function bounceFlag(addr, b, { withAddress = false } = {}) {
    const blocking = bounceBlocks(b);
    const label = b.kind === 'complaint' ? 'complained' : `${b.kind} bounce`;
    const when = fmtAgo(b.at);
    const title = [
        blocking ? 'Delivery to this address is stopped until you clear it.' : 'One delivery failed; later mail is still sent to this address.',
        b.subject ? `Message: ${b.subject}` : '',
        b.detail || '',
        addr,
    ].filter(Boolean).join(' — ');
    return `<span class="mail-flag ${blocking ? 'mail-flag-bad' : 'mail-flag-soft'}" title="${escAttr(title)}">${esc(label)}${when ? ' ' + esc(when) : ''}${withAddress ? ': ' + esc(addr) : ''}</span>`;
}

function renderContact(c) {
    const playerNames = (c.playerIds || []).map(id => (state.roster || []).find(p => p.id === id)?.name || id);
    const flags = [];
    if (c.status && c.status !== 'active') flags.push(`<span class="mail-flag">${esc(c.status)}</span>`);
    const bounces = shownBounces(c);
    for (const [addr, b] of bounces) {
        flags.push(bounceFlag(addr, b, { withAddress: contactEmails(c).length > 1 }));
    }
    if ((c.optOut || []).length) flags.push(`<span class="mail-flag">opted out: ${esc(c.optOut.join(', '))}</span>`);
    const derived = c.derived;
    const editing = !derived && openEditors.has(c.id);
    return `
        <div class="member-item mail-editable-row" data-contact-id="${escAttr(c.id)}">
            <div class="member-info">
                <span class="member-icon">${c.kind === 'coach' ? '🎯' : c.kind === 'guardian' ? '👪' : c.kind === 'manager' ? '📋' : '✉️'}</span>
                <div class="member-details">
                    <span class="member-name">${highlight(c.name, peopleQuery)} ${flags.join(' ')}</span>
                    <span class="member-email">${highlight(contactSummary(c), peopleQuery)}</span>
                    ${notesHit(c)}
                </div>
                <span class="member-role role-${c.kind === 'coach' ? 'coach' : 'viewer'}">${esc(KIND_LABELS[c.kind] || c.kind)}</span>
            </div>
            ${derived ? '' : `
            <div class="mail-contact-actions">
                ${bounces.length ? `<button class="icon-button" data-action="clear-bounce" data-id="${escAttr(c.id)}" title="${bounces.some(([, b]) => bounceBlocks(b)) ? 'Deliver to this contact again' : 'Clear the bounce note'}"><i class="fas fa-redo"></i></button>` : ''}
                <button class="icon-button" data-action="${editing ? 'close-editor' : 'edit-contact'}" data-id="${escAttr(c.id)}" title="${editing ? 'Done editing' : 'Edit name, email addresses, role or players'}"><i class="fas fa-${editing ? 'check' : 'pen'}"></i></button>
                <button class="icon-button" data-action="toggle-status" data-id="${escAttr(c.id)}" data-status="${escAttr(c.status || 'active')}" title="${c.status === 'active' ? 'Pause delivery' : 'Resume delivery'}"><i class="fas fa-${c.status === 'active' ? 'pause' : 'play'}"></i></button>
                <button class="icon-button remove-member-btn" data-action="remove-contact" data-id="${escAttr(c.id)}" data-name="${escAttr(c.name)}" title="Remove from directory"><i class="fas fa-times"></i></button>
            </div>
            ${editing ? renderContactEditor(c) : ''}`}
        </div>`;
}

/** A note is not shown on the row; when the search hit it, show the note so the match makes sense. */
function notesHit(c) {
    if (!peopleQuery || !c.notes) return '';
    const note = String(c.notes).toLowerCase();
    if (!tokens(peopleQuery).some(t => note.includes(t))) return '';
    return `<span class="member-email mail-note-hit">Note: ${highlight(c.notes, peopleQuery)}</span>`;
}

function contactSummary(c) {
    const playerNames = (c.playerIds || []).map(id => (state.roster || []).find(p => p.id === id)?.name || id);
    return `${contactEmails(c).join(', ') || '(no email)'}${playerNames.length ? ` · ${playerNames.join(', ')}` : ''}`;
}

/**
 * Inline editor under a parent / manager row. Every field saves when you
 * leave it (see saveField); "Done" just closes the editor.
 */
function renderContactEditor(c) {
    const ids = c.playerIds || [];
    return `
        <form class="mail-contact-editor" data-form="contact-edit" data-id="${escAttr(c.id)}">
            <div class="mail-form-grid">
                <label>Name <input type="text" name="name" data-field="name" data-saved="${escAttr(c.name)}" value="${escAttr(c.name)}" maxlength="80" class="url-input"></label>
                <label>Email (one or more, comma-separated) <input type="email" multiple name="emails" data-field="emails" data-saved="${escAttr(contactEmails(c).join(', '))}" value="${escAttr(contactEmails(c).join(', '))}" class="url-input" autocapitalize="none" placeholder="parent@example.com, other@example.com"></label>
                <label>Role
                    <select name="kind" data-field="kind" data-saved="${escAttr(c.kind)}">
                        <option value="guardian" ${c.kind === 'guardian' ? 'selected' : ''}>Parent / guardian</option>
                        <option value="manager" ${c.kind === 'manager' ? 'selected' : ''}>Team manager (staff)</option>
                        <option value="other" ${c.kind === 'other' ? 'selected' : ''}>Other (everyone list only)</option>
                    </select>
                </label>
                <label data-player-picker ${c.kind === 'guardian' ? '' : 'hidden'}>Player(s)
                    <select name="playerIds" data-field="playerIds" data-saved="${escAttr(ids.join(','))}" multiple size="4">
                        ${(state.roster || []).map(p => `<option value="${escAttr(p.id)}" ${ids.includes(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
                    </select>
                </label>
            </div>
            <div class="mail-list-actions">
                <button type="button" class="invite-btn viewer-invite" data-action="close-editor" data-id="${escAttr(c.id)}"><i class="fas fa-check"></i> Done</button>
                <span class="icon-status mail-field-status" data-status></span>
            </div>
        </form>`;
}

function renderRoster() {
    const roster = state.roster || [];
    const players = (state.contacts || []).filter(c => c.kind === 'player');
    const byPlayer = Object.fromEntries(players.map(c => [c.playerIds?.[0], c]));
    const missing = roster.filter(p => !byPlayer[p.id]);
    const guardiansOf = p => (state.contacts || []).filter(g => g.kind === 'guardian' && (g.playerIds || []).includes(p.id)).map(g => g.name);
    const shown = roster.filter(p => matches(playerFields(p, byPlayer[p.id], guardiansOf(p)), peopleQuery));
    return `
        <div class="settings-section" data-section="roster">
            <h3>Player addresses</h3>
            <p class="section-description">Writing to a player's address reaches the player (if they have an email), all of their guardians, and every coach. Set a player's own email here if they have one (several, comma-separated, is fine); edit the address name if two players share a first name. Changes save when you leave the box.</p>
            ${missing.length ? `<button class="invite-btn viewer-invite" data-action="sync-aliases"><i class="fas fa-sync"></i> Add addresses for ${missing.length} new player${missing.length === 1 ? '' : 's'}</button>` : ''}
            <div class="mail-scroll">
            ${matchCount(shown.length, roster.length, 'players')}
            <div class="members-list">
                ${shown.map(p => {
                    const c = byPlayer[p.id];
                    if (!c) return `<div class="member-item"><div class="member-info"><div class="member-details"><span class="member-name">${highlight(p.name, peopleQuery)}</span><span class="member-email">no address yet</span></div></div></div>`;
                    const guardians = guardiansOf(p);
                    return `
                    <div class="member-item mail-player-row mail-editable-row" data-contact-id="${escAttr(c.id)}">
                        <div class="member-info">
                            <div class="member-details mail-player-details">
                                <span class="mail-player-id">
                                    <span class="member-name">${highlight(p.name, peopleQuery)}</span><span class="mail-player-sep">: </span>
                                    <span class="member-email"><code data-player-address>${highlight(p.address || '', peopleQuery)}</code></span>
                                    ${shownBounces(c).map(([addr, b]) => bounceFlag(addr, b)).join(' ')}
                                </span>
                                <span class="member-email mail-player-guardians">${guardians.length ? 'Guardians: ' + highlight(guardians.join(', '), peopleQuery) : '<em>No guardians linked yet</em>'}</span>
                            </div>
                        </div>
                        <form class="mail-player-form" data-form="player" data-id="${escAttr(c.id)}">
                            <input type="text" name="alias" data-field="alias" data-saved="${escAttr(c.alias || '')}" value="${escAttr(c.alias || '')}" maxlength="24" class="url-input mail-alias-input" autocapitalize="none" title="Address name" aria-label="Address name">
                            <input type="email" multiple name="email" data-field="emails" data-saved="${escAttr(contactEmails(c).join(', '))}" value="${escAttr(contactEmails(c).join(', '))}" placeholder="player's own email(s), optional" class="url-input" autocapitalize="none" aria-label="Player email">
                            <span class="icon-status mail-field-status" data-status></span>
                        </form>
                    </div>`;
                }).join('') || (peopleQuery ? '' : '<p class="info-message">No players on the roster.</p>')}
            </div>
            </div>
        </div>`;
}

// =============================================================================
// Event lists
// =============================================================================

function renderEvents() {
    const events = state.events || [];
    return `
        <div class="settings-section" data-section="events">
            <h3>Event lists</h3>
            <p class="section-description">One address per tournament or trip, <code>${esc(state.slug)}-&lt;event&gt;@${esc(state.domain)}</code>, for the logistics of the people going: the coaches and managers, the players you tick (and their parents from the directory), and any pickup players with their parents. Pickup players and their parents are on the event list only — they never get the team's other mail. Anyone on the list may write to it.</p>
            <div class="mail-events">
                ${events.map(renderEventCard).join('')}
            </div>
            ${renderAddEvent()}
        </div>`;
}

function eventSectionOpen(ev, section) {
    const key = `${ev.id}:${section}`;
    if (openEventSections.has(key)) return true;
    if (openEventSections.has(`${key}:closed`)) return false;
    return EVENT_SECTIONS_OPEN_BY_DEFAULT.includes(section);
}

function setEventSectionOpen(eventId, section, open) {
    openEventSections.delete(`${eventId}:${section}`);
    openEventSections.delete(`${eventId}:${section}:closed`);
    openEventSections.add(open ? `${eventId}:${section}` : `${eventId}:${section}:closed`);
}

function renderEventCard(ev) {
    const roster = state.roster || [];
    const going = new Set(ev.playerIds || []);
    const pickups = (ev.contacts || []).filter(c => c.kind === 'player');
    const recipients = ev.recipients || [];
    const linked = (state.tournamentEvents || []).find(t => t.id === ev.eventId);
    const details = (section, summary, body) => `
        <details class="mail-event-section" data-event-section="${section}" ${eventSectionOpen(ev, section) ? 'open' : ''}>
            <summary>${summary}</summary>
            ${body}
        </details>`;
    return `
        <div class="mail-event" data-event-id="${escAttr(ev.id)}">
            <div class="mail-event-head">
                <strong class="mail-event-name">${esc(ev.name)}</strong>
                <code class="mail-address">${esc(ev.address)}</code>
                <button class="icon-button copy-address-btn" data-copy="${escAttr(ev.address)}" title="Copy address"><i class="fas fa-copy"></i></button>
                <label class="mail-toggle"><input type="checkbox" data-event-toggle="enabled" ${ev.enabled ? 'checked' : ''}> On</label>
                <button class="icon-button remove-member-btn" data-action="remove-event" data-id="${escAttr(ev.id)}" data-name="${escAttr(ev.name)}" title="Delete this event list"><i class="fas fa-trash"></i></button>
            </div>
            <p class="section-description mail-event-summary">
                Reaches ${recipients.length} address${recipients.length === 1 ? '' : 'es'}${recipients.length ? `: ${esc(recipients.map(r => r.name).filter((n, i, a) => a.indexOf(n) === i).join(', '))}` : ''}.
                ${linked ? ` Linked to the event <strong>${esc(linked.name)}</strong>.` : ''}
            </p>
            ${details('players', `Players going <span class="mail-count">${going.size} of ${roster.length}</span>`, `
                <div class="mail-check-grid">
                    ${roster.map(p => `<label><input type="checkbox" data-event-player="${escAttr(p.id)}" ${going.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('') || '<p class="info-message">No players on the roster.</p>'}
                </div>
                <div class="mail-list-actions">
                    ${linked ? `<button type="button" class="invite-btn viewer-invite" data-action="sync-event" data-id="${escAttr(ev.id)}" title="Tick the players on the event's roster and add its pickup players"><i class="fas fa-sync"></i> Copy from the event roster</button>` : ''}
                    <span class="icon-status mail-field-status" data-status="players"></span>
                </div>`)}
            ${details('pickups', `Pickup players <span class="mail-count">${pickups.length}</span>`, `
                ${pickups.map(p => renderPickup(ev, p)).join('') || '<p class="info-message">No pickup players yet.</p>'}
                <form class="mail-add-form mail-pickup-add" data-form="add-pickup" data-event="${escAttr(ev.id)}">
                    <div class="mail-form-grid">
                        <label>Pickup player's name <input type="text" name="name" class="url-input" maxlength="80" required placeholder="Name"></label>
                        <label>Their email (optional) <input type="email" multiple name="email" class="url-input" autocapitalize="none" placeholder="player@example.com"></label>
                        <label>Parent / guardian email(s), comma-separated (optional) <input type="email" multiple name="guardianEmails" class="url-input" autocapitalize="none" placeholder="mom@example.com, dad@example.com"></label>
                    </div>
                    <div class="mail-list-actions">
                        <button type="submit" class="save-identity-btn"><i class="fas fa-user-plus"></i> Add pickup player</button>
                        <span class="icon-status" data-status></span>
                    </div>
                </form>`)}
            ${details('settings', 'Settings', renderEventSettings(ev))}
        </div>`;
}

function renderPickup(ev, p) {
    const pickupId = p.playerIds?.[0];
    const guardians = (ev.contacts || []).filter(c => c.kind === 'guardian' && (c.playerIds || []).includes(pickupId));
    const flags = [];
    if (p.status && p.status !== 'active') flags.push(`<span class="mail-flag">${esc(p.status)}</span>`);
    for (const [addr, b] of shownBounces(p)) flags.push(bounceFlag(addr, b, { withAddress: contactEmails(p).length > 1 }));
    return `
        <div class="member-item mail-player-row mail-editable-row mail-pickup" data-contact-id="${escAttr(p.id)}">
            <div class="member-info">
                <span class="member-icon">🎒</span>
                <div class="member-details">
                    <span class="member-name">${esc(p.name)} ${flags.join(' ')}</span>
                    <span class="member-email">Pickup player${guardians.length ? '' : ' · <em>no parent addresses yet</em>'}</span>
                </div>
                <span class="member-role role-viewer">Pickup</span>
            </div>
            <div class="mail-contact-actions">
                ${shownBounces(p).length ? `<button class="icon-button" data-action="clear-event-bounce" data-id="${escAttr(p.id)}" data-event="${escAttr(ev.id)}" title="Deliver to this address again"><i class="fas fa-redo"></i></button>` : ''}
                <button class="icon-button remove-member-btn" data-action="remove-pickup" data-id="${escAttr(p.id)}" data-event="${escAttr(ev.id)}" data-name="${escAttr(p.name)}" title="Remove this pickup player and their parents from the list"><i class="fas fa-times"></i></button>
            </div>
            <form class="mail-player-form" data-form="event-contact" data-id="${escAttr(p.id)}" data-event="${escAttr(ev.id)}">
                <input type="text" name="name" data-field="name" data-saved="${escAttr(p.name)}" value="${escAttr(p.name)}" maxlength="80" class="url-input mail-alias-input" aria-label="Name">
                <input type="email" multiple name="email" data-field="emails" data-saved="${escAttr(contactEmails(p).join(', '))}" value="${escAttr(contactEmails(p).join(', '))}" placeholder="player's own email(s), optional" class="url-input" autocapitalize="none" aria-label="Player email">
                <span class="icon-status mail-field-status" data-status></span>
            </form>
            <div class="mail-event-guardians">
                ${guardians.map(g => renderPickupGuardian(ev, g)).join('')}
                <form class="mail-player-form mail-guardian-add" data-form="add-pickup-guardian" data-event="${escAttr(ev.id)}" data-pickup="${escAttr(pickupId)}">
                    <input type="text" name="name" class="url-input mail-alias-input" maxlength="80" placeholder="Parent / guardian name" aria-label="Parent / guardian name">
                    <input type="email" multiple name="emails" class="url-input" autocapitalize="none" placeholder="email(s), comma-separated" aria-label="Parent / guardian email" required>
                    <button type="submit" class="invite-btn viewer-invite"><i class="fas fa-plus"></i> Add parent</button>
                    <span class="icon-status" data-status></span>
                </form>
            </div>
        </div>`;
}

function renderPickupGuardian(ev, g) {
    const flags = [];
    if (g.status && g.status !== 'active') flags.push(`<span class="mail-flag">${esc(g.status)}</span>`);
    for (const [addr, b] of shownBounces(g)) flags.push(bounceFlag(addr, b, { withAddress: contactEmails(g).length > 1 }));
    return `
        <form class="mail-player-form mail-guardian-row" data-form="event-contact" data-id="${escAttr(g.id)}" data-event="${escAttr(ev.id)}" data-contact-id="${escAttr(g.id)}">
            <span class="member-icon" title="Parent / guardian">👪</span>
            <input type="text" name="name" data-field="name" data-saved="${escAttr(g.name)}" value="${escAttr(g.name)}" maxlength="80" class="url-input mail-alias-input" aria-label="Parent / guardian name">
            <input type="email" multiple name="emails" data-field="emails" data-saved="${escAttr(contactEmails(g).join(', '))}" value="${escAttr(contactEmails(g).join(', '))}" class="url-input" autocapitalize="none" aria-label="Parent / guardian email" placeholder="email(s), comma-separated">
            ${flags.join(' ')}
            ${shownBounces(g).length ? `<button type="button" class="icon-button" data-action="clear-event-bounce" data-id="${escAttr(g.id)}" data-event="${escAttr(ev.id)}" title="Deliver to this address again"><i class="fas fa-redo"></i></button>` : ''}
            <button type="button" class="icon-button remove-member-btn" data-action="remove-pickup-guardian" data-id="${escAttr(g.id)}" data-event="${escAttr(ev.id)}" data-name="${escAttr(g.name)}" title="Remove this parent"><i class="fas fa-times"></i></button>
            <span class="icon-status mail-field-status" data-status></span>
        </form>`;
}

function renderEventSettings(ev) {
    const anyone = (ev.postPolicy || []).includes('anyone');
    const tournaments = state.tournamentEvents || [];
    return `
        <form class="mail-list-form mail-event-settings" data-form="event-settings" data-event="${escAttr(ev.id)}">
            <div class="mail-form-grid">
                <label>Name <input type="text" name="name" value="${escAttr(ev.name)}" maxlength="60" class="url-input" required></label>
                <label><span>Address word (<code>${esc(state.slug)}-…</code>)</span> <input type="text" name="slug" value="${escAttr(ev.slug)}" maxlength="24" class="url-input" autocapitalize="none" required></label>
                <label>Linked tournament event
                    <select name="eventId">
                        <option value="">Not linked</option>
                        ${tournaments.map(t => `<option value="${escAttr(t.id)}" ${t.id === ev.eventId ? 'selected' : ''}>${esc(t.name)}${t.status && t.status !== 'open' ? ` (${esc(t.status)})` : ''}</option>`).join('')}
                    </select>
                </label>
                <fieldset class="mail-policy">
                    <legend>Who may post</legend>
                    <label><input type="checkbox" name="anyone" ${anyone ? 'checked' : ''}> Anyone on the list</label>
                    ${POSTER_KINDS.filter(k => k !== 'other').map(k => `<label><input type="checkbox" name="kind:${k}" ${!anyone && (ev.postPolicy || []).includes(k) ? 'checked' : ''} ${anyone ? 'disabled' : ''}> ${esc(KIND_LABELS[k])}</label>`).join('')}
                </fieldset>
                <label>Subject tag <input type="text" name="subjectTag" value="${escAttr(ev.subjectTag || '')}" maxlength="40" class="url-input"></label>
                <label>Reply goes to
                    <select name="replyTo">
                        <option value="list" ${ev.replyTo === 'list' ? 'selected' : ''}>The list</option>
                        <option value="author" ${ev.replyTo === 'author' ? 'selected' : ''}>The person who wrote it</option>
                        <option value="coaches" ${ev.replyTo === 'coaches' ? 'selected' : ''}>The coaches</option>
                    </select>
                </label>
            </div>
            <div class="mail-list-actions">
                <button type="submit" class="save-identity-btn"><i class="fas fa-save"></i> Save</button>
                <span class="icon-status" data-status></span>
            </div>
        </form>`;
}

function renderAddEvent() {
    const tournaments = state.tournamentEvents || [];
    return `
        <form class="mail-add-form mail-event-add" data-form="add-event">
            <h4>New event list</h4>
            <div class="mail-form-grid">
                ${tournaments.length ? `
                <label>Tournament event (optional — fills the list from its roster)
                    <select name="eventId">
                        <option value="">Not linked</option>
                        ${tournaments.map(t => `<option value="${escAttr(t.id)}" data-name="${escAttr(t.name)}">${esc(t.name)}${t.status && t.status !== 'open' ? ` (${esc(t.status)})` : ''} — ${t.playerCount} player${t.playerCount === 1 ? '' : 's'}${t.pickupCount ? `, ${t.pickupCount} pickup${t.pickupCount === 1 ? '' : 's'}` : ''}</option>`).join('')}
                    </select>
                </label>` : ''}
                <label>Name (for subject tags and "via" lines) <input type="text" name="name" class="url-input" maxlength="60" required placeholder="States 2026"></label>
                <label><span>Address word: <span class="mail-address-preview"><code>${esc(state.slug)}-<span data-slug-preview>event</span>@${esc(state.domain)}</code></span></span>
                    <input type="text" name="slug" class="url-input" maxlength="24" autocapitalize="none" autocomplete="off" required placeholder="states"></label>
            </div>
            <div class="mail-list-actions">
                <button type="submit" class="save-identity-btn"><i class="fas fa-envelope"></i> Create event list</button>
                <span class="icon-status" data-status></span>
            </div>
        </form>`;
}

/** Redraw one event card in place from a fresh payload (or drop it). */
function replaceEventCard(ev, { remove = false } = {}) {
    const list = state.events || (state.events = []);
    const at = list.findIndex(e => e.id === ev.id);
    const card = document.querySelector(`.mail-event[data-event-id="${CSS.escape(ev.id)}"]`);
    if (remove) {
        if (at >= 0) list.splice(at, 1);
        card?.remove();
        if (!list.length) {
            const section = document.querySelector('[data-section="events"]');
            if (section) section.outerHTML = renderEvents();
        }
        return;
    }
    if (at >= 0) list[at] = ev; else list.push(ev);
    if (card) card.outerHTML = renderEventCard(ev);
    else {
        const section = document.querySelector('[data-section="events"]');
        if (section) section.outerHTML = renderEvents();
    }
}

function renderLists() {
    const lists = state.lists || {};
    return `
        <div class="settings-section">
            <h3>List settings</h3>
            <p class="section-description">Who may post to each list, the tag added to subjects, and where a plain Reply goes.</p>
            ${['all', 'parents', 'coaches', 'staff', 'players', 'player'].map(kind => {
                const l = lists[kind] || {};
                const anyone = (l.postPolicy || []).includes('anyone');
                const recipients = l.recipients || [];
                return `
                <form class="mail-list-form" data-form="list" data-kind="${kind}">
                    <div class="mail-list-head">
                        <strong>${esc(LIST_LABELS[kind])}</strong>
                        <code>${esc(l.address || '')}</code>
                        ${kind === 'players' ? `<label class="mail-toggle"><input type="checkbox" name="enabled" ${l.enabled ? 'checked' : ''}> Turned on</label>` : ''}
                    </div>
                    <p class="section-description">${esc(LIST_BLURBS[kind])}${kind !== 'player' ? ` Currently ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.` : ''}</p>
                    <div class="mail-form-grid">
                        <fieldset class="mail-policy">
                            <legend>Who may post</legend>
                            <label><input type="checkbox" name="anyone" ${anyone ? 'checked' : ''}> Anyone in the directory</label>
                            ${POSTER_KINDS.map(k => `<label><input type="checkbox" name="kind:${k}" ${!anyone && (l.postPolicy || []).includes(k) ? 'checked' : ''} ${anyone ? 'disabled' : ''}> ${esc(KIND_LABELS[k])}</label>`).join('')}
                        </fieldset>
                        <label>Subject tag <input type="text" name="subjectTag" value="${escAttr(l.subjectTag || '')}" maxlength="40" class="url-input"></label>
                        <label>Reply goes to
                            <select name="replyTo">
                                <option value="list" ${l.replyTo === 'list' ? 'selected' : ''}>The list</option>
                                <option value="author" ${l.replyTo === 'author' ? 'selected' : ''}>The person who wrote it</option>
                                <option value="coaches" ${l.replyTo === 'coaches' ? 'selected' : ''}>The coaches</option>
                            </select>
                        </label>
                    </div>
                    <div class="mail-list-actions">
                        <button type="submit" class="save-identity-btn"><i class="fas fa-save"></i> Save</button>
                        <span class="icon-status" data-status></span>
                    </div>
                </form>`;
            }).join('')}
        </div>`;
}

function renderLog() {
    return `
        <div class="settings-section">
            <h3>Recent activity</h3>
            <p class="section-description">✅ means the mail service accepted the message for every recipient and nothing has bounced back since; it is not a receipt from each inbox. When one recipient's mail bounces, the message shows ⚠️ with who bounced, and the contact gets a bounce note.</p>
            <div id="mailLogList"><p class="loading-message">Loading…</p></div>
        </div>`;
}

async function loadLog() {
    const list = document.getElementById('mailLogList');
    const qlist = document.getElementById('mailQuarantineList');
    try {
        if (state.quarantineCount && qlist) {
            const q = await api('/quarantine');
            qlist.innerHTML = q.items.length ? q.items.map(renderHeld).join('') : '<p class="info-message">Nothing held.</p>';
        }
        if (list) {
            const data = await api('/log?limit=40');
            list.innerHTML = data.entries.length ? `<table class="mail-log"><tbody>${data.entries.map(renderLogRow).join('')}</tbody></table>`
                : '<p class="info-message">No mail yet.</p>';
        }
    } catch (error) {
        if (list) list.innerHTML = `<p class="error-message">${esc(error.message)}</p>`;
    }
}

function renderHeld(item) {
    return `
        <div class="member-item mail-held" data-held-id="${escAttr(item.id)}">
            <div class="member-info">
                <div class="member-details">
                    <span class="member-name">${esc(item.subject || '(no subject)')}</span>
                    <span class="member-email">From ${senderLink(item.fromName, item.from)} to <code>${esc(item.list)}</code> · ${esc(fmtDate(item.at))}</span>
                    <span class="member-email mail-reason">${esc(REASON_LABELS[item.reason] || item.reason || '')}</span>
                    <div class="mail-held-preview" hidden></div>
                </div>
            </div>
            <div class="mail-contact-actions">
                <button class="icon-button" data-action="preview-held" data-id="${escAttr(item.id)}" title="Show the message"><i class="fas fa-eye"></i></button>
                ${item.reason === 'unknown-sender' && item.from ? `<button class="invite-btn viewer-invite" data-action="release-add" data-id="${escAttr(item.id)}" data-from="${escAttr(item.from)}" data-name="${escAttr(item.fromName || '')}" title="Add the sender to the directory, then deliver"><i class="fas fa-user-plus"></i> Add &amp; deliver</button>` : ''}
                <button class="invite-btn coach-invite" data-action="release" data-id="${escAttr(item.id)}" title="Deliver this message"><i class="fas fa-paper-plane"></i> Deliver</button>
                <button class="icon-button remove-member-btn" data-action="discard" data-id="${escAttr(item.id)}" title="Discard"><i class="fas fa-trash"></i></button>
            </div>
        </div>`;
}

/** A sender's name as a button that looks them up in the directory search (plain text when the address is unknown). */
function senderLink(name, email) {
    if (!email) return esc(name || '');
    const label = name ? `${esc(name)} <span class="mail-link-addr">&lt;${esc(email)}&gt;</span>` : esc(email);
    return `<button type="button" class="mail-link" data-action="find-sender" data-email="${escAttr(email)}" title="Find this address in the directory">${label}</button>`;
}

function renderLogRow(e) {
    const bounced = Array.isArray(e.bounces) ? e.bounces : [];     // bounce rows the server tied to this relay
    let icon = { relayed: '✅', released: '✅', quarantined: '⏸', dropped: '🚫', failed: '❌', bounce: '↩️', complaint: '⚠️', test: '🧪' }[e.action] || '•';
    let what;
    let title = '';
    if (e.action === 'relayed' || e.action === 'released') {
        what = `to ${e.recipients} recipient${e.recipients === 1 ? '' : 's'}`;
        if (bounced.length) {
            icon = '⚠️';
            what += `, ${bounced.length} bounced`;
            title = bounced.map(b => `${b.email}: ${b.kind === 'complaint' ? 'complaint' : (b.kind || '') + ' bounce'}${b.detail ? ' — ' + b.detail : ''}`).join('\n');
        }
    } else if (e.action === 'bounce' || e.action === 'complaint') {
        what = e.action === 'complaint' ? 'marked as spam by the recipient (delivery stopped)'
            : `${e.reason || ''} bounce${e.reason === 'soft' ? ' (still delivering)' : ' (delivery stopped)'}`;
        title = e.detail || '';
    } else {
        what = REASON_LABELS[e.reason] || e.reason || e.action;
    }
    return `<tr${bounced.length ? ' class="mail-log-warn"' : ''}><td>${icon}</td><td>${esc(fmtDate(e.at))}</td><td><code>${esc(e.list || '')}</code></td><td>${senderLink(e.fromName, e.from)}</td><td>${esc(e.subject || '')}</td><td title="${escAttr(title)}">${esc(what)}</td></tr>`;
}

// =============================================================================
// Interaction
// =============================================================================

async function onContentClick(event) {
    const copy = event.target.closest('[data-copy]');
    if (copy) {
        copyToClipboard(copy.dataset.copy);
        copy.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => { copy.innerHTML = '<i class="fas fa-copy"></i>'; }, 1200);
        return;
    }
    const button = event.target.closest('[data-action]');
    if (!button || busy) return;
    const { action, id } = button.dataset;
    try {
        busy = true;
        if (action === 'sort-directory') {
            setDirectorySort(button.dataset.sort);
            await rerenderPeople();
        } else if (action === 'clear-search') {
            const input = document.getElementById('mailPeopleSearch');
            if (input) input.value = '';
            setQuery('');
            input?.focus();
        } else if (action === 'find-sender') {
            findAddress(button.dataset.email || '');
        } else if (action === 'send-test') {
            const r = await api('/test', { method: 'POST' });
            setStatus('mailSettingsStatus', `Sent to ${r.to} via ${r.transport}.`, 'success');
        } else if (action === 'sync-aliases') {
            await api('/aliases/sync', { method: 'POST' });
            await refreshQuiet();
        } else if (action === 'remove-contact') {
            if (!confirm(`Remove ${button.dataset.name} from the directory? They will no longer receive or be able to send list mail.`)) return;
            await api(`/contacts/${id}`, { method: 'DELETE' });
            await refreshQuiet();
        } else if (action === 'toggle-status') {
            const status = button.dataset.status === 'active' ? 'paused' : 'active';
            await api(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
            await refreshQuiet();
        } else if (action === 'edit-contact') {
            openEditors.add(id);
            render();
            document.querySelector(`form[data-form="contact-edit"][data-id="${CSS.escape(id)}"] input[name="name"]`)?.focus();
        } else if (action === 'close-editor') {
            openEditors.delete(id);
            await refreshQuiet();
        } else if (action === 'clear-bounce') {
            await api(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify({ bounces: null }) });
            await refreshQuiet();
        } else if (action === 'prefill') {
            const form = document.querySelector('form[data-form="add-contact"]');
            if (form) {
                form.elements.name.value = button.dataset.name || '';
                form.elements.email.value = button.dataset.email || '';
                form.scrollIntoView({ behavior: 'smooth', block: 'center' });
                form.elements.name.focus();
            }
        } else if (action === 'preview-held') {
            const row = button.closest('[data-held-id]');
            const box = row?.querySelector('.mail-held-preview');
            if (box) {
                if (!box.hidden) { box.hidden = true; return; }
                const item = await api(`/quarantine/${id}`);
                box.textContent = item.preview || '(no readable text)';
                box.hidden = false;
            }
        } else if (action === 'release') {
            const r = await api(`/quarantine/${id}/release`, { method: 'POST', body: JSON.stringify({}) });
            reportRelease(r);
            await refreshQuiet();
        } else if (action === 'release-add') {
            const kind = prompt(`Add ${button.dataset.from} to the directory as which role?\n\nType: parent, manager or other`, 'parent');
            if (kind === null) return;
            const kinds = { parent: 'guardian', guardian: 'guardian', manager: 'manager', other: 'other' };
            const chosen = kinds[kind.trim().toLowerCase()];
            if (!chosen) { alert('Please type parent, manager or other.'); return; }
            const name = prompt('Their name:', button.dataset.name || '') || button.dataset.from;
            let playerIds = [];
            if (chosen === 'guardian') {
                const names = (state.roster || []).map((p, i) => `${i + 1}. ${p.name}`).join('\n');
                const pick = prompt(`Which player(s) are they a guardian of? Enter numbers separated by commas:\n\n${names}`, '');
                if (pick === null) return;
                playerIds = pick.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 1 && n <= state.roster.length).map(n => state.roster[n - 1].id);
                if (!playerIds.length) { alert('A guardian must be linked to at least one player.'); return; }
            }
            const r = await api(`/quarantine/${id}/release`, {
                method: 'POST', body: JSON.stringify({ addSender: { kind: chosen, name, playerIds } }),
            });
            reportRelease(r);
            await refreshQuiet();
        } else if (action === 'discard') {
            await api(`/quarantine/${id}`, { method: 'DELETE' });
            await refreshQuiet();
        } else if (action === 'remove-event') {
            if (!confirm(`Delete the event list "${button.dataset.name}"? Its address stops working and its pickup players are forgotten. Players and parents from the directory are not affected.`)) return;
            await api(`/events/${id}`, { method: 'DELETE' });
            replaceEventCard({ id }, { remove: true });
            await refreshQuiet();
        } else if (action === 'sync-event') {
            const r = await api(`/events/${id}/sync`, { method: 'POST' });
            replaceEventCard(r.event);
            const added = (r.added || []).length;
            flashStatus(document.querySelector(`.mail-event[data-event-id="${CSS.escape(id)}"] [data-event-section="players"]`),
                `Copied: ${r.playerIds.length} player${r.playerIds.length === 1 ? '' : 's'}${added ? `, ${added} pickup${added === 1 ? '' : 's'} added` : ''}`);
        } else if (action === 'remove-pickup' || action === 'remove-pickup-guardian') {
            const what = action === 'remove-pickup' ? `${button.dataset.name} and their parents` : button.dataset.name;
            if (!confirm(`Remove ${what} from this event list?`)) return;
            const r = await api(`/events/${button.dataset.event}/contacts/${id}`, { method: 'DELETE' });
            replaceEventCard(r.event);
        } else if (action === 'clear-event-bounce') {
            await api(`/events/${button.dataset.event}/contacts/${id}`, { method: 'PATCH', body: JSON.stringify({ bounces: null }) });
            const r = await api(`/events/${button.dataset.event}`, { method: 'PATCH', body: JSON.stringify({}) });
            replaceEventCard(r.event);
        }
    } catch (error) {
        alert(error.message);
    } finally {
        busy = false;
    }
}

function reportRelease(r) {
    const first = r?.results?.[0];
    if (!first) return;
    if (first.action !== 'relay') {
        alert(`The message was not delivered: ${REASON_LABELS[first.reason] || first.reason || first.action}.`);
    }
}

function onDetailsToggle(event) {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.dataset.eventSection) return;
    const card = details.closest('[data-event-id]');
    if (card) setEventSectionOpen(card.dataset.eventId, details.dataset.eventSection, details.open);
}

/** Live helpers on the "new event list" form: a picked tournament event
 *  fills the name; the name fills the address word until it is edited. */
function onContentInput(event) {
    if (event.target?.matches?.('[data-search]')) { setQuery(event.target.value); return; }
    const form = event.target.closest('form[data-form="add-event"]');
    if (!form) return;
    const slugInput = form.elements.slug;
    if (event.target === slugInput) {
        slugInput.dataset.touched = slugInput.value ? '1' : '';
    } else if (event.target === form.elements.name && !slugInput.dataset.touched) {
        slugInput.value = slugify(form.elements.name.value);
    }
    const preview = form.querySelector('[data-slug-preview]');
    if (preview) preview.textContent = slugify(slugInput.value) || 'event';
}

async function onEventQuickChange(input) {
    const card = input.closest('[data-event-id]');
    if (!card) return;
    const eventId = card.dataset.eventId;
    const status = card.querySelector('[data-status="players"]');
    try {
        busy = true;
        let body;
        if (input.dataset.eventToggle) {
            body = { [input.dataset.eventToggle]: input.checked };
        } else {
            body = { playerIds: Array.from(card.querySelectorAll('[data-event-player]:checked')).map(b => b.dataset.eventPlayer) };
        }
        const r = await api(`/events/${eventId}`, { method: 'PATCH', body: JSON.stringify(body) });
        replaceEventCard(r.event);
        if (!input.dataset.eventToggle) {
            flashStatus(document.querySelector(`.mail-event[data-event-id="${CSS.escape(eventId)}"] [data-event-section="players"]`), 'Saved');
        }
    } catch (error) {
        if (status) { status.textContent = error.message; status.className = 'icon-status error'; }
        else alert(error.message);
        input.checked = !input.checked;
    } finally {
        busy = false;
    }
}

function onContentChange(event) {
    if (event.target.dataset?.field && event.target.tagName === 'SELECT') {
        queueSave(event.target);
    }
    if (event.target.dataset?.eventToggle || event.target.dataset?.eventPlayer) {
        if (!busy) onEventQuickChange(event.target);
        return;
    }
    const addEvent = event.target.closest('form[data-form="add-event"]');
    if (addEvent && event.target.name === 'eventId') {
        const picked = event.target.selectedOptions[0];
        if (picked?.dataset.name) {
            addEvent.elements.name.value = picked.dataset.name;
            if (!addEvent.elements.slug.dataset.touched) addEvent.elements.slug.value = slugify(picked.dataset.name);
            const preview = addEvent.querySelector('[data-slug-preview]');
            if (preview) preview.textContent = slugify(addEvent.elements.slug.value) || 'event';
        }
    }
    // "Anyone" disables the per-kind boxes in a list's post policy.
    if (event.target.name === 'anyone') {
        const fieldset = event.target.closest('fieldset');
        fieldset?.querySelectorAll('input[name^="kind:"]').forEach(box => { box.disabled = event.target.checked; });
    }
    if (event.target.name === 'kind') {
        const picker = event.target.closest('form')?.querySelector('[data-player-picker]');
        if (picker) picker.hidden = event.target.value !== 'guardian';
    }
}

async function onContentSubmit(event) {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    if (busy) return;
    const kind = form.dataset.form;
    const status = form.querySelector('[data-status]');
    try {
        busy = true;
        if (kind === 'setup' || kind === 'settings') {
            const body = { slug: form.elements.slug.value.trim(), displayName: form.elements.displayName.value.trim() };
            state = await api('', { method: 'POST', body: JSON.stringify(body) });
            render();
            if (kind === 'settings') setStatus('mailSettingsStatus', 'Saved.', 'success');
        } else if (kind === 'add-contact') {
            const playerIds = Array.from(form.elements.playerIds.selectedOptions).map(o => o.value);
            const body = {
                kind: form.elements.kind.value,
                name: form.elements.name.value.trim(),
                emails: form.elements.email.value.trim(),      // the server splits on commas
                playerIds: form.elements.kind.value === 'guardian' ? playerIds : [],
            };
            await api('/contacts', { method: 'POST', body: JSON.stringify(body) });
            await refreshQuiet();
        } else if (kind === 'player' || kind === 'contact-edit' || kind === 'event-contact') {
            // Fields save on leaving them; Enter just leaves the field.
            document.activeElement?.blur?.();
        } else if (kind === 'add-event') {
            const body = {
                name: form.elements.name.value.trim(),
                slug: slugify(form.elements.slug.value),
                eventId: form.elements.eventId?.value || null,
            };
            const r = await api('/events', { method: 'POST', body: JSON.stringify(body) });
            setEventSectionOpen(r.event.id, 'players', true);
            setEventSectionOpen(r.event.id, 'pickups', true);
            await refreshQuiet();
            document.querySelector(`.mail-event[data-event-id="${CSS.escape(r.event.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else if (kind === 'add-pickup') {
            const eventId = form.dataset.event;
            const body = {
                kind: 'player',
                name: form.elements.name.value.trim(),
                emails: form.elements.email.value.trim(),
                guardianEmails: form.elements.guardianEmails.value.trim() || null,
            };
            const r = await api(`/events/${eventId}/contacts`, { method: 'POST', body: JSON.stringify(body) });
            replaceEventCard(r.event);
            document.querySelector(`.mail-event[data-event-id="${CSS.escape(eventId)}"] form[data-form="add-pickup"] input[name="name"]`)?.focus();
        } else if (kind === 'add-pickup-guardian') {
            const eventId = form.dataset.event;
            const body = {
                kind: 'guardian',
                name: form.elements.name.value.trim() || 'Parent / guardian',
                emails: form.elements.emails.value.trim(),
                playerIds: [form.dataset.pickup],
            };
            const r = await api(`/events/${eventId}/contacts`, { method: 'POST', body: JSON.stringify(body) });
            replaceEventCard(r.event);
        } else if (kind === 'event-settings') {
            const anyone = form.elements.anyone.checked;
            const postPolicy = anyone ? ['anyone'] : POSTER_KINDS.filter(k => form.elements[`kind:${k}`]?.checked);
            if (!postPolicy.length) throw new Error('Pick at least one role that may post, or "Anyone on the list".');
            const body = {
                name: form.elements.name.value.trim(),
                slug: slugify(form.elements.slug.value),
                eventId: form.elements.eventId.value || null,
                postPolicy, subjectTag: form.elements.subjectTag.value, replyTo: form.elements.replyTo.value,
            };
            const r = await api(`/events/${form.dataset.event}`, { method: 'PATCH', body: JSON.stringify(body) });
            setEventSectionOpen(r.event.id, 'settings', true);
            replaceEventCard(r.event);
            const saved = document.querySelector(`.mail-event[data-event-id="${CSS.escape(r.event.id)}"] form[data-form="event-settings"] [data-status]`);
            if (saved) { saved.textContent = 'Saved.'; saved.className = 'icon-status success'; }
        } else if (kind === 'list') {
            const anyone = form.elements.anyone.checked;
            const postPolicy = anyone ? ['anyone'] : POSTER_KINDS.filter(k => form.elements[`kind:${k}`].checked);
            if (!postPolicy.length) throw new Error('Pick at least one role that may post, or "Anyone".');
            const body = { postPolicy, subjectTag: form.elements.subjectTag.value, replyTo: form.elements.replyTo.value };
            if (form.elements.enabled) body.enabled = form.elements.enabled.checked;
            await api(`/lists/${form.dataset.kind}`, { method: 'PATCH', body: JSON.stringify(body) });
            if (status) { status.textContent = 'Saved.'; status.className = 'icon-status success'; }
            if (form.dataset.kind === 'players') await refreshQuiet();
        }
    } catch (error) {
        if (status) { status.textContent = error.message; status.className = 'icon-status error'; }
        else alert(error.message);
    } finally {
        busy = false;
    }
}

async function refreshQuiet() {
    const y = window.scrollY;
    await pendingSave;
    state = await api('');
    lookupCache.clear();
    render();
    window.scrollTo(0, y);
}

// =============================================================================
// Save-on-leave fields (player rows and the inline contact editor)
// =============================================================================

function onFieldBlur(event) {
    const input = event.target;
    if (!(input instanceof HTMLElement) || !input.dataset?.field) return;
    if (input.tagName === 'SELECT') return;             // selects save on change
    if (dialogOpen) return;                             // the dialog took the focus, not the user
    if (!document.hasFocus()) return;                   // switched windows mid-typing; save on the real leave
    queueSave(input);
}

function queueSave(input) {
    pendingSave = pendingSave.then(() => saveField(input)).catch(error => console.error('teamMail: save failed', error));
    return pendingSave;
}

function fieldValue(input) {
    if (input.tagName === 'SELECT' && input.multiple) {
        return Array.from(input.selectedOptions).map(o => o.value);
    }
    return input.value;
}

function serialize(value) {
    return Array.isArray(value) ? value.join(',') : String(value ?? '').trim();
}

function restoreField(input) {
    const saved = input.dataset.saved ?? '';
    if (input.tagName === 'SELECT' && input.multiple) {
        const ids = saved ? saved.split(',') : [];
        Array.from(input.options).forEach(o => { o.selected = ids.includes(o.value); });
    } else {
        input.value = saved;
    }
}

async function saveField(input) {
    const form = input.closest('form[data-id]');
    const id = form?.dataset.id;
    const field = input.dataset.field;
    if (!id || !field || !input.isConnected) return;
    let value = fieldValue(input);
    if (serialize(value) === (input.dataset.saved ?? '')) return;

    if (field === 'emails') {
        const parsed = parseEmailList(value);
        if (parsed.invalid.length) {
            const bad = parsed.invalid.map(v => `"${v}"`).join(', ');
            const choice = await askDialog({
                title: 'Check that address',
                message: `${bad} ${parsed.invalid.length === 1 ? 'is not a well-formed email address' : 'are not well-formed email addresses'} and will be dropped.`
                    + (parsed.valid.length ? ` Keeping ${parsed.valid.join(', ')}.` : ''),
                retryLabel: 'Go back and edit',
                discardLabel: parsed.valid.length ? 'Drop it, keep the rest' : 'Drop it',
            });
            if (choice === 'retry') { input.focus(); return; }
        }
        value = parsed.normalized;
        input.value = value;
    } else if (field === 'alias') {
        value = value.trim().toLowerCase();
    } else if (field === 'name') {
        value = value.trim();
    }

    try {
        const path = form.dataset.event ? `/events/${form.dataset.event}/contacts/${id}` : `/contacts/${id}`;
        const r = await api(path, { method: 'PATCH', body: JSON.stringify({ [field]: value }) });
        applyContactUpdate(r.contact, form);
        const contact = r.contact;
        input.dataset.saved = field === 'emails' ? contactEmails(contact).join(', ')
            : field === 'playerIds' ? (contact.playerIds || []).join(',')
            : String(contact[field] ?? '');
        if (field === 'emails') input.value = contactEmails(contact).join(', ');
        else if (field === 'alias' || field === 'name') input.value = contact[field] ?? '';
        flashStatus(form, 'Saved');
    } catch (error) {
        const choice = await askDialog({
            title: 'Not saved',
            message: error.message,
            retryLabel: 'Go back and edit',
            discardLabel: 'Revert',
        });
        if (choice === 'retry') input.focus();
        else restoreField(input);
    }
}

/** Reflect a saved contact in `state` and in the row's summary, without re-rendering. */
function applyContactUpdate(contact, form) {
    const eventId = form?.dataset.event;
    const ev = eventId ? (state?.events || []).find(e => e.id === eventId) : null;
    const list = ev ? (ev.contacts || []) : (state?.contacts || []);
    const at = list.findIndex(c => c.id === contact.id);
    if (at >= 0) list[at] = { ...list[at], ...contact };
    const row = form?.closest('[data-contact-id]');
    if (!row) return;
    if (ev) {
        // A pickup's name shows on its row; a guardian lives in its own form.
        const nameEl = row.querySelector('.member-name');
        if (nameEl?.firstChild && contact.kind === 'player') nameEl.firstChild.nodeValue = `${contact.name} `;
        return;
    }
    const nameEl = row.querySelector('.member-name');
    if (nameEl && nameEl.firstChild && contact.kind !== 'player') nameEl.firstChild.nodeValue = `${contact.name} `;
    if (contact.kind === 'player') {
        const roster = (state?.roster || []).find(p => p.contactId === contact.id);
        const address = `${contact.alias}-${state.slug}@${state.domain}`;
        if (roster) { roster.alias = contact.alias; roster.address = address; }
        const code = row.querySelector('[data-player-address]');
        if (code) code.textContent = address;
    } else {
        const summary = row.querySelector('.member-email');
        if (summary) summary.textContent = contactSummary(contact);
        const role = row.querySelector('.member-role');
        if (role) role.textContent = KIND_LABELS[contact.kind] || contact.kind;
        const picker = form.querySelector('[data-player-picker]');
        if (picker) picker.hidden = contact.kind !== 'guardian';
    }
}

function flashStatus(form, text) {
    const el = form?.querySelector('[data-status]');
    if (!el) return;
    el.textContent = text;
    el.className = 'icon-status mail-field-status success';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.textContent = ''; }, 1800);
}

/**
 * A two-button modal. Resolves "retry" (go back to the field) or "discard".
 * Escape and the backdrop count as "retry" — the safe choice keeps the text.
 */
function askDialog({ title, message, retryLabel, discardLabel }) {
    return new Promise(resolve => {
        const modal = document.createElement('div');
        modal.className = 'modal mail-dialog';
        modal.innerHTML = `
            <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="mailDialogTitle">
                <h3 id="mailDialogTitle">${esc(title)}</h3>
                <p>${esc(message)}</p>
                <div class="modal-buttons">
                    <button type="button" class="invite-btn viewer-invite" data-choice="retry">${esc(retryLabel)}</button>
                    <button type="button" class="invite-btn coach-invite" data-choice="discard">${esc(discardLabel)}</button>
                </div>
            </div>`;
        const finish = choice => {
            document.removeEventListener('keydown', onKey);
            modal.remove();
            dialogOpen = false;
            resolve(choice);
        };
        const onKey = e => { if (e.key === 'Escape') finish('retry'); };
        modal.addEventListener('click', e => {
            const button = e.target.closest('[data-choice]');
            if (button) finish(button.dataset.choice);
            else if (e.target === modal) finish('retry');
        });
        document.addEventListener('keydown', onKey);
        dialogOpen = true;
        document.body.appendChild(modal);
        modal.querySelector('[data-choice="retry"]')?.focus();
    });
}

function setStatus(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = `icon-status ${cls || ''}`.trim();
}

// =============================================================================
// Utilities
// =============================================================================

function esc(value) {
    if (value === null || value === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(value);
    return div.innerHTML;
}

function escAttr(value) {
    return esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function slugify(name) {
    return String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '');
}

function fmtDate(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (_) {
        return iso;
    }
}

function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
        return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try { document.execCommand('copy'); } catch (_) { /* ignore */ }
    document.body.removeChild(textarea);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeTeamMail);
} else {
    initializeTeamMail();
}

export { showTeamMailScreen };
