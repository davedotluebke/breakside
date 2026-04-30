/*
 * Full Play-by-Play
 *
 * The "Full" PBP tab provides rapid every-event entry alongside the existing
 * "Simple" mode. See docs/full-pbp-requirements.md for the full UI spec.
 *
 * Phase 2 scope (this file):
 *   - State reconstruction from current point's event stream (mode + holder)
 *   - Player column rendering (Unknown + on-field roster, holder highlighted)
 *   - Per-row contextual buttons:
 *       holder row     → throwaway / break / …
 *       non-holder row → drop / score / …
 *   - O-mode interactions:
 *       tap player name (no holder) → set initial holder, no event
 *       tap player name (has holder) → Throw{thrower=holder, receiver=tapped,
 *                                            break_flag if armed}; tapped becomes new holder
 *       tap drop on other row    → Turnover{drop, holder→tapped}
 *       tap throwaway on holder  → Turnover{throwaway, holder→Unknown}
 *       tap score on other row   → Throw{score, holder→tapped}; ends point
 *       tap break on holder row  → arms break_flag for next throw
 *   - Undo button: delegates to the existing global undoEvent() so all the
 *     score-rollback / possession-cleanup / point-removal edge cases stay
 *     in one place. Re-renders + publishes eventRetracted afterwards so
 *     bus subscribers (transcript, future ultra-compact log) update too.
 *   - Event bus: publishes eventAdded with source='manual' on every event.
 *
 * Deferred to later phases:
 *   - Auto-flip O↔D on turnover/block/interception (phase 3)
 *   - "They turnover" right-side button (phase 3)
 *   - D-mode action buttons (block / interception) (phase 3)
 *   - O/D pill toggle creating inferred turnover events (phase 3)
 *   - "Last pass was a:" / "Last D was a:" modifier panel (phase 4)
 *   - "…" popover (Stall / Good D / Callahan) (phase 5)
 */

(function() {
    // -----------------------------------------------------------------
    // Module-level state
    // -----------------------------------------------------------------

    /**
     * Manual holder override — set when the user taps a player name while
     * the event-stream-derived holder is null (start of point or after a
     * turnover/block). Cleared whenever a real event is added or retracted
     * so the derivation stays the source of truth otherwise.
     *
     * To override an *incorrect* derived holder (e.g. coach mis-entered
     * the previous receiver), the user should Undo and re-tap.
     */
    let manualHolder = null;

    /**
     * Whether the next Throw will have its break_flag set. Toggled by the
     * "break" button on the holder row; auto-clears as soon as a Throw is
     * created (or the user taps "break" again to disarm).
     */
    let breakArmed = false;

    // -----------------------------------------------------------------
    // State reconstruction
    // -----------------------------------------------------------------

    /**
     * Walk the current point's possessions and derive (mode, holder) from
     * the most recent game event. See requirements doc, "Start state &
     * transitions" section.
     *
     * Mode rules (last-event-wins):
     *   - no events           → point.startingPosition (or 'offense' default)
     *   - last is Throw       → 'offense', holder = receiver (unless score → next point)
     *   - last is Turnover    → 'defense', no holder
     *   - last is Defense
     *       interception      → 'offense', holder = defender
     *       block/stall/UE/Callahan → 'offense' (or next point on Callahan), no holder
     *
     * Returns { mode, holder } where holder is a Player or null.
     */
    function reconstructState() {
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        if (!point) {
            return { mode: 'offense', holder: null, point: null };
        }

        // Default mode from point's starting position.
        let mode = (point.startingPosition === 'defense') ? 'defense' : 'offense';
        let holder = null;

        // Find the most recent event across all possessions in this point.
        // We trust event semantics, not possession.offensive — possession
        // boundaries can lag (e.g. a Turnover event lives in the offensive
        // possession that just ended; the new D possession isn't created
        // until the next D event).
        let lastEvent = null;
        if (point.possessions) {
            for (let i = point.possessions.length - 1; i >= 0; i--) {
                const events = point.possessions[i].events;
                if (events && events.length) {
                    lastEvent = events[events.length - 1];
                    break;
                }
            }
        }

        if (lastEvent) {
            if (lastEvent.type === 'Throw') {
                // Score-flag Throws end the point — moveToNextPoint advances
                // game.points so the *current* point is now empty. We won't
                // typically see one here unless the next point hasn't been
                // initialized yet; fall through to mode default.
                if (!lastEvent.score_flag) {
                    mode = 'offense';
                    holder = lastEvent.receiver || null;
                }
            } else if (lastEvent.type === 'Turnover') {
                mode = 'defense';
                holder = null;
            } else if (lastEvent.type === 'Defense') {
                if (lastEvent.Callahan_flag) {
                    // Point ended; mode falls back to default. Same caveat
                    // as score-flag Throw above.
                } else {
                    mode = 'offense';
                    holder = lastEvent.interception_flag ? (lastEvent.defender || null) : null;
                }
            }
            // Pull / Violation / Other don't change mode or holder here.
        }

        return { mode, holder, point };
    }

    /**
     * Effective holder = derived holder, with the manual override applied
     * only when derived is null (start of possession). This keeps "first
     * tap establishes holder" working without letting the override stomp
     * on the event stream.
     */
    function effectiveHolder(state) {
        return state.holder || manualHolder;
    }

    function getMode() {
        return reconstructState().mode;
    }

    // -----------------------------------------------------------------
    // Panel construction
    // -----------------------------------------------------------------

    function createPlayByPlayFullPanel() {
        const panel = document.createElement('div');
        panel.id = 'panel-playByPlayFull';
        panel.className = 'game-panel panel-playByPlay panel-playByPlayFull';

        const titleBar = window.createPanelTitleBar
            ? window.createPanelTitleBar({
                panelId: 'playByPlayFull',
                title: 'Play-by-Play',
                showDragHandle: false
            })
            : (() => {
                const tb = document.createElement('div');
                tb.className = 'panel-title-bar';
                tb.innerHTML = '<span class="panel-title">Play-by-Play</span>';
                return tb;
            })();
        panel.appendChild(titleBar);

        const content = document.createElement('div');
        content.className = 'panel-content full-pbp-content';
        content.id = 'panel-playByPlayFull-content';
        content.appendChild(buildFullPbpBody());
        panel.appendChild(content);

        return panel;
    }

    function buildFullPbpBody() {
        const body = document.createElement('div');
        body.className = 'full-pbp-body';
        body.innerHTML = `
            <div class="full-pbp-header">
                <span class="full-pbp-mode-pill" id="fullPbpModePill">Offense</span>
                <span class="full-pbp-no-point-msg" id="fullPbpNoPointMsg" style="display:none">No active point</span>
                <button class="full-pbp-undo-btn" id="fullPbpUndoBtn" title="Undo last event">
                    <i class="fas fa-undo"></i>
                    <span>Undo</span>
                </button>
            </div>
            <div class="full-pbp-main">
                <div class="full-pbp-col full-pbp-col-players-wide" id="fullPbpRows">
                    <!-- Player rows + per-row buttons rendered here -->
                </div>
                <div class="full-pbp-col full-pbp-col-modifiers" id="fullPbpModifiers">
                    <div class="full-pbp-placeholder">Modifiers (phase 4)</div>
                </div>
            </div>
            <div class="full-pbp-log-reserve" id="fullPbpLogReserve">
                <div class="full-pbp-log-placeholder">Compact event log (future)</div>
            </div>
        `;
        return body;
    }

    // -----------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------

    /**
     * Repaint the panel. Cheap to call — recomputes state from the event
     * stream every time, so any external mutation (Simple-mode entry,
     * narration, undo) is reflected on the next render.
     */
    function render() {
        const state = reconstructState();

        // Mode pill + no-point message
        const pill = document.getElementById('fullPbpModePill');
        if (pill) {
            pill.textContent = state.mode === 'offense' ? 'Offense' : 'Defense';
            pill.classList.toggle('mode-offense', state.mode === 'offense');
            pill.classList.toggle('mode-defense', state.mode === 'defense');
        }

        const hasPoint = !!(state.point && state.point.players && state.point.players.length);
        const msg = document.getElementById('fullPbpNoPointMsg');
        if (msg) msg.style.display = hasPoint ? 'none' : '';

        const rows = document.getElementById('fullPbpRows');
        if (!rows) return;

        if (!hasPoint) {
            rows.innerHTML = '<div class="full-pbp-placeholder">Start a point to begin entering events.</div>';
            return;
        }

        const holder = effectiveHolder(state);
        const isOffense = state.mode === 'offense';

        // Collect on-field player names (Unknown first, then roster order).
        const names = [UNKNOWN_PLAYER, ...state.point.players];

        rows.innerHTML = '';
        names.forEach(name => {
            const player = (typeof getPlayerFromName === 'function') ? getPlayerFromName(name) : null;
            if (!player) return;

            const isHolder = !!(holder && holder.name === name);
            const row = renderPlayerRow(player, isHolder, isOffense);
            rows.appendChild(row);
        });
    }

    /**
     * Build one player row. The per-row button set is contextual:
     *   - O-mode holder      → throwaway / break / …
     *   - O-mode non-holder  → drop / score / …
     *   - D-mode             → no buttons yet (phase 3 fills these in)
     */
    function renderPlayerRow(player, isHolder, isOffense) {
        const row = document.createElement('div');
        row.className = 'full-pbp-player-row';
        row.classList.toggle('is-holder', isHolder);

        // Player name (left side — the "first column" of the v1 design).
        const nameBtn = document.createElement('button');
        nameBtn.type = 'button';
        nameBtn.className = 'full-pbp-name-btn';
        nameBtn.textContent = player.name;
        nameBtn.addEventListener('click', () => handlePlayerNameTap(player));
        row.appendChild(nameBtn);

        // Action buttons (middle — second column of v1 design).
        const actions = document.createElement('div');
        actions.className = 'full-pbp-row-actions';

        if (!isOffense) {
            // D-mode: every row gets block / interception. Callahan + Stall
            // land in the "…" popover in phase 5; the right-side "They
            // turnover" button lands in phase 3.
            actions.classList.add('full-pbp-row-actions-defense');
            actions.appendChild(makeRowActionBtn('block', 'Block',
                () => handleBlockTap(player)));
            actions.appendChild(makeRowActionBtn('interception', 'D!',
                () => handleInterceptionTap(player)));
            actions.appendChild(makeRowActionBtn('more', '…',
                () => handleMoreTap(player, false)));
        } else if (isHolder) {
            actions.appendChild(makeRowActionBtn('throwaway', 'Throwaway',
                () => handleThrowawayTap()));
            actions.appendChild(makeRowActionBtn('break',
                breakArmed ? 'Break ✓' : 'Break',
                () => handleBreakTap(),
                { armed: breakArmed }));
            actions.appendChild(makeRowActionBtn('more', '…',
                () => handleMoreTap(player, true)));
        } else {
            actions.appendChild(makeRowActionBtn('drop', 'Drop',
                () => handleDropTap(player)));
            actions.appendChild(makeRowActionBtn('score', 'Score',
                () => handleScoreTap(player)));
            actions.appendChild(makeRowActionBtn('more', '…',
                () => handleMoreTap(player, false)));
        }

        row.appendChild(actions);
        return row;
    }

    function makeRowActionBtn(kind, label, onTap, opts) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `full-pbp-row-action full-pbp-row-action-${kind}`;
        if (opts && opts.armed) btn.classList.add('armed');
        btn.textContent = label;
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation(); // don't trigger the row's name button
            onTap();
        });
        return btn;
    }

    // -----------------------------------------------------------------
    // Interaction handlers
    // -----------------------------------------------------------------

    /**
     * Tap on a player's name.
     *   - In O-mode, no holder yet  → set initial holder, no event.
     *   - In O-mode, holder exists  → log a Throw (holder → tapped); tapped
     *     becomes new holder.
     *   - In D-mode → noop for phase 2 (D-mode interactions land in phase 3).
     */
    function handlePlayerNameTap(player) {
        const state = reconstructState();
        if (!state.point) return;

        if (state.mode !== 'offense') {
            // D-mode: tapping a name itself doesn't log a Defense event —
            // the user picks an action button (Block / D!) on the row to
            // disambiguate intent. This is intentional: a name tap during
            // D mode is too ambiguous to commit to a specific Defense
            // event, and we want to avoid silent miscategorization.
            return;
        }

        const holder = effectiveHolder(state);
        if (!holder) {
            // No holder yet — this tap establishes it. No event logged.
            manualHolder = player;
            render();
            return;
        }

        if (holder.name === player.name) {
            // Tapping the holder is a no-op for now. (Phase 7 polish: maybe
            // long-press to deselect.)
            return;
        }

        createThrow(holder, player, { score: false });
    }

    function handleDropTap(player) {
        const state = reconstructState();
        const holder = effectiveHolder(state);
        if (!holder) {
            // No holder = no thrower. Drop without a thrower is just a
            // generic turnover; defer to throwaway semantics (Unknown
            // thrower, this player as receiver).
            createTurnover(getUnknown(), player, { drop: true });
        } else {
            createTurnover(holder, player, { drop: true });
        }
    }

    function handleThrowawayTap() {
        const state = reconstructState();
        const holder = effectiveHolder(state);
        if (!holder) return; // shouldn't be reachable — button only on holder row
        createTurnover(holder, getUnknown(), { throwaway: true });
    }

    function handleScoreTap(player) {
        const state = reconstructState();
        const holder = effectiveHolder(state);
        if (!holder) {
            // No holder yet but user is claiming a score — treat the tapped
            // player as catching from Unknown. Edge case; keeps the button
            // from being a dead end.
            createThrow(getUnknown(), player, { score: true });
        } else {
            createThrow(holder, player, { score: true });
        }
    }

    function handleBreakTap() {
        breakArmed = !breakArmed;
        render();
    }

    function handleBlockTap(player) {
        // Block: defender knocks the disc down. Possession not yet settled
        // — fall to D side with no holder; first tap on the new O side
        // establishes who picked it up. (Per requirements doc, A.)
        createDefense(player, { /* no flags */ });
    }

    function handleInterceptionTap(player) {
        // Interception: defender catches the disc cleanly. Becomes new
        // holder when we flip to O.
        createDefense(player, { interception: true });
    }

    /**
     * "…" popover. Phase 5 will implement Stall / Good D / Callahan.
     */
    function handleMoreTap(player, isHolder) {
        console.log('[fullPbp] "…" popover (phase 5):', player.name, isHolder ? '(holder)' : '');
    }

    /**
     * Undo button — defers to the global undoEvent() so we share all the
     * score-rollback / possession-cleanup / point-removal logic with
     * Simple mode. Then we render and publish eventRetracted to the bus
     * (since undoEvent itself doesn't currently publish — that's a small
     * follow-up worth doing, but out of scope for this phase).
     */
    function handleUndo() {
        if (typeof undoEvent !== 'function') {
            console.warn('[fullPbp] global undoEvent not available');
            return;
        }
        // Snapshot the last event before undoEvent removes it, so we can
        // pass it along on the bus for subscribers.
        const before = lastEventSnapshot();
        undoEvent();
        manualHolder = null;
        breakArmed = false;
        render();
        if (before && window.narrationEventBus) {
            window.narrationEventBus.publish('eventRetracted', {
                event: before.event,
                source: 'manual',
                provisionalId: null
            });
        }
    }

    function lastEventSnapshot() {
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        if (!point || !point.possessions) return null;
        for (let i = point.possessions.length - 1; i >= 0; i--) {
            const events = point.possessions[i].events;
            if (events && events.length) {
                return { event: events[events.length - 1] };
            }
        }
        return null;
    }

    // -----------------------------------------------------------------
    // Event creation helpers — mirror the patterns in keyPlayDialog and
    // narrationEngine so all event sources stay consistent.
    // -----------------------------------------------------------------

    function getUnknown() {
        return (typeof getPlayerFromName === 'function')
            ? getPlayerFromName(UNKNOWN_PLAYER)
            : null;
    }

    function createThrow(thrower, receiver, opts) {
        if (typeof ensurePossessionExists !== 'function') return;
        if (!thrower || !receiver) return;

        const evt = new Throw({
            thrower,
            receiver,
            huck: false,
            breakmark: !!breakArmed,
            dump: false,
            hammer: false,
            sky: false,
            layout: false,
            score: !!opts.score
        });
        const possession = ensurePossessionExists(true);
        possession.addEvent(evt);

        // Stats: every throw counts as a completed pass; a score also
        // earns the thrower an assist and the receiver a goal.
        if (typeof thrower.completedPasses !== 'number') thrower.completedPasses = 0;
        thrower.completedPasses += 1;
        if (evt.score_flag) {
            thrower.assists = (thrower.assists || 0) + 1;
            receiver.goals = (receiver.goals || 0) + 1;
        }

        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt);

        // Once any event is added, clear the manual holder override and
        // disarm the break flag so they don't bleed into subsequent
        // events.
        manualHolder = null;
        breakArmed = false;

        if (evt.score_flag && typeof updateScore === 'function' && typeof Role !== 'undefined') {
            updateScore(Role.TEAM);
            if (typeof moveToNextPoint === 'function') moveToNextPoint();
        }

        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
        render();
    }

    function createTurnover(thrower, receiver, opts) {
        if (typeof ensurePossessionExists !== 'function') return;
        const evt = new Turnover({
            thrower: thrower || null,
            receiver: receiver || null,
            throwaway: !!opts.throwaway,
            huck: false,
            receiverError: !!opts.drop,
            goodDefense: !!opts.goodDefense,
            stall: !!opts.stall
        });
        // Turnovers live in the offensive possession that just ended.
        const possession = ensurePossessionExists(true);
        possession.addEvent(evt);

        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt);

        manualHolder = null;
        breakArmed = false;

        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
        render();
    }

    function createDefense(defender, opts) {
        if (typeof ensurePossessionExists !== 'function') return;
        if (!defender) return;

        const evt = new Defense({
            defender,
            interception: !!opts.interception,
            layout: false,
            sky: false,
            Callahan: !!opts.Callahan,
            stall: !!opts.stall,
            unforcedError: !!opts.unforcedError
        });
        // Defense events live in a defensive possession.
        const possession = ensurePossessionExists(false);
        possession.addEvent(evt);

        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt);

        manualHolder = null;
        breakArmed = false;

        if (evt.Callahan_flag && typeof updateScore === 'function' && typeof Role !== 'undefined') {
            defender.goals = (defender.goals || 0) + 1;
            updateScore(Role.TEAM);
            if (typeof moveToNextPoint === 'function') moveToNextPoint();
        }

        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
        render();
    }

    function publishAdded(evt) {
        if (!window.narrationEventBus) return;
        window.narrationEventBus.publish('eventAdded', {
            event: evt,
            source: 'manual',
            provisionalId: null
        });
    }

    // -----------------------------------------------------------------
    // Init / wiring
    // -----------------------------------------------------------------

    function wireEvents() {
        const undoBtn = document.getElementById('fullPbpUndoBtn');
        if (undoBtn && !undoBtn.dataset.wired) {
            undoBtn.dataset.wired = 'true';
            undoBtn.addEventListener('click', handleUndo);
        }

        // Mode pill — phase 3 will hook this for the O/D toggle. Wire it
        // now so the click handler exists; phase 3 fills in the logic.
        const pill = document.getElementById('fullPbpModePill');
        if (pill && !pill.dataset.wired) {
            pill.dataset.wired = 'true';
            pill.addEventListener('click', () => {
                console.log('[fullPbp] mode pill tap (phase 3 stub)');
            });
        }
    }

    function init() {
        wireEvents();
        render();

        if (window.narrationEventBus) {
            // Re-render on any event-stream change from outside this panel
            // (Simple-mode entry, narration, score updates, etc.).
            window.narrationEventBus.subscribe('eventAdded', render);
            window.narrationEventBus.subscribe('eventAmended', render);
            window.narrationEventBus.subscribe('eventRetracted', render);
            window.narrationEventBus.subscribe('pointChanged', render);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 0);
    }

    // -----------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------

    window.fullPbp = {
        createPlayByPlayFullPanel,
        render,
        wireEvents,
        getMode,
        // Inspection helpers — handy from devtools while iterating:
        //   window.fullPbp._reconstruct()  → current { mode, holder, point }
        _reconstruct: reconstructState
    };
})();
