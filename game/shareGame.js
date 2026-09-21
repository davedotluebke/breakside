/*
 * Share Game dialog — create, copy, and revoke public share links for a game.
 *
 * A share link (https://www.breakside.pro/view/{hash}) opens the standalone
 * viewer in share mode: live score + play-by-play, no account needed. Links
 * expire. Routing chain documented in ARCHITECTURE.md § Share Links.
 *
 * "List publicly" (put the game on the breakside.pro landing page) is
 * DISABLED — see PUBLIC_LISTING_ENABLED below. The code is kept so it can
 * come back as an admin-only action for verified games.
 */
import { log } from '../utils/logger.js';
import { getApiBaseUrl, authFetch } from '../store/sync.js';
import { showControllerToast } from './controllerState.js';
import { encodeQr, qrSvg } from '../utils/qrCode.js';

/*
 * Public listing switch. false since 2026-09-07: letting any coach of any
 * team put a game (their team name, opponent name, score) on the site's home
 * page is a defacement vector — a throwaway account is all it takes. The
 * backend has the matching gate (config.public_listing_enabled, default
 * off) and is the one that matters; this only hides the checkbox and the
 * "Public" badge. Flipping this alone does nothing on production. The
 * intended way back is an admin-only listing of verified games; see TODO.md
 * and ARCHITECTURE.md § Share Links.
 */
const PUBLIC_LISTING_ENABLED = false;

const EXPIRY_CHOICES = [
    { days: 1, label: '1 day' },
    { days: 7, label: '1 week' },
    { days: 31, label: '1 month' },
    { days: 183, label: '6 months' },
];
const DEFAULT_EXPIRY_DAYS = 7;

function esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        // Clipboard API needs a secure context; fall back for plain-http dev.
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (e2) {
            return false;
        }
    }
}

function daysLeft(expiresAt) {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt) - Date.now();
    return Math.max(0, Math.ceil(ms / 86400000));
}

function renderShareRow(share) {
    const left = daysLeft(share.expiresAt);
    const expiry = left == null ? 'never expires'
        : left === 0 ? 'expires today'
        : left === 1 ? 'expires tomorrow'
        : `expires in ${left} days`;
    const listedBadge = PUBLIC_LISTING_ENABLED && share.listed
        ? '<span class="share-listed-badge" title="Shown in the public games list on breakside.pro">Public</span>'
        : '';
    return `
        <div class="share-link-row" data-share-id="${esc(share.id)}" data-share-url="${esc(share.url)}">
            <div class="share-link-info">
                <span class="share-link-url">…/view/${esc(share.hash)}</span>
                <span class="share-link-meta">${expiry}${listedBadge ? ' · ' : ''}${listedBadge}</span>
            </div>
            <button class="share-qr-btn" title="Show this link as a QR code for someone to scan" aria-expanded="false">QR</button>
            <button class="share-copy-btn" title="Copy link">Copy</button>
            <button class="share-revoke-btn" title="Turn off this link — it stops working for everyone who has it">Turn off</button>
        </div>
        <div class="share-qr-panel" data-share-id="${esc(share.id)}" hidden></div>`;
}

/**
 * Fill a row's QR panel (once) and show or hide it.
 *
 * The code is the share URL itself, so a parent on the sideline points their
 * camera at the coach's phone instead of typing or receiving a link — and it
 * sidesteps the clipboard entirely, which iOS Safari has been known to refuse
 * after the await in createShare. Rendered lazily: a dialog listing several
 * links shouldn't pay for codes nobody opens.
 */
function toggleQrPanel(row, show) {
    const panel = row.nextElementSibling;
    const btn = row.querySelector('.share-qr-btn');
    if (!panel || !panel.classList.contains('share-qr-panel')) return;
    const url = row.dataset.shareUrl;
    const open = show === undefined ? panel.hidden : !!show;
    if (open && !panel.dataset.rendered) {
        try {
            const svg = qrSvg(encodeQr(url), { label: `QR code for ${url}` });
            panel.innerHTML = `
                ${svg}
                <span class="share-qr-caption">Scan to watch live</span>
                <span class="share-qr-url">${esc(url)}</span>`;
            panel.dataset.rendered = '1';
        } catch (err) {
            log('QR render failed:', err);
            panel.innerHTML = '<span class="share-qr-caption">Couldn\'t draw a QR code for this link.</span>';
        }
    }
    panel.hidden = !open;
    if (btn) {
        // The label stays "QR" — a wider "Hide QR" would reflow the row on a
        // phone; the expanded state is carried by aria-expanded and its style.
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.title = open ? 'Hide the QR code' : 'Show this link as a QR code for someone to scan';
    }
}

async function loadShareList(modal, gameId, opts) {
    const openQrFor = opts && opts.openQrFor;
    const listEl = modal.querySelector('#shareLinksList');
    listEl.innerHTML = '<p class="share-list-note">Loading links…</p>';
    try {
        const response = await authFetch(`${getApiBaseUrl()}/api/games/${gameId}/shares`);
        if (response.status === 404) {
            // Game not on the server yet (offline-created, never synced).
            listEl.innerHTML = '<p class="share-list-note">This game hasn\'t synced to the cloud yet — get online, then try again.</p>';
            modal.querySelector('#createShareLinkBtn').disabled = true;
            return;
        }
        if (response.status === 403) {
            listEl.innerHTML = '<p class="share-list-note">Only coaches can manage share links.</p>';
            modal.querySelector('#createShareLinkBtn').disabled = true;
            return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const active = (data.shares || []).filter(s => s.isValid);
        if (active.length === 0) {
            listEl.innerHTML = '<p class="share-list-note">No active links yet — create one below.</p>';
            return;
        }
        listEl.innerHTML = active.map(renderShareRow).join('');

        listEl.querySelectorAll('.share-qr-btn').forEach(btn => {
            btn.addEventListener('click', () => toggleQrPanel(btn.closest('.share-link-row')));
        });
        // A link that was just created opens with its code showing: the
        // coach made it to hand to someone standing right there.
        if (openQrFor) {
            const row = listEl.querySelector(`.share-link-row[data-share-id="${CSS.escape(String(openQrFor))}"]`);
            if (row) toggleQrPanel(row, true);
        }

        listEl.querySelectorAll('.share-copy-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const url = btn.closest('.share-link-row').dataset.shareUrl;
                if (await copyText(url)) {
                    showControllerToast('Link copied', 'success', 2000);
                } else {
                    showControllerToast(`Copy failed — link: ${url}`, 'warning', 8000);
                }
            });
        });

        listEl.querySelectorAll('.share-revoke-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const shareId = btn.closest('.share-link-row').dataset.shareId;
                // Irreversible for everyone holding the link, so confirm
                // (the app's plain confirm() convention, as for End Game).
                if (!confirm('Turn off this share link? Anyone who has it will lose access, and it can\'t be turned back on.')) return;
                btn.disabled = true;
                try {
                    const r = await authFetch(`${getApiBaseUrl()}/api/shares/${shareId}`, { method: 'DELETE' });
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    showControllerToast('Share link turned off', 'info', 2500);
                    loadShareList(modal, gameId);
                } catch (err) {
                    btn.disabled = false;
                    log('Share revoke failed:', err);
                    showControllerToast('Couldn\'t turn off the link — check your connection', 'error');
                }
            });
        });
    } catch (err) {
        log('Share list load failed:', err);
        listEl.innerHTML = '<p class="share-list-note">Couldn\'t load links — check your connection.</p>';
    }
}

async function createShare(modal, gameId) {
    const btn = modal.querySelector('#createShareLinkBtn');
    const days = modal.querySelector('#shareExpirySelect').value;
    const listedBox = modal.querySelector('#shareListedCheckbox');
    const listed = PUBLIC_LISTING_ENABLED && !!(listedBox && listedBox.checked);
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
        const listedParam = PUBLIC_LISTING_ENABLED ? `&listed=${listed}` : '';
        const response = await authFetch(
            `${getApiBaseUrl()}/api/games/${gameId}/share?expires_days=${encodeURIComponent(days)}${listedParam}`,
            { method: 'POST' }
        );
        if (response.status === 404) {
            showControllerToast('Game isn\'t on the server yet — sync first', 'warning');
            return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const copied = await copyText(data.url);
        showControllerToast(
            copied ? 'Share link created and copied' : 'Share link created',
            'success', 3000
        );
        loadShareList(modal, gameId, { openQrFor: data.id || (data.share && data.share.id) });
    } catch (err) {
        log('Share create failed:', err);
        showControllerToast('Couldn\'t create the link — check your connection', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Create link';
    }
}

/**
 * Open the Share Game dialog for a game (must have a server id — i.e. any
 * game that has synced at least once; others get a friendly nudge).
 */
function showShareGameDialog(game) {
    if (!game || !game.id) {
        showControllerToast('No game to share yet', 'warning');
        return;
    }

    let modal = document.getElementById('shareGameModal');
    if (modal) modal.remove();

    const expiryOptions = EXPIRY_CHOICES.map(c =>
        `<option value="${c.days}"${c.days === DEFAULT_EXPIRY_DAYS ? ' selected' : ''}>${c.label}</option>`
    ).join('');
    const listedControl = PUBLIC_LISTING_ENABLED ? `
                    <label class="share-listed-label" title="Also show this game in the public games list on breakside.pro">
                        <input type="checkbox" id="shareListedCheckbox"> List publicly
                    </label>` : '';

    modal = document.createElement('div');
    modal.id = 'shareGameModal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content share-game-content">
            <div class="dialog-header prominent-dialog-header">
                <h2>Share Game</h2>
                <span class="close">&times;</span>
            </div>
            <div class="share-game-body">
                <p class="share-intro">
                    Anyone with a share link can watch
                    <strong>${esc(game.team || 'this game')} vs ${esc(game.opponent || 'TBD')}</strong>
                    live — score and play-by-play, no account needed. Copy a link, or show its QR code for someone to scan.
                </p>
                <div id="shareLinksList"></div>
                <div class="share-create-row">
                    <label class="share-expiry-label">Expires:
                        <select id="shareExpirySelect">${expiryOptions}</select>
                    </label>
${listedControl}
                    <button id="createShareLinkBtn" type="button">Create link</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);

    modal.querySelector('#createShareLinkBtn').addEventListener('click',
        () => createShare(modal, game.id));

    const close = () => modal.remove();
    modal.querySelector('.close').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };

    loadShareList(modal, game.id);
}

// --- ES-module exports ---
export { showShareGameDialog };
