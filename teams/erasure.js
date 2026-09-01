/*
 * Erase a player, or erase a team — the destructive counterpart to the
 * ordinary remove/delete actions.
 *
 * The distinction the UI has to carry:
 *
 *   "Remove from roster" takes a player off this team. Their record survives,
 *   their history survives, and they can be added back. It is the everyday
 *   action and it stays where it always was.
 *
 *   "Erase record permanently" destroys the person. The record is deleted and
 *   every reference to them — team rosters and lines, tournament rosters, each
 *   game's current state and *every version backup of it* — is rewritten to an
 *   opaque tombstone. There is no undo, no restore, and no support path back.
 *
 * Same shape for a team: DELETE removes one file and leaves the games,
 * shares, invites and memberships behind, complete on disk; erase takes the
 * whole cascade.
 *
 * Both flows are preview-then-confirm, and the preview is fetched from the
 * server rather than counted locally — this device holds a cache, not the
 * truth about how many version backups mention somebody. The server runs the
 * *identical* traversal for the preview and the erasure (writes disabled for
 * the preview), so the numbers the coach agrees to are the numbers that
 * happen.
 *
 * Pattern and markup conventions follow teams/accountDeletion.js: .modal /
 * .modal-content / .prominent-dialog-header / .modal-buttons, static markup in
 * index.html toggled with display, listeners bound at module evaluation.
 *
 * Note the preview is not a cheap call — measured at ~4s against a
 * production-sized corpus, and the erase itself at ~14s, because both walk
 * every version file. Hence the explicit loading and in-flight states.
 */
import { authFetch, API_BASE_URL, purgeErasedPlayerFromSync, purgeErasedTeamFromSync }
    from '../store/sync.js';
import {
    teams, currentTeam, setCurrentTeam, saveAllTeamsData,
} from '../store/storage.js';
import { stripPlayerFromTeamRecord } from '../store/erasureCleanup.js';
import { isPointInProgress } from '../utils/helpers.js';
import { escapeHtml } from '../utils/gameLogRenderer.js';
import { log } from '../utils/logger.js';

// The word the coach types. Deliberately not "DELETE" — the account dialog
// uses that, and these two actions must not share a muscle-memory.
const CONFIRM_WORD = 'ERASE';

// Dialog state. `mode` is 'player' or 'team'; `target` is { id, name }.
let mode = null;
let target = null;
let currentPreview = null;
let eraseInFlight = false;
let eraseDone = false;
// Team mode only: whether orphaned players are erased alongside the team.
// Default false, deliberately — a person is not a side effect of deleting a
// team, and the server defaults the same way.
let eraseOrphans = false;
// Set when the caller wants something re-rendered after a successful erase.
let onErased = null;

function dialogEl(id) {
    return document.getElementById(id);
}

// -----------------------------------------------------------------------
// Guards
// -----------------------------------------------------------------------

/**
 * Why erasure must not run right now, or null if it may.
 *
 * A live game is the one that matters. The game screen syncs continuously, so
 * erasing a player off the roster mid-point races the next sync: the server
 * would scrub them out of the game while this device keeps pushing a state
 * that still has them in the active line. The server wins that race (it scrubs
 * every inbound game write) but the coach is left watching a point they can no
 * longer score correctly. Blocking for the length of a point costs nothing —
 * erasure has never been urgent.
 *
 * @param {string} [teamId] - Erasing this team, or a player on it.
 * @returns {string|null}
 */
export function erasureBlockedReason(teamId) {
    let pointLive = false;
    try {
        pointLive = typeof isPointInProgress === 'function' && isPointInProgress();
    } catch (e) {
        // currentGame() throws when there is no team loaded; that is "no live
        // game", not a reason to block.
        pointLive = false;
    }
    if (!pointLive) return null;
    // A point is live on the current team. Only block if this erasure touches
    // it — erasing an unrelated team mid-game is not a race.
    if (teamId && currentTeam && currentTeam.id !== teamId) return null;
    return 'A point is in progress. Finish the point before erasing anything.';
}

// -----------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------

/**
 * Erase one player, everywhere.
 * @param {object} player - { id, name }
 * @param {object} [options] - { teamId, onErased }
 */
export function showErasePlayerDialog(player, options = {}) {
    if (!player || !player.id) {
        console.error('Cannot erase: no player');
        return;
    }
    const blocked = erasureBlockedReason(options.teamId || currentTeam?.id);
    if (blocked) {
        alert(blocked);
        return;
    }
    openDialog('player', {
        id: player.id,
        // What the dialog calls them: the app renders `nickname || name`.
        name: player.nickname || player.name || 'this player',
        // What local cleanup matches on. Both, because a stored display string
        // in lines[].players holds whichever one the roster showed at the time.
        displayNames: [player.name, player.nickname].filter(Boolean),
    }, options);
}

/**
 * Erase one team and everything that only existed because of it.
 * @param {object} team - { id, name }
 * @param {object} [options] - { onErased }
 */
export function showEraseTeamDialog(team, options = {}) {
    if (!team || !team.id) {
        console.error('Cannot erase: no team');
        return;
    }
    const blocked = erasureBlockedReason(team.id);
    if (blocked) {
        alert(blocked);
        return;
    }
    openDialog('team', { id: team.id, name: team.name || 'this team' }, options);
}

function openDialog(nextMode, nextTarget, options) {
    const dialog = dialogEl('eraseDialog');
    if (!dialog) return;

    mode = nextMode;
    target = nextTarget;
    currentPreview = null;
    eraseInFlight = false;
    eraseDone = false;
    eraseOrphans = false;
    onErased = typeof options.onErased === 'function' ? options.onErased : null;

    dialogEl('eraseDialogTitle').textContent =
        mode === 'player' ? 'Erase player permanently' : 'Erase team permanently';
    dialogEl('eraseDialogLede').innerHTML = mode === 'player'
        ? `This permanently erases <strong>${escapeHtml(target.name)}</strong> from Breakside — ` +
          'their record and every reference to them in past games. ' +
          '<strong>It cannot be undone.</strong>'
        : `This permanently erases <strong>${escapeHtml(target.name)}</strong> and everything ` +
          'that only existed because of it. <strong>It cannot be undone.</strong>';

    setError('');
    dialogEl('eraseBody').textContent = 'Checking what would be erased…';
    dialogEl('eraseConfirm').style.display = 'none';
    dialogEl('eraseOrphanRow').style.display = 'none';
    dialogEl('eraseOrphanCheck').checked = false;
    dialogEl('eraseTypeInput').value = '';
    const confirmBtn = dialogEl('eraseConfirmBtn');
    confirmBtn.disabled = true;
    confirmBtn.style.display = '';
    confirmBtn.textContent = 'Erase permanently';
    dialogEl('eraseCancelBtn').textContent = 'Cancel';
    dialog.style.display = 'flex';

    loadPreview();
}

function closeDialog() {
    if (eraseInFlight) return;   // never yank the dialog out from under an erase
    const dialog = dialogEl('eraseDialog');
    if (dialog) dialog.style.display = 'none';
    // Fire the caller's refresh on the way out, not the moment the erase
    // returns — otherwise a roster re-render happens behind the open receipt.
    if (eraseDone && onErased) {
        try { onErased(); } catch (e) { console.error('Post-erase refresh failed:', e); }
    }
    mode = null;
    target = null;
    currentPreview = null;
    eraseDone = false;
    onErased = null;
}

function setError(message) {
    const el = dialogEl('eraseError');
    if (!el) return;
    if (!message) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    el.style.display = 'block';
    el.textContent = message;
}

// -----------------------------------------------------------------------
// Preview
// -----------------------------------------------------------------------

function previewUrl() {
    const id = encodeURIComponent(target.id);
    return mode === 'player'
        ? `${API_BASE_URL}/api/players/${id}/erase-preview`
        : `${API_BASE_URL}/api/teams/${id}/erase-preview?erase_orphaned_players=${eraseOrphans}`;
}

async function loadPreview() {
    const requestedFor = target && target.id;
    try {
        const response = await authFetch(previewUrl());
        if (!target || target.id !== requestedFor) return;   // dialog moved on
        if (!response.ok) {
            const detail = await readErrorDetail(response, 'check');
            dialogEl('eraseBody').textContent = detail;
            dialogEl('eraseConfirm').style.display = 'none';
            dialogEl('eraseConfirmBtn').disabled = true;
            return;
        }
        currentPreview = await response.json();
        renderPreview(currentPreview);
    } catch (error) {
        console.error('Erase preview failed:', error);
        if (!target || target.id !== requestedFor) return;
        dialogEl('eraseBody').textContent =
            'Could not reach the server to check what would be erased. ' +
            'Erasing needs a connection — nothing has been changed.';
        dialogEl('eraseConfirm').style.display = 'none';
        dialogEl('eraseConfirmBtn').disabled = true;
    }
}

// The server's count keys, in the order they read best. Both modes share the
// shape; the wording differs because the same key means different things —
// for a player `games` is games *rewritten*, for a team it is games *deleted*.
const PLAYER_COUNT_LABELS = [
    ['players', 'player record erased', 'player records erased'],
    ['games', 'game rewritten to remove them', 'games rewritten to remove them'],
    ['versions', 'saved game version rewritten', 'saved game versions rewritten'],
    ['rosters', 'team roster updated', 'team rosters updated'],
    ['events', 'tournament/event roster updated', 'tournament/event rosters updated'],
];

const TEAM_COUNT_LABELS = [
    ['teams', 'team deleted', 'teams deleted'],
    ['games', 'game deleted', 'games deleted'],
    ['versions', 'saved game version deleted', 'saved game versions deleted'],
    ['shares', 'share link revoked', 'share links revoked'],
    ['invites', 'invite code deleted', 'invite codes deleted'],
    ['memberships', 'team membership removed', 'team memberships removed'],
    ['events', 'tournament/event deleted', 'tournaments/events deleted'],
    ['players', 'orphaned player erased', 'orphaned players erased'],
];

/**
 * Render a counts block. `counts` is the server's `willErase` (preview) or
 * `erased` (receipt) object — identical shapes, by design, so the coach can
 * see that what they were promised is what happened.
 */
function countsList(counts, labels) {
    const lines = labels
        .filter(([key]) => (counts[key] || 0) > 0)
        .map(([key, one, many]) =>
            `<li><strong>${counts[key]}</strong> ${counts[key] === 1 ? one : many}</li>`);
    if (!lines.length) {
        return '<p class="erase-nothing">Nothing left to erase — this record is already gone.</p>';
    }
    return `<ul class="erase-summary">${lines.join('')}</ul>`;
}

function renderPreview(preview) {
    const body = dialogEl('eraseBody');
    const counts = preview.willErase || {};
    const labels = mode === 'player' ? PLAYER_COUNT_LABELS : TEAM_COUNT_LABELS;
    const parts = [];

    parts.push('<p class="erase-section-title">This will erase:</p>');
    parts.push(countsList(counts, labels));

    // Every warning the server returns, verbatim. They are the things it
    // knows and this device cannot: a shared-publicly game, a same-named
    // teammate who would be caught by a legacy name-only reference, the
    // irreversibility of rewriting version backups in place — and, always
    // last, that already-exported spreadsheets keep the name. That one is not
    // repeated in our own words below; the server says it on every preview,
    // and saying it twice in one dialog reads as padding rather than emphasis.
    if ((preview.warnings || []).length) {
        parts.push('<ul class="erase-warnings">');
        for (const warning of preview.warnings) {
            parts.push(`<li>${escapeHtml(warning)}</li>`);
        }
        parts.push('</ul>');
    }

    body.innerHTML = parts.join('');

    dialogEl('eraseConfirm').style.display = 'block';

    // Team mode: the orphan opt-in. `orphanedPlayerIds` is always the full
    // orphan list on a preview, whichever way the flag is set, so this row can
    // be rendered from it directly.
    const orphans = (preview.orphanedPlayerIds || []).length;
    const orphanRow = dialogEl('eraseOrphanRow');
    if (mode === 'team' && orphans > 0) {
        dialogEl('eraseOrphanLabel').textContent = orphans === 1
            ? 'Also erase the 1 player who is on no other team. ' +
              'Leave unchecked and their record survives this team.'
            : `Also erase the ${orphans} players who are on no other team. ` +
              'Leave unchecked and their records survive this team.';
        orphanRow.style.display = 'flex';
    } else {
        orphanRow.style.display = 'none';
    }

    updateConfirmEnabled();
}

/**
 * The orphan checkbox changes what the operation *is*, so the preview is
 * re-fetched rather than adjusted locally — the server documents that the
 * preview should be asked with the same flag the erase will use, so that the
 * counts describe the operation actually about to run.
 */
function onOrphanToggle() {
    if (eraseInFlight || eraseDone) return;
    eraseOrphans = !!dialogEl('eraseOrphanCheck')?.checked;
    // Keep the typed confirmation; only the counts are stale.
    dialogEl('eraseBody').textContent = 'Rechecking what would be erased…';
    dialogEl('eraseConfirmBtn').disabled = true;
    loadPreview();
}

function updateConfirmEnabled() {
    const btn = dialogEl('eraseConfirmBtn');
    if (!btn || !currentPreview || eraseDone) return;
    const typed = (dialogEl('eraseTypeInput')?.value || '').trim().toUpperCase();
    btn.disabled = eraseInFlight || typed !== CONFIRM_WORD;
}

// -----------------------------------------------------------------------
// Erase
// -----------------------------------------------------------------------

function eraseUrl() {
    const id = encodeURIComponent(target.id);
    return mode === 'player'
        ? `${API_BASE_URL}/api/players/${id}/erase`
        : `${API_BASE_URL}/api/teams/${id}/erase?erase_orphaned_players=${eraseOrphans}`;
}

async function confirmErase() {
    if (eraseInFlight || eraseDone || !currentPreview || !target) return;

    const btn = dialogEl('eraseConfirmBtn');
    eraseInFlight = true;
    setError('');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Erasing…';
    }
    // The server walks every version backup; on a big corpus that is seconds,
    // not milliseconds. Say so rather than looking hung.
    dialogEl('eraseBody').innerHTML =
        '<p class="erase-working">Rewriting every game and version backup that ' +
        'mentions this record. This can take a few seconds — don\'t close the app.</p>';

    try {
        const response = await authFetch(eraseUrl(), { method: 'POST' });

        if (!response.ok) {
            const detail = await readErrorDetail(response, 'erase');
            eraseInFlight = false;
            if (btn) {
                btn.innerHTML = 'Erase permanently';
            }
            setError(detail);
            // Nothing local is touched on a failure — a device cleaned against
            // a server that still holds the record is the one state worse than
            // no cleanup at all.
            renderPreview(currentPreview);
            return;
        }

        const receipt = await response.json();
        eraseInFlight = false;
        eraseDone = true;
        log(`Erased ${mode} ${target.id}`, receipt);

        // Only now is local cleanup safe.
        const cleanup = mode === 'player'
            ? cleanUpAfterPlayerErase(target.id, target.displayNames)
            : cleanUpAfterTeamErase(target.id, receipt);

        renderReceipt(receipt, cleanup);
    } catch (error) {
        console.error('Erase failed:', error);
        eraseInFlight = false;
        if (btn) btn.innerHTML = 'Erase permanently';
        setError(
            'Could not reach the server: ' + error.message +
            '. Nothing was erased — please try again.'
        );
        if (currentPreview) renderPreview(currentPreview);
    }
}

function renderReceipt(receipt, cleanup) {
    const counts = receipt.erased || {};
    const labels = mode === 'player' ? PLAYER_COUNT_LABELS : TEAM_COUNT_LABELS;
    const parts = [];

    parts.push(`<p class="erase-done">${escapeHtml(target.name)} has been permanently erased.</p>`);
    parts.push(countsList(counts, labels));

    if (mode === 'player' && receipt.tombstoneId) {
        parts.push(
            '<p class="erase-note">Past games now show <strong>Removed Player</strong> ' +
            'where they appeared.</p>'
        );
    }
    if (mode === 'team' && (receipt.orphanedPlayerIds || []).length) {
        const n = receipt.orphanedPlayerIds.length;
        parts.push(
            `<p class="erase-note">${n} player record${n === 1 ? '' : 's'} ` +
            `survived — ${n === 1 ? 'it was' : 'they were'} not erased with the team. ` +
            'Erase them individually if that is what you meant.</p>'
        );
    }
    if (cleanup && cleanup.queuedGames) {
        const n = cleanup.queuedGames;
        parts.push(
            `<p class="erase-note">This device still has ${n} unsynced ` +
            `game${n === 1 ? '' : 's'} waiting to upload. ` +
            `${n === 1 ? 'It' : 'They'} will be scrubbed by the server on arrival.</p>`
        );
    }
    parts.push(
        '<p class="erase-exports">Game records already downloaded to other devices ' +
        'still show the old name until they next sync.</p>'
    );

    dialogEl('eraseBody').innerHTML = parts.join('');
    dialogEl('eraseConfirm').style.display = 'none';
    dialogEl('eraseConfirmBtn').style.display = 'none';
    dialogEl('eraseCancelBtn').textContent = 'Done';
    setError('');
}

// -----------------------------------------------------------------------
// Local cleanup — only ever reached after a 2xx
// -----------------------------------------------------------------------

/**
 * Take the erased player out of this device's state.
 *
 * Cached game *histories* are deliberately not rewritten here. A player is
 * referenced deep inside points, possessions, events and roster snapshots, and
 * reimplementing the server's scrubber in the client — against data we would
 * then overwrite locally with no backup — trades a tidy-up for a plausible
 * data-loss bug. The server's copy is already scrubbed, and every path that
 * loads a game from the cloud replaces the local one, so a cached game
 * self-heals on its next refresh. The receipt says so rather than implying the
 * device is instantly clean.
 */
function cleanUpAfterPlayerErase(playerId, displayNames) {
    let rosters = 0;
    for (const team of teams || []) {
        if (stripPlayerFromTeamRecord(team, playerId, displayNames)) rosters += 1;
    }
    if (rosters) saveAllTeamsData();

    const sync = purgeErasedPlayerFromSync(playerId, displayNames);
    return { rosters, ...sync };
}

/**
 * Take the erased team out of this device's state, and switch away from it if
 * it was the one selected.
 */
function cleanUpAfterTeamErase(teamId, receipt) {
    const index = (teams || []).findIndex(t => t && t.id === teamId);
    const gameIds = index !== -1
        ? (teams[index].games || []).map(g => g && (g.id || g.game_id)).filter(Boolean)
        : [];

    if (index !== -1) {
        teams.splice(index, 1);
        if (currentTeam && currentTeam.id === teamId) {
            setCurrentTeam(teams.length > 0 ? teams[0] : null);
        }
        saveAllTeamsData();
    }

    const sync = purgeErasedTeamFromSync(teamId, gameIds);
    return { removedLocally: index !== -1, ...sync };
}

// -----------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------

/**
 * A plain sentence for each status the erase endpoints actually return.
 * `stage` is 'check' or 'erase' so the message can promise the right thing
 * about what did or did not happen.
 */
async function readErrorDetail(response, stage) {
    const nothingHappened = stage === 'erase'
        ? ' Nothing was erased.'
        : ' Nothing has been changed.';
    let serverDetail = '';
    try {
        const body = await response.json();
        const detail = body?.detail;
        if (typeof detail === 'string') serverDetail = detail;
        else if (detail?.message) serverDetail = detail.message;
    } catch (e) {
        /* no body, or not JSON — fall through to the status-based wording */
    }
    // The server's sentence runs straight into ours. Not every detail string
    // ends in punctuation, and "Not a coach of this team Nothing was erased"
    // reads as one broken sentence.
    serverDetail = serverDetail.trim();
    if (serverDetail && !/[.!?]$/.test(serverDetail)) serverDetail += '.';

    switch (response.status) {
        case 401:
            return 'Your session has expired. Sign in again and retry.' + nothingHappened;
        case 403:
            return (serverDetail ||
                'You need to be a coach of this team to erase this record.') + nothingHappened;
        case 404:
            return (serverDetail || 'That record no longer exists on the server.')
                + nothingHappened;
        case 409:
            // Player erase only: ErasureBlocked — some target file sits in a
            // directory the server cannot write. It refuses before touching
            // anything, so this really is a clean failure.
            return serverDetail ||
                ('The server refused the erase because some stored files are not ' +
                 'writable.' + nothingHappened);
        case 410:
            return serverDetail || 'That record was already permanently erased.';
        default:
            return (serverDetail || `The server refused the request (${response.status}).`)
                + nothingHappened;
    }
}

// -----------------------------------------------------------------------
// Wiring — module evaluation happens after DOM parse, so these exist.
// -----------------------------------------------------------------------

dialogEl('eraseCloseX')?.addEventListener('click', closeDialog);
dialogEl('eraseCancelBtn')?.addEventListener('click', closeDialog);
dialogEl('eraseConfirmBtn')?.addEventListener('click', confirmErase);
dialogEl('eraseTypeInput')?.addEventListener('input', updateConfirmEnabled);
dialogEl('eraseOrphanCheck')?.addEventListener('change', onOrphanToggle);

// Backdrop click closes, matching the other modals.
window.addEventListener('click', (event) => {
    if (event.target === dialogEl('eraseDialog')) closeDialog();
});
