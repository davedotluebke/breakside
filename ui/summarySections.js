/*
 * Collapsible sections on the Review / post-game summary screen
 * (teams/gameSummary.js): Player Stats, Game Flow, Game Log. Each
 * `.summary-section[data-section]` has a heading (`.summary-section-toggle`)
 * that shows or hides its `.summary-section-body`, and the choice is
 * remembered per device in localStorage, so a coach who opens Game Flow
 * once finds it open on the next game. Defaults: stats and log open, Game
 * Flow collapsed — it is the deepest dive on the page, and the score and the
 * stats table are what most visits come for.
 *
 * Collapsing is a class on the section (`collapsed`) with the body hidden
 * by CSS (css/tables.css). That is what lets the Game Flow chart draw
 * lazily: it draws inside a ResizeObserver, which fires when the body gets
 * a width (ARCHITECTURE.md § Game Flow). A section dispatches a bubbling
 * `summary-section-toggle` CustomEvent ({key, open}) when tapped, for
 * anything that must re-measure once shown.
 *
 * The state helpers take their storage as a parameter and are node-tested:
 * tests/unit/summarySections.test.mjs.
 */

const STORAGE_KEY = 'breakside_summary_sections';
const DEFAULT_OPEN = Object.freeze({ stats: true, flow: false, log: true });

/**
 * The open/closed state of every section: the defaults, overridden by
 * whatever the device saved. Junk in storage reads as the defaults.
 * @param {Storage|null} storage
 * @param {Object<string, boolean>} [defaults]
 * @returns {Object<string, boolean>}
 */
function readSectionStates(storage, defaults = DEFAULT_OPEN) {
    const states = { ...defaults };
    try {
        const raw = storage ? storage.getItem(STORAGE_KEY) : null;
        const saved = raw ? JSON.parse(raw) : null;
        if (saved && typeof saved === 'object') {
            Object.keys(defaults).forEach(key => {
                if (typeof saved[key] === 'boolean') states[key] = saved[key];
            });
        }
    } catch (e) { /* unreadable → defaults */ }
    return states;
}

/**
 * Remember one section's state. Returns the full state map as saved.
 * A storage that throws (quota, private mode) leaves the in-memory result
 * correct and the next read on the defaults.
 */
function saveSectionState(storage, key, open, defaults = DEFAULT_OPEN) {
    const states = readSectionStates(storage, defaults);
    states[key] = !!open;
    try { if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(states)); } catch (e) { /* not persisted */ }
    return states;
}

/** Show or hide a section's body and keep the toggle's ARIA state in step. */
function applySectionOpen(section, open) {
    section.classList.toggle('collapsed', !open);
    const toggle = section.querySelector(':scope > .summary-section-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function isSectionOpen(section) {
    return !section.classList.contains('collapsed');
}

/**
 * Apply the remembered states and wire every section's heading as a toggle.
 * Safe to call again (re-applies states; wiring happens once per section).
 * @param {ParentNode} [root]
 * @param {Storage|null} [storage]
 */
function initSummarySections(root = document, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    const states = readSectionStates(storage);
    root.querySelectorAll('.summary-section[data-section]').forEach(section => {
        const key = section.dataset.section;
        if (!(key in DEFAULT_OPEN)) return;
        applySectionOpen(section, states[key]);
        if (section.dataset.collapsibleWired) return;
        section.dataset.collapsibleWired = '1';
        const toggle = section.querySelector(':scope > .summary-section-toggle');
        if (!toggle) return;
        toggle.setAttribute('role', 'button');
        toggle.setAttribute('tabindex', '0');
        const flip = () => {
            const open = !isSectionOpen(section);
            applySectionOpen(section, open);
            saveSectionState(storage, key, open);
            section.dispatchEvent(new CustomEvent('summary-section-toggle', { bubbles: true, detail: { key, open } }));
        };
        toggle.addEventListener('click', flip);
        toggle.addEventListener('keydown', ev => {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); flip(); }
        });
    });
}

// --- ES-module exports ---
export {
    initSummarySections, readSectionStates, saveSectionState, applySectionOpen, isSectionOpen,
    STORAGE_KEY, DEFAULT_OPEN,
};
