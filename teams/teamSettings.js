/**
 * Team Settings Screen
 * Manages team members, invites, and joining teams
 */
import { currentTeam, saveAllTeamsData } from '../store/storage.js';
import { authFetch, syncTeamToCloud, syncUserTeams } from '../store/sync.js';
import { showScreen } from '../screens/navigation.js';
import { showGameScreen } from '../ui/panelSystem.js';
import { updateTeamRosterDisplay } from './rosterManagement.js';
import { showSelectTeamScreen } from './teamList.js';

// =============================================================================
// State
// =============================================================================

let currentInvite = null;
let pendingJoinInfo = null;

// =============================================================================
// API Helpers
// =============================================================================

// Authenticated requests go through the shared global `authFetch` (auth.js),
// which attaches the bearer token and Content-Type and centralizes any
// retry/refresh behavior. Unauthenticated endpoints (invite info, image proxy)
// use plain `fetch`.

function getApiBaseUrl() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : '';
}

// =============================================================================
// Screen Navigation
// =============================================================================

// Track where we came from so Back returns to the right screen
let _settingsReturnScreen = 'teamRosterScreen';

function showTeamSettingsScreen(returnScreen) {
    if (!currentTeam) {
        alert('No team selected');
        return;
    }

    // Guard against being passed an Event object when used as an event handler directly
    _settingsReturnScreen = (typeof returnScreen === 'string') ? returnScreen : 'teamRosterScreen';

    // Update team name
    const teamNameElement = document.getElementById('settingsTeamName');
    if (teamNameElement) {
        teamNameElement.textContent = currentTeam.name;
    }

    // Load team identity fields
    loadTeamIdentity();

    // Load data
    loadTeamMembers();
    loadTeamInvites();

    showScreen('teamSettingsScreen');
}

function initializeTeamSettings() {
    // Team Settings button
    const teamSettingsBtn = document.getElementById('teamSettingsBtn');
    if (teamSettingsBtn) {
        teamSettingsBtn.addEventListener('click', showTeamSettingsScreen);
    }
    
    // Back button
    const backFromSettingsBtn = document.getElementById('backFromSettingsBtn');
    if (backFromSettingsBtn) {
        backFromSettingsBtn.addEventListener('click', () => {
            if (_settingsReturnScreen === 'gameScreen') {
                if (typeof showGameScreen === 'function') {
                    showGameScreen();
                }
            } else if (_settingsReturnScreen === 'selectTeamScreen') {
                if (typeof showSelectTeamScreen === 'function') {
                    showSelectTeamScreen();
                } else {
                    showScreen('selectTeamScreen');
                }
            } else {
                // Re-populate roster before showing (content may be stale)
                if (_settingsReturnScreen === 'teamRosterScreen' && typeof updateTeamRosterDisplay === 'function') {
                    updateTeamRosterDisplay();
                }
                showScreen(_settingsReturnScreen);
            }
        });
    }
    
    // Invite buttons
    const createCoachInviteBtn = document.getElementById('createCoachInviteBtn');
    if (createCoachInviteBtn) {
        createCoachInviteBtn.addEventListener('click', () => createInvite('coach'));
    }
    
    const createViewerInviteBtn = document.getElementById('createViewerInviteBtn');
    if (createViewerInviteBtn) {
        createViewerInviteBtn.addEventListener('click', () => createInvite('viewer'));
    }
    
    // Invite modal buttons
    const closeInviteModalBtn = document.getElementById('closeInviteModalBtn');
    if (closeInviteModalBtn) {
        closeInviteModalBtn.addEventListener('click', hideInviteModal);
    }
    
    const copyCodeBtn = document.getElementById('copyCodeBtn');
    if (copyCodeBtn) {
        copyCodeBtn.addEventListener('click', copyInviteCode);
    }
    
    const copyLinkBtn = document.getElementById('copyLinkBtn');
    if (copyLinkBtn) {
        copyLinkBtn.addEventListener('click', copyInviteLink);
    }
    
    // Join team buttons
    const joinTeamBtn = document.getElementById('joinTeamBtn');
    if (joinTeamBtn) {
        joinTeamBtn.addEventListener('click', handleJoinCodeEntry);
    }
    
    const joinCodeInput = document.getElementById('joinCodeInput');
    if (joinCodeInput) {
        // Auto-uppercase and submit on enter
        joinCodeInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.toUpperCase();
        });
        joinCodeInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleJoinCodeEntry();
            }
        });
    }
    
    // Join modal buttons
    const cancelJoinBtn = document.getElementById('cancelJoinBtn');
    if (cancelJoinBtn) {
        cancelJoinBtn.addEventListener('click', hideJoinModal);
    }
    
    const confirmJoinBtn = document.getElementById('confirmJoinBtn');
    if (confirmJoinBtn) {
        confirmJoinBtn.addEventListener('click', confirmJoinTeam);
    }
    
    // Close modals on backdrop click
    const inviteModal = document.getElementById('inviteCreatedModal');
    if (inviteModal) {
        inviteModal.addEventListener('click', (e) => {
            if (e.target === inviteModal) hideInviteModal();
        });
    }
    
    const joinModal = document.getElementById('joinTeamModal');
    if (joinModal) {
        joinModal.addEventListener('click', (e) => {
            if (e.target === joinModal) hideJoinModal();
        });
    }
    
    // Initialize team identity handlers
    initializeTeamIdentityHandlers();
}

// =============================================================================
// Load Team Members
// =============================================================================

async function loadTeamMembers() {
    const membersList = document.getElementById('membersList');
    const memberCount = document.getElementById('memberCount');
    
    if (!membersList) return;
    
    // Check if authenticated (distinguish "signed out" from "offline/degraded")
    const auth = window.breakside?.auth;
    if (!auth?.isAuthenticated?.()) {
        membersList.innerHTML = (auth?.canActOffline?.() ?? !navigator.onLine)
            ? '<p class="info-message">You\'re offline. Members will load when you\'re back online.</p>'
            : '<p class="info-message">Sign in to view team members</p>';
        if (memberCount) memberCount.textContent = '0';
        return;
    }
    
    if (!currentTeam?.id) {
        membersList.innerHTML = '<p class="error-message">No team selected</p>';
        if (memberCount) memberCount.textContent = '0';
        return;
    }
    
    membersList.innerHTML = '<p class="loading-message">Loading members...</p>';
    
    try {
        const response = await authFetch(`${getApiBaseUrl()}/api/teams/${currentTeam.id}/members`);

        if (response.status === 403) {
            membersList.innerHTML = '<p class="info-message">You don\'t have access to view members</p>';
            if (memberCount) memberCount.textContent = '?';
            return;
        }
        
        if (!response.ok) {
            throw new Error('Failed to load members');
        }
        
        const data = await response.json();
        const members = data.members || [];
        
        if (memberCount) {
            memberCount.textContent = members.length.toString();
        }
        
        if (members.length === 0) {
            membersList.innerHTML = '<p class="info-message">No members yet</p>';
            return;
        }
        
        membersList.innerHTML = members.map(member => renderMemberItem(member)).join('');
        
        // Add remove button handlers
        membersList.querySelectorAll('.remove-member-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const userId = btn.dataset.userId;
                const name = btn.dataset.name;
                removeMember(userId, name);
            });
        });
        
    } catch (error) {
        console.error('Error loading members:', error);
        membersList.innerHTML = '<p class="error-message">Failed to load members</p>';
    }
}

function renderMemberItem(member) {
    const displayName = member.displayName || member.email?.split('@')[0] || 'Unknown';
    const roleIcon = member.role === 'coach' ? '🎯' : '👁️';
    const roleClass = member.role === 'coach' ? 'role-coach' : 'role-viewer';
    
    // Get current user ID to prevent self-removal UI issues
    const currentUserId = window.breakside?.auth?.getCurrentUser?.()?.id;
    const isSelf = member.userId === currentUserId;
    
    return `
        <div class="member-item">
            <div class="member-info">
                <span class="member-icon">${roleIcon}</span>
                <div class="member-details">
                    <span class="member-name">${escapeHtmlAttr(displayName)}${isSelf ? ' (you)' : ''}</span>
                    <span class="member-email">${escapeHtmlAttr(member.email || '')}</span>
                </div>
                <span class="member-role ${roleClass}">${escapeHtmlAttr(member.role || '')}</span>
            </div>
            <button class="remove-member-btn icon-button"
                    data-user-id="${escapeHtmlAttr(member.userId || '')}"
                    data-name="${escapeHtmlAttr(displayName)}"
                    title="Remove member">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;
}

async function removeMember(userId, name) {
    if (!confirm(`Remove ${name} from the team? They will lose access to all team data.`)) {
        return;
    }
    
    try {
        const response = await authFetch(`${getApiBaseUrl()}/api/teams/${currentTeam.id}/members/${userId}`, {
            method: 'DELETE'
        });

        if (response.status === 400) {
            const data = await response.json();
            alert(data.detail || 'Cannot remove this member');
            return;
        }
        
        if (!response.ok) {
            throw new Error('Failed to remove member');
        }
        
        // Reload members list
        loadTeamMembers();
        
    } catch (error) {
        console.error('Error removing member:', error);
        alert('Failed to remove member: ' + error.message);
    }
}

// =============================================================================
// Load Team Invites
// =============================================================================

async function loadTeamInvites() {
    const invitesList = document.getElementById('invitesList');
    
    if (!invitesList) return;
    
    // Check if authenticated (distinguish "signed out" from "offline/degraded")
    const auth = window.breakside?.auth;
    if (!auth?.isAuthenticated?.()) {
        invitesList.innerHTML = (auth?.canActOffline?.() ?? !navigator.onLine)
            ? '<p class="info-message">You\'re offline. Invites will load when you\'re back online.</p>'
            : '<p class="info-message">Sign in to view invites</p>';
        return;
    }
    
    if (!currentTeam?.id) {
        invitesList.innerHTML = '<p class="error-message">No team selected</p>';
        return;
    }
    
    invitesList.innerHTML = '<p class="loading-message">Loading invites...</p>';
    
    try {
        const response = await authFetch(`${getApiBaseUrl()}/api/teams/${currentTeam.id}/invites`);

        if (response.status === 403) {
            invitesList.innerHTML = '<p class="info-message">You don\'t have access to manage invites</p>';
            return;
        }
        
        if (!response.ok) {
            throw new Error('Failed to load invites');
        }
        
        const data = await response.json();
        const invites = (data.invites || []).filter(inv => inv.isValid);
        
        if (invites.length === 0) {
            invitesList.innerHTML = '<p class="info-message">No active invites</p>';
            return;
        }
        
        invitesList.innerHTML = invites.map(invite => renderInviteItem(invite)).join('');
        
        // Add revoke button handlers
        invitesList.querySelectorAll('.revoke-invite-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const inviteId = btn.dataset.inviteId;
                revokeInvite(inviteId);
            });
        });
        
        // Add copy code handlers
        invitesList.querySelectorAll('.copy-invite-code-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const code = btn.dataset.code;
                copyToClipboard(code);
                btn.innerHTML = '<i class="fas fa-check"></i>';
                setTimeout(() => {
                    btn.innerHTML = '<i class="fas fa-copy"></i>';
                }, 1500);
            });
        });
        
    } catch (error) {
        console.error('Error loading invites:', error);
        invitesList.innerHTML = '<p class="error-message">Failed to load invites</p>';
    }
}

function renderInviteItem(invite) {
    const roleIcon = invite.role === 'coach' ? '🎯' : '👁️';
    const roleClass = invite.role === 'coach' ? 'role-coach' : 'role-viewer';
    const expiresDate = invite.expiresAt ? formatDate(invite.expiresAt) : 'Never';
    
    return `
        <div class="invite-item">
            <div class="invite-info">
                <span class="invite-role-icon">${roleIcon}</span>
                <div class="invite-details">
                    <span class="invite-code">${escapeHtmlAttr(invite.code || '')}</span>
                    <span class="invite-meta">${escapeHtmlAttr(invite.role || '')} • expires ${escapeHtmlAttr(expiresDate)}</span>
                </div>
            </div>
            <div class="invite-actions">
                <button class="copy-invite-code-btn icon-button"
                        data-code="${escapeHtmlAttr(invite.code || '')}"
                        title="Copy code">
                    <i class="fas fa-copy"></i>
                </button>
                <button class="revoke-invite-btn icon-button"
                        data-invite-id="${escapeHtmlAttr(invite.id || '')}"
                        title="Revoke invite">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        </div>
    `;
}

async function revokeInvite(inviteId) {
    if (!confirm('Revoke this invite? It will no longer be usable.')) {
        return;
    }
    
    try {
        const response = await authFetch(`${getApiBaseUrl()}/api/invites/${inviteId}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            throw new Error('Failed to revoke invite');
        }
        
        // Reload invites list
        loadTeamInvites();
        
    } catch (error) {
        console.error('Error revoking invite:', error);
        alert('Failed to revoke invite: ' + error.message);
    }
}

// =============================================================================
// Create Invite
// =============================================================================

async function createInvite(role) {
    // Minting an invite code requires a live server round-trip, so this can't
    // happen offline — but tell an offline user that rather than "sign in".
    const auth = window.breakside?.auth;
    if (!auth?.isAuthenticated?.()) {
        alert((auth?.canActOffline?.() ?? !navigator.onLine)
            ? 'You\'re offline. Reconnect to create invites.'
            : 'Please sign in to create invites');
        return;
    }
    
    if (!currentTeam?.id) {
        alert('No team selected');
        return;
    }
    
    try {
        const response = await authFetch(`${getApiBaseUrl()}/api/teams/${currentTeam.id}/invites`, {
            method: 'POST',
            body: JSON.stringify({ role })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || 'Failed to create invite');
        }
        
        const data = await response.json();
        currentInvite = data;
        
        showInviteModal(data, role);
        
        // Reload invites list
        loadTeamInvites();
        
    } catch (error) {
        console.error('Error creating invite:', error);
        alert('Failed to create invite: ' + error.message);
    }
}

function showInviteModal(data, role) {
    const modal = document.getElementById('inviteCreatedModal');
    const roleText = document.getElementById('inviteRoleText');
    const codeText = document.getElementById('inviteCodeText');
    const linkInput = document.getElementById('inviteLinkText');
    const expiryText = document.getElementById('inviteExpiry');
    
    if (!modal) return;
    
    if (roleText) {
        roleText.textContent = role === 'coach' 
            ? 'Share this code with your new coach:' 
            : 'Share this code with your new viewer:';
    }
    
    if (codeText) {
        codeText.textContent = data.code;
    }
    
    if (linkInput) {
        linkInput.value = data.url || `https://www.breakside.pro/join/${data.code}`;
    }
    
    if (expiryText && data.invite?.expiresAt) {
        expiryText.textContent = `Expires: ${formatDate(data.invite.expiresAt)}`;
    }
    
    modal.style.display = 'flex';
}

function hideInviteModal() {
    const modal = document.getElementById('inviteCreatedModal');
    if (modal) {
        modal.style.display = 'none';
    }
    currentInvite = null;
}

function copyInviteCode() {
    const codeText = document.getElementById('inviteCodeText');
    if (codeText) {
        copyToClipboard(codeText.textContent);
        showCopyFeedback('copyCodeBtn');
    }
}

function copyInviteLink() {
    const linkInput = document.getElementById('inviteLinkText');
    if (linkInput) {
        copyToClipboard(linkInput.value);
        showCopyFeedback('copyLinkBtn');
    }
}

function showCopyFeedback(btnId) {
    const btn = document.getElementById(btnId);
    if (btn) {
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => {
            btn.innerHTML = originalHtml;
        }, 1500);
    }
}

// =============================================================================
// Join Team
// =============================================================================

async function handleJoinCodeEntry() {
    const input = document.getElementById('joinCodeInput');
    if (!input) return;
    
    const code = input.value.trim().toUpperCase();
    if (code.length !== 5) {
        alert('Please enter a 5-character invite code');
        return;
    }
    
    if (!window.breakside?.auth?.isAuthenticated?.()) {
        alert('Please sign in to join a team');
        return;
    }
    
    try {
        // Fetch invite info first
        const response = await fetch(`${getApiBaseUrl()}/api/invites/${code}/info`);
        
        if (response.status === 404) {
            alert('Invite not found. Please check the code and try again.');
            return;
        }
        
        if (response.status === 410) {
            const data = await response.json();
            alert(data.detail || 'This invite has expired or been revoked.');
            return;
        }
        
        if (!response.ok) {
            throw new Error('Failed to load invite info');
        }
        
        const info = await response.json();
        pendingJoinInfo = { code, ...info };
        
        showJoinModal(info);
        
    } catch (error) {
        console.error('Error checking invite:', error);
        alert('Failed to check invite: ' + error.message);
    }
}

function showJoinModal(info) {
    const modal = document.getElementById('joinTeamModal');
    const teamNameEl = document.getElementById('joinTeamName');
    const roleEl = document.getElementById('joinTeamRole');
    const inviterEl = document.getElementById('joinTeamInviter');
    
    if (!modal) return;
    
    if (teamNameEl) teamNameEl.textContent = info.teamName;
    if (roleEl) roleEl.textContent = info.role;
    if (inviterEl) inviterEl.textContent = info.invitedBy || 'A coach';
    
    modal.style.display = 'flex';
}

function hideJoinModal() {
    const modal = document.getElementById('joinTeamModal');
    if (modal) {
        modal.style.display = 'none';
    }
    pendingJoinInfo = null;
}

async function confirmJoinTeam() {
    if (!pendingJoinInfo?.code) {
        hideJoinModal();
        return;
    }
    
    const confirmBtn = document.getElementById('confirmJoinBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Joining...';
    }
    
    try {
        const response = await authFetch(`${getApiBaseUrl()}/api/invites/${pendingJoinInfo.code}/redeem`, {
            method: 'POST'
        });

        if (response.status === 409) {
            alert("You're already on this team!");
            hideJoinModal();
            return;
        }
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || 'Failed to join team');
        }
        
        const result = await response.json();
        
        hideJoinModal();
        
        // Clear the input
        const input = document.getElementById('joinCodeInput');
        if (input) input.value = '';
        
        alert(`You've joined ${result.team?.name || 'the team'} as a ${result.membership?.role}!`);
        
        // Trigger a sync to pull the new team
        if (typeof syncUserTeams === 'function') {
            await syncUserTeams();
        }
        
        // Refresh the team list or go back
        if (typeof showSelectTeamScreen === 'function') {
            showSelectTeamScreen();
        }
        
    } catch (error) {
        console.error('Error joining team:', error);
        alert('Failed to join team: ' + error.message);
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Join Team';
        }
    }
}

// =============================================================================
// Team Identity Management
// =============================================================================

const ICON_CACHE_KEY = 'breakside_team_icons';
const MAX_ICON_SIZE = 128;            // Maximum dimension for cached icons
const MAX_CACHED_ICONS = 50;          // Cap on icon-cache entries (evict oldest)
const MAX_ICON_BYTES = 256 * 1024;    // Per-image byte cap (~256KB decoded)

/**
 * Approximate decoded byte size of a data URL (from its base64 payload).
 */
function dataUrlByteSize(dataUrl) {
    if (typeof dataUrl !== 'string') return 0;
    const comma = dataUrl.indexOf(',');
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(b64.length * 3 / 4) - padding);
}

/**
 * Persist the icon cache. Returns true on success, false if the write failed
 * (e.g. localStorage quota exceeded) — callers decide how to surface that.
 */
function persistIconCache(cache) {
    try {
        localStorage.setItem(ICON_CACHE_KEY, JSON.stringify(cache));
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Trim the cache down to at most `maxEntries`, evicting the oldest entries
 * first (by `cachedAt`; entries without a timestamp count as oldest). Never
 * evicts `protectTeamId`. Mutates `cache` in place.
 */
function evictOldestIcons(cache, maxEntries, protectTeamId) {
    const ids = Object.keys(cache);
    if (ids.length <= maxEntries) return;
    const candidates = ids
        .filter(id => id !== protectTeamId)
        .sort((a, b) => (cache[a]?.cachedAt || 0) - (cache[b]?.cachedAt || 0));
    let toRemove = ids.length - maxEntries;
    for (const id of candidates) {
        if (toRemove <= 0) break;
        delete cache[id];
        toRemove--;
    }
}

/**
 * Load team identity fields into the form
 */
function loadTeamIdentity() {
    const symbolInput = document.getElementById('teamSymbolInput');
    const iconUrlInput = document.getElementById('teamIconUrlInput');
    const iconPreviewContainer = document.getElementById('iconPreviewContainer');
    const iconPreview = document.getElementById('iconPreview');
    const iconStatus = document.getElementById('iconStatus');
    
    if (symbolInput) {
        symbolInput.value = currentTeam.teamSymbol || '';
    }
    
    if (iconUrlInput) {
        // Show the original URL, not the cached data URL
        const originalUrl = getOriginalIconUrl(currentTeam.id);
        iconUrlInput.value = originalUrl || '';
    }
    
    // Show icon preview if we have a cached icon
    if (currentTeam.iconUrl && iconPreviewContainer && iconPreview) {
        iconPreview.src = currentTeam.iconUrl;
        iconPreviewContainer.style.display = 'flex';
        if (iconStatus) {
            iconStatus.textContent = 'Icon cached locally';
            iconStatus.className = 'icon-status success';
        }
    } else if (iconPreviewContainer) {
        iconPreviewContainer.style.display = 'none';
        if (iconStatus) {
            iconStatus.textContent = '';
            iconStatus.className = 'icon-status';
        }
    }
}

/**
 * Get the original URL for a cached icon
 */
function getOriginalIconUrl(teamId) {
    try {
        const cache = JSON.parse(localStorage.getItem(ICON_CACHE_KEY) || '{}');
        return cache[teamId]?.originalUrl || null;
    } catch (e) {
        return null;
    }
}

/**
 * Save the original URL when caching an icon
 */
function saveOriginalIconUrl(teamId, url) {
    let cache;
    try {
        cache = JSON.parse(localStorage.getItem(ICON_CACHE_KEY) || '{}');
    } catch (e) {
        cache = {};
    }
    if (!cache[teamId]) cache[teamId] = {};
    cache[teamId].originalUrl = url;
    cache[teamId].cachedAt = Date.now();

    // Keep the cache bounded, evicting the oldest entries first.
    evictOldestIcons(cache, MAX_CACHED_ICONS, teamId);

    if (persistIconCache(cache)) return true;

    // Write failed (most likely quota). Evict aggressively and retry once.
    evictOldestIcons(cache, Math.floor(MAX_CACHED_ICONS / 2), teamId);
    if (persistIconCache(cache)) return true;

    // Still failing — surface it rather than swallowing the quota error.
    console.error('Team icon cache: localStorage quota exceeded; icon URL not saved for', teamId);
    return false;
}

/**
 * Fetch, resize, and cache team icon from URL
 * Uses server-side proxy to bypass CORS restrictions
 */
async function fetchAndCacheIcon() {
    const urlInput = document.getElementById('teamIconUrlInput');
    const fetchBtn = document.getElementById('fetchIconBtn');
    const iconStatus = document.getElementById('iconStatus');
    const iconPreviewContainer = document.getElementById('iconPreviewContainer');
    const iconPreview = document.getElementById('iconPreview');
    
    if (!urlInput || !urlInput.value.trim()) {
        if (iconStatus) {
            iconStatus.textContent = 'Please enter a URL';
            iconStatus.className = 'icon-status error';
        }
        return;
    }
    
    const url = urlInput.value.trim();
    
    // Validate URL format
    try {
        new URL(url);
    } catch (e) {
        if (iconStatus) {
            iconStatus.textContent = 'Invalid URL format';
            iconStatus.className = 'icon-status error';
        }
        return;
    }
    
    // Update UI for loading state
    if (fetchBtn) {
        fetchBtn.disabled = true;
        fetchBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    if (iconStatus) {
        iconStatus.textContent = 'Fetching image via server...';
        iconStatus.className = 'icon-status';
    }
    
    try {
        // Use server-side proxy to fetch and resize image
        const response = await fetch(`${getApiBaseUrl()}/api/proxy-image`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url })
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || `Server error: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.dataUrl) {
            // Enforce a per-image byte cap so one oversized icon can't blow the
            // localStorage quota for the whole teams blob.
            const bytes = dataUrlByteSize(data.dataUrl);
            if (bytes > MAX_ICON_BYTES) {
                throw new Error(`Image too large to cache (${Math.round(bytes / 1024)}KB; max ${Math.round(MAX_ICON_BYTES / 1024)}KB)`);
            }

            // Save to team and update preview
            currentTeam.iconUrl = data.dataUrl;
            const saved = saveOriginalIconUrl(currentTeam.id, url);

            if (iconPreview) {
                iconPreview.src = data.dataUrl;
            }
            if (iconPreviewContainer) {
                iconPreviewContainer.style.display = 'flex';
            }
            if (iconStatus) {
                iconStatus.textContent = saved
                    ? 'Icon loaded and cached!'
                    : 'Icon loaded (cache full — original URL not saved)';
                iconStatus.className = saved ? 'icon-status success' : 'icon-status';
            }
        } else {
            throw new Error('No image data returned');
        }
    } catch (error) {
        console.error('Error fetching icon:', error);
        if (iconStatus) {
            iconStatus.textContent = error.message || 'Failed to load image';
            iconStatus.className = 'icon-status error';
        }
    } finally {
        if (fetchBtn) {
            fetchBtn.disabled = false;
            fetchBtn.innerHTML = '<i class="fas fa-download"></i>';
        }
    }
}

/**
 * Clear the team icon
 */
function clearTeamIcon() {
    const iconPreviewContainer = document.getElementById('iconPreviewContainer');
    const iconUrlInput = document.getElementById('teamIconUrlInput');
    const iconStatus = document.getElementById('iconStatus');
    
    currentTeam.iconUrl = null;
    
    // Clear the cached original URL
    try {
        const cache = JSON.parse(localStorage.getItem(ICON_CACHE_KEY) || '{}');
        if (cache[currentTeam.id]) {
            delete cache[currentTeam.id];
            localStorage.setItem(ICON_CACHE_KEY, JSON.stringify(cache));
        }
    } catch (e) {
        // Ignore
    }
    
    if (iconPreviewContainer) {
        iconPreviewContainer.style.display = 'none';
    }
    if (iconUrlInput) {
        iconUrlInput.value = '';
    }
    if (iconStatus) {
        iconStatus.textContent = 'Icon removed';
        iconStatus.className = 'icon-status';
    }
}

/**
 * Save team identity (symbol and icon)
 */
function saveTeamIdentity() {
    const symbolInput = document.getElementById('teamSymbolInput');
    const saveBtn = document.getElementById('saveIdentityBtn');
    
    if (!currentTeam) {
        alert('No team selected');
        return;
    }
    
    // Update symbol (uppercase, max 4 chars)
    if (symbolInput) {
        const symbol = symbolInput.value.trim().toUpperCase().substring(0, 4);
        currentTeam.teamSymbol = symbol || null;
        symbolInput.value = symbol;
    }
    
    // Icon is already saved when fetched, just update timestamp
    currentTeam.updatedAt = new Date().toISOString();
    
    // Save to local storage
    if (typeof saveAllTeamsData === 'function') {
        saveAllTeamsData();
    }
    
    // Sync team to cloud (includes teamSymbol and iconUrl)
    if (typeof syncTeamToCloud === 'function' && currentTeam.id) {
        console.log('🔄 Syncing team identity to cloud:', {
            id: currentTeam.id,
            teamSymbol: currentTeam.teamSymbol,
            iconUrl: currentTeam.iconUrl ? `${currentTeam.iconUrl.substring(0, 50)}...` : null
        });
        syncTeamToCloud(currentTeam);
    } else {
        console.warn('⚠️ Cannot sync team: syncTeamToCloud=', typeof syncTeamToCloud, 'teamId=', currentTeam?.id);
    }
    
    // Update header if visible
    if (typeof updateHeaderTeamIdentities === 'function') {
        updateHeaderTeamIdentities();
    }
    
    // Visual feedback
    if (saveBtn) {
        const originalHtml = saveBtn.innerHTML;
        saveBtn.innerHTML = '<i class="fas fa-check"></i> Saved!';
        saveBtn.disabled = true;
        setTimeout(() => {
            saveBtn.innerHTML = originalHtml;
            saveBtn.disabled = false;
        }, 1500);
    }
}

/**
 * Initialize team identity event handlers
 */
function initializeTeamIdentityHandlers() {
    const fetchIconBtn = document.getElementById('fetchIconBtn');
    if (fetchIconBtn) {
        fetchIconBtn.addEventListener('click', fetchAndCacheIcon);
    }
    
    const clearIconBtn = document.getElementById('clearIconBtn');
    if (clearIconBtn) {
        clearIconBtn.addEventListener('click', clearTeamIcon);
    }
    
    const saveIdentityBtn = document.getElementById('saveIdentityBtn');
    if (saveIdentityBtn) {
        saveIdentityBtn.addEventListener('click', saveTeamIdentity);
    }
    
    // Auto-uppercase symbol input
    const symbolInput = document.getElementById('teamSymbolInput');
    if (symbolInput) {
        symbolInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.toUpperCase();
        });
    }
    
    // Allow Enter to fetch icon
    const iconUrlInput = document.getElementById('teamIconUrlInput');
    if (iconUrlInput) {
        iconUrlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                fetchAndCacheIcon();
            }
        });
    }
}

// =============================================================================
// Utility Functions
// =============================================================================

function escapeHtmlAttr(str) {
    if (str === null || str === undefined || str === '') return '';
    // textContent→innerHTML escapes &, <, > but NOT quotes, so values
    // interpolated into double-quoted attributes (data-code, data-user-id…)
    // could still break out. Escape quotes too for attribute safety.
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(isoString) {
    if (!isoString) return 'Never';
    try {
        const date = new Date(isoString);
        return date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
    } catch (e) {
        return 'Unknown';
    }
}

function copyToClipboard(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(err => {
            console.error('Clipboard write failed:', err);
            fallbackCopyToClipboard(text);
        });
    } else {
        fallbackCopyToClipboard(text);
    }
}

function fallbackCopyToClipboard(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
    } catch (err) {
        console.error('Fallback copy failed:', err);
    }
    document.body.removeChild(textarea);
}

// =============================================================================
// Initialize on DOM ready
// =============================================================================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeTeamSettings);
} else {
    initializeTeamSettings();
}

// --- ES-module exports; window.* shims below are transitional for
// --- not-yet-converted classic scripts (removed at end of migration).
export { showTeamSettingsScreen };
// showTeamSettingsScreen: called bare (typeof-guarded) by classic
// game/gameScreenEvents.js and by main.js.
window.showTeamSettingsScreen = showTeamSettingsScreen;

