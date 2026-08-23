/*
 * Sync status indicator, full-refresh flow, pending-sync dialog, sign-out,
 * connection info, and app-update helpers for the teams screen.
 * Split out of teamSelection.js (D2 refactor).
 */
import {
    API_BASE_URL, getSyncStatus, processSyncQueue, syncUserTeams, pullFromCloud,
    getSyncQueueItems, clearSyncQueue,
} from '../store/sync.js';
import { populateCloudTeamsAndGames } from './teamList.js';
import { showControllerToast } from '../game/controllerState.js';
import { escapeHtml } from '../utils/gameLogRenderer.js';
import { isDiagnosticHost } from '../utils/diagnosticSurface.js';
import { log } from '../utils/logger.js';

/**
 * Build the HTML for the sync status indicator
 */
function buildSyncStatusHTML() {
    let status = getSyncStatus();

    const isOnline = status.isOnline;
    const totalPending = status.pendingCount || 0;
    const statusIcon = isOnline ? '🌐' : '📴';
    const statusText = isOnline ? 'Online' : 'Offline';
    const pendingBadge = totalPending > 0
        ? `<span class="pending-badge" onclick="showPendingSyncDialog()" style="cursor: pointer;">${totalPending} pending</span>`
        : '';

    // Check if user is authenticated
    const isAuthenticated = window.breakside?.auth?.isAuthenticated?.() || false;
    const userEmail = window.breakside?.auth?.getCurrentUser?.()?.email || '';
    const signOutButton = isAuthenticated
        ? `<button id="signOutBtn" class="sync-btn sign-out-btn" onclick="handleSignOut()" title="${userEmail}">
               <i class="fas fa-sign-out-alt"></i> Sign Out
           </button>`
        : '';

    return `
        <div class="sync-status-info" onclick="showConnectionInfo()" style="cursor: pointer;">
            <span class="sync-status-icon">${statusIcon}</span>
            <span class="sync-status-text">${statusText}</span>
        </div>
        ${pendingBadge}
        <div class="sync-status-actions">
            ${signOutButton}
        </div>
    `;
}

/**
 * Update the sync status display
 */
function updateSyncStatusDisplay() {
    const container = document.getElementById('syncStatusContainer');
    if (container) {
        container.innerHTML = buildSyncStatusHTML();
    }
}

/**
 * Unified refresh: push pending local changes, pull latest from cloud, re-render.
 * @param {boolean} silent - If true, don't show alerts on failure (used for auto-refresh)
 */
let _refreshInProgress = false;
async function doFullRefresh(silent = false) {
    if (_refreshInProgress) return;
    _refreshInProgress = true;

    // Subtle feedback: spin the refresh icon once (no text change, no reflow)
    const refreshIcon = document.getElementById('refreshIcon');
    if (refreshIcon) {
        refreshIcon.classList.add('refresh-spin');
    }

    try {
        // Step 1: Push any pending local changes
        if (typeof processSyncQueue === 'function') {
            try {
                await processSyncQueue();
            } catch (e) {
                console.warn('Sync queue processing failed:', e);
            }
        }

        // Step 2: Pull latest data from cloud
        if (typeof syncUserTeams === 'function') {
            try {
                await syncUserTeams();
            } catch (e) {
                console.warn('Team sync failed:', e);
            }
        }

        if (typeof pullFromCloud === 'function') {
            try {
                await pullFromCloud();
            } catch (e) {
                console.warn('Pull from cloud failed:', e);
            }
        }

        // Step 3: Re-render the team/game list
        updateSyncStatusDisplay();
        await populateCloudTeamsAndGames();

    } catch (error) {
        console.error('Refresh failed:', error);
        if (!silent) {
            alert('Refresh failed: ' + error.message);
        }
    } finally {
        _refreshInProgress = false;
        // Remove spin class (re-query since innerHTML may have been rebuilt)
        const icon = document.getElementById('refreshIcon');
        if (icon) {
            icon.classList.remove('refresh-spin');
        }
    }
}

/**
 * Restore the sign-out button to its resting label.
 * Its markup lives in buildSyncStatusHTML(); this keeps the three places that
 * temporarily relabel it from each hard-coding the same string.
 */
function resetSignOutButton() {
    const btn = document.getElementById('signOutBtn');
    if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-out-alt"></i> Sign Out';
    }
}

/**
 * Gate sign-out on not silently destroying unsynced work.
 *
 * signOut() → clearLocalData() wipes teamsData and the sync queue, so a coach
 * who recorded a tournament with no signal and then tapped Sign Out lost the
 * games *and* the queue that would have uploaded them — no prompt, no warning.
 * (docs/offline-no-account-audit.md § 6.)
 *
 * When items are pending we first try to drain the queue, which is what the
 * user actually wants and usually resolves it silently. Only if changes are
 * still stranded afterwards do we ask — and then the prompt names the count and
 * says plainly that they'll be erased.
 *
 * @returns {Promise<boolean>} true if it's safe to proceed with signing out.
 */
async function confirmSignOutWithPending() {
    let pending = getSyncStatus().pendingCount || 0;
    if (pending === 0) return true;

    const isOnline = navigator.onLine;

    // Online: push first. processSyncQueue() attempts every queued item once
    // before returning (its 5s timer only re-tries what's left), so the count
    // immediately after is an honest "what's genuinely stuck".
    if (isOnline) {
        const btn = document.getElementById('signOutBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Syncing ${pending}...`;
        }
        try {
            await processSyncQueue();
        } catch (e) {
            console.warn('Pre-sign-out sync failed:', e);
        }
        resetSignOutButton();

        pending = getSyncStatus().pendingCount || 0;
        if (pending === 0) return true;
    }

    const noun = pending === 1 ? 'change has' : 'changes have';
    const reason = isOnline
        ? 'Syncing them just now didn\'t clear them — tap the Online status and use "View / Clear…" to see why.'
        : 'You\'re offline. Reconnecting first would let them sync.';

    return confirm(
        `${pending} ${noun} not synced to the cloud yet.\n\n` +
        `${reason}\n\n` +
        'Signing out erases all local data on this device, including these ' +
        'unsynced changes. This cannot be undone.\n\n' +
        'Sign out anyway?'
    );
}

/**
 * Handle sign out - clears auth state and shows login screen
 */
async function handleSignOut() {
    if (!window.breakside?.auth?.signOut) {
        alert('Sign out not available');
        return;
    }

    if (!(await confirmSignOutWithPending())) {
        resetSignOutButton();
        return;
    }

    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) {
        signOutBtn.disabled = true;
        signOutBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing out...';
    }

    try {
        await window.breakside.auth.signOut();
        log('Signed out successfully');

        // Show the login screen
        if (window.breakside?.loginScreen?.showAuthScreen) {
            window.breakside.loginScreen.showAuthScreen();
        } else {
            // Fallback: reload the page
            window.location.reload();
        }
    } catch (error) {
        console.error('Sign out failed:', error);
        alert('Sign out failed: ' + error.message);

        resetSignOutButton();
    }
}

/**
 * Show connection info toast when tapping the Online/Offline status.
 * Uses the existing toast system (showControllerToast) for consistent styling.
 * Includes version info and update check.
 */
async function showConnectionInfo() {
    const userEmail = window.breakside?.auth?.getCurrentUser?.()?.email || 'Not signed in';
    const serverUrl = typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'Not configured';
    const isOnline = navigator.onLine;

    // Get current version
    const version = window.APP_VERSION || '?';
    const build = window.APP_BUILD || '?';

    // Start with basic info, update later if we find an update available
    const label = window.APP_DEPLOY_LABEL;
    let versionLine = `Version: ${version} (Build ${build})${label ? ' [' + label + ']' : ''}`;
    let updateButton = '';

    // Check for updates if online (checkForAppUpdate is main.js-owned; stays
    // window-qualified until the migration's final consolidation pass)
    if (isOnline && typeof window.checkForAppUpdate === 'function') {
        try {
            const updateInfo = await window.checkForAppUpdate();
            if (updateInfo.hasUpdate) {
                versionLine = `Version: ${version} (Build ${build}) → <b>${updateInfo.latestBuild} available</b>`;
                updateButton = `<br><button onclick="confirmAppUpdate()" class="update-now-btn">Update Now</button>`;
            }
        } catch (e) {
            log('Update check failed:', e);
        }
    }

    // Surface stuck sync-queue items with a path to inspect/clear them —
    // the pending badge only exists on the teams screen's sync bar, so from
    // here (e.g. mid-game) this is the only route to the pending dialog.
    const pendingCount = getSyncStatus().pendingCount || 0;
    const pendingLine = pendingCount > 0
        ? `<br>${pendingCount} pending update${pendingCount > 1 ? 's' : ''} waiting to sync ` +
          `<button onclick="showPendingSyncDialog()" class="update-now-btn">View / Clear…</button>`
        : '';

    // Storage durability — the "where did my data go?" diagnostic. localStorage
    // is evictable unless the browser granted persistence (requested on first
    // write in store/storage.js), and there's otherwise no way to tell from the
    // app which tier you're on.
    //
    // Deliberately NOT behind isDiagnosticSurface(): unlike the battery report
    // this is a claim about the user's own data, so it stays visible in
    // production. Revisit if it reads as noise.
    let storageLine = '';
    try {
        if (navigator.storage?.persisted) {
            storageLine = (await navigator.storage.persisted())
                ? '<br>Storage: durable'
                : '<br>Storage: best-effort (may be evicted)';
        }
    } catch (e) {
        log('Storage persistence check failed:', e);
    }

    // Battery report — what this session actually did. Lives here rather than
    // in its own screen because this overlay is already the "what's going on
    // under the hood" surface, and it's reachable mid-game.
    //
    // Developer surfaces only: it's a wall of counters aimed at whoever is
    // tuning the polling loops, not at a coach on a sideline.
    const powerLine = (window.powerLog && isDiagnosticSurface())
        ? '<br><button onclick="showPowerReport()" class="update-now-btn">Battery report…</button>'
        : '';

    // Info lines first, then the things you can press.
    const message = `${isOnline ? 'Online' : 'Offline'}<br>` +
        `<span style="font-size:0.9em;">${versionLine}<br>User: ${userEmail}<br>Server: ${serverUrl}` +
        `${storageLine}${pendingLine}${powerLine}${updateButton}</span>`;

    if (typeof showControllerToast === 'function') {
        // Longer duration if update is available or pending items need action
        showControllerToast(message, 'info', (updateButton || pendingLine) ? 8000 : 4000);
    }
}

/**
 * Is this a surface where developer diagnostics may be shown at all?
 *
 * Rules live in utils/diagnosticSurface.js (pure, unit-tested against every
 * origin including production). This just supplies the two live inputs:
 * `window._isStaging` is set inline by index.html before any module loads, so
 * it is already settled by the time this runs.
 *
 * @returns {boolean}
 */
function isDiagnosticSurface() {
    return isDiagnosticHost(location.hostname, window._isStaging === true);
}

/**
 * Show the power/battery report for this session as a copyable toast.
 *
 * The copy button matters more than the display: the useful version of this
 * data is pasted into a field report next to "phone died at 2pm", not squinted
 * at on a sideline.
 */
function showPowerReport() {
    // Re-checked rather than trusting the hidden button: this is reachable as
    // a global (the button uses an inline onclick), and a stale cached toast
    // could still carry one after a deploy.
    if (!isDiagnosticSurface()) return;
    const report = window.powerLog?.formatReport?.();
    if (!report) return;

    const body = escapeHtml(report).replace(/\n/g, '<br>');
    const message = `<b>Battery report</b><br>` +
        `<span style="font-size:0.85em;font-family:monospace;">${body}</span><br>` +
        `<button onclick="copyPowerReport()" class="update-now-btn">Copy</button>`;

    if (typeof showControllerToast === 'function') {
        showControllerToast(message, 'info', 30000);
    }
}

/** Copy the power report to the clipboard for pasting into a field report. */
function copyPowerReport() {
    if (!isDiagnosticSurface()) return;
    const report = window.powerLog?.formatReport?.();
    if (!report) return;
    const done = () => showControllerToast?.('Battery report copied', 'success', 2000);
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(report).then(done).catch(() => {});
    }
}

/**
 * Show confirmation dialog and force app update
 */
function confirmAppUpdate() {
    // No confirmation prompt: the "Update Now" button already takes several
    // steps to reach, and the worst case if hit by accident is just re-joining
    // the game from the Teams screen.
    // forceAppUpdate is main.js-owned; window-qualified until final consolidation
    if (typeof window.forceAppUpdate === 'function') {
        window.forceAppUpdate();
    } else {
        // Fallback: just reload with cache clear
        window.location.reload(true);
    }
}

/**
 * Show the pending sync dialog with a summary of queued items.
 */
function showPendingSyncDialog() {
    const items = getSyncQueueItems();
    const listEl = document.getElementById('pendingSyncList');
    if (!listEl) return;

    if (items.length === 0) {
        listEl.innerHTML = '<p class="pending-sync-empty">No pending updates.</p>';
    } else {
        const maxShown = 3;
        const lines = items.slice(0, maxShown).map(item => {
            const label = describeSyncItem(item);
            const age = formatSyncAge(item.timestamp);
            const retryNote = item.retryCount > 0
                ? ` <span class="pending-sync-retry">(${item.retryCount} failed attempt${item.retryCount > 1 ? 's' : ''})</span>`
                : '';
            // Surface the most recent failure so a stuck item is diagnosable
            // from the UI (offline-classified failures retry forever and would
            // otherwise show no reason at all).
            const errNote = item.lastError
                ? `<div class="pending-sync-error">last error: ${escapeHtml(item.lastError).slice(0, 300)}</div>`
                : '';
            return `<div class="pending-sync-item">
                <span class="pending-sync-action">${item.action}</span> ${label}${retryNote}
                <div class="pending-sync-age">${age}</div>
                ${errNote}
            </div>`;
        });
        if (items.length > maxShown) {
            lines.push(`<div class="pending-sync-more">...and ${items.length - maxShown} more</div>`);
        }
        listEl.innerHTML = lines.join('');
    }

    document.getElementById('pendingSyncDialog').style.display = 'block';
}

/**
 * Describe a sync queue item for display (team name, game opponent, player name).
 */
function describeSyncItem(item) {
    const data = item.data || {};
    if (item.type === 'game') {
        const team = data.team || '?';
        const opponent = data.opponent || '?';
        return `game: ${team} vs ${opponent}`;
    }
    if (item.type === 'team') {
        return `team: ${data.name || item.id}`;
    }
    if (item.type === 'player') {
        return `player: ${data.name || item.id}`;
    }
    return `${item.type}: ${item.id}`;
}

/**
 * Format how long ago a sync item was queued.
 */
function formatSyncAge(timestamp) {
    if (!timestamp) return '';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function closePendingSyncDialog() {
    document.getElementById('pendingSyncDialog').style.display = 'none';
}

function confirmClearSyncQueue() {
    if (!confirm('Discard all pending updates? These changes will be lost.')) return;
    clearSyncQueue();
    closePendingSyncDialog();
    updateSyncStatusDisplay();
}

// Close pending sync dialog on backdrop click
window.addEventListener('click', function(event) {
    const dialog = document.getElementById('pendingSyncDialog');
    if (event.target === dialog) {
        closePendingSyncDialog();
    }
});

// Pending-sync dialog buttons (were inline onclick in index.html pre-ESM).
// Module evaluation happens after DOM parse, so the elements exist here.
document.getElementById('pendingSyncCloseX')?.addEventListener('click', closePendingSyncDialog);
document.getElementById('pendingSyncKeepBtn')?.addEventListener('click', closePendingSyncDialog);
document.getElementById('pendingSyncClearAllBtn')?.addEventListener('click', confirmClearSyncQueue);

// --- ES-module exports ---
export {
    buildSyncStatusHTML, updateSyncStatusDisplay, doFullRefresh,
    showConnectionInfo,
};
// window survivor: late-bound back-edge hook (called by store/sync.js, which
// evaluates before this file and cannot import from it without a reorder)
window.updateSyncStatusDisplay = updateSyncStatusDisplay;
// window survivor: generated-HTML onclick (sync-status bar)
window.showConnectionInfo = showConnectionInfo;
// window survivor: referenced by generated-HTML onclick
window.handleSignOut = handleSignOut;
// window survivor: referenced by generated-HTML onclick
window.showPendingSyncDialog = showPendingSyncDialog;
// window survivor: referenced by generated-HTML onclick
window.confirmAppUpdate = confirmAppUpdate;
// window survivor: referenced by generated-HTML onclick
window.showPowerReport = showPowerReport;
// window survivor: referenced by generated-HTML onclick
window.copyPowerReport = copyPowerReport;
