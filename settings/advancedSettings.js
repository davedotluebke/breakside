/*
 * Advanced Settings
 *
 * Per-device coach preferences for power-user / A/B knobs that don't belong
 * in Team Settings (which is team-scoped and synced). These are stored in
 * localStorage on this device only — they tune how THIS phone behaves, not
 * the shared team data.
 *
 * v1 groups:
 *   - Audio Narration: VAD eagerness, noise reduction, transcription model,
 *     vocabulary biasing, browser audio processing, force-English.
 *   - Sync: cloud refresh interval.
 *
 * Single source of truth: window.advancedSettings.get(key) returns, in order
 * of precedence:
 *   1. a window override (e.g. NARRATION_VAD_EAGERNESS) — kept so the console
 *      knobs we previously advertised still work for quick dev A/B;
 *   2. the stored localStorage value;
 *   3. the built-in default.
 */
const advancedSettings = (function() {
    const STORAGE_KEY = 'breakside_advanced_settings';

    // Common ultimate-frisbee jargon to bias transcription toward. Spelled
    // into the default template below; users can edit/extend in the modal.
    const JARGON = [
        'huck', 'hammer', 'scoober', 'blade', 'break', 'break mark', 'dump',
        'swing', 'reset', 'sky', 'layout', 'bid', 'Callahan', 'brick', 'pull',
        'stall', 'stall out', 'poach', 'force', 'flick', 'backhand', 'IO', 'OI',
        'inside-out', 'outside-in', 'endzone', 'throwaway', 'drop', 'footblock',
        'bookends', 'Greatest', 'handler', 'cutter', 'give-and-go', 'strike',
        'under', 'deep', 'goal', 'assist', 'turnover', 'interception', 'block'
    ];

    // Default vocabulary-prompt template. `{names}` is substituted at session
    // start with the current on-field roster (names + nicknames). Users can
    // edit this freely in the modal — remove `{names}` to skip auto-injection
    // of roster names, add their own terms, or rewrite entirely.
    const DEFAULT_VOCAB_PROMPT =
        `Ultimate frisbee game. Likely names and terms: {names}, ${JARGON.join(', ')}.`;

    // Auto line-selection priority factors. This array's order IS the default
    // priority order (position above rest, both above O/D). Each is a soft key
    // the Auto greedy applies in the user-chosen order; fixed sub-tiebreakers
    // (fewer points, longer bench streak, name) always run last. Keys are the
    // stable ids stored in autoLine.priorityOrder; labels drive the reorder UI.
    // NB: Auto only ADDS players (it never benches anyone), so "Rest" means
    // "favor players who have sat out more", not "sit players".
    const AUTO_LINE_FACTORS = [
        ['position', 'Position (handlers / cutters)'],
        ['rest', 'Rest (favor players who have sat more)'],
        ['od', 'Prioritize O/D squad'],
        ['pt', 'Even playing time'],
    ];
    const AUTO_LINE_FACTOR_KEYS = AUTO_LINE_FACTORS.map(f => f[0]);

    const DEFAULTS = {
        // --- Auto Line Selection ---
        // Ordered priority of the soft factors (drag to reorder). Default is the
        // classic ordering (rest above O/D).
        'autoLine.priorityOrder': AUTO_LINE_FACTOR_KEYS.slice(),
        // true => a Crossover player counts the same as a dedicated D-line
        // player on a defense point (and O-line on offense) — the classic
        // behavior. false => dedicated line players are preferred over Crossover
        // for their point type.
        'autoLine.crossoverSamePriority': true,
        // --- Audio Narration ---
        'narration.vadEagerness': 'medium',              // low | medium | high | auto
        'narration.noiseReduction': 'near_field',        // near_field | far_field | off
        'narration.transcriptionModel': 'gpt-4o-mini-transcribe', // or gpt-4o-transcribe
        'narration.forceEnglish': true,                  // true -> language 'en'; false -> auto-detect
        'narration.vocabularyHint': true,                // bias ASR toward roster names + ultimate jargon
        'narration.vocabularyPrompt': DEFAULT_VOCAB_PROMPT, // editable template; {names} -> roster
        'narration.echoCancellation': true,              // getUserMedia audio constraints
        'narration.noiseSuppression': true,
        // AGC default OFF: it pumps gain during quiet moments outdoors and
        // amplifies wind/crowd noise, which hurts transcription far more than
        // it helps with a phone held near the coach's mouth.
        'narration.autoGainControl': false,
        // --- Sync ---
        'sync.refreshIntervalSec': 10,                   // cloud auto-refresh cadence (applies after reload)
        // --- Battery ---
        // Hold a screen wake lock during a game so the display doesn't sleep.
        // On by default: it's what lets a coach dim the screen right down,
        // which is the single biggest battery saving available.
        'power.keepScreenAwake': true,
        // --- Display ---
        // auto | light | dark. Applied by utils/theme.js (and by an inline
        // copy of its resolve step in index.html, so the first paint is already
        // the right theme). Dark uses a true-black page background, which on an
        // OLED phone is a real battery saving over a two-hour game.
        'display.theme': 'dark',
        'display.showPlayerNumbers': true,               // jersey numbers alongside names everywhere
        // --- Field ---
        'field.endzoneYards': 20,                         // endzone depth drawn on the Field tab (20 = USAU, 25 = some leagues)
        'field.huckFraction': 0.5,                        // auto-classify a throw as a huck at ≥ this fraction of the playing field
        'field.swingFraction': 0.25,                      // auto-classify a throw as a swing at ≥ this lateral fraction of the field width
        'field.flipHA': false,                            // swap which sideline is Home (Field tab display)
        'field.flipAD': false,                            // base attack direction (auto-alternates each point on top of this)
        // --- Replay (Log tab field playback; docs/replay-viewer-plan.md) ---
        'replay.capWithinMs': 4000,                       // dead time clipped between plays within a point (0 = Off)
        'replay.capBetweenMs': 8000,                      // dead time clipped between points (0 = Off)
        'replay.orientation': 'landscape',                // default orientation the replay field opens in: landscape (wide) | portrait (tall); the ⟳ button writes here too
        // --- Hints ---
        'hints.hideAll': false                            // suppress all new-user hint toasts (see ui/hints.js)
    };

    // Back-compat: console globals we advertised before this UI existed.
    // If set, they win over stored/default so quick dev A/B still works.
    const WINDOW_OVERRIDES = {
        'narration.vadEagerness': 'NARRATION_VAD_EAGERNESS',
        'narration.noiseReduction': 'NARRATION_NOISE_REDUCTION',
        'narration.transcriptionModel': 'NARRATION_TRANSCRIPTION_MODEL'
    };

    function readStore() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
        } catch (e) {
            return {};
        }
    }

    function writeStore(obj) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
        } catch (e) {
            console.warn('[advancedSettings] failed to persist:', e);
        }
    }

    function get(key) {
        const overrideVar = WINDOW_OVERRIDES[key];
        if (overrideVar && typeof window !== 'undefined' && window[overrideVar] != null) {
            return window[overrideVar];
        }
        const store = readStore();
        if (Object.prototype.hasOwnProperty.call(store, key)) {
            return store[key];
        }
        return DEFAULTS[key];
    }

    function set(key, value) {
        const store = readStore();
        store[key] = value;
        writeStore(store);
    }

    // --- Convenience accessors used by consumers ---

    function getRefreshIntervalMs() {
        let sec = parseInt(get('sync.refreshIntervalSec'), 10);
        if (!Number.isFinite(sec)) sec = DEFAULTS['sync.refreshIntervalSec'];
        // Clamp to a sane range so a bad value can't hammer the API or stall sync.
        sec = Math.max(3, Math.min(120, sec));
        return sec * 1000;
    }

    function getNarrationAudioConstraints() {
        return {
            echoCancellation: !!get('narration.echoCancellation'),
            noiseSuppression: !!get('narration.noiseSuppression'),
            autoGainControl: !!get('narration.autoGainControl'),
            channelCount: 1
        };
    }

    /**
     * Build the transcription `prompt` biasing string. The template is
     * user-editable in Advanced Settings; `{names}` is substituted with the
     * current on-field roster (names + nicknames). Returns '' when the
     * vocabulary hint is off.
     * @param {Array<{name:string,nickname?:string}>} rosterInfo
     */
    function buildNarrationVocabularyPrompt(rosterInfo) {
        if (!get('narration.vocabularyHint')) return '';
        const template = String(get('narration.vocabularyPrompt') || DEFAULT_VOCAB_PROMPT);
        const names = (rosterInfo || [])
            .flatMap(p => [p.name, p.nickname].filter(Boolean))
            .join(', ');
        // If the template doesn't contain {names}, the user has chosen to
        // skip auto-roster injection — respect that and pass through verbatim.
        return template.replace(/\{names\}/g, names);
    }

    function getDefault(key) { return DEFAULTS[key]; }

    /**
     * Sanitized Auto line-selection priority order: the stored order filtered to
     * known factor keys and de-duped, with any missing factors appended in their
     * canonical order. Guarantees every factor appears exactly once, so a stale
     * or partial stored value (e.g. after a new factor is added) can't drop a
     * rule.
     * @returns {string[]}
     */
    function getAutoLinePriorityOrder() {
        const stored = get('autoLine.priorityOrder');
        const seen = new Set();
        const order = [];
        (Array.isArray(stored) ? stored : []).forEach(k => {
            if (AUTO_LINE_FACTOR_KEYS.includes(k) && !seen.has(k)) { seen.add(k); order.push(k); }
        });
        AUTO_LINE_FACTOR_KEYS.forEach(k => { if (!seen.has(k)) order.push(k); });
        return order;
    }

    /** Whether Crossover players rank with dedicated O/D-line players. */
    function getAutoLineCrossoverSamePriority() {
        return !!get('autoLine.crossoverSamePriority');
    }

    /** Endzone depth (yards) for the Field tab. Defaults to 20 (USAU). */
    /** Replay pacing/orientation (see docs/replay-viewer-plan.md). */
    function getReplaySettings() {
        const num = (key) => {
            const v = parseInt(get(key), 10);
            return Number.isFinite(v) && v >= 0 ? v : DEFAULTS[key];
        };
        const o = get('replay.orientation');
        return {
            capWithinMs: num('replay.capWithinMs'),
            capBetweenMs: num('replay.capBetweenMs'),
            orientation: o === 'portrait' ? 'portrait' : 'landscape',
        };
    }

    function getEndzoneYards() {
        let y = parseInt(get('field.endzoneYards'), 10);
        if (!Number.isFinite(y)) y = DEFAULTS['field.endzoneYards'];
        return y;
    }

    /** Narration settings bundled for narrationRealtimeSession.start(). */
    function getNarrationSessionOptions(rosterInfo) {
        return {
            vadEagerness: get('narration.vadEagerness'),
            noiseReduction: get('narration.noiseReduction'),
            transcriptionModel: get('narration.transcriptionModel'),
            transcriptionLanguage: get('narration.forceEnglish') ? 'en' : undefined,
            transcriptionPrompt: buildNarrationVocabularyPrompt(rosterInfo),
            audioConstraints: getNarrationAudioConstraints()
        };
    }

    // -----------------------------------------------------------------
    // Modal UI
    // -----------------------------------------------------------------

    // Declarative schema drives the form so adding a knob is a one-line edit.
    const SCHEMA = [
        {
            group: 'Auto Line Selection',
            note: 'How the ⚡ Auto button fills a line. Gender ratio (when set) is always satisfied first; these factors then apply in the order below.',
            fields: [
                {
                    key: 'autoLine.priorityOrder', label: 'Priority order',
                    help: 'Drag (or use ▲▼) to rank how Auto decides — higher wins. <b>Position</b>: aim for a handler/cutter balance. <b>Rest</b>: favor players who have sat out more (Auto only adds players — it never benches anyone). <b>O/D squad</b>: on a defense point favor D-line players, on offense favor O-line players. <b>Even playing time</b>: favor players with less time on the field.',
                    type: 'reorder',
                    items: AUTO_LINE_FACTORS
                },
                {
                    key: 'autoLine.crossoverSamePriority', label: 'Crossover ranks with dedicated line',
                    help: 'When on, a Crossover player is treated as just as good a fit as a dedicated D-line player on a defense point (and O-line on offense) — the classic behavior. Turn off to prefer your dedicated D-line (or O-line) players over Crossover players for their point type.',
                    type: 'toggle'
                }
            ]
        },
        {
            group: 'Audio Narration',
            note: 'Changes apply the next time you tap the mic.',
            fields: [
                {
                    key: 'narration.vadEagerness', label: 'Speech detection',
                    help: 'How eagerly it decides you have finished a phrase. Lower keeps multi-clause narrations together; higher reacts faster on stop.',
                    type: 'select',
                    options: [
                        ['low', 'Low (wait longest)'],
                        ['medium', 'Medium (recommended)'],
                        ['high', 'High (snappy)'],
                        ['auto', 'Auto']
                    ]
                },
                {
                    key: 'narration.noiseReduction', label: 'Noise reduction',
                    help: 'Near-field for a phone held near your mouth; far-field for distance; off to A/B in calm conditions.',
                    type: 'select',
                    options: [
                        ['near_field', 'Near-field (phone at mouth)'],
                        ['far_field', 'Far-field (distant mic)'],
                        ['off', 'Off']
                    ]
                },
                {
                    key: 'narration.transcriptionModel', label: 'Transcription model',
                    help: 'The full model is more accurate but costs more per minute.',
                    type: 'select',
                    options: [
                        ['gpt-4o-mini-transcribe', 'Mini (faster, cheaper)'],
                        ['gpt-4o-transcribe', 'Full (more accurate)']
                    ]
                },
                {
                    key: 'narration.vocabularyHint', label: 'Vocabulary hint',
                    help: 'Bias transcription toward your roster names and ultimate jargon. Usually improves name accuracy.',
                    type: 'toggle'
                },
                {
                    key: 'narration.vocabularyPrompt', label: 'Vocabulary prompt',
                    help: 'Free-text hint passed to the transcription model. <code>{names}</code> is replaced with on-field player names at session start. Edit to add team-specific terms, opponent names, or your own jargon — or remove <code>{names}</code> to skip auto-roster injection.',
                    type: 'textarea',
                    rows: 5,
                    showWhen: 'narration.vocabularyHint',
                    resettable: true
                },
                {
                    key: 'narration.forceEnglish', label: 'Force English',
                    help: 'Pin recognition to English so unusual names are not misread as another language.',
                    type: 'toggle'
                },
                {
                    key: 'narration.autoGainControl', label: 'Auto gain control',
                    help: 'Automatic mic gain. Can amplify wind during pauses outdoors — try turning off for field use.',
                    type: 'toggle'
                },
                {
                    key: 'narration.noiseSuppression', label: 'Browser noise suppression',
                    help: 'The browser’s own noise filter, applied before audio is sent.',
                    type: 'toggle'
                },
                {
                    key: 'narration.echoCancellation', label: 'Echo cancellation',
                    help: 'The browser’s echo canceller. Rarely needs changing for sideline use.',
                    type: 'toggle'
                }
            ]
        },
        {
            group: 'Sync',
            note: 'Applies after the app reloads.',
            fields: [
                {
                    key: 'sync.refreshIntervalSec', label: 'Cloud refresh interval',
                    help: 'How often the app pulls fresh team/game data. Longer saves battery and data.',
                    type: 'select',
                    options: [
                        ['5', 'Every 5 seconds'],
                        ['10', 'Every 10 seconds'],
                        ['30', 'Every 30 seconds'],
                        ['60', 'Every 60 seconds']
                    ]
                }
            ]
        },
        {
            group: 'Battery',
            note: 'Phones don’t always survive a full tournament day. These help.',
            fields: [
                {
                    key: 'power.keepScreenAwake', label: 'Keep screen awake in a game',
                    help: 'Stops the display sleeping while you’re on the game screen, so you can turn your brightness right down — which saves far more power than the wake lock costs. Tap the ☀ in the game header to release it when you pocket the phone.',
                    type: 'toggle'
                }
            ]
        },
        {
            group: 'Display',
            fields: [
                {
                    key: 'display.theme', label: 'Theme',
                    help: 'Dark is the default: it uses a true-black background, and on an OLED phone those pixels are switched off, which meaningfully extends battery over a long game. Auto follows your device setting instead.',
                    type: 'select',
                    options: [['auto', 'Auto (match device)'], ['light', 'Light'], ['dark', 'Dark']]
                },
                {
                    key: 'display.showPlayerNumbers', label: 'Show player numbers',
                    help: 'Show jersey numbers alongside player names (roster, lines, play-by-play, dialogs). Turn off for a cleaner display when you know your players by name.',
                    type: 'toggle'
                }
            ]
        },
        {
            group: 'Field',
            note: 'Used by the Field tab; applies the next time it redraws.',
            fields: [
                {
                    key: 'field.endzoneYards', label: 'Endzone depth',
                    help: 'Depth of each endzone drawn on the Field tab. USAU is 20 yards; some leagues use 25.',
                    type: 'select',
                    options: [
                        ['20', '20 yards (USAU)'],
                        ['25', '25 yards']
                    ]
                },
                {
                    key: 'field.huckFraction', label: 'Huck threshold',
                    help: 'A Field-mode throw traveling at least this far downfield is auto-tagged as a huck (always overridable via the throw’s modifier chips).',
                    type: 'select',
                    options: [
                        ['0.4', '40% of the field'],
                        ['0.5', '50% of the field'],
                        ['0.6', '60% of the field']
                    ]
                },
                {
                    key: 'field.swingFraction', label: 'Swing threshold',
                    help: 'A Field-mode throw traveling at least this far across the field width is auto-tagged as a swing (always overridable via the throw’s modifier chips).',
                    type: 'select',
                    options: [
                        ['0.15', '15% of the field width'],
                        ['0.25', '25% of the field width'],
                        ['0.35', '35% of the field width']
                    ]
                }
            ]
        },
        {
            group: 'Replay',
            note: 'Playback of the field diagram on the Log tab. Dead time is clipped so a replay at 1× doesn’t sit through real-world gaps; Off keeps the real spacing.',
            fields: [
                {
                    key: 'replay.capWithinMs', label: 'Dead time within a point',
                    help: 'Longest wait between two plays of the same point during timed playback.',
                    type: 'select',
                    options: [
                        ['0', 'Off (real spacing)'],
                        ['2000', '2 seconds'],
                        ['4000', '4 seconds'],
                        ['8000', '8 seconds'],
                        ['15000', '15 seconds']
                    ]
                },
                {
                    key: 'replay.capBetweenMs', label: 'Dead time between points',
                    help: 'Longest wait from the end of one point to the start of the next during timed playback.',
                    type: 'select',
                    options: [
                        ['0', 'Off (real spacing)'],
                        ['4000', '4 seconds'],
                        ['8000', '8 seconds'],
                        ['15000', '15 seconds'],
                        ['30000', '30 seconds']
                    ]
                },
                {
                    key: 'replay.orientation', label: 'Field orientation',
                    help: 'Default orientation the replay field opens in: landscape draws it wide, portrait draws it tall. The ⟳ button on the replay bar flips the field and updates this default.',
                    type: 'select',
                    options: [
                        ['landscape', 'Landscape (wide)'],
                        ['portrait', 'Portrait (tall)']
                    ]
                }
            ]
        },
        {
            group: 'Hints',
            fields: [
                {
                    key: 'hints.hideAll', label: 'Hide all hints',
                    help: 'Suppress the occasional pop-up tips for new users (e.g. “rotate your phone for a full-screen Field view”). Toggle this setting on and off to reset all hints so they show again.',
                    type: 'toggle'
                }
            ]
        }
    ];

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderField(field) {
        const current = get(field.key);
        // Rows that are gated on another setting carry data-show-when so the
        // modal init can hide them when the gating toggle is off, and unhide
        // them when the user flips it on.
        const showWhenAttr = field.showWhen ? ` data-show-when="${field.showWhen}"` : '';

        if (field.type === 'toggle') {
            const checked = current ? 'checked' : '';
            return `
                <div class="adv-setting-row"${showWhenAttr}>
                    <div class="adv-setting-text">
                        <label class="adv-setting-label" for="adv_${field.key}">${field.label}</label>
                        <div class="adv-setting-help">${field.help}</div>
                    </div>
                    <label class="adv-switch">
                        <input type="checkbox" id="adv_${field.key}" data-key="${field.key}" data-type="toggle" ${checked}>
                        <span class="adv-slider"></span>
                    </label>
                </div>`;
        }
        if (field.type === 'textarea') {
            const rows = field.rows || 4;
            const resetBtn = field.resettable
                ? `<button type="button" class="adv-reset-btn" data-reset-key="${field.key}">Reset to default</button>`
                : '';
            return `
                <div class="adv-setting-row adv-setting-stack"${showWhenAttr}>
                    <div class="adv-setting-text">
                        <label class="adv-setting-label" for="adv_${field.key}">${field.label}</label>
                        <div class="adv-setting-help">${field.help}</div>
                    </div>
                    <div class="adv-textarea-wrap">
                        <textarea id="adv_${field.key}" class="adv-textarea" data-key="${field.key}" data-type="textarea" rows="${rows}">${escapeHtml(current)}</textarea>
                        ${resetBtn}
                    </div>
                </div>`;
        }
        if (field.type === 'reorder') {
            const order = getAutoLinePriorityOrder();
            const labelMap = {};
            (field.items || []).forEach(([k, l]) => { labelMap[k] = l; });
            const items = order.map((k, i) => `
                <li class="adv-reorder-item" draggable="true" data-item-key="${escapeHtml(k)}">
                    <span class="adv-reorder-grip" aria-hidden="true">⣿</span>
                    <span class="adv-reorder-rank">${i + 1}</span>
                    <span class="adv-reorder-label">${escapeHtml(labelMap[k] || k)}</span>
                    <span class="adv-reorder-btns">
                        <button type="button" class="adv-reorder-btn" data-dir="up" aria-label="Move up">▲</button>
                        <button type="button" class="adv-reorder-btn" data-dir="down" aria-label="Move down">▼</button>
                    </span>
                </li>`).join('');
            return `
                <div class="adv-setting-row adv-setting-stack"${showWhenAttr}>
                    <div class="adv-setting-text">
                        <label class="adv-setting-label">${field.label}</label>
                        <div class="adv-setting-help">${field.help}</div>
                    </div>
                    <ol class="adv-reorder-list" data-key="${field.key}" data-type="reorder">${items}</ol>
                </div>`;
        }
        // select
        const opts = field.options.map(([val, lbl]) => {
            const sel = String(current) === String(val) ? 'selected' : '';
            return `<option value="${val}" ${sel}>${lbl}</option>`;
        }).join('');
        return `
            <div class="adv-setting-row"${showWhenAttr}>
                <div class="adv-setting-text">
                    <label class="adv-setting-label" for="adv_${field.key}">${field.label}</label>
                    <div class="adv-setting-help">${field.help}</div>
                </div>
                <select id="adv_${field.key}" class="adv-select" data-key="${field.key}" data-type="select">${opts}</select>
            </div>`;
    }

    function renderGroup(group) {
        const fields = group.fields.map(renderField).join('');
        const note = group.note ? `<div class="adv-group-note">${group.note}</div>` : '';
        return `
            <div class="adv-group">
                <h3 class="adv-group-title">${group.group}</h3>
                ${note}
                ${fields}
            </div>`;
    }

    function showAdvancedSettings() {
        let modal = document.getElementById('advancedSettingsModal');
        if (modal) modal.remove();

        modal = document.createElement('div');
        modal.id = 'advancedSettingsModal';
        modal.className = 'modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-content adv-settings-content">
                <div class="dialog-header prominent-dialog-header">
                    <h2>Advanced Settings</h2>
                    <span class="close">&times;</span>
                </div>
                <div class="adv-settings-body">
                    ${SCHEMA.map(renderGroup).join('')}
                </div>
                <div class="adv-settings-footer">
                    <button class="adv-done-btn" type="button">Done</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        // Show/hide gated rows based on their `data-show-when` toggle's
        // current value. Called on init and whenever a toggle changes.
        const refreshShowWhen = () => {
            modal.querySelectorAll('[data-show-when]').forEach(row => {
                const gatingKey = row.getAttribute('data-show-when');
                row.classList.toggle('adv-hidden', !get(gatingKey));
            });
        };
        refreshShowWhen();

        // Live-save on every change. Narration knobs take effect next session;
        // the sync interval note tells the user a reload is needed.
        // Textareas get `input` events too so typing persists keystroke-by-
        // keystroke without waiting for blur.
        modal.querySelectorAll('[data-key]').forEach(el => {
            if (el.getAttribute('data-type') === 'reorder') return; // wired separately below
            const persist = () => {
                const key = el.getAttribute('data-key');
                const type = el.getAttribute('data-type');
                if (type === 'toggle') {
                    set(key, el.checked);
                } else {
                    set(key, el.value);
                }
                // Flipping "Hide all hints" (either direction) clears the
                // per-hint "shown today" stamps, so toggling it off and on
                // again resets all hints — a way for users to bring them back
                // and for us to re-test new ones. See ui/hints.js.
                if (key === 'hints.hideAll' && window.hints && typeof window.hints.resetAll === 'function') {
                    window.hints.resetAll();
                }
                // The wake lock is one of two settings that act immediately —
                // the coach may well be mid-game with the modal open.
                if (key === 'power.keepScreenAwake') {
                    window.wakeLockManager?.reconcile?.();
                }
                // Theme is the other: the user is looking at the thing they
                // just changed.
                if (key === 'display.theme' && window.theme) {
                    window.theme.applyTheme(el.value);
                }
                // A toggle flip may unhide a gated row (e.g. flipping the
                // vocabulary hint on reveals the prompt textarea).
                if (type === 'toggle') refreshShowWhen();
            };
            el.addEventListener('change', persist);
            if (el.getAttribute('data-type') === 'textarea') {
                el.addEventListener('input', persist);
            }
        });

        // Reorder lists (priority order): drag on desktop, ▲▼ on touch. Both
        // paths reorder the <li>s in the DOM, then persist + renumber from the
        // resulting DOM order.
        modal.querySelectorAll('.adv-reorder-list').forEach(list => {
            const persistOrder = () => {
                const key = list.getAttribute('data-key');
                const items = [...list.querySelectorAll('.adv-reorder-item')];
                set(key, items.map(li => li.getAttribute('data-item-key')));
                items.forEach((li, i) => {
                    const rank = li.querySelector('.adv-reorder-rank');
                    if (rank) rank.textContent = String(i + 1);
                });
            };

            // ▲▼ buttons
            list.addEventListener('click', (e) => {
                const btn = e.target.closest('.adv-reorder-btn');
                if (!btn) return;
                const li = btn.closest('.adv-reorder-item');
                if (!li) return;
                if (btn.getAttribute('data-dir') === 'up' && li.previousElementSibling) {
                    list.insertBefore(li, li.previousElementSibling);
                } else if (btn.getAttribute('data-dir') === 'down' && li.nextElementSibling) {
                    list.insertBefore(li.nextElementSibling, li);
                }
                persistOrder();
            });

            // HTML5 drag (desktop). Touch devices use the buttons above.
            let dragEl = null;
            list.addEventListener('dragstart', (e) => {
                const li = e.target.closest('.adv-reorder-item');
                if (!li) return;
                dragEl = li;
                li.classList.add('adv-reorder-dragging');
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            });
            list.addEventListener('dragover', (e) => {
                e.preventDefault();
                const li = e.target.closest('.adv-reorder-item');
                if (!li || li === dragEl || !dragEl) return;
                const rect = li.getBoundingClientRect();
                const after = (e.clientY - rect.top) > rect.height / 2;
                list.insertBefore(dragEl, after ? li.nextElementSibling : li);
            });
            list.addEventListener('dragend', () => {
                if (dragEl) dragEl.classList.remove('adv-reorder-dragging');
                dragEl = null;
                persistOrder();
            });
            list.addEventListener('drop', (e) => e.preventDefault());
        });

        // Reset-to-default buttons restore the built-in default for their
        // setting and refresh the visible textarea content.
        modal.querySelectorAll('.adv-reset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-reset-key');
                const def = getDefault(key);
                set(key, def);
                const ta = modal.querySelector(`#adv_${CSS.escape(key)}`);
                if (ta) ta.value = def == null ? '' : String(def);
            });
        });

        const close = () => modal.remove();
        modal.querySelector('.close').onclick = close;
        modal.querySelector('.adv-done-btn').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };
    }

    // Expose
    return {
        get,
        set,
        getRefreshIntervalMs,
        getNarrationAudioConstraints,
        buildNarrationVocabularyPrompt,
        getNarrationSessionOptions,
        getEndzoneYards,
        getReplaySettings,
        getAutoLinePriorityOrder,
        getAutoLineCrossoverSamePriority,
        showAdvancedSettings
    };
})();

// --- ES-module export ---
export { advancedSettings };
// window survivor: late-bound state accessor (settings namespace read
// window-qualified by main.js, ui/hints.js, store/sync.js and game/* modules;
// window.advancedSettings is the documented settings surface)
window.advancedSettings = advancedSettings;
