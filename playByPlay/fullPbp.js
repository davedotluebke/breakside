/*
 * Full Play-by-Play
 *
 * The "Full" PBP tab provides rapid every-event entry alongside the existing
 * "Simple" mode (renamed from the original Play tab). See
 * docs/full-pbp-requirements.md for the full UI spec.
 *
 * Phase 1: skeleton only. The panel renders a 3-column layout (players /
 * middle / right) plus a header (mode indicator + Undo) and a reserved bottom
 * strip for the future ultra-compact game log. No event creation logic yet —
 * that comes in phase 2.
 *
 * Public API (window.fullPbp):
 *   - createPlayByPlayFullPanel(): HTMLElement — builds the panel
 *   - render(): void — re-renders the panel content from current game state
 *   - getMode(): 'offense'|'defense' — current sub-mode
 *   - setMode(mode): void — manual override of O/D (auto-flip lands in phase 3)
 */

(function() {
    // -----------------------------------------------------------------
    // State
    // -----------------------------------------------------------------
    let mode = 'offense';     // 'offense' | 'defense' (manual for phase 1)

    function getMode() { return mode; }

    function setMode(m) {
        if (m !== 'offense' && m !== 'defense') return;
        mode = m;
        render();
    }

    // -----------------------------------------------------------------
    // Panel construction
    // -----------------------------------------------------------------

    /**
     * Build the Full PBP panel. Mirrors the structure of the Simple
     * play-by-play panel but with id `panel-playByPlayFull` so the panel
     * system + tab routing can address it independently.
     */
    function createPlayByPlayFullPanel() {
        const panel = document.createElement('div');
        panel.id = 'panel-playByPlayFull';
        panel.className = 'game-panel panel-playByPlay panel-playByPlayFull';

        // Title bar — re-uses the shared helper for consistency. No drag
        // handle: this panel is only visible in the Full tab (single-panel
        // fullscreen), where drag handles are hidden anyway.
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

        // Content area
        const content = document.createElement('div');
        content.className = 'panel-content full-pbp-content';
        content.id = 'panel-playByPlayFull-content';
        content.appendChild(buildFullPbpBody());
        panel.appendChild(content);

        return panel;
    }

    /**
     * Top-level body for the Full PBP UI. Layout:
     *
     *   ┌───────────────────────────────────────────────────────┐
     *   │  Header: [Mode pill]              [Undo]              │
     *   ├──────────┬───────────────┬────────────────────────────┤
     *   │ Players  │ Per-player    │ Modifier panel /           │
     *   │  (1/3)   │  buttons (1/3)│   "They turnover" (1/3)    │
     *   │          │               │                            │
     *   ├──────────┴───────────────┴────────────────────────────┤
     *   │  Bottom 20% — reserved for future ultra-compact log   │
     *   └───────────────────────────────────────────────────────┘
     */
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
                <div class="full-pbp-col full-pbp-col-players" id="fullPbpPlayers">
                    <div class="full-pbp-placeholder">Players (phase 2)</div>
                </div>
                <div class="full-pbp-col full-pbp-col-actions" id="fullPbpActions">
                    <div class="full-pbp-placeholder">Per-player buttons (phase 2)</div>
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
    // Render — refresh panel content from current state
    // -----------------------------------------------------------------

    function render() {
        const pill = document.getElementById('fullPbpModePill');
        if (pill) {
            pill.textContent = mode === 'offense' ? 'Offense' : 'Defense';
            pill.classList.toggle('mode-offense', mode === 'offense');
            pill.classList.toggle('mode-defense', mode === 'defense');
        }

        // Show "No active point" if we have no point to track yet, so the
        // user knows what's going on instead of seeing empty placeholders.
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        const hasPoint = !!(point && point.players && point.players.length);
        const msg = document.getElementById('fullPbpNoPointMsg');
        if (msg) msg.style.display = hasPoint ? 'none' : '';
    }

    // -----------------------------------------------------------------
    // Wiring
    // -----------------------------------------------------------------

    function wireEvents() {
        const undoBtn = document.getElementById('fullPbpUndoBtn');
        if (undoBtn && !undoBtn.dataset.wired) {
            undoBtn.dataset.wired = 'true';
            undoBtn.addEventListener('click', handleUndo);
        }
    }

    /**
     * Phase 1 stub. Phase 2 will pop the last event from the active
     * possession, revert stats, and publish `eventRetracted`.
     */
    function handleUndo() {
        console.log('[fullPbp] Undo clicked (phase 1 stub)');
    }

    // Initialize after the panel is in the DOM. We hook into the same
    // DOMContentLoaded path as the rest of the game UI.
    function init() {
        // Wire when the panel exists. Game screen is built lazily, so try
        // both paths: now (in case it already exists) and on a short delay.
        wireEvents();
        render();

        // Also re-wire whenever the tab is switched to 'full' — buildGameScreen
        // creates the panel once and keeps it in DOM, so a single wire is
        // enough, but render() needs to refresh on tab switch.
        if (window.narrationEventBus) {
            window.narrationEventBus.subscribe('eventAdded', render);
            window.narrationEventBus.subscribe('eventAmended', render);
            window.narrationEventBus.subscribe('eventRetracted', render);
            window.narrationEventBus.subscribe('pointChanged', render);
        }
    }

    // Defer init until DOM and panel system are ready.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // The game screen panel may not exist yet; init is idempotent and
        // wireEvents short-circuits if the button isn't present.
        setTimeout(init, 0);
    }

    // Re-wire after the game screen is built. gameScreen.js calls
    // initGameScreen() which appends the panels; we listen for that via a
    // direct hook below if available, otherwise the deferred init above
    // catches it on the first tab switch.
    window.fullPbp = {
        createPlayByPlayFullPanel,
        render,
        wireEvents,
        getMode,
        setMode
    };
})();
