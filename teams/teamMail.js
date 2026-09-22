/**
 * Team Mail — the coach-only admin screen for a team's email lists.
 *
 * Everything here talks to /api/teams/{id}/mail (routers/mail.py). The screen
 * is reached from Team Settings and renders from one payload: settings and
 * addresses, the per-list policy, the directory (guardians, players, managers,
 * plus coaches derived from memberships), the roster with each player's
 * alias, the quarantine queue and the delivery log. See TODO.Comms.md
 * § Phase 0 for the design.
 */
import { currentTeam } from '../store/storage.js';
import { authFetch, API_BASE_URL } from '../store/sync.js';
import { showScreen } from '../screens/navigation.js';
import { showTeamSettingsScreen, getTeamSettingsReturnScreen } from './teamSettings.js';
import { log } from '../utils/logger.js';
import { parseEmailList } from './mailAddressInput.js';

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
// Contact ids whose inline editor is open. Field saves update the row in
// place (a full re-render would steal the focus mid-tab), so the set only
// matters when something structural re-renders the screen.
const openEditors = new Set();
// Fields save when you leave them; a save in flight must land before a
// structural refresh reads the directory back, or the refresh shows stale
// data and the editor closes on top of it.
let pendingSave = Promise.resolve();
let dialogOpen = false;

// =============================================================================
// Screen
// =============================================================================

function showTeamMailScreen() {
    if (!currentTeam) {
        alert('No team selected');
        return;
    }
    showScreen('teamMailScreen');
    refresh();
}

function initializeTeamMail() {
    document.getElementById('openTeamMailBtn')?.addEventListener('click', showTeamMailScreen);
    document.getElementById('backFromTeamMailBtn')?.addEventListener('click', () => showTeamSettingsScreen(getTeamSettingsReturnScreen()));
    document.getElementById('teamMailContent')?.addEventListener('click', onContentClick);
    document.getElementById('teamMailContent')?.addEventListener('change', onContentChange);
    document.getElementById('teamMailContent')?.addEventListener('submit', onContentSubmit);
    document.getElementById('teamMailContent')?.addEventListener('focusout', onFieldBlur);
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
        render();
    } catch (error) {
        log.error('teamMail: load failed', error);
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
        renderDirectory(),
        renderRoster(),
        renderLists(),
        renderLog(),
    ].join('');
    loadLog();
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

function renderDirectory() {
    const contacts = state.contacts || [];
    const coaches = contacts.filter(c => c.kind === 'coach');
    const others = contacts.filter(c => c.kind !== 'coach' && c.kind !== 'player');
    const unlisted = (state.members || []).filter(m => m.email && !m.inDirectory && m.role !== 'coach');
    return `
        <div class="settings-section">
            <h3>Directory</h3>
            <p class="section-description">Who can send to and receive from the lists. Coaches come from the team's members automatically. Player addresses are in the roster section below. A person can have several addresses, comma-separated: each one receives list mail and any of them may post.</p>
            <div class="members-list">
                ${coaches.map(renderContact).join('')}
                ${others.map(renderContact).join('') || '<p class="info-message">No parents or managers yet.</p>'}
            </div>
            ${unlisted.length ? `
            <details class="mail-import">
                <summary>${unlisted.length} team member${unlisted.length === 1 ? '' : 's'} with an account but not in the directory</summary>
                <div class="members-list">
                    ${unlisted.map(m => `
                        <div class="member-item">
                            <div class="member-info">
                                <div class="member-details">
                                    <span class="member-name">${esc(m.displayName || m.email)}</span>
                                    <span class="member-email">${esc(m.email)}</span>
                                </div>
                            </div>
                            <button class="invite-btn viewer-invite" data-action="prefill" data-name="${escAttr(m.displayName || '')}" data-email="${escAttr(m.email)}"><i class="fas fa-plus"></i> Add</button>
                        </div>`).join('')}
                </div>
            </details>` : ''}
            <form class="mail-add-form" data-form="add-contact">
                <h4>Add a parent, guardian or manager</h4>
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

function renderContact(c) {
    const playerNames = (c.playerIds || []).map(id => (state.roster || []).find(p => p.id === id)?.name || id);
    const flags = [];
    if (c.status && c.status !== 'active') flags.push(`<span class="mail-flag">${esc(c.status)}</span>`);
    const bounces = contactBounces(c);
    for (const [addr, b] of bounces) {
        flags.push(`<span class="mail-flag mail-flag-bad" title="${escAttr((b.detail || '') + ' — ' + addr)}">${esc(b.kind === 'complaint' ? 'complained' : b.kind + ' bounce')}${contactEmails(c).length > 1 ? ': ' + esc(addr) : ''}</span>`);
    }
    if ((c.optOut || []).length) flags.push(`<span class="mail-flag">opted out: ${esc(c.optOut.join(', '))}</span>`);
    const derived = c.derived;
    const editing = !derived && openEditors.has(c.id);
    return `
        <div class="member-item mail-editable-row" data-contact-id="${escAttr(c.id)}">
            <div class="member-info">
                <span class="member-icon">${c.kind === 'coach' ? '🎯' : c.kind === 'guardian' ? '👪' : c.kind === 'manager' ? '📋' : '✉️'}</span>
                <div class="member-details">
                    <span class="member-name">${esc(c.name)} ${flags.join(' ')}</span>
                    <span class="member-email">${esc(contactSummary(c))}</span>
                </div>
                <span class="member-role role-${c.kind === 'coach' ? 'coach' : 'viewer'}">${esc(KIND_LABELS[c.kind] || c.kind)}</span>
            </div>
            ${derived ? '' : `
            <div class="mail-contact-actions">
                ${bounces.length ? `<button class="icon-button" data-action="clear-bounce" data-id="${escAttr(c.id)}" title="Deliver to this contact again"><i class="fas fa-redo"></i></button>` : ''}
                <button class="icon-button" data-action="${editing ? 'close-editor' : 'edit-contact'}" data-id="${escAttr(c.id)}" title="${editing ? 'Done editing' : 'Edit name, email addresses, role or players'}"><i class="fas fa-${editing ? 'check' : 'pen'}"></i></button>
                <button class="icon-button" data-action="toggle-status" data-id="${escAttr(c.id)}" data-status="${escAttr(c.status || 'active')}" title="${c.status === 'active' ? 'Pause delivery' : 'Resume delivery'}"><i class="fas fa-${c.status === 'active' ? 'pause' : 'play'}"></i></button>
                <button class="icon-button remove-member-btn" data-action="remove-contact" data-id="${escAttr(c.id)}" data-name="${escAttr(c.name)}" title="Remove from directory"><i class="fas fa-times"></i></button>
            </div>
            ${editing ? renderContactEditor(c) : ''}`}
        </div>`;
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
    return `
        <div class="settings-section">
            <h3>Player addresses</h3>
            <p class="section-description">Writing to a player's address reaches the player (if they have an email), all of their guardians, and every coach. Set a player's own email here if they have one (several, comma-separated, is fine); edit the address name if two players share a first name. Changes save when you leave the box.</p>
            ${missing.length ? `<button class="invite-btn viewer-invite" data-action="sync-aliases"><i class="fas fa-sync"></i> Add addresses for ${missing.length} new player${missing.length === 1 ? '' : 's'}</button>` : ''}
            <div class="members-list">
                ${roster.map(p => {
                    const c = byPlayer[p.id];
                    if (!c) return `<div class="member-item"><div class="member-info"><div class="member-details"><span class="member-name">${esc(p.name)}</span><span class="member-email">no address yet</span></div></div></div>`;
                    const guardians = (state.contacts || []).filter(g => g.kind === 'guardian' && (g.playerIds || []).includes(p.id)).map(g => g.name);
                    return `
                    <div class="member-item mail-player-row mail-editable-row" data-contact-id="${escAttr(c.id)}">
                        <div class="member-info">
                            <div class="member-details">
                                <span class="member-name">${esc(p.name)} ${contactBounces(c).length ? '<span class="mail-flag mail-flag-bad">bounce</span>' : ''}</span>
                                <span class="member-email"><code data-player-address>${esc(p.address || '')}</code></span>
                                <span class="member-email">${guardians.length ? 'Guardians: ' + esc(guardians.join(', ')) : '<em>No guardians linked yet</em>'}</span>
                            </div>
                        </div>
                        <form class="mail-player-form" data-form="player" data-id="${escAttr(c.id)}">
                            <input type="text" name="alias" data-field="alias" data-saved="${escAttr(c.alias || '')}" value="${escAttr(c.alias || '')}" maxlength="24" class="url-input mail-alias-input" autocapitalize="none" title="Address name" aria-label="Address name">
                            <input type="email" multiple name="email" data-field="emails" data-saved="${escAttr(contactEmails(c).join(', '))}" value="${escAttr(contactEmails(c).join(', '))}" placeholder="player's own email(s), optional" class="url-input" autocapitalize="none" aria-label="Player email">
                            <span class="icon-status mail-field-status" data-status></span>
                        </form>
                    </div>`;
                }).join('') || '<p class="info-message">No players on the roster.</p>'}
            </div>
        </div>`;
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
                    <span class="member-email">From ${esc(item.fromName || '')} &lt;${esc(item.from || '?')}&gt; to <code>${esc(item.list)}</code> · ${esc(fmtDate(item.at))}</span>
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

function renderLogRow(e) {
    const icon = { relayed: '✅', released: '✅', quarantined: '⏸', dropped: '🚫', failed: '❌', bounce: '↩️', complaint: '⚠️', test: '🧪' }[e.action] || '•';
    const what = e.action === 'relayed' || e.action === 'released'
        ? `to ${e.recipients} recipient${e.recipients === 1 ? '' : 's'}`
        : (REASON_LABELS[e.reason] || e.reason || e.action);
    return `<tr><td>${icon}</td><td>${esc(fmtDate(e.at))}</td><td><code>${esc(e.list || '')}</code></td><td>${esc(e.fromName || e.from || '')}</td><td>${esc(e.subject || '')}</td><td>${esc(what)}</td></tr>`;
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
        if (action === 'send-test') {
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

function onContentChange(event) {
    if (event.target.dataset?.field && event.target.tagName === 'SELECT') {
        queueSave(event.target);
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
        } else if (kind === 'player' || kind === 'contact-edit') {
            // Fields save on leaving them; Enter just leaves the field.
            document.activeElement?.blur?.();
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
    pendingSave = pendingSave.then(() => saveField(input)).catch(error => log.error('teamMail: save failed', error));
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
        const r = await api(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify({ [field]: value }) });
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
    const list = state?.contacts || [];
    const at = list.findIndex(c => c.id === contact.id);
    if (at >= 0) list[at] = { ...list[at], ...contact };
    const row = form?.closest('[data-contact-id]');
    if (!row) return;
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
