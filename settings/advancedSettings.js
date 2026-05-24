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
(function() {
    const STORAGE_KEY = 'breakside_advanced_settings';

    const DEFAULTS = {
        // --- Audio Narration ---
        'narration.vadEagerness': 'medium',              // low | medium | high | auto
        'narration.noiseReduction': 'near_field',        // near_field | far_field | off
        'narration.transcriptionModel': 'gpt-4o-mini-transcribe', // or gpt-4o-transcribe
        'narration.forceEnglish': true,                  // true -> language 'en'; false -> auto-detect
        'narration.vocabularyHint': true,                // bias ASR toward roster names + ultimate jargon
        'narration.echoCancellation': true,              // getUserMedia audio constraints
        'narration.noiseSuppression': true,
        'narration.autoGainControl': true,               // AGC can pump up wind outdoors — toggle off to test
        // --- Sync ---
        'sync.refreshIntervalSec': 10                    // cloud auto-refresh cadence (applies after reload)
    };

    // Back-compat: console globals we advertised before this UI existed.
    // If set, they win over stored/default so quick dev A/B still works.
    const WINDOW_OVERRIDES = {
        'narration.vadEagerness': 'NARRATION_VAD_EAGERNESS',
        'narration.noiseReduction': 'NARRATION_NOISE_REDUCTION',
        'narration.transcriptionModel': 'NARRATION_TRANSCRIPTION_MODEL'
    };

    // Common ultimate-frisbee jargon to bias transcription toward. Player
    // names are appended at session start (they're roster-dependent).
    const JARGON = [
        'huck', 'hammer', 'scoober', 'blade', 'break', 'break mark', 'dump',
        'swing', 'reset', 'sky', 'layout', 'bid', 'Callahan', 'brick', 'pull',
        'stall', 'stall out', 'poach', 'force', 'flick', 'backhand', 'IO', 'OI',
        'inside-out', 'outside-in', 'endzone', 'throwaway', 'drop', 'footblock',
        'bookends', 'Greatest', 'handler', 'cutter', 'give-and-go', 'strike',
        'under', 'deep', 'goal', 'assist', 'turnover', 'interception', 'block'
    ];

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
     * Build the transcription `prompt` biasing string from on-field player
     * names plus ultimate jargon. Returns '' when the vocabulary hint is off.
     * @param {Array<{name:string,nickname?:string}>} rosterInfo
     */
    function buildNarrationVocabularyPrompt(rosterInfo) {
        if (!get('narration.vocabularyHint')) return '';
        const names = (rosterInfo || [])
            .flatMap(p => [p.name, p.nickname].filter(Boolean));
        const terms = names.concat(JARGON);
        // The transcription prompt is a free-text hint; a comma-joined list of
        // expected words nudges the recognizer without constraining it.
        return `Ultimate frisbee game. Likely names and terms: ${terms.join(', ')}.`;
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
        }
    ];

    function renderField(field) {
        const current = get(field.key);
        if (field.type === 'toggle') {
            const checked = current ? 'checked' : '';
            return `
                <div class="adv-setting-row">
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
        // select
        const opts = field.options.map(([val, lbl]) => {
            const sel = String(current) === String(val) ? 'selected' : '';
            return `<option value="${val}" ${sel}>${lbl}</option>`;
        }).join('');
        return `
            <div class="adv-setting-row">
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

        // Live-save on every change. Narration knobs take effect next session;
        // the sync interval note tells the user a reload is needed.
        modal.querySelectorAll('[data-key]').forEach(el => {
            el.addEventListener('change', () => {
                const key = el.getAttribute('data-key');
                const type = el.getAttribute('data-type');
                if (type === 'toggle') {
                    set(key, el.checked);
                } else {
                    set(key, el.value);
                }
            });
        });

        const close = () => modal.remove();
        modal.querySelector('.close').onclick = close;
        modal.querySelector('.adv-done-btn').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };
    }

    // Expose
    window.advancedSettings = {
        get,
        set,
        getRefreshIntervalMs,
        getNarrationAudioConstraints,
        buildNarrationVocabularyPrompt,
        getNarrationSessionOptions,
        showAdvancedSettings
    };
})();
