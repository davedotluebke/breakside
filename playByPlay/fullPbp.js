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
                <button class="full-pbp-start-point-btn" id="fullPbpStartPointBtn" style="display:none">Start Point</button>
                <span class="full-pbp-mode-pill" id="fullPbpModePill">Offense</span>
                <span class="full-pbp-no-point-msg" id="fullPbpNoPointMsg" style="display:none">No active point</span>
                <button class="full-pbp-undo-btn" id="fullPbpUndoBtn" title="Undo last event">
                    <i class="fas fa-undo"></i>
                    <span>Undo</span>
                </button>
            </div>
            <div class="full-pbp-rows-area" id="fullPbpRows">
                <!-- Player rows fill the full width -->
            </div>
            <div class="full-pbp-modifier-row" id="fullPbpModifierRow">
                <!-- Horizontal modifier chips for the most recent editable event -->
            </div>
            <div class="full-pbp-bottom-actions" id="fullPbpBottomActions">
                <!-- D-mode: They turnover / Events / They score
                     O-mode: just Events (centered) -->
            </div>
            <div class="full-pbp-log-reserve" id="fullPbpLogReserve">
                <div class="full-pbp-log-list" id="fullPbpLogList"></div>
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
     *
     * Header behavior is driven by isPointInProgress():
     *   - Point in progress  → mode pill visible, Start Point button hidden,
     *                          player rows interactive
     *   - Between points     → Start Point button visible (replaces pill),
     *                          player rows greyed out and disabled
     *   - No point at all    → "No active point" message, rows hidden
     */
    function render() {
        const state = reconstructState();
        const inPoint = (typeof isPointInProgress === 'function') && isPointInProgress();

        const pill = document.getElementById('fullPbpModePill');
        const startBtn = document.getElementById('fullPbpStartPointBtn');
        const msg = document.getElementById('fullPbpNoPointMsg');
        const hasPoint = !!(state.point && state.point.players && state.point.players.length);

        // Header: between-points → Start Point; in-point → mode pill.
        // Reuse the existing applyStartPointButtonState so we get the
        // canonical "Start Point (Offense)" label + feedback class.
        if (startBtn) {
            const showStart = !inPoint;
            startBtn.style.display = showStart ? 'inline-flex' : 'none';
            if (showStart && typeof applyStartPointButtonState === 'function') {
                applyStartPointButtonState(startBtn, false);
            }
        }
        if (pill) {
            pill.style.display = inPoint ? 'inline-block' : 'none';
            pill.textContent = state.mode === 'offense' ? 'Offense' : 'Defense';
            pill.classList.toggle('mode-offense', state.mode === 'offense');
            pill.classList.toggle('mode-defense', state.mode === 'defense');
        }
        if (msg) {
            // Only show the "no point" caption if there's truly nothing —
            // between points we still want the Start Point button present
            // and the (last point's) roster faintly visible to avoid an
            // empty-feeling screen.
            msg.style.display = (!hasPoint && inPoint) ? '' : 'none';
        }

        const rows = document.getElementById('fullPbpRows');
        if (rows) {
            if (!hasPoint) {
                rows.innerHTML = '<div class="full-pbp-placeholder">Start a point to begin entering events.</div>';
            } else {
                const holder = inPoint ? effectiveHolder(state) : null;
                const isOffense = state.mode === 'offense';
                const names = [UNKNOWN_PLAYER, ...state.point.players];

                rows.innerHTML = '';
                names.forEach(name => {
                    const player = (typeof getPlayerFromName === 'function') ? getPlayerFromName(name) : null;
                    if (!player) return;

                    const isHolder = !!(holder && holder.name === name);
                    const row = renderPlayerRow(player, isHolder, isOffense);
                    if (!inPoint) row.classList.add('between-points');
                    rows.appendChild(row);
                });
            }
        }

        renderModifierRow(state, inPoint);
        renderBottomActions(state, inPoint);
        renderMiniLog(state.point);
    }

    /**
     * Modifier row — full-width horizontal strip of pill chips that
     * sits above the bottom action row. Adapts to the most recent
     * editable event in the current point:
     *
     *     Throw    → "Last pass was a:"     {break, huck, reset, hammer, sky catch, layout catch}
     *     Turnover → "Last turnover was a:" {huck, good D}
     *     Defense  → "Last D was a:"        {sky, layout}
     *
     * Toggling a chip amends the event in place and publishes
     * eventAmended to the bus. Chips auto-clear when render() rebuilds
     * the row from a new "last event."
     *
     * If there's no editable event yet (first point, just-after-pull,
     * etc.), the row is hidden so it doesn't take up empty space.
     */
    function renderModifierRow(state, inPoint) {
        const row = document.getElementById('fullPbpModifierRow');
        if (!row) return;

        const editable = inPoint ? findLastEditableEvent(state.point) : null;
        if (!editable) {
            row.style.display = 'none';
            row.innerHTML = '';
            return;
        }

        row.style.display = '';
        row.innerHTML = '';

        const isThrow = editable.type === 'Throw';
        const isTurnover = editable.type === 'Turnover';
        const flags = isThrow ? THROW_MODIFIERS
                    : isTurnover ? TURNOVER_MODIFIERS
                    : DEFENSE_MODIFIERS;
        const titleText = isThrow ? 'Last pass was a:'
                        : isTurnover ? 'Last turnover was a:'
                        : 'Last D was a:';

        const title = document.createElement('span');
        title.className = 'full-pbp-modifier-row-label';
        title.textContent = titleText;
        row.appendChild(title);

        const chips = document.createElement('div');
        chips.className = 'full-pbp-modifier-row-chips';
        flags.forEach(f => {
            const chip = document.createElement('label');
            chip.className = 'full-pbp-modifier-chip';
            if (editable[f.prop]) chip.classList.add('checked');

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!editable[f.prop];
            cb.addEventListener('change', () => handleModifierChange(editable, f.prop, cb.checked, f.label));

            const span = document.createElement('span');
            span.textContent = f.label;

            chip.appendChild(cb);
            chip.appendChild(span);
            chips.appendChild(chip);
        });
        row.appendChild(chips);
    }

    /**
     * Bottom action row — full-width strip below the modifier row.
     *
     *   D-mode: [They turnover] [⚙ Events] [They score]
     *   O-mode: [               ⚙ Events               ]
     *
     * "Events" opens the existing Game Events modal (Timeout / Injury
     * Sub / Halftime / Switch Sides / End Game) — same modal Simple
     * mode uses. Routes through handlePbpGameEvents so role/permission
     * checks stay consistent.
     */
    function renderBottomActions(state, inPoint) {
        const bar = document.getElementById('fullPbpBottomActions');
        if (!bar) return;

        if (!inPoint) {
            bar.style.display = 'none';
            bar.innerHTML = '';
            return;
        }

        bar.style.display = '';
        bar.innerHTML = '';
        bar.classList.toggle('mode-defense', state.mode === 'defense');
        bar.classList.toggle('mode-offense', state.mode === 'offense');

        if (state.mode === 'defense') {
            const tt = document.createElement('button');
            tt.id = 'fullPbpTheyTurnoverBtn';
            tt.className = 'full-pbp-they-turnover-btn';
            tt.title = 'Opponent turned it over without a specific defender getting credit';
            tt.textContent = 'They turnover';
            tt.addEventListener('click', handleTheyTurnoverTap);
            bar.appendChild(tt);
        }

        const ev = document.createElement('button');
        ev.id = 'fullPbpGameEventsBtn';
        ev.className = 'full-pbp-game-events-btn';
        ev.title = 'Timeout, injury sub, halftime, switch sides, end game';
        ev.innerHTML = '<i class="fas fa-cog"></i> Events';
        ev.addEventListener('click', handleGameEventsTap);
        bar.appendChild(ev);

        if (state.mode === 'defense') {
            const ts = document.createElement('button');
            ts.id = 'fullPbpTheyScoreBtn';
            ts.className = 'full-pbp-they-score-btn';
            ts.title = 'Opponent scored — ends the current point';
            ts.textContent = 'They score';
            ts.addEventListener('click', handleTheyScoreTap);
            bar.appendChild(ts);
        }
    }

    /**
     * Walk the current point's events backwards, return the first
     * Throw, Turnover, or Defense found. Returns null if none.
     *
     * Including Turnover here is essential: if the user logs a
     * Throwaway, the panel needs to amend the *turnover* (e.g. "this
     * was a huck attempt that turned over"), not the previous
     * completed Throw — the throw before the turnover is already
     * complete and accurate, and re-modifying it would be wrong.
     */
    function findLastEditableEvent(point) {
        if (!point || !point.possessions) return null;
        for (let i = point.possessions.length - 1; i >= 0; i--) {
            const events = point.possessions[i].events;
            if (!events) continue;
            for (let j = events.length - 1; j >= 0; j--) {
                const e = events[j];
                if (e.type === 'Throw' || e.type === 'Turnover' || e.type === 'Defense') return e;
            }
        }
        return null;
    }

    /**
     * Per-event-type definitions of which flags are editable from the
     * modifier panel. Keys are the *visible* checkbox label; values are
     * the property name on the event object. Order = display order.
     */
    // Order = display order, most-frequent first so common modifiers
    // show up at the head of the row before any horizontal scroll.
    // Labels are user-facing text; underlying property names on the
    // event object stay the same (so existing data is unaffected).
    const THROW_MODIFIERS = [
        { label: 'break',        prop: 'break_flag'  },
        { label: 'huck',         prop: 'huck_flag'   },
        { label: 'reset',        prop: 'dump_flag'   },  // displayed as "reset", flag stays dump_flag
        { label: 'hammer',       prop: 'hammer_flag' },
        { label: 'sky catch',    prop: 'sky_flag'    },
        { label: 'layout catch', prop: 'layout_flag' }
    ];
    const TURNOVER_MODIFIERS = [
        { label: 'huck',   prop: 'huck_flag'    },
        { label: 'good D', prop: 'defense_flag' }
    ];
    const DEFENSE_MODIFIERS = [
        { label: 'sky',    prop: 'sky_flag'    },
        { label: 'layout', prop: 'layout_flag' }
    ];

    /**
     * Toggle a flag on the most recent Throw/Defense in place. This is
     * an AMEND, not a RETRACT+ADD — the event keeps its identity and
     * position in the timeline, stats are unchanged (these are
     * presentation-only flags), and a single eventAmended bus message
     * carries the before/after for subscribers.
     *
     * For score-flag changes we'd need to handle moveToNextPoint reversal,
     * but the modifier panel never exposes score_flag — score events are
     * created by the dedicated Score row button.
     */
    function handleModifierChange(event, propName, newValue, displayLabel) {
        // Clone the prior state for the bus payload so subscribers can
        // diff "before vs. after". Cheap shallow clone — flags are
        // primitives and player references are intentionally shared.
        const previousEvent = Object.assign(
            Object.create(Object.getPrototypeOf(event)),
            event
        );

        event[propName] = !!newValue;

        if (typeof logEvent === 'function') {
            // Empty description path is fine — logEvent rebuilds the log
            // textarea from summarizeGame() either way, and our amendment
            // is reflected in the next event.summarize() call.
            logEvent(`Amended ${event.type}: ${displayLabel} → ${newValue ? 'on' : 'off'}`);
        }

        if (window.narrationEventBus) {
            window.narrationEventBus.publish('eventAmended', {
                event,
                previousEvent,
                source: 'manual',
                provisionalId: null
            });
        }

        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
        render();
    }

    /**
     * Rebuild the bottom-strip mini-log from the current point's event
     * stream. One line per event, prefixed with O/D so transitions are
     * obvious in scan-and-skim. Auto-scrolls to bottom so the most recent
     * event is always visible.
     *
     * Built from the source-of-truth event stream rather than incrementally
     * appending bus events, so it stays correct regardless of who created
     * the events (Simple, Full, narration) and survives Undo cleanly.
     */
    function renderMiniLog(point) {
        const list = document.getElementById('fullPbpLogList');
        if (!list) return;

        if (!point || !point.possessions || !point.possessions.length) {
            list.textContent = '';
            return;
        }

        const lines = [];
        point.possessions.forEach(poss => {
            (poss.events || []).forEach(evt => {
                const side = poss.offensive ? 'O' : 'D';
                const summary = (typeof evt.summarize === 'function')
                    ? evt.summarize() : evt.type;
                lines.push(`${side}  ${summary}`);
            });
        });

        list.textContent = lines.join('\n');
        // Auto-scroll to keep the most recent event in view.
        list.scrollTop = list.scrollHeight;
    }

    /**
     * Build one player row. The per-row button set is contextual:
     *   - O-mode holder      → throwaway / break / …
     *   - O-mode non-holder  → drop / score / …
     *   - D-mode any row     → block / Interception / …
     */
    function renderPlayerRow(player, isHolder, isOffense) {
        const isUnknown = (player.name === UNKNOWN_PLAYER);
        const row = document.createElement('div');
        row.className = 'full-pbp-player-row';
        row.classList.toggle('is-holder', isHolder);
        row.classList.toggle('is-unknown', isUnknown);

        // Player name (left side — the "first column" of the v1 design).
        // We display "Unknown" rather than the full "Unknown Player" string
        // because the long label overflows on narrow viewports. The
        // underlying constant UNKNOWN_PLAYER stays the same so storage,
        // lookups, and serialization aren't affected.
        const nameBtn = document.createElement('button');
        nameBtn.type = 'button';
        nameBtn.className = 'full-pbp-name-btn';
        nameBtn.textContent = isUnknown ? 'Unknown' : player.name;
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
            actions.appendChild(makeRowActionBtn('interception', 'Interception',
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
            // the user picks an action button (Block / Interception) on the row to
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
     * "They turnover" button — always visible in the modifier column
     * while in D mode. Logs an unforced opponent turnover (defender =
     * null, unforced error). NOT inferred — this is a real observed
     * event; the user just doesn't have a specific defender to credit.
     * Flips us back to O with no holder.
     */
    function handleTheyTurnoverTap() {
        createDefense(null, { unforcedError: true });
    }

    /**
     * "They score" button — opponent scored without us recording a
     * specific event. Delegates to the existing global handlePbpTheyScore
     * so all the point-timer / score-update / moveToNextPoint plumbing
     * matches Simple mode exactly. (No event added to possessions, same
     * as Simple's "They Score" button — point.winner is set instead.)
     */
    function handleTheyScoreTap() {
        if (typeof handlePbpTheyScore === 'function') {
            handlePbpTheyScore();
        }
    }

    /**
     * "Events" button — opens the existing Game Events modal (Timeout
     * / Injury Sub / Halftime / Switch Sides / End Game). Routes
     * through handlePbpGameEvents so role/permission checks match
     * Simple mode exactly. The modal itself is shared across modes.
     */
    function handleGameEventsTap() {
        if (typeof handlePbpGameEvents === 'function') {
            handlePbpGameEvents();
        }
    }

    /**
     * O/D pill tap. Indicates the user thinks the possession side has
     * changed in a way that wasn't captured by an explicit event.
     *
     * Behavior:
     *   1. If the most recent event in the current point is itself an
     *      `inferred=true` event, retract it (the user is undoing a
     *      previous pill tap that turned out to be wrong).
     *   2. Otherwise, insert a synthetic event in the appropriate
     *      direction:
     *        O → D : Turnover{thrower=Unknown, throwaway, inferred}
     *        D → O : Defense{defender=null, unforcedError, inferred}
     *
     * The retract-first rule means tapping the pill twice in a row
     * with no events between cleanly cancels — no orphan inferred
     * events left behind.
     */
    function handleModePillTap() {
        const inPoint = (typeof isPointInProgress === 'function') && isPointInProgress();
        if (!inPoint) return;

        // Retract a most-recent inferred event if present.
        if (retractLastInferredEvent()) {
            manualHolder = null;
            breakArmed = false;
            if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
            render();
            return;
        }

        // Otherwise insert a new inferred event in the appropriate direction.
        const state = reconstructState();
        if (state.mode === 'offense') {
            // O → D: synthetic turnover charged to Unknown Player so no
            // real player's stats are affected by an inferred event.
            const unknown = getUnknown();
            createInferredTurnover(unknown);
        } else {
            // D → O: synthetic unforced opponent error (defender = null).
            createDefense(null, { unforcedError: true, inferred: true });
        }
    }

    /**
     * Pop the most recent event from the current point if and only if it
     * is `inferred=true`. Cleans up an empty possession after popping.
     * Returns the popped event, or null if nothing to retract.
     *
     * Doesn't touch stats: inferred Turnovers/Defense{unforcedError}
     * don't update player stats on creation, so nothing to revert.
     */
    function retractLastInferredEvent() {
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        if (!point || !point.possessions) return null;

        for (let i = point.possessions.length - 1; i >= 0; i--) {
            const poss = point.possessions[i];
            if (!poss.events || !poss.events.length) continue;
            const lastEvent = poss.events[poss.events.length - 1];
            if (!lastEvent.inferred_flag) return null;

            poss.events.pop();
            if (poss.events.length === 0) {
                point.possessions.splice(i, 1);
            }

            if (typeof logEvent === 'function') {
                logEvent(`Retracted inferred event: ${lastEvent.summarize()}`);
            }
            if (window.narrationEventBus) {
                window.narrationEventBus.publish('eventRetracted', {
                    event: lastEvent,
                    source: 'manual',
                    provisionalId: null
                });
            }
            return lastEvent;
        }
        return null;
    }

    /**
     * Helper: synthetic turnover with thrower/receiver = Unknown so no
     * real player gets debited. Marks inferred_flag for the log prefix
     * and the retract-on-double-tap detection.
     */
    function createInferredTurnover(unknown) {
        if (typeof ensurePossessionExists !== 'function') return;
        const evt = new Turnover({
            thrower: unknown,
            receiver: unknown,
            throwaway: true,
            huck: false,
            receiverError: false,
            goodDefense: false,
            stall: false
        });
        evt.inferred_flag = true;

        const possession = ensurePossessionExists(true);
        possession.addEvent(evt);

        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt);

        manualHolder = null;
        breakArmed = false;

        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
        render();
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

    /**
     * Create a Defense event. `defender` may be null for unforced-error
     * cases ("They turnover" button, or D→O pill toggle) — the Defense
     * model explicitly supports null to mean "unforced turnover by
     * opponent". The `inferred` opt marks system-synthesized events
     * (currently only used by the O/D pill toggle).
     */
    function createDefense(defender, opts) {
        if (typeof ensurePossessionExists !== 'function') return;
        // Block / interception need a defender; unforced errors don't.
        if (!defender && !opts.unforcedError) return;

        const evt = new Defense({
            defender: defender || null,
            interception: !!opts.interception,
            layout: false,
            sky: false,
            Callahan: !!opts.Callahan,
            stall: !!opts.stall,
            unforcedError: !!opts.unforcedError
        });
        if (opts.inferred) evt.inferred_flag = true;

        // Defense events live in a defensive possession.
        const possession = ensurePossessionExists(false);
        possession.addEvent(evt);

        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt);

        manualHolder = null;
        breakArmed = false;

        if (evt.Callahan_flag && typeof updateScore === 'function' && typeof Role !== 'undefined') {
            if (defender) defender.goals = (defender.goals || 0) + 1;
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

        // Mode pill — tap to toggle O ↔ D. See handleModePillTap for the
        // inferred-event semantics (insert vs. retract-on-double-tap).
        const pill = document.getElementById('fullPbpModePill');
        if (pill && !pill.dataset.wired) {
            pill.dataset.wired = 'true';
            pill.addEventListener('click', handleModePillTap);
        }

        // Start Point button — between-points UI. Delegates to the same
        // global handler the simple PBP panel uses so role/lineup checks
        // and pull-dialog flow stay consistent across modes.
        const startBtn = document.getElementById('fullPbpStartPointBtn');
        if (startBtn && !startBtn.dataset.wired) {
            startBtn.dataset.wired = 'true';
            startBtn.addEventListener('click', () => {
                if (typeof handlePanelStartPoint === 'function') {
                    handlePanelStartPoint();
                } else if (typeof startNextPoint === 'function') {
                    startNextPoint();
                }
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
