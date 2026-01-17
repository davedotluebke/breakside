/**
 * Team Settings Screen
 * Manages team members, invites, and joining teams
 */

// =============================================================================
// State
// =============================================================================

let currentInvite = null;
let pendingJoinInfo = null;

// =============================================================================
// API Helpers
// =============================================================================

async function getAuthHeaders() {
    if (!window.breakside?.auth?.isAuthenticated?.()) {
        throw new Error('Not authenticated');
    }
    
    const token = await window.breakside?.auth?.getAccessToken?.();
    if (!token) {
        throw new Error('No access token');
    }
    
    return {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };
}

function getApiBaseUrl() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : '';
}

// =============================================================================
// Screen Navigation
// =============================================================================

function showTeamSettingsScreen() {
    if (!currentTeam) {
        alert('No team selected');
        return;
    }
    
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
            showScreen('teamRosterScreen');
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
    
    // Check if authenticated
    if (!window.breakside?.auth?.isAuthenticated?.()) {
        membersList.innerHTML = '<p class="info-message">Sign in to view team members</p>';
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
        const headers = await getAuthHeaders();
        const response = await fetch(`${getApiBaseUrl()}/api/teams/${currentTeam.id}/members`, {
            headers
        });
        
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
                    <span class="member-name">${escapeHtml(displayName)}${isSelf ? ' (you)' : ''}</span>
                    <span class="member-email">${escapeHtml(member.email || '')}</span>
                </div>
                <span class="member-role ${roleClass}">${member.role}</span>
            </div>
            <button class="remove-member-btn icon-button" 
                    data-user-id="${member.userId}" 
                    data-name="${escapeHtml(displayName)}"
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
        const headers = await getAuthHeaders();
        const response = await fetch(`${getApiBaseUrl()}/api/teams/${currentTeam.id}/members/${userId}`, {
            method: 'DELETE',
            headers
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
    
    // Check if authenticated
    if (!window.breakside?.auth?.isAuthenticated?.()) {
        invitesList.innerHTML = '<p class="info-message">Sign in to view invites</p>';
        return;
    }
    
    if (!currentTeam?.id) {
        invitesList.innerHTML = '<p class="error-message">No team selected</p>';
        return;
    }
    
    invitesList.innerHTML = '<p class="loading-message">Loading invites...</p>';
    
    try {
        const headers = await getAuthHeaders();
        const response = await fetch(`${getApiBaseUrl()}/api/teams/${currentTeam.id}/invites`, {
            headers
        });
        
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
                    <span class="invite-code">${invite.code}</span>
                    <span class="invite-meta">${invite.role} • expires ${expiresDate}</span>
                </div>
            </div>
            <div class="invite-actions">
                <button class="copy-invite-code-btn icon-button" 
                        data-code="${invite.code}"
                        title="Copy code">
                    <i class="fas fa-copy"></i>
                </button>
                <button class="revoke-invite-btn icon-button" 
                        data-invite-id="${invite.id}"
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
        const headers = await getAuthHeaders();
        const response = await fetch(`${getApiBaseUrl()}/api/invites/${inviteId}`, {
            method: 'DELETE',
            headers
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
    if (!window.breakside?.auth?.isAuthenticated?.()) {
        alert('Please sign in to create invites');
        return;
    }
    
    if (!currentTeam?.id) {
        alert('No team selected');
        return;
    }
    
    try {
        const headers = await getAuthHeaders();
        const response = await fetch(`${getApiBaseUrl()}/api/teams/${currentTeam.id}/invites`, {
            method: 'POST',
            headers,
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
        const headers = await getAuthHeaders();
        const response = await fetch(`${getApiBaseUrl()}/api/invites/${pendingJoinInfo.code}/redeem`, {
            method: 'POST',
            headers
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
const MAX_ICON_SIZE = 128; // Maximum dimension for cached icons

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
    try {
        const cache = JSON.parse(localStorage.getItem(ICON_CACHE_KEY) || '{}');
        if (!cache[teamId]) cache[teamId] = {};
        cache[teamId].originalUrl = url;
        localStorage.setItem(ICON_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
        console.warn('Failed to save original icon URL:', e);
    }
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
            // Save to team and update preview
            currentTeam.iconUrl = data.dataUrl;
            saveOriginalIconUrl(currentTeam.id, url);
            
            if (iconPreview) {
                iconPreview.src = data.dataUrl;
            }
            if (iconPreviewContainer) {
                iconPreviewContainer.style.display = 'flex';
            }
            if (iconStatus) {
                iconStatus.textContent = 'Icon loaded and cached!';
                iconStatus.className = 'icon-status success';
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

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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

