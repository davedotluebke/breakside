/*
 * The Export dialog — one popup behind every Export button (Review, Event
 * Roster + Stats, Team Roster + Stats).
 *
 * It asks what to export and in what form:
 *
 *   Format    Excel (.xlsx) · Google Sheets · Game JSON · Game log (text)
 *   Scope     the same choices as the screen's scope control (all-time / event
 *             / game, or all games / a phase / a game), plus an optional
 *             "a sheet per …" breakdown
 *   Stats     Fun · Basic · Advanced · Full (only the team's level when the
 *             user is held to one — utils/statsAudience.js)
 *   Shout-outs  at Fun: "Shout out the top [5] players for each stat" and the
 *             throws Completion % needs (blank = automatic); starts at the
 *             screen's Fun options, hidden for a user held to Fun
 *   Players   All players, or one (the privacy handout — see
 *             utils/exportWorkbook.js exportSelection)
 *
 * Every choice starts at what the screen is showing, and none of them writes
 * back: changing the level here does not change the table's Stats menu (the
 * shared, persisted setting in utils/statsLevel.js). Only the format and the
 * breakdown checkbox are remembered between exports, per device.
 *
 * The caller supplies the data; this module owns the writers:
 *   buildWorkbook(choice, progress) → utils/exportWorkbook.js model
 *   gameFor(choice) → the one game a JSON / text export writes
 */

import { serializeGame } from '../store/storage.js';
import { StatsLevel, LEVEL_OPTIONS } from '../utils/statsLevel.js';
import { downloadXlsx } from '../utils/xlsxExport.js';
import { safeFilename } from '../utils/exportWorkbook.js';
import {
    googleSheetsConfigured, preloadGoogleSheets, googleSheetsReady,
    getAccessToken, createGoogleSheet,
} from '../utils/sheetsExport.js';
import { formatPlayerName } from '../utils/helpers.js';

const FORMAT_KEY = 'exportFormat';
const BREAKDOWN_KEY = 'exportBreakdown';

const FORMATS = [
    { value: 'xlsx', label: 'Excel', icon: 'fa-file-excel', hint: 'Download an .xlsx workbook' },
    { value: 'sheets', label: 'Google Sheets', icon: 'fa-table', hint: 'Create a sheet in your Google Drive' },
    { value: 'json', label: 'Game JSON', icon: 'fa-file-code', hint: 'The complete game record, for backup or re-import', singleGame: true },
    { value: 'text', label: 'Game log', icon: 'fa-clipboard', hint: 'Copy the play-by-play log as plain text', singleGame: true },
];

function esc(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
}

function readPref(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; }
}
function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        return false;
    }
}

function downloadBlob(text, type, filename) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/**
 * Open the Export dialog.
 *
 * @param {object} opts
 * @param {string} opts.subject - what is being exported, shown under the title
 * @param {Array<object>} opts.scopes - [{value, label, group?, disabled?,
 *   singleGame?: boolean, breakdown?: string}]. `breakdown` labels the
 *   "a sheet per …" checkbox for that scope; omit when there is nothing to
 *   break down. `singleGame` scopes also offer JSON and text.
 * @param {string} opts.scope - the scope the screen is showing
 * @param {string} opts.level - the stats level the screen is showing
 * @param {string} [opts.lockedLevel] - the only level this user may export
 * @param {{topN: number, minCompThrows: number|null}} [opts.funOptions] - the
 *   screen's Fun options (utils/statsAudience.js getFunOptions)
 * @param {Array<object>} opts.players - who a stats export can cover
 * @param {Array<string>} [opts.formats] - allowed formats (default: all)
 * @param {Function} opts.buildWorkbook - async (choice, progress) → workbook
 * @param {Function} [opts.gameFor] - (choice) → game, for JSON / text
 * @param {Function} [opts.gameText] - (game) → the game log as text
 */
function openExportDialog(opts) {
    document.getElementById('exportDialogModal')?.remove();

    const sheetsOk = googleSheetsConfigured();
    const allowed = (opts.formats || FORMATS.map(f => f.value))
        .filter(v => v !== 'sheets' || sheetsOk)
        .filter(v => !(FORMATS.find(f => f.value === v)?.singleGame) || opts.gameFor);
    const formats = FORMATS.filter(f => allowed.includes(f.value));

    const scopes = opts.scopes || [];
    const startScope = scopes.find(s => s.value === opts.scope && !s.disabled) || scopes.find(s => !s.disabled) || scopes[0];

    const state = {
        format: allowed.includes(readPref(FORMAT_KEY, 'xlsx')) ? readPref(FORMAT_KEY, 'xlsx') : allowed[0],
        scope: startScope ? startScope.value : '',
        level: opts.lockedLevel || opts.level || StatsLevel.ADVANCED,
        playerId: '',
        funTopN: (opts.funOptions && opts.funOptions.topN) || 5,
        funMinThrows: (opts.funOptions && opts.funOptions.minCompThrows) || '',
        breakdown: readPref(BREAKDOWN_KEY, '0') === '1',
        busy: false,
    };

    const scopeOptions = (() => {
        let html = '';
        let group = null;
        scopes.forEach(s => {
            if ((s.group || null) !== group) {
                if (group) html += '</optgroup>';
                group = s.group || null;
                if (group) html += `<optgroup label="${esc(group)}">`;
            }
            html += `<option value="${esc(s.value)}"${s.disabled ? ' disabled' : ''}>${esc(s.label)}</option>`;
        });
        if (group) html += '</optgroup>';
        return html;
    })();

    const playerOptions = ['<option value="">All players</option>']
        .concat((opts.players || []).filter(p => p && p.id)
            .map(p => `<option value="${esc(p.id)}">${esc(formatPlayerName(p))}</option>`))
        .join('');

    const modal = document.createElement('div');
    modal.id = 'exportDialogModal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content export-dialog-content" role="dialog" aria-labelledby="exportDialogTitle">
            <div class="dialog-header prominent-dialog-header">
                <h2 id="exportDialogTitle">Export</h2>
                <span class="close" aria-label="Close">&times;</span>
            </div>
            <div class="export-dialog-body">
                <p class="export-subject">${esc(opts.subject || '')}</p>
                <div class="export-formats" role="radiogroup" aria-label="Format">
                    ${formats.map(f => `
                    <label class="export-format" data-format="${f.value}">
                        <input type="radio" name="exportFormat" value="${f.value}">
                        <i class="fas ${f.icon}" aria-hidden="true"></i>
                        <span class="export-format-label">${esc(f.label)}</span>
                        <span class="export-format-hint">${esc(f.hint)}</span>
                    </label>`).join('')}
                </div>
                <div class="export-options">
                    <label class="export-option" data-row="scope"${scopes.length > 1 ? '' : ' hidden'}>
                        <span>Scope</span>
                        <select id="exportScopeSelect">${scopeOptions}</select>
                    </label>
                    <label class="export-option export-breakdown" data-row="breakdown" hidden>
                        <input type="checkbox" id="exportBreakdownCheckbox">
                        <span id="exportBreakdownLabel"></span>
                    </label>
                    <label class="export-option" data-row="level">
                        <span>Stats</span>
                        <select id="exportLevelSelect"${opts.lockedLevel ? ' disabled' : ''}>
                            ${LEVEL_OPTIONS.filter(o => !opts.lockedLevel || o.value === opts.lockedLevel)
                                .map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}
                        </select>
                    </label>
                    <div class="export-option export-fun-options" data-row="fun" hidden>
                        <label>Shout out the top
                            <input type="number" id="exportFunTopN" min="1" max="99" inputmode="numeric">
                            players for each stat</label>
                        <label>Completion % needs
                            <input type="number" id="exportFunMinThrows" min="1" max="999" inputmode="numeric" placeholder="auto">
                            throws</label>
                    </div>
                    <label class="export-option" data-row="players">
                        <span>Players</span>
                        <select id="exportPlayerSelect" title="A single player's sheet still carries the team totals">${playerOptions}</select>
                    </label>
                </div>
                <div class="export-status" id="exportStatus" aria-live="polite"></div>
                <div class="export-actions">
                    <button type="button" id="exportCancelBtn" class="export-cancel-btn">Close</button>
                    <button type="button" id="exportGoBtn" class="export-go-btn">Export</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const $ = sel => modal.querySelector(sel);
    const scopeSelect = $('#exportScopeSelect');
    const levelSelect = $('#exportLevelSelect');
    const playerSelect = $('#exportPlayerSelect');
    const breakdownBox = $('#exportBreakdownCheckbox');
    const statusEl = $('#exportStatus');
    const goBtn = $('#exportGoBtn');

    scopeSelect.value = state.scope;
    levelSelect.value = state.level;
    const funTopNInput = $('#exportFunTopN');
    const funMinThrowsInput = $('#exportFunMinThrows');
    funTopNInput.value = state.funTopN;
    funMinThrowsInput.value = state.funMinThrows;
    breakdownBox.checked = state.breakdown;

    const currentScope = () => scopes.find(s => s.value === state.scope) || {};

    function setStatus(html, kind = '') {
        statusEl.className = `export-status${kind ? ' export-status-' + kind : ''}`;
        statusEl.innerHTML = html;
    }

    function refresh() {
        const scope = currentScope();
        // JSON and text write one game; they're offered only when the scope is one.
        modal.querySelectorAll('.export-format').forEach(el => {
            const f = FORMATS.find(x => x.value === el.dataset.format);
            const offline = f.value === 'sheets' && !navigator.onLine;
            const disabled = (f.singleGame && !scope.singleGame) || offline;
            const input = el.querySelector('input');
            input.disabled = disabled;
            el.classList.toggle('disabled', disabled);
            el.title = offline ? 'Google Sheets needs a connection'
                : (f.singleGame && !scope.singleGame) ? 'Pick a single game to export this' : '';
        });
        const chosen = FORMATS.find(f => f.value === state.format);
        const chosenInput = modal.querySelector(`input[value="${state.format}"]`);
        if (!chosen || !chosenInput || chosenInput.disabled) {
            const firstOk = modal.querySelector('.export-format input:not(:disabled)');
            state.format = firstOk ? firstOk.value : state.format;
        }
        modal.querySelectorAll('.export-format input').forEach(input => {
            input.checked = input.value === state.format;
            input.closest('.export-format').classList.toggle('selected', input.checked);
        });

        // Google's sign-in script loads only once Google Sheets is picked, so
        // opening the dialog for an Excel export never contacts Google
        // (privacy.html § Who else sees it). Picking the tile is a click
        // before the Export click, which gives the script time to load.
        if (state.format === 'sheets') preloadGoogleSheets();

        const statsFormat = state.format === 'xlsx' || state.format === 'sheets';
        $('[data-row="level"]').hidden = !statsFormat;
        $('[data-row="players"]').hidden = !statsFormat;
        $('[data-row="fun"]').hidden = !statsFormat || state.level !== StatsLevel.FUN || !!opts.lockedLevel;
        const showBreakdown = statsFormat && !!scope.breakdown;
        $('[data-row="breakdown"]').hidden = !showBreakdown;
        $('#exportBreakdownLabel').textContent = scope.breakdown || '';
        goBtn.disabled = state.busy || !modal.querySelector('.export-format input:checked');
        goBtn.textContent = state.format === 'text' ? 'Copy' : state.format === 'json' ? 'Download' : 'Export';
    }

    modal.querySelectorAll('.export-format input').forEach(input => {
        input.addEventListener('change', () => {
            state.format = input.value;
            writePref(FORMAT_KEY, state.format);
            setStatus('');
            refresh();
        });
    });
    scopeSelect.onchange = () => { state.scope = scopeSelect.value; setStatus(''); refresh(); };
    levelSelect.onchange = () => { state.level = levelSelect.value; refresh(); };
    funTopNInput.onchange = () => { state.funTopN = funTopNInput.value; };
    funMinThrowsInput.onchange = () => { state.funMinThrows = funMinThrowsInput.value; };
    playerSelect.onchange = () => { state.playerId = playerSelect.value; };
    breakdownBox.onchange = () => {
        state.breakdown = breakdownBox.checked;
        writePref(BREAKDOWN_KEY, state.breakdown ? '1' : '0');
    };

    const onConnectivity = () => refresh();
    window.addEventListener('online', onConnectivity);
    window.addEventListener('offline', onConnectivity);
    const close = () => {
        window.removeEventListener('online', onConnectivity);
        window.removeEventListener('offline', onConnectivity);
        modal.remove();
    };
    $('.close').onclick = close;
    $('#exportCancelBtn').onclick = close;
    modal.onclick = (e) => { if (e.target === modal && !state.busy) close(); };

    goBtn.onclick = () => {
        const choice = {
            format: state.format,
            scope: state.scope,
            level: state.level,
            playerId: state.playerId,
            breakdown: !!currentScope().breakdown && state.breakdown,
            // Read at click time: a number typed without leaving the box has
            // not fired 'change' yet. A user held to Fun gets the defaults.
            fun: opts.lockedLevel ? {} : {
                topN: funTopNInput.value,
                minCompThrows: funMinThrowsInput.value,
            },
        };
        // Google's consent popup must open inside this click, before any await.
        let tokenPromise = null;
        if (choice.format === 'sheets') {
            if (!googleSheetsReady()) {
                setStatus('Connecting to Google… try again in a moment.', 'error');
                preloadGoogleSheets();
                return;
            }
            tokenPromise = getAccessToken();
        }
        run(choice, tokenPromise);
    };

    async function run(choice, tokenPromise) {
        state.busy = true;
        refresh();
        try {
            if (choice.format === 'json' || choice.format === 'text') {
                await exportGame(choice);
                return;
            }
            if (tokenPromise) setStatus('Waiting for Google sign-in…');
            const token = tokenPromise ? await tokenPromise : null;
            setStatus('Building…');
            const workbook = await opts.buildWorkbook(choice, msg => setStatus(esc(msg)));
            if (!workbook || !workbook.sheets.length) {
                setStatus('Nothing to export for that choice.', 'error');
                return;
            }
            if (choice.format === 'xlsx') {
                downloadXlsx(workbook);
                setStatus(`Downloaded <strong>${esc(workbook.stem)}.xlsx</strong>`, 'ok');
            } else {
                setStatus('Creating the Google Sheet…');
                const url = await createGoogleSheet(workbook, token, workbook.stem.replace(/-/g, ' '));
                setStatus(`Sheet created in your Google Drive. <a href="${esc(url)}" target="_blank" rel="noopener">Open in Google Sheets <i class="fas fa-external-link-alt" aria-hidden="true"></i></a>`, 'ok');
            }
        } catch (e) {
            console.error('Export failed:', e);
            setStatus(`Export failed: ${esc(e.message || e)}`, 'error');
        } finally {
            state.busy = false;
            refresh();
        }
    }

    async function exportGame(choice) {
        const game = await opts.gameFor(choice);
        if (!game) { setStatus('No game to export.', 'error'); return; }
        const started = new Date(game.gameStartTimestamp || Date.now());
        const day = (Number.isNaN(started.getTime()) ? new Date() : started).toISOString().split('T')[0];
        const stem = `${safeFilename(game.team || 'Team')}_vs_${safeFilename(game.opponent || 'Opponent')}_${day}`;
        if (choice.format === 'json') {
            downloadBlob(JSON.stringify(serializeGame(game), null, 2), 'application/json', `${stem}.json`);
            setStatus(`Downloaded <strong>${esc(stem)}.json</strong>`, 'ok');
            return;
        }
        const text = opts.gameText ? opts.gameText(game) : '';
        if (await copyText(text)) {
            setStatus('Game log copied to the clipboard.', 'ok');
        } else {
            // Clipboard refused (no user gesture left, or plain http): hand
            // the text over to copy by hand.
            setStatus('The browser blocked the clipboard — select the log below and copy it.', 'error');
            const ta = document.createElement('textarea');
            ta.className = 'export-text-fallback';
            ta.readOnly = true;
            ta.value = text;
            statusEl.appendChild(ta);
            ta.select();
        }
    }

    refresh();
    return modal;
}

// --- ES-module exports ---
export { openExportDialog };
