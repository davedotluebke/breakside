/*
 * Sync status indicator, full-refresh flow, pending-sync dialog, sign-out,
 * connection info, and app-update helpers for the teams screen.
 * Split out of teamSelection.js (D2 refactor).
 */
import {
    API_BASE_URL, getSyncStatus, processSyncQueue, syncUserTeams, pullFromCloud,
} from '../store/sync.js';
import { populateCloudTeamsAndGames } from './teamList.js';
import { showControllerToast } from '../game/controllerState.js';

function showSetServerDialog() {
    const currentUrl = localStorage.getItem('ultistats_api_url') ||
        (typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://localhost:8000');

    const newUrl = prompt(
        'Enter the server address:\n\n' +
        'Examples:\n' +
        '• https://api.breakside.pro (production)\n' +
        '• http://192.168.1.100:8000 (local network)\n' +
        '• http://localhost:8000 (same device)\n\n' +
        'Leave empty to use auto-detection.',
        currentUrl
    );

    if (newUrl === null) {
        // User cancelled
        return;
    }

    if (newUrl.trim() === '') {
        // Clear stored URL - will use auto-detection
        localStorage.removeItem('ultistats_api_url');
        alert('Server URL cleared. The app will auto-detect the server on next reload.');
    } else {
        // Validate URL format
        try {
            new URL(newUrl.trim());
            localStorage.setItem('ultistats_api_url', newUrl.trim());
            alert('Server URL updated. Reload the app to apply changes.');
        } catch (e) {
            alert('Invalid URL format. Please enter a valid URL (e.g., http://192.168.1.100:8000)');
            return;
        }
    }

    // Offer to reload
    if (confirm('Reload the app now to apply changes?')) {
        window.location.reload();
    }
}

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

// Keep old function names for backwards compatibility
async function triggerManualSync() { return doFullRefresh(); }
async function pullDataFromCloud() { return doFullRefresh(); }

/**
 * Handle sign out - clears auth state and shows login screen
 */
async function handleSignOut() {
    if (!window.breakside?.auth?.signOut) {
        alert('Sign out not available');
        return;
    }

    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) {
        signOutBtn.disabled = true;
        signOutBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing out...';
    }

    try {
        await window.breakside.auth.signOut();
        console.log('Signed out successfully');

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

        if (signOutBtn) {
            signOutBtn.disabled = false;
            signOutBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i> Sign Out';
        }
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
                updateButton = `<br><button onclick="confirmAppUpdate()" style="margin-top:6px;padding:4px 12px;background:#28a745;color:white;border:none;border-radius:4px;cursor:pointer;">Update Now</button>`;
            }
        } catch (e) {
            console.log('Update check failed:', e);
        }
    }

    const message = `${isOnline ? 'Online' : 'Offline'}<br>` +
        `<span style="font-size:0.9em;">${versionLine}<br>User: ${userEmail}<br>Server: ${serverUrl}${updateButton}</span>`;

    if (typeof showControllerToast === 'function') {
        // Longer duration if update is available
        showControllerToast(message, 'info', updateButton ? 8000 : 4000);
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
    // TODO(esm): sync.js exposes the queue accessors on window only — import
    // them once store/sync.js exports getSyncQueueItems/clearSyncQueue.
    const items = typeof window.getSyncQueueItems === 'function' ? window.getSyncQueueItems() : [];
    const listEl = document.getElementById('pendingSyncList');
    if (!listEl) return;

    if (items.length === 0) {
        listEl.innerHTML = '<p style="color:#888; font-style:italic;">No pending updates.</p>';
    } else {
        const maxShown = 3;
        const lines = items.slice(0, maxShown).map(item => {
            const label = describeSyncItem(item);
            const age = formatSyncAge(item.timestamp);
            const retryNote = item.retryCount > 0
                ? ` <span style="color:#c00; font-size:0.8rem;">(${item.retryCount} failed attempt${item.retryCount > 1 ? 's' : ''})</span>`
                : '';
            return `<div style="padding: 0.4rem 0; border-bottom: 1px solid #eee;">
                <span style="font-weight:600;">${item.action}</span> ${label}${retryNote}
                <div style="font-size:0.8rem; color:#888;">${age}</div>
            </div>`;
        });
        if (items.length > maxShown) {
            lines.push(`<div style="padding: 0.4rem 0; color: #888; font-style: italic;">...and ${items.length - maxShown} more</div>`);
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
    // TODO(esm): window-only sync.js queue accessor (see showPendingSyncDialog)
    if (typeof window.clearSyncQueue === 'function') {
        window.clearSyncQueue();
    }
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

// --- ES-module exports; window.* shims below are transitional or documented
// --- survivors (generated-HTML / index.html inline onclick handlers).
export {
    buildSyncStatusHTML, updateSyncStatusDisplay, doFullRefresh,
    showConnectionInfo,
};
// updateSyncStatusDisplay: called bare (typeof-guarded) by converted store/sync.js.
window.updateSyncStatusDisplay = updateSyncStatusDisplay;
// showConnectionInfo: called bare by game/gameScreenEvents.js (classic) and
// main.js; also a generated-HTML onclick survivor (sync-status bar).
// window survivor: referenced by generated-HTML onclick
window.showConnectionInfo = showConnectionInfo;
// window survivor: referenced by generated-HTML onclick
window.handleSignOut = handleSignOut;
// window survivor: referenced by generated-HTML onclick
window.showPendingSyncDialog = showPendingSyncDialog;
// window survivor: referenced by generated-HTML onclick
window.confirmAppUpdate = confirmAppUpdate;
// window survivor: referenced by index.html inline onclick (converted later in migration)
window.closePendingSyncDialog = closePendingSyncDialog;
// window survivor: referenced by index.html inline onclick (converted later in migration)
window.confirmClearSyncQueue = confirmClearSyncQueue;
