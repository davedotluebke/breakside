/*
 * Squad Narration — speak the squads in the scrimmage picker.
 *
 * A layer on the shared capture machinery (narration/rosterNarration.js: the
 * state machine, the status strip, the request, the toasts), with its own
 * backend endpoint (/api/narration/squads). Its sibling is lineup narration
 * (narration/lineupNarration.js), which does the same for the next point's
 * line. It drives the New Scrimmage / Edit Squads dialog
 * (teams/scrimmageDialogs.js) through the dialog's narration seam
 * (getSquadDialogContext / applyNarratedSquads).
 *
 * No button of its own: the floating mic FAB (narration/micButton.js) routes
 * to this layer whenever the squad picker is open — on the team list, or
 * over a game for Edit Squads — with the same tap-toggle / hold-to-record
 * gestures as the other layers. This module owns what is the picker's: where
 * the strip goes (under its Clear / Auto row), what the server is told, and
 * how its answer is applied.
 *
 * Flow:
 *   tap the mic with the picker open → transcription session opens
 *   (vocabulary biased to the whole roster AND the two squad names) → coach
 *   speaks ("Alice and Bob on Orange, Dana on Black", "Eve sits out",
 *   "everyone else on Black", "the rest of the FMPs on Orange", "two more
 *   guys on Black") → tap again → transcript + roster (with each player's
 *   gender group, whether they are here, and whether the coach already
 *   placed them) + squad names + current squads POST to
 *   /api/narration/squads → the derived squads replace the picker's
 *   assignment, the way taps would, any counts are picked here by Auto's
 *   balance rules (narration/squadResolve.js), and a toast says who moved.
 *   Names spoken without a squad go on the FIRST squad, and a name the
 *   recognizer mangled is resolved against the closed roster; both rules
 *   are the server's (narration_squads.py over narration_common.py), not
 *   the model's.
 */
import { createRosterNarration, rosterInfo, rosterForServer } from './rosterNarration.js';
import { resolveSquadResult, buildSquadToast } from './squadResolve.js';
import { log } from '../utils/logger.js';
import { advancedSettings } from '../settings/advancedSettings.js';
import { getSquadDialogContext, applyNarratedSquads } from '../teams/scrimmageDialogs.js';

// The confirmation toast reports a whole split, next to a picker that shows
// it; lineup narration's on-Line-tab lifetime is the right one.
const CONFIRM_TOAST_MS = 4000 * 3;

const PICKER_CLOSED = 'Squad picker closed — nothing applied';

/**
 * The open picker's state, or why squads cannot be narrated right now.
 * Asked again at every stage: the dialog can close while the coach talks.
 */
function readContext(stage) {
    const ctx = getSquadDialogContext();
    if (stage === 'start') {
        if (!ctx) return { problem: 'Open the squad picker to narrate squads' };
        if (!ctx.roster.length) return { problem: 'The roster is still loading — try again in a moment' };
        return { ctx };
    }
    if (!ctx || !ctx.roster.length) return { problem: PICKER_CLOSED, level: 'info' };
    if (!ctx.teamId) return { problem: 'Voice squads failed — team context lost', level: 'error' };
    return { ctx };
}

/** {X: [names], Y: [names]} from the picker's id → squad map. */
function currentSquadNames(ctx) {
    const out = { X: [], Y: [] };
    ctx.roster.forEach(p => {
        const squad = ctx.assignment.get(p.id);
        if (squad === 'X' || squad === 'Y') out[squad].push(p.name);
    });
    return out;
}

/**
 * Apply the backend's squads to the open picker. The server returns the
 * FULL resulting squads (its current squads ± the voiced changes), so
 * applying is a plain replacement — plus the counts it could only verify
 * ("two more FMPs on Dark"), which are picked here — and the toast reports
 * the delta. A result in which nothing was heard never touches the picker.
 */
function applySquads(data, ctx, { toast, showConfirmToast }) {
    const voicedAssign = Array.isArray(data.voiced_assign) ? data.voiced_assign : [];
    const voicedOut = Array.isArray(data.out) ? data.out : [];
    const voicedGroups = Array.isArray(data.voiced_groups) ? data.voiced_groups : [];
    const fills = Array.isArray(data.fills) ? data.fills : [];
    const modelUnmatched = Array.isArray(data.unmatched) ? data.unmatched : [];
    const heard = voicedAssign.length || voicedOut.length || voicedGroups.length || fills.length
        || data.voiced_clear === true || !!data.voiced_rest;
    if (!heard && !modelUnmatched.length) {
        toast('No squad changes heard', 'info');
        return false;
    }

    const result = resolveSquadResult(data, ctx, {
        // A narrated count is picked by the Auto button's own rules.
        priorityOrder: (advancedSettings && advancedSettings.getAutoLinePriorityOrder)
            ? advancedSettings.getAutoLinePriorityOrder()
            : undefined
    });
    if (!heard) {
        // Only unmatched references: nothing to apply, say what was missed.
        const shown = result.unmatched.slice(0, 3).map(u => `"${u}"`).join(', ');
        toast(`No roster match: ${shown}${result.unmatched.length > 3 ? ', …' : ''} — squads unchanged`, 'warning');
        return false;
    }

    if (!applyNarratedSquads(result.assignment, { absent: result.absent, pinned: result.pinned })) return false;

    if (data.note) log('[squadNarration] note:', data.note);
    const { message, type } = buildSquadToast({
        names: ctx.names, counts: result.counts,
        moved: result.moved, removed: result.removed, unmatched: result.unmatched,
        shortfalls: result.shortfalls
    });
    showConfirmToast(message, type);
    return true;
}

const layer = createRosterNarration({
    name: 'squadNarration',
    label: 'Squad',
    voiceLabel: 'Voice squads',
    unchanged: 'squads',
    endpoint: '/api/narration/squads',
    statusId: 'squadNarrationStatus',
    statusAnchor: () => document.querySelector('.scrimmage-dialog .scrimmage-tools'),
    listeningHint: (ctx) => {
        const names = ctx ? ctx.names : { X: 'Dark', Y: 'Light' };
        return `Listening — "Alice and Bob on ${names.X}, the rest of the FMPs on ${names.Y}"; names alone go on ${names.X}`;
    },
    processingLabel: 'Working out the squads…',
    busyMessage: 'Still working out the previous squads…',
    otherRunningMessage: 'Narration is already running — stop it before narrating squads',
    context: readContext,
    // The whole roster and the squad names: the squad words are what tell
    // this narration apart from a line call, so the recognizer must get them
    // right. They ride along as roster-shaped entries, which is all the
    // vocabulary prompt reads.
    vocabulary: (ctx) => rosterInfo(ctx.roster).concat([{ name: ctx.names.X }, { name: ctx.names.Y }]),
    // Per player the server also needs: whether they are here today (never
    // swept up by a collective phrase when not) and whether the coach
    // already placed them ("everyone else" leaves those alone).
    buildPayload: (ctx, transcript) => ({
        teamId: ctx.teamId,
        transcript,
        roster: rosterForServer(ctx.roster, p => ({
            here: !ctx.absent.has(p.id),
            pinned: ctx.pinned.has(p.id)
        })),
        squad_names: { X: ctx.names.X, Y: ctx.names.Y },
        current_squads: currentSquadNames(ctx)
    }),
    apply: applySquads,
    confirmToastMs: () => CONFIRM_TOAST_MS,
});

// The picker closing mid-recording ends the recording: there is nothing
// left to apply it to (the context is read again before the request and
// before the apply, and says so). Its report is moot once the dialog is
// gone, too.
document.addEventListener('breakside:scrimmage-dialog', (e) => {
    if (e.detail && e.detail.open) return;
    layer.dismissConfirmToast();
    if (layer.getPhase() === 'recording' || layer.getPhase() === 'connecting') layer.stop();
});

// Public API — driven by narration/micButton.js while the picker is open.
const squadNarration = {
    ...layer,
    /** Whether a squad picker is open — the mic button's cue to route here. */
    isDialogOpen: () => !!getSquadDialogContext(),
};

// --- ES-module export ---
export { squadNarration };
// window survivor: debug/e2e seam — lets the console and Playwright drive
// the apply path (squadNarration._applyResult) and the typed-transcript
// path (squadNarration._narrate) without mic hardware; mirrors
// lineupNarration's seam.
window.squadNarration = squadNarration;
